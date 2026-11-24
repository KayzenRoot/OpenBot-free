import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type ProjectProcessResult = {
  exitCode: number;
  stdout: { text: string; truncated: boolean };
  stderr: { text: string; truncated: boolean };
  timedOut: boolean;
};

type Execute = (
  command: string[],
  cwd: string,
  env: Record<string, string>,
  options?: { limit?: number; milliseconds?: number; input?: string },
) => Promise<ProjectProcessResult>;

export type ProjectContainerRunner = {
  kind: "docker" | "podman";
  run(
    args: string[],
    milliseconds: number,
    limit?: number,
  ): Promise<ProjectProcessResult>;
  mountPath(path: string): Promise<string | null>;
};

const bunImage = "docker.io/oven/bun:1.4.3";

export class ProjectSandboxError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function unavailable(code = "PROJECT_PILOT_SANDBOX_REQUIRED"): never {
  throw new ProjectSandboxError(code);
}

function succeeded(result: ProjectProcessResult) {
  return result.exitCode === 0 && !result.timedOut && !result.stdout.truncated;
}

function nativeRunner(
  execute: Execute,
  storage: string,
  env: Record<string, string>,
): ProjectContainerRunner | null {
  const docker = Bun.which(
    process.platform === "win32" ? "docker.exe" : "docker",
  );
  if (!docker || !isAbsolute(docker)) return null;
  const config = join(storage, "docker-settings");
  mkdirSync(config, { recursive: true });
  const endpoint =
    process.platform === "win32"
      ? "npipe:////./pipe/dockerDesktopLinuxEngine"
      : "unix:///var/run/docker.sock";
  return {
    kind: "docker",
    run: (args, milliseconds, limit) =>
      execute(
        [docker, "--host", endpoint, ...args],
        storage,
        { ...env, DOCKER_CONFIG: config },
        { milliseconds, limit },
      ),
    async mountPath(path) {
      return path;
    },
  };
}

async function wslRunner(
  execute: Execute,
  storage: string,
  env: Record<string, string>,
): Promise<ProjectContainerRunner | null> {
  if (process.platform !== "win32") return null;
  const wsl = Bun.which("wsl.exe");
  if (!wsl || !isAbsolute(wsl)) return null;
  const distro =
    process.env.OPENBOT_PROJECT_PODMAN_DISTRO?.trim() || "podman-openbot";
  const runtime =
    process.env.OPENBOT_PROJECT_PODMAN_RUNTIME_DIR?.trim() ||
    "/tmp/openbot-project-runtime-1000";
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(distro) ||
    !/^\/tmp\/openbot-[a-zA-Z0-9_-]{1,80}$/.test(runtime)
  )
    return null;
  const prefix = [wsl, "-d", distro, "--exec"];
  const linux = (args: string[], milliseconds: number, limit?: number) =>
    execute([...prefix, ...args], storage, env, { milliseconds, limit });
  const id = await linux(["/usr/bin/id", "-u"], 5_000);
  const uid = id.stdout.text.trim();
  if (!succeeded(id) || !/^[1-9][0-9]{0,8}$/.test(uid)) return null;
  const account = await linux(["/usr/bin/getent", "passwd", uid], 5_000);
  const home = account.stdout.text.trim().split(":")[5];
  if (!succeeded(account) || !home || !/^\/home\/[a-zA-Z0-9_-]+$/.test(home))
    return null;
  const created = await linux(
    ["/usr/bin/install", "-d", "-m", "0700", runtime],
    6_000,
  );
  if (!succeeded(created)) return null;
  const stat = await linux(["/usr/bin/stat", "-c", "%u:%a:%F", runtime], 5_000);
  if (!succeeded(stat) || stat.stdout.text.trim() !== `${uid}:700:directory`)
    return null;
  return {
    kind: "podman",
    run(args, milliseconds, limit) {
      return linux(
        [
          "/usr/bin/env",
          `XDG_RUNTIME_DIR=${runtime}`,
          "/usr/bin/podman",
          "--remote=false",
          "--root",
          `${home}/.local/share/openbot-project-containers`,
          "--runroot",
          `${runtime}/containers`,
          "--tmpdir",
          `${runtime}/libpod`,
          "--events-backend=file",
          "--cgroup-manager=cgroupfs",
          "--default-mounts-file=/dev/null",
          ...args,
        ],
        milliseconds,
        limit,
      );
    },
    async mountPath(path) {
      const result = await linux(
        ["/usr/bin/wslpath", "-a", "-u", path.replaceAll("\\", "/")],
        6_000,
      );
      const location = result.stdout.text.trim();
      return succeeded(result) && /^\/mnt\/[a-z]\//.test(location)
        ? location
        : null;
    },
  };
}

