import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const bunVersion = "1.4.3";
const executableName = "OpenBotLocal.exe";
const scratchPrefix = "openbot-exe-smoke-";
const portLine =
  /^OpenBot local API listening on (http:\/\/127\.0\.0\.1:[1-9]\d{0,4})$/m;

type ReleaseFile = { file: string; bytes: number; sha256: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReleaseFile(value: unknown): value is ReleaseFile {
  return (
    record(value) &&
    typeof value.file === "string" &&
    value.file
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && !part.endsWith("."),
      ) &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}

async function releaseFiles(root: string, directory = root): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isDirectory()) paths.push(...(await releaseFiles(root, path)));
    else if (stat.isFile())
      paths.push(relative(root, path).replaceAll(sep, "/"));
    else
      throw new Error("The executable package contains a non-regular entry.");
  }
  return paths;
}

async function verifyPackage(root: string, originalManifest?: string) {
  const names = await releaseFiles(root);
  const manifestText = await readFile(join(root, "manifest.json"), "utf8");
  if (originalManifest !== undefined && manifestText !== originalManifest)
    throw new Error("The manifest changed during ZIP relocation.");
  const manifest: unknown = JSON.parse(manifestText);
  if (
    !record(manifest) ||
    manifest.platform !== "win32-x64" ||
    manifest.bun !== bunVersion ||
    manifest.entrypoint !== executableName ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every(validReleaseFile)
  ) {
    throw new Error(
      "The package manifest does not identify a valid Windows x64 build.",
    );
  }

  const files = new Map<string, ReleaseFile>();
  for (const file of manifest.files) {
    const key = file.file.toLowerCase();
    if (key === "manifest.json" || files.has(key))
      throw new Error(
        "The package manifest contains a duplicate or reserved name.",
      );
    files.set(key, file);
  }
  for (const required of [
    executableName,
    "OpenBot-Profile.cmd",
    "LICENSE",
    "resources/playwright-core/index.js",
  ]) {
    if (!files.has(required.toLowerCase()))
      throw new Error(`The package is missing ${required}.`);
  }
  const declared = [
    ...manifest.files.map(({ file }) => file),
    "manifest.json",
  ].sort();
  if (names.sort().join("\n") !== declared.join("\n"))
    throw new Error(
      "The manifest does not match the executable package contents.",
    );

  for (const { file, bytes, sha256 } of files.values()) {
    const path = join(root, file);
    if ((await lstat(path)).size !== bytes)
      throw new Error(
        `The package size does not match the manifest for ${file}.`,
      );
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
    if (hash.digest("hex") !== sha256)
      throw new Error(
        `The SHA-256 digest does not match the manifest for ${file}.`,
      );
  }
  return manifestText;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function isolatedEnvironment(root: string) {
  const profile = join(root, "profile");
  const home = join(root, "home");
  const temp = join(root, "temp");
  const cwd = join(root, "working directory");
  const local = join(home, "AppData", "Local");
  const roaming = join(home, "AppData", "Roaming");
  await Promise.all(
    [profile, temp, cwd, local, roaming].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const windows = await realpath(process.env.SystemRoot ?? "C:\\Windows");
  const system32 = join(windows, "System32");
  const token = randomBytes(32).toString("base64url");
  const drive = parse(home).root.slice(0, 2);

  const system = Object.fromEntries(
    [
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "SystemDrive",
      "OS",
      "PROCESSOR_ARCHITECTURE",
      "PATHEXT",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  return {
    cwd,
    token,
    tar: join(system32, "tar.exe"),
    env: {
      ...system,
      SystemRoot: windows,
      WINDIR: windows,
      ComSpec: join(system32, "cmd.exe"),
      PATH: `${system32};${windows}`,
      USERPROFILE: home,
      HOME: home,
      HOMEDRIVE: drive,
      HOMEPATH: home.slice(drive.length),
      LOCALAPPDATA: local,
      APPDATA: roaming,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      OPENBOT_LOCAL_PORT: "0",
      OPENBOT_LOCAL_DATA_DIR: profile,
      OPENBOT_LOCAL_TOKEN: token,
    },
  };
}

async function archiveCommand(
  cmd: string[],
  options: Awaited<ReturnType<typeof isolatedEnvironment>>,
) {
  const child = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    if ((await withTimeout(child.exited, 90_000, "ZIP command")) !== 0)
      throw new Error("The ZIP command did not finish successfully.");
  } finally {
    if (!child.killed && child.exitCode === null) {
      child.kill();
      await withTimeout(child.exited, 10_000, "ZIP command shutdown");
    }
  }
}

function listeningOrigin(stdout: ReadableStream<Uint8Array>) {
  const {
    promise,
    resolve: listening,
    reject,
  } = Promise.withResolvers<string>();
  void (async () => {
    const decoder = new TextDecoder();
    let tail = "";
    let origin: string | undefined;
    for await (const bytes of stdout) {
      tail = (tail + decoder.decode(bytes, { stream: true })).slice(-4096);
      if (!origin) {
        origin = portLine.exec(tail)?.[1];
        if (origin) listening(new URL(origin).origin);
      }
    }
    if (!origin)
      reject(new Error("OpenBot exited before announcing its loopback port."));
  })().catch(reject);
  return promise;
}

async function verifyFrontend(
  origin: string,
  env: Record<string, string | undefined>,
) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    timeout: 20_000,
    env,
    args: ["--disable-background-networking"],
  });
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const document = await page.goto(origin, {
      waitUntil: "load",
      timeout: 15_000,
    });
    if (!document?.ok() || (await page.title()) !== "OpenBot Local")
      throw new Error(
        "The relocated executable did not serve the embedded page.",
      );
    await page
      .getByLabel("Token local", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    const assets = await Promise.all([
      page
        .locator('script[type="module"][src^="/assets/"]')
        .first()
        .getAttribute("src", { timeout: 5_000 }),
      page
        .locator('link[rel="stylesheet"][href^="/assets/"]')
        .first()
        .getAttribute("href", { timeout: 5_000 }),
    ]);
    const mediaTypes = [
      /^(?:text|application)\/javascript\b/i,
      /^text\/css\b/i,
    ];
    await Promise.all(
      assets.map(async (asset, index) => {
        if (!asset || !/^\/assets\/[A-Za-z0-9_.-]+$/.test(asset))
          throw new Error("The embedded frontend is missing a local asset.");
        const response = await fetch(new URL(asset, origin), {
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (
          !response.ok ||
          !mediaTypes[index]?.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !(await response.arrayBuffer()).byteLength
        )
          throw new Error("A bundled frontend asset is missing or invalid.");
      }),
    );
  } finally {
    await withTimeout(browser.close(), 12_000, "Edge shutdown");
  }
}

async function verifyExport(origin: string, token: string) {
  const books = `${origin}/api/local/studio/books`;
  const unauthenticated = await fetch(books, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (unauthenticated.status !== 401)
    throw new Error(
      "The relocated executable did not protect the local studio.",
    );

  const authorization = `Bearer ${token}`;
  const created = await fetch(books, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Edição de teste",
      author: "Teste local",
      coverTheme: "azul",
      chapters: [
        {
          title: "Capítulo de teste",
          text: "Conteúdo sintético para validar a exportação local.",
        },
      ],
    }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (created.status !== 201)
    throw new Error(
      `The local studio rejected the fixture (${created.status}).`,
    );
  const payload: unknown = await created.json();
  if (
    !record(payload) ||
    !record(payload.book) ||
    typeof payload.book.id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(payload.book.id)
  )
    throw new Error("The local studio returned an invalid book identifier.");
  const response = await fetch(`${books}/${payload.book.id}/export/cover`, {
    headers: { authorization },
    redirect: "error",
    signal: AbortSignal.timeout(38_000),
  });
  if (!response.ok || response.headers.get("content-type") !== "image/png")
    throw new Error(`The Edge cover export failed (${response.status}).`);
  const png = Buffer.from(await response.arrayBuffer());
  if (
    png.length < 24 ||
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    png.readUInt32BE(16) !== 780 ||
    png.readUInt32BE(20) !== 1170
  )
    throw new Error("The Edge export returned an invalid studio cover.");
}

async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    Bun.version !== bunVersion
  )
    throw new Error(
      `Run the executable smoke test on Windows x64 with Bun ${bunVersion}.`,
    );
  const [packagePath = ".openbot/openbot-windows-x64", ...extra] =
    process.argv.slice(2);
  if (extra.length)
    throw new Error(
      "Usage: bun --no-env-file scripts/test-openbot-exe.ts [package-directory]",
    );
  const source = await realpath(resolve(packagePath));
  const manifest = await verifyPackage(source);
  const trustedTemp = await realpath(tmpdir());
  const scratch = await mkdtemp(join(trustedTemp, scratchPrefix));
  try {
    const options = await isolatedEnvironment(scratch);
    const zip = join(scratch, "portable.zip");
    const relocated = join(scratch, "relocated package");
    await mkdir(relocated);
    await archiveCommand(
      [
        options.tar,
        "-a",
        "-cf",
        zip,
        "--options",
        "zip:compression=store",
        "-C",
        source,
        ".",
      ],
      options,
    );
    await archiveCommand([options.tar, "-xf", zip, "-C", relocated], options);
    await verifyPackage(relocated, manifest);

    const child = Bun.spawn([join(relocated, executableName)], {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const origin = await withTimeout(
        listeningOrigin(child.stdout),
        25_000,
        "OpenBot startup",
      );
      await verifyFrontend(origin, options.env);
      await verifyExport(origin, options.token);
    } finally {
      if (child.exitCode === null) child.kill();
      await withTimeout(child.exited, 10_000, "OpenBot shutdown");
    }
    console.log(
      "Windows executable smoke passed: SHA-256, ZIP relocation, embedded frontend, protected studio, and Edge PNG export.",
    );
  } finally {
    if (
      dirname(scratch) !== trustedTemp ||
      !parse(scratch).base.startsWith(scratchPrefix) ||
      (await realpath(scratch)) !== scratch
    )
      console.warn(
        "The smoke directory no longer resolves to the isolated path and was retained.",
      );
    else await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

await main();
