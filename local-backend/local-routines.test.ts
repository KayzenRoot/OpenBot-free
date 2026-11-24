import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRoutines } from "./local-routines";

type Store = ReturnType<typeof createLocalRoutines>;
type Runner = Parameters<typeof createLocalRoutines>[0]["run"];
type Routine = {
  id: string;
  title: string;
  prompt: string;
  timezone: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: string | null;
};

const collection = "/api/local/routines";
const start = Date.parse("2026-11-23T12:00:00Z");
const window = 15 * 60_000;

function testStore(
  run: Runner,
  options: { timeoutMs?: number; dbPath?: string } = {},
) {
  let clock = start;
  return {
    store: createLocalRoutines({
      dbPath: ":memory:",
      run,
      now: () => clock,
      ...options,
    }),
    time(offset: number) {
      clock = start + offset;
    },
  };
}

function at(offset: number) {
  return new Date(start + offset).toISOString();
}

async function call(store: Store, method: string, path = "", data?: object) {
  const url = collection + path;
  const response = await store.handle(
    new Request(`http://127.0.0.1${url}`, {
      method,
      ...(data
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          }
        : {}),
    }),
    new URL(`http://127.0.0.1${url}`).pathname,
  );
  if (!response) throw new Error("Missing routine route");
  return response;
}

async function create(store: Store, input?: Partial<Routine>) {
  const response = await call(store, "POST", "", {
    title: "Morning summary",
    prompt: "Summarize notes",
    intervalMinutes: 15,
    ...input,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { routine: Routine }).routine;
}

async function history(store: Store, id: string) {
  const response = await call(store, "GET", `/${id}/runs`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { runs: object[] }).runs;
}

test("validates inputs and schedules only after explicit enablement", async () => {
  const { store, time } = testStore(async () => "Summary");
  try {
    for (const invalid of [
      { intervalMinutes: 14 },
      { intervalMinutes: 15.5 },
      { timezone: "Invalid/Zone" },
      { enabled: "true" },
    ]) {
      const response = await call(store, "POST", "", {
        title: "Routine",
        prompt: "Prompt",
        intervalMinutes: 15,
        ...invalid,
      });
      expect(response.status).toBe(400);
    }
    const routine = await create(store, { timezone: "America/Sao_Paulo" });
    expect(routine).toMatchObject({
      enabled: false,
      nextRunAt: null,
      timezone: "America/Sao_Paulo",
    });
    time(window);
    await store.tick();
    expect(await history(store, routine.id)).toEqual([]);

    const enabled = await call(store, "PATCH", `/${routine.id}`, {
      enabled: true,
    });
    expect(await enabled.json()).toMatchObject({
      routine: {
        enabled: true,
        nextRunAt: at(2 * window),
        timezone: "America/Sao_Paulo",
      },
    });
    const renamed = await call(store, "PATCH", `/${routine.id}`, {
      title: "Updated",
      timezone: "Asia/Tokyo",
    });
    expect(await renamed.json()).toMatchObject({
      routine: {
        title: "Updated",
        nextRunAt: at(2 * window),
        timezone: "Asia/Tokyo",
      },
    });

    const intervalChanged = await call(store, "PATCH", `/${routine.id}`, {
      intervalMinutes: 30,
    });
    expect(await intervalChanged.json()).toMatchObject({
      routine: { nextRunAt: at(3 * window), intervalMinutes: 30 },
    });
    expect(await (await call(store, "GET")).json()).toMatchObject({
      routines: [{ id: routine.id }],
    });
    expect((await call(store, "DELETE", `/${routine.id}`)).status).toBe(204);
    expect((await call(store, "GET", `/${routine.id}`)).status).toBe(404);
  } finally {
    await store.close();
  }
});

test("claims a due window once under concurrent ticks and coalesces missed windows", async () => {
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<string>();
  const prompts: string[] = [];
  const { store, time } = testStore(async ({ prompt }) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      started.resolve();
      return finished.promise;
    }
    return "Later result";
  });
  try {
    const routine = await create(store, { enabled: true });
    await store.tick();
    expect(prompts).toEqual([]);
    time(window);
    const firstTick = store.tick();
    await started.promise;
    await store.tick();
    expect(await history(store, routine.id)).toMatchObject([
      {
        status: "running",
        scheduledAt: at(window),
        finishedAt: null,
      },
    ]);

    finished.resolve("First result");
    await firstTick;
    await store.tick();
    expect(prompts).toEqual(["Summarize notes"]);

    time(4 * window + 20_000);
    await Promise.all([store.tick(), store.tick()]);
    expect(prompts).toEqual(["Summarize notes", "Summarize notes"]);
    expect(await history(store, routine.id)).toMatchObject([
      {
        status: "completed",
        answer: "Later result",
        scheduledAt: at(4 * window),
      },
      { status: "completed", answer: "First result", scheduledAt: at(window) },
    ]);
    expect(
      await (await call(store, "GET", `/${routine.id}`)).json(),
    ).toMatchObject({
      routine: { nextRunAt: at(5 * window) },
    });
  } finally {
    finished.resolve("Cleanup");
    await store.close();
  }
});