export async function selectProjectRunner(
  execute: Execute,
  storage: string,
  env: Record<string, string>,
  override?: ProjectContainerRunner,
) {
  const usable = async (runner: ProjectContainerRunner | null) => {
    if (!runner) return null;
    const template = runner.kind === "podman" ? "{{.Host.OS}}" : "{{.OSType}}";
    try {
      const system = await runner.run(["info", "--format", template], 12_000);
      return succeeded(system) && system.stdout.text.trim() === "linux"
        ? runner
        : null;
    } catch {
      return null;
    }
  };
  return override
    ? ((await usable(override)) ?? unavailable())
    : ((await usable(nativeRunner(execute, storage, env))) ??
        (await usable(await wslRunner(execute, storage, env))) ??
        unavailable());
}

export async function inspectTestImage(runner: ProjectContainerRunner) {
  const image = await runner.run(
    [
      "image",
      "inspect",
      "--format",
      "{{.Id}} {{.Os}} {{json .Config.Volumes}}",
      bunImage,
    ],
    12_000,
  );
  if (!succeeded(image))
    return unavailable("PROJECT_PILOT_TEST_IMAGE_REQUIRED");
  const match = /^(?:sha256:)?([0-9a-f]{64})\s+linux\s+(?:null|\{\})$/i.exec(
    image.stdout.text.trim(),
  );
  if (!match?.[1]) return unavailable("PROJECT_PILOT_TEST_IMAGE_REQUIRED");
  return `sha256:${match[1]}`;
}

function readOnlyMount(source: string | null, destination: string) {
  if (!source || /[\r\n\0",]/.test(source))
    return unavailable("PROJECT_PILOT_INVALID_TEST_MOUNT");
  return `type=bind,source=${source},target=${destination},readonly`;
}

export async function runProjectContainer(
  runner: ProjectContainerRunner,
  image: string,
  name: string,
  source: string,
  config: string,
  testPaths: string[],
) {
  const mounts = [
    "--mount",
    readOnlyMount(await runner.mountPath(source), "/workspace"),
    "--mount",
    readOnlyMount(await runner.mountPath(config), "/openbot-runner.toml"),
  ];
  const testArgs = [
    "--no-env-file",
    "--no-install",
    "--config=/openbot-runner.toml",
    "test",
    "--timeout=10000",
    ...testPaths.map((path) => `./${path}`),
  ];
  const flags = [
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--read-only",
    "--ipc=none",
    "--pids-limit=64",
    "--cpus=1",
    "--memory=384m",
    "--memory-swap=384m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/usr/local/bin/bun",
  ];
  if (runner.kind === "podman")
    flags.push(
      "--http-proxy=false",
      "--read-only-tmpfs=false",
      "--unsetenv-all",
    );
  flags.push(
    "--env",
    "HOME=/tmp",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    "XDG_CACHE_HOME=/tmp",
    ...mounts,
  );
  let result: ProjectProcessResult;
  try {
    result = await runner.run(
      ["run", ...flags, image, ...testArgs],
      45_000,
      16_384,
    );
  } finally {
    // If the CLI was killed, the engine may still be executing the container.
    await runner
      .run(["container", "rm", "--force", name], 8_000)
      .catch(() => undefined);
  }
  return { result, command: ["bun", ...testArgs] };
}
