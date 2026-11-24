import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CrashPoint,
  CrashProbe,
  RecoveryKind,
  ResumeProbe,
} from "./fixtures/bot-recovery-worker";

const fixture = fileURLToPath(
  new URL("./fixtures/bot-recovery-worker.ts", import.meta.url),
);
const scratchPrefix = "openbot-bot-recovery-";

function withTimeout<T>(
  value: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([value, deadline]).finally(() => clearTimeout(timer));
}

function worker(
  directory: string,
  kind: RecoveryKind,
  mode: CrashPoint | "resume",
  id?: string,
) {
  const system = Object.fromEntries(
    [
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATH",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
    ].flatMap((key) => {
      const value = process.env[key];
      return value ? [[key, value]] : [];
    }),
  );
  const temp = join(directory, "renderer-temp");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fixture,
      directory,
      kind,
      mode,
      ...(id ? [id] : []),
    ],
    {
      cwd: directory,
      env: {
        ...system,
        HOME: directory,
        USERPROFILE: directory,
        LOCALAPPDATA: directory,
        APPDATA: directory,
        TEMP: temp,
        TMP: temp,
        TMPDIR: temp,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { child, stderr: new Response(child.stderr).text() };
}

function firstLine<T>(stdout: ReadableStream<Uint8Array>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  void (async () => {
    const decoder = new TextDecoder();
    let line = "";
    let reported = false;
    for await (const data of stdout) {
      if (reported) continue;
      line += decoder.decode(data, { stream: true });
      const newline = line.indexOf("\n");
      if (newline >= 0) {
        resolve(JSON.parse(line.slice(0, newline)) as T);
        reported = true;
      }
    }
    if (!reported)
      reject(new Error("Fixture exited without reporting a checkpoint."));
  })().catch(reject);
  return promise;
}

async function terminate(child: ReturnType<typeof worker>["child"]) {
  if (child.exitCode === null) child.kill("SIGKILL");
  return withTimeout(child.exited, 10_000, "Fixture worker did not terminate.");
}

async function removeTree(directory: string, root: string) {
  if (
    (directory !== root && !directory.startsWith(`${root}${sep}`)) ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error("Unexpected recovery test cleanup path.");
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeTree(path, root);
    else await unlink(path);
  }
  await rmdir(directory);
}

const cases = [
  ["epub", "started"],
  ["epub", "stored"],
  ["pdf", "started"],
  ["pdf", "stored"],
  ["sales", "started"],
  ["sales", "stored"],
] as const satisfies readonly (readonly [RecoveryKind, CrashPoint])[];

test.each(cases)(
  "recovers %s after killing a worker at the %s boundary",
  async (kind, point) => {
    const temp = await realpath(tmpdir());
    const directory = await mkdtemp(join(temp, scratchPrefix));
    let original: ReturnType<typeof worker> | undefined;
    let restarted: ReturnType<typeof worker> | undefined;
    try {
      await mkdir(join(directory, "renderer-temp"));
      original = worker(directory, kind, point);
      const interrupted = await withTimeout(
        firstLine<CrashProbe>(original.child.stdout),
        35_000,
        "Fixture did not reach the selected interruption point.",
      );
      expect(interrupted.job).toMatchObject({
        status: "running",
        currentStage: kind,
        outputs: { prepared: { revision: 1 } },
      });
      expect(interrupted.job.outputs[kind]).toBeUndefined();
      expect(interrupted.writes).toBe(point === "stored" ? 1 : 0);
      if (point === "stored")
        expect(interrupted.storedSha256).toMatch(/^[a-f0-9]{64}$/);
      else expect(interrupted.storedSha256).toBeNull();
      expect(original.child.exitCode).toBeNull();
      expect(await terminate(original.child)).not.toBe(0);

      restarted = worker(directory, kind, "resume", interrupted.job.id);
      const output = firstLine<ResumeProbe>(restarted.child.stdout);
      const [finished, exit] = await withTimeout(
        Promise.all([output, restarted.child.exited]),
        35_000,
        "Recovery worker did not finish.",
      );
      expect(exit).toBe(0);
      expect(finished.job).toMatchObject({
        id: interrupted.job.id,
        status: "completed",
        currentStage: null,
      });
      expect(finished.job.outputs.prepared).toEqual({ revision: 1 });
      expect(finished.job.outputs[kind]).toMatchObject({
        artifact: kind,
        sha256: finished.digest,
      });
      expect(finished.artifacts).toHaveLength(1);
      expect(finished.artifacts[0]).toMatchObject({
        kind,
        sha256: finished.digest,
      });
      expect(finished.writes).toBe(point === "stored" ? 0 : 1);
      if (point === "stored")
        expect(finished.digest).toBe(interrupted.storedSha256!);

      const relevant = finished.events.filter(({ stage }) => stage === kind);
      expect(
        relevant.filter(({ type }) => type === "stage_started"),
      ).toHaveLength(2);
      expect(relevant.filter(({ type }) => type === "retry_scheduled")).toEqual(
        [expect.objectContaining({ detail: "BOT_STAGE_INTERRUPTED" })],
      );
      expect(
        relevant.filter(({ type }) => type === "stage_completed"),
      ).toHaveLength(1);
      expect(
        finished.events.filter(
          ({ type, stage }) =>
            type === "stage_completed" && stage === "prepared",
        ),
      ).toHaveLength(1);

      if (kind === "epub") {
        expect(finished.contentType).toBe("application/epub+zip");
        expect(finished.signature).toStartWith("504b0304");
      } else if (kind === "pdf") {
        expect(finished.contentType).toBe("application/pdf");
        expect(finished.signature).toBe("255044462d");
      } else {
        expect(finished.contentType).toBe("application/json");
        expect(finished.report).toMatchObject({
          report: { summary: { purchases: 1, refunds: 0, netCents: 1250 } },
        });
      }
    } catch (error) {
      for (const process of [original, restarted]) {
        if (!process) continue;
        await terminate(process.child);
        const message = await process.stderr;
        if (message.trim()) console.error(message.trim());
      }
      throw error;
    } finally {
      if (
        dirname(directory) === temp &&
        basename(directory).startsWith(scratchPrefix)
      )
        await removeTree(directory, directory);
    }
  },
  85_000,
);
