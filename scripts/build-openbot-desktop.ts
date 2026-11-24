import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const [version, ...extra] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || extra.length) {
  throw new Error("Usage: bun run local:desktop <major.minor.patch>");
}
if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  Bun.version !== "1.4.3"
) {
  throw new Error("Build OpenBot on Windows x64 with Bun 1.4.3.");
}

const dotnetOption =
  process.env.OPENBOT_DOTNET_EXECUTABLE || Bun.which("dotnet.exe");
const tar = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "tar.exe",
);
if (!dotnetOption || !(await Bun.file(tar).exists()))
  throw new Error("Install the .NET 8 SDK and Windows tar.exe.");
const dotnet = await realpath(dotnetOption);

const root = resolve(import.meta.dir, "..");
const work = join(root, ".openbot");
await mkdir(work, { recursive: true });
const stage = await mkdtemp(join(work, `desktop-${version}-`));
const payload = join(stage, "payload");
const zip = join(stage, "payload.zip");
const setup = join(stage, "setup");

async function run(cmd: string[]) {
  const child = Bun.spawn({
    cmd,
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error(`Build step failed: ${cmd.slice(0, 3).join(" ")}`);
}

function publish(project: string, output: string, properties: string[] = []) {
  return run([
    dotnet,
    "publish",
    join(root, "windows-local", project),
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-warnaserror",
    "-o",
    output,
    "-p:DebugType=None",
    "-p:DebugSymbols=false",
    `-p:Version=${version}`,
    ...properties,
  ]);
}

const bun = process.execPath;
await run([bun, "--no-env-file", "scripts/generate-app-config.ts"]);
await run([bun, "--no-env-file", "run", "local:build"]);
await publish("Host/OpenBotFree.csproj", payload);
const notices = join(payload, "notices");
await mkdir(notices, { recursive: true });
await Promise.all([
  copyFile(
    join(dirname(dotnet), "LICENSE.txt"),
    join(notices, "dotnet-LICENSE.txt"),
  ),
  copyFile(
    join(dirname(dotnet), "ThirdPartyNotices.txt"),
    join(notices, "dotnet-ThirdPartyNotices.txt"),
  ),
]);
await run([
  bun,
  "--no-env-file",
  "scripts/build-openbot-exe.ts",
  join(payload, "runtime"),
]);
await run([
  tar,
  "-a",
  "-cf",
  zip,
  "-C",
  payload,
  ...(await readdir(payload)).sort(),
]);
await publish("Setup/OpenBotFreeSetup.csproj", setup, [
  "-p:PublishSingleFile=true",
  "-p:IncludeNativeLibrariesForSelfExtract=true",
  "-p:EnableCompressionInSingleFile=true",
  `-p:PayloadZip=${zip}`,
  `-p:AppVersion=${version}`,
]);

const filename = `OpenBot-free-Setup-${version}-x64.exe`;
const installer = join(stage, filename);
await copyFile(join(setup, "OpenBotFreeSetup.exe"), installer);
const hash = createHash("sha256");
for await (const chunk of Bun.file(installer).stream()) hash.update(chunk);
await writeFile(`${installer}.sha256`, `${hash.digest("hex")}  ${filename}\n`);
console.log(installer);