test("records run failures and aborts an active run when disabled", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  let executions = 0;
  const { store, time } = testStore(async ({ signal }) => {
    executions += 1;
    if (executions === 1) throw new Error("Private provider details");
    started.resolve(signal);
    return new Promise<string>(() => {});
  });
  try {
    const routine = await create(store, { enabled: true });
    time(window);
    await store.tick();
    expect(await history(store, routine.id)).toMatchObject([
      { status: "failed", answer: null, error: "ROUTINE_RUN_FAILED" },
    ]);

    time(2 * window);
    const tick = store.tick();
    const signal = await started.promise;
    expect(
      (await call(store, "PATCH", `/${routine.id}`, { enabled: false })).status,
    ).toBe(200);
    await tick;
    expect(signal.aborted).toBe(true);
    expect(await history(store, routine.id)).toMatchObject([
      { status: "cancelled", answer: null, error: "ROUTINE_DISABLED" },
      { status: "failed", error: "ROUTINE_RUN_FAILED" },
    ]);
    time(5 * window);
    await store.tick();
    expect(executions).toBe(2);
  } finally {
    await store.close();
  }
});

test("enforces the runner deadline even when the runner never settles", async () => {
  const { store, time } = testStore(() => new Promise<string>(() => {}), {
    timeoutMs: 10,
  });
  try {
    const routine = await create(store, { enabled: true });
    time(window);
    await store.tick();
    expect(await history(store, routine.id)).toMatchObject([
      { status: "failed", answer: null, error: "ROUTINE_RUN_TIMEOUT" },
    ]);
  } finally {
    await store.close();
  }
});

test("recovers an interrupted claim on restart without replaying its scheduled window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-routines-"));
  const dbPath = join(directory, "routines.sqlite");
  try {
    const { store: first } = testStore(async () => "Unexpected run", {
      dbPath,
    });
    let routine: Routine;
    try {
      routine = await create(first, { enabled: true });
    } finally {
      await first.close();
    }

    // Simulate the durable state committed before an abrupt process exit.
    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        db.run("UPDATE local_routines SET next_run_at = ? WHERE id = ?", [
          start + 2 * window,
          routine.id,
        ]);
        db.run(
          `INSERT INTO local_routine_runs (id, routine_id, scheduled_at, started_at, status)
          VALUES (?, ?, ?, ?, 'running')`,
          ["previous", routine.id, start + window, start + window],
        );
      }).immediate();
    } finally {
      db.close();
    }

    let executions = 0;
    let clock = start + window + 10;
    const resumed = createLocalRoutines({
      dbPath,
      now: () => clock,
      run: async () => {
        executions += 1;
        return "Recovered";
      },
    });
    try {
      expect(await history(resumed, routine.id)).toMatchObject([
        {
          id: "previous",
          status: "interrupted",
          error: "ROUTINE_RESTARTED",
          finishedAt: at(window + 10),
        },
      ]);
      await resumed.tick();
      expect(executions).toBe(0);
      clock = start + 2 * window;
      await resumed.tick();
      expect(executions).toBe(1);
      expect(await history(resumed, routine.id)).toMatchObject([
        {
          status: "completed",
          answer: "Recovered",
          scheduledAt: at(2 * window),
        },
        { id: "previous", status: "interrupted" },
      ]);
    } finally {
      await resumed.close();
    }
  } finally {
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      rmSync(file, { force: true });
    }
    rmdirSync(directory);
  }
});
