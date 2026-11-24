import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Build the Windows x64 local package on a Windows x64 host.");
}

const root = resolve(import.meta.dir, "..");
const output = resolve(
  process.argv[2] ?? join(root, ".openbot", "local-windows"),
);
const app = join(root, "app", "dist-local");
await readFile(join(app, "local.html"));
await mkdir(dirname(output), { recursive: true });
await mkdir(output);

const bundled = await Bun.build({
  entrypoints: [
    join(root, "local-backend", "server.ts"),
    join(root, "local-backend", "profile-backup.ts"),
  ],
  target: "bun",
  external: ["playwright-core"],
  outdir: join(output, "local-backend"),
});
if (!bundled.success)
  throw new AggregateError(bundled.logs, "Local backend build failed");

const playwrightRoot = dirname(
  fileURLToPath(import.meta.resolve("playwright-core/package.json")),
);
await Promise.all([
  cp(app, join(output, "app", "dist-local"), { recursive: true }),
  cp(playwrightRoot, join(output, "node_modules", "playwright-core"), {
    recursive: true,
  }),
  copyFile(join(root, "LICENSE"), join(output, "LICENSE")),
  copyFile(process.execPath, join(output, "bun.exe")),
  writeFile(
    join(output, "OpenBot-Local.cmd"),
    [
      "@echo off",
      "setlocal",
      'pushd "%~dp0" || exit /b 1',
      '"bun.exe" "local-backend\\server.js"',
      "if errorlevel 1 pause",
      "popd",
      "",
    ].join("\r\n"),
  ),
]);
console.log(output);
