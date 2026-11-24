import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { openCodeGo } from "./opencode";
import { createProjectPilot } from "./project-pilot";
import type { ProjectContainerRunner } from "./project-pilot-container";

const gitPath = Bun.which(process.platform === "win32" ? "git.exe" : "git");
const route = "/api/local/project-pilots";
const source = "export const value = 1;\n";
const dirty = "export const value = 99;\n";
const update = {
  edits: [{ path: "value.ts", find: "value = 1", replace: "value = 2" }],
};

function model(output: object) {
  const frame = JSON.stringify({
    choices: [
      { delta: { content: JSON.stringify(output) }, finish_reason: "stop" },
    ],
  });
  return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function post(path: string, body: object) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setup(
  complete: ReturnType<typeof openCodeGo>,
  containerRunner?: ProjectContainerRunner,
) {
  if (!gitPath) throw new Error("Git is required");
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "openbot-project-pilot-")),
  );
  const repo = join(root, "source checkout");
  const storage = join(root, "storage");
  mkdirSync(repo);
  function git(...args: string[]) {
    const result = Bun.spawnSync([gitPath as string, ...args], { cwd: repo });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  git("init", "--quiet", "--template=");
  writeFileSync(join(repo, "value.ts"), source);
  writeFileSync(
    join(repo, "value.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'import { value } from "./value";',
      'test("updated without host or dotenv secrets", () => {',
      "  expect(value).toBe(2);",
      "  expect(process.env.OPENBOT_PILOT_TEST_SECRET).toBeUndefined();",
      "  expect(process.env.PILOT_DOTENV_SECRET).toBeUndefined();",
      "});",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "unselected.test.ts"),
    'import { test } from "bun:test"; test("fail when unintentionally run", () => { throw new Error("unselected"); });\n',
  );
  writeFileSync(
    join(repo, "bunfig.toml"),
    '[test]\npreload = ["./malicious-preload.ts"]\n',
  );
  writeFileSync(
    join(repo, "malicious-preload.ts"),
    'throw new Error("avoid project-defined preload");\n',
  );
  writeFileSync(join(repo, ".env"), "PILOT_DOTENV_SECRET=fixture\n");
  git("add", ".");
  git(
    "-c",
    "user.name=OpenBot Test",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Add fixture",
  );
  const revision = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "value.ts"), dirty);
  const backend = createProjectPilot({
    directory: storage,
    gitPath,
    complete,
    containerRunner,
  });
  return {
    repo,
    revision,
    backend,
    git,
    close() {
      backend.close();
      if (
        realpathSync(root) === root &&
        lstatSync(root).isDirectory() &&
        root.startsWith(join(realpathSync(tmpdir()), "openbot-project-pilot-"))
      ) {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function containerResult(text: string, exitCode = 0) {
  return {
    exitCode,
    stdout: { text, truncated: false },
    stderr: { text: "", truncated: false },
    timedOut: false,
  };
}

function isolatedFixtureRunner() {
  const calls: string[][] = [];
  let imageAvailable = true;
  const runner: ProjectContainerRunner = {
    kind: "podman",
    async mountPath(path) {
      return path;
    },
    async run(args) {
      calls.push(args);
      if (args[0] === "info") return containerResult("linux\n");
      if (args[0] === "image")
        return imageAvailable
          ? containerResult(`sha256:${"a".repeat(64)} linux null\n`)
          : containerResult("", 125);
      if (args[0] === "run") {
        const mounts = args.filter((arg) => arg.startsWith("type=bind,"));
        expect(mounts).toHaveLength(2);
        expect(args).toEqual(
          expect.arrayContaining([
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--user=65534:65534",
            "--memory=384m",
            "--pids-limit=64",
            "--cpus=1",
            "--read-only",
            "--pull=never",
            "--http-proxy=false",
            "--no-env-file",
            "--no-install",
            "--config=/openbot-runner.toml",
            "./value.test.ts",
          ]),
        );
        expect(args).not.toContain("./unselected.test.ts");
        const bind = mounts[0]?.match(
          /^type=bind,source=(.+),target=\/workspace,readonly$/,
        )?.[1];
        if (!bind) throw new Error("Missing read-only code mount");
        expect(readFileSync(join(bind, "value.ts"), "utf8")).toBe(
          "export const value = 2;\n",
        );
        expect(existsSync(join(bind, ".git"))).toBe(false);
        expect(existsSync(join(bind, "untracked-fixture.ts"))).toBe(false);
        return containerResult("\n 1 pass\n 0 fail\n");
      }
      return containerResult("");
    },
  };
  return {
    calls,
    runner,
    removeImage: () => {
      imageAvailable = false;
    },
  };
}

test.skipIf(!gitPath)(
  "drafts from HEAD and supplies explicitly approved files to an isolated runner",
  async () => {
    const container = isolatedFixtureRunner();
    const fixture = setup(async (turn) => {
      expect(turn.tools).toBeUndefined();
      const supplied = JSON.parse(turn.messages.at(-1)?.content ?? "{}");
      expect(supplied.files).toEqual([{ path: "value.ts", text: source }]);
      return model(update);
    }, container.runner);
    try {
      const created = await fixture.backend.handle(
        post(route, {
          repoPath: fixture.repo,
          prompt: "Change value to 2.",
          paths: ["value.ts"],
        }),
        route,
      );
      expect(created?.status).toBe(201);
      if (!created) throw new Error("Missing creation response");
      const { pilot } = await created.json();
      writeFileSync(
        join(pilot.worktree, "untracked-fixture.ts"),
        "throw new Error('untracked');\n",
      );
      expect(pilot.baseCommit).toBe(fixture.revision);
      expect(pilot.status).toBe("review");
      expect(pilot.test).toBeNull();
      expect(pilot.patch).toContain("+export const value = 2;");
      expect(readFileSync(join(fixture.repo, "value.ts"), "utf8")).toBe(dirty);
      expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.revision);
      expect(fixture.git("worktree", "list").split("\n")).toHaveLength(1);
      const testPath = `${route}/${pilot.id}/test`;
      const noConsent = await fixture.backend.handle(
        post(testPath, { paths: ["value.test.ts"] }),
        testPath,
      );
      expect(await noConsent?.json()).toEqual({
        error: "PROJECT_PILOT_TEST_CONFIRMATION_REQUIRED",
      });
      expect(container.calls).toHaveLength(0);
      const result = await fixture.backend.handle(
        post(testPath, { paths: ["value.test.ts"], confirmed: true }),
        testPath,
      );
      const tested = await result?.json();
      if (tested.pilot?.test?.status !== "passed")
        throw new Error(JSON.stringify(tested));
      expect(
        `${tested.pilot?.test?.stdout}\n${tested.pilot?.test?.stderr}`,
      ).toContain("1 pass");
      expect(tested.pilot?.test?.status).toBe("passed");
      expect(container.calls.map(([action]) => action)).toEqual([
        "info",
        "image",
        "run",
        "container",
      ]);
      expect(tested.pilot?.patch).toBe(pilot.patch);
      container.removeImage();
      const noImage = await fixture.backend.handle(
        post(testPath, { paths: ["value.test.ts"], confirmed: true }),
        testPath,
      );
      expect(noImage?.status).toBe(424);
      expect(await noImage?.json()).toEqual({
        error: "PROJECT_PILOT_TEST_IMAGE_REQUIRED",
      });
      const reviewed = await fixture.backend.handle(
        new Request(`http://127.0.0.1${route}/${pilot.id}`),
        `${route}/${pilot.id}`,
      );
      expect((await reviewed?.json())?.pilot.test.status).toBe("passed");
      expect(readFileSync(join(fixture.repo, "value.ts"), "utf8")).toBe(dirty);
    } finally {
      fixture.close();
    }
  },
  45_000,
);

test.skipIf(!gitPath)(
  "rejects escape paths, hidden files and out-of-scope model changes",
  async () => {
    let completions = 0;
    const fixture = setup(async () => {
      completions += 1;
      return model({
        edits: [{ path: "malicious-preload.ts", find: "throw", replace: "//" }],
      });
    });
    try {
      for (const path of [
        "../value.ts",
        ".env",
        "a\\value.ts",
        "AUX.js",
        "value.ts::$DATA",
      ]) {
        const response = await fixture.backend.handle(
          post(route, {
            repoPath: fixture.repo,
            prompt: "Try this path.",
            paths: [path],
          }),
          route,
        );
        expect(response?.status).toBe(422);
      }
      expect(completions).toBe(0);
      const response = await fixture.backend.handle(
        post(route, {
          repoPath: fixture.repo,
          prompt: "Draft this edit.",
          paths: ["value.ts"],
        }),
        route,
      );
      expect(await response?.json()).toEqual({
        error: "PROJECT_PILOT_MODEL_OUTPUT_INVALID",
      });
      expect(completions).toBe(1);
      expect(readFileSync(join(fixture.repo, "value.ts"), "utf8")).toBe(dirty);
    } finally {
      fixture.close();
    }
  },
  45_000,
);
