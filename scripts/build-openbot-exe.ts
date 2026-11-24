import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";

const bunVersion = "1.4.3";
if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  Bun.version !== bunVersion
) {
  throw new Error(`Build OpenBot on Windows x64 with Bun ${bunVersion}.`);
}

const [destination, ...extra] = process.argv.slice(2);
if (extra.length)
  throw new Error(
    "Usage: bun scripts/build-openbot-exe.ts [new-output-directory]",
  );

const root = resolve(import.meta.dir, "..");
const output = resolve(
  destination ?? join(root, ".openbot", "openbot-windows-x64"),
);
const frontend = join(root, "app", "dist-local");
const executable = join(output, "OpenBotLocal.exe");
const resources = join(output, "resources");
const playwright = dirname(
  fileURLToPath(import.meta.resolve("playwright-core/package.json")),
);

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Non-regular release entry: ${path}`);
  }
  return files.sort();
}

const localPage = join(frontend, "local.html");
if (!(await lstat(localPage)).isFile())
  throw new Error("Run bun run local:build before compiling the executable.");
const assets = (await regularFiles(join(frontend, "assets"))).map((path) =>
  relative(frontend, path).replaceAll("\\", "/"),
);
if (
  assets.length === 0 ||
  !assets.every((name) => /^assets\/[A-Za-z0-9_.-]+$/.test(name))
) {
  throw new Error(
    "The embedded frontend has no assets or has paths unsupported by the local server.",
  );
}
const names = ["local.html", ...assets];
const uiImports = names.map((name, index) => {
  if (!mime.has(extname(name)))
    throw new Error(`Unsupported frontend asset type: ${name}`);
  return `import asset${index} from ${JSON.stringify(`./app/dist-local/${name}`)} with { type: "file" };`;
});
const uiTable = names.map(
  (name, index) =>
    `[${JSON.stringify(name)}, [asset${index}, ${JSON.stringify(mime.get(extname(name)))}]]`,
);
let embeddedUi = false;
const embedded: BunPlugin = {
  name: "openbot-release-assets",
  setup(build) {
    build.onResolve({ filter: /^\.\/exe-static$/ }, () => ({
      path: "ui",
      namespace: "openbot-exe",
    }));
    build.onResolve({ filter: /^playwright-core$/ }, () => ({
      path: "playwright",
      namespace: "openbot-exe",
    }));
    build.onLoad({ filter: /^ui$/, namespace: "openbot-exe" }, () => {
      embeddedUi = true;
      return {
        contents: `${uiImports.join("\n")}\nconst assets = new Map([${uiTable.join(",")}]);\nexport function executableAsset(name) {\n const entry = assets.get(name);\n return entry && Bun.file(entry[0], {type: entry[1]});\n}`,
        loader: "js",
        resolveDir: root,
      };
    });
    build.onLoad({ filter: /^playwright$/, namespace: "openbot-exe" }, () => ({
      contents: `import { createRequire } from "node:module";\nimport { dirname, join } from "node:path";\nconst require = createRequire(process.execPath);\nconst sidecar = join(dirname(process.execPath), "resources", "playwright-core", "index.js");\nexport const { chromium } = require(sidecar);\n`,
      loader: "js",
      resolveDir: root,
    }));
  },
};

const manifestSource = (await Bun.file(join(root, "package.json")).json()) as {
  version?: string;
};
const releaseVersion = manifestSource.version;
if (!releaseVersion || !/^\d+\.\d+\.\d+$/.test(releaseVersion))
  throw new Error("The package version must use major.minor.patch.");

await mkdir(dirname(output), { recursive: true });
await mkdir(output);
await mkdir(resources);

const compiled = await Bun.build({
  entrypoints: [join(root, "local-backend", "executable-entry.ts")],
  target: "bun",
  compile: {
    outfile: executable,
    target: "bun-windows-x64",
    autoloadDotenv: false,
    autoloadBunfig: false,
    windows: {
      title: "OpenBot Local",
      version: releaseVersion,
      description: "OpenBot Local para Windows",
    },
  },
  plugins: [embedded],
});
if (!compiled.success || !(await Bun.file(executable).exists())) {
  throw new AggregateError(compiled.logs, "Windows executable build failed");
}
if (!embeddedUi)
  throw new Error(
    "The server does not import the embedded frontend. No release manifest was created.",
  );

await Promise.all([
  cp(await realpath(playwright), join(resources, "playwright-core"), {
    recursive: true,
    dereference: true,
  }),
  copyFile(join(root, "LICENSE"), join(output, "LICENSE")),
  writeFile(
    join(output, "OpenBot-Profile.cmd"),
    ["@echo off", "setlocal", '"%~dp0OpenBotLocal.exe" profile %*', ""].join(
      "\r\n",
    ),
  ),
]);

const windowsPowerShell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const signatureScript =
  "(Get-AuthenticodeSignature -LiteralPath $env:OPENBOT_EXE_VERIFY_PATH).Status.ToString()";
const signature = Bun.spawnSync({
  cmd: [
    windowsPowerShell,
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(signatureScript, "utf16le").toString("base64"),
  ],
  env: { ...process.env, OPENBOT_EXE_VERIFY_PATH: executable },
  stdout: "pipe",
  stderr: "pipe",
});
async function signatureFallback() {
  const pe = Buffer.from(
    await Bun.file(executable).slice(0, 4096).arrayBuffer(),
  );
  if (pe.length < 64 || pe.readUInt16LE(0) !== 0x5a4d) return "Unavailable";
  const header = pe.readUInt32LE(0x3c);
  const optional = header + 24;
  if (optional + 152 > pe.length || pe.readUInt32LE(header) !== 0x4550)
    return "Unavailable";
  if (
    pe.readUInt16LE(optional) !== 0x20b ||
    pe.readUInt32LE(optional + 108) < 5
  )
    return "Unavailable";
  const certificate = optional + 112 + 4 * 8;
  return pe.readUInt32LE(certificate) === 0 &&
    pe.readUInt32LE(certificate + 4) === 0
    ? "NotSigned"
    : "Unavailable";
}
const verifiedSignature =
  signature.exitCode === 0 ? signature.stdout.toString().trim() : "";
const signatureStatus = verifiedSignature || (await signatureFallback());

const files = [];
for (const path of await regularFiles(output)) {
  const bytes = await readFile(path);
  files.push({
    file: relative(output, path).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  join(output, "manifest.json"),
  `${JSON.stringify(
    {
      name: "OpenBot Local",
      version: releaseVersion,
      platform: "win32-x64",
      bun: bunVersion,
      entrypoint: "OpenBotLocal.exe",
      authenticode: signatureStatus,
      files,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);

console.log(output);
console.log(`Authenticode: ${signatureStatus}`);
