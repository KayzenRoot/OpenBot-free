import { Database } from "bun:sqlite";

const MINUTE = 60_000;
export const MIN_ROUTINE_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 525_600;
const MAX_CONCURRENT_RUNS = 4;
const HISTORY_PAGE_SIZE = 100;

const collection = "/api/local/routines";
const routinePath =
  /^\/api\/local\/routines\/([a-zA-Z0-9_-]{1,128})(?:\/(runs))?$/;
const headers = { "cache-control": "private, no-store" };
const routineColumns = `id, title, prompt, timezone, enabled, interval_minutes AS intervalMinutes,
  next_run_at AS nextRunAt, created_at AS createdAt, updated_at AS updatedAt`;
const runColumns = `id, routine_id AS routineId, sequence, status, answer, error,
  scheduled_at AS scheduledAt, started_at AS startedAt, finished_at AS finishedAt`;

type RoutineInput = {
  title: string;
  prompt: string;
  timezone: string;
  enabled: boolean;
  intervalMinutes: number;
};

type RoutineRow = Omit<RoutineInput, "enabled"> & {
  id: string;
  enabled: 0 | 1;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

type RunRow = {
  id: string;
  routineId: string;
  sequence: number;
  status: RunStatus;
  answer: string | null;
  error: string | null;
  scheduledAt: number;
  startedAt: number;
  finishedAt: number | null;
};

type Runner = (input: {
  routineId: string;
  prompt: string;
  signal: AbortSignal;
}) => Promise<string>;

type Running = { controller: AbortController; task: Promise<void> };

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function routineView(row: RoutineRow) {
  return {
    ...row,
    enabled: row.enabled === 1,
    nextRunAt: row.nextRunAt === null ? null : iso(row.nextRunAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function runView({ sequence, ...row }: RunRow) {
  return {
    ...row,
    scheduledAt: iso(row.scheduledAt),
    startedAt: iso(row.startedAt),
    finishedAt: row.finishedAt === null ? null : iso(row.finishedAt),
  };
}

function json(value: object, status = 200) {
  return Response.json(value, { status, headers });
}

function problem(status: number, error: string) {
  return json({ error }, status);
}

async function readObject(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return problem(415, "JSON_REQUIRED");
  }
  const result: unknown = await request.json().catch(() => null);
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : problem(400, "INVALID_ROUTINE");
}

function validatedInput(data: Record<string, unknown>): RoutineInput | null {
  const { title, prompt, timezone, intervalMinutes, enabled } = data;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 120 ||
    typeof prompt !== "string" ||
    !prompt.trim() ||
    prompt.length > 16_000 ||
    typeof timezone !== "string" ||
    !timezone ||
    timezone.length > 96 ||
    typeof enabled !== "boolean" ||
    typeof intervalMinutes !== "number" ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < MIN_ROUTINE_INTERVAL_MINUTES ||
    intervalMinutes > MAX_INTERVAL_MINUTES
  )
    return null;

  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    return null;
  }
  return {
    title: title.trim(),
    prompt: prompt.trim(),
    timezone,
    intervalMinutes,
    enabled,
  };
}

function runUntilAborted(
  run: () => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createLocalRoutines({
  dbPath,
  run,
  now = Date.now,
  timeoutMs = 120_000,
}: {
  dbPath: string;
  run: Runner;
  now?: () => number;
  timeoutMs?: number;
}) {
  const db = new Database(dbPath);
  try {
    db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;",
    );
    db.transaction(() => {
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version === 0) {
        db.exec(`
          CREATE TABLE local_routines (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            timezone TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            interval_minutes INTEGER NOT NULL CHECK(interval_minutes BETWEEN ${MIN_ROUTINE_INTERVAL_MINUTES} AND ${MAX_INTERVAL_MINUTES}),
            next_run_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK((enabled = 1 AND next_run_at IS NOT NULL) OR (enabled = 0 AND next_run_at IS NULL))
          );
          CREATE INDEX local_routines_due ON local_routines(next_run_at) WHERE enabled = 1;
          CREATE TABLE local_routine_runs (
            sequence INTEGER PRIMARY KEY,
            id TEXT UNIQUE NOT NULL,
            routine_id TEXT NOT NULL REFERENCES local_routines(id) ON DELETE CASCADE,
            scheduled_at INTEGER NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
            answer TEXT,
            error TEXT,
            UNIQUE(routine_id, scheduled_at)
          );
          CREATE UNIQUE INDEX local_routine_live_run ON local_routine_runs(routine_id) WHERE status = 'running';
          CREATE INDEX local_routine_history ON local_routine_runs(routine_id, sequence DESC);
          PRAGMA user_version = 1;
        `);
      } else if (version !== 1) {
        throw new Error(`Unsupported routine database version ${version}`);
      }
      // A profile belongs to one backend process. Its terminated process cannot resume a claim.
      db.run(
        "UPDATE local_routine_runs SET status = 'interrupted', error = 'ROUTINE_RESTARTED', finished_at = ? WHERE status = 'running'",
        [now()],
      );
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const all = db.query<RoutineRow, []>(
    `SELECT ${routineColumns} FROM local_routines ORDER BY created_at DESC, id`,
  );
  const get = db.query<RoutineRow, [string]>(
    `SELECT ${routineColumns} FROM local_routines WHERE id = ?`,
  );
  const insert = db.query<
    RoutineRow,
    [
      string,
      string,
      string,
      string,
      number,
      number,
      number | null,
      number,
      number,
    ]
  >(
    `INSERT INTO local_routines (id, title, prompt, timezone, enabled, interval_minutes, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${routineColumns}`,
  );
  const update = db.query<
    RoutineRow,
    [string, string, string, number, number, number | null, number, string]
  >(
    `UPDATE local_routines SET title = ?, prompt = ?, timezone = ?, enabled = ?,
      interval_minutes = ?, next_run_at = ?, updated_at = ? WHERE id = ? RETURNING ${routineColumns}`,
  );
  const remove = db.query<unknown, [string]>(
    "DELETE FROM local_routines WHERE id = ?",
  );

  const due = db.query<RoutineRow, [number, number]>(
    `SELECT ${routineColumns} FROM local_routines AS routines
     WHERE enabled = 1 AND next_run_at <= ? AND NOT EXISTS (
       SELECT 1 FROM local_routine_runs WHERE routine_id = routines.id AND status = 'running'
     ) ORDER BY next_run_at, id LIMIT ?`,
  );
  const insertRun = db.query<unknown, [string, string, number, number]>(
    `INSERT INTO local_routine_runs (id, routine_id, scheduled_at, started_at, status)
     VALUES (?, ?, ?, ?, 'running') ON CONFLICT(routine_id, scheduled_at) DO NOTHING`,
  );
  const advance = db.query<unknown, [number, string]>(
    "UPDATE local_routines SET next_run_at = ? WHERE id = ?",
  );
  const finish = db.query<
    unknown,
    [RunStatus, string | null, string | null, number, string]
  >(
    "UPDATE local_routine_runs SET status = ?, answer = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
  );
  const historyCursor = db.query<{ sequence: number }, [string, string]>(
    "SELECT sequence FROM local_routine_runs WHERE routine_id = ? AND id = ?",
  );
  const history = db.query<
    RunRow,
    [string, number | null, number | null, number]
  >(
    `SELECT ${runColumns} FROM local_routine_runs
     WHERE routine_id = ? AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?`,
  );

  const claimDue = db.transaction((time: number, capacity: number) => {
    const claims: Array<{ routineId: string; runId: string; prompt: string }> =
      [];
    for (const row of due.all(time, capacity)) {
      const next = row.nextRunAt;
      if (next === null) continue;
      const interval = row.intervalMinutes * MINUTE;
      const scheduled = next + Math.floor((time - next) / interval) * interval;
      const runId = crypto.randomUUID();

      // Coalesce missed intervals. Even a crash after claiming cannot replay this window.
      advance.run(scheduled + interval, row.id);
      if (insertRun.run(runId, row.id, scheduled, time).changes === 1) {
        claims.push({ routineId: row.id, runId, prompt: row.prompt });
      }
    }
    return claims;
  });

  const active = new Map<string, Running>();
  let closing: Promise<void> | undefined;

  async function execute(
    {
      routineId,
      runId,
      prompt,
    }: { routineId: string; runId: string; prompt: string },
    controller: AbortController,
  ) {
    let status: RunStatus = "completed";
    let answer: string | null = null;
    let error: string | null = null;
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      const result = await runUntilAborted(
        () => run({ routineId, prompt, signal }),
        signal,
      );
      signal.throwIfAborted();
      answer = result.slice(0, 32_000);
    } catch (cause) {
      if (controller.signal.aborted) {
        status = "cancelled";
        error = String(controller.signal.reason);
      } else {
        status = "failed";
        error =
          cause instanceof DOMException && cause.name === "TimeoutError"
            ? "ROUTINE_RUN_TIMEOUT"
            : "ROUTINE_RUN_FAILED";
      }
    }
    try {
      finish.run(status, answer, error, now(), runId);
    } finally {
      active.delete(routineId);
    }
  }

  function listRuns(id: string, request: Request) {
    const cursor = new URL(request.url).searchParams.get("cursor");
    const sequence =
      cursor === null ? null : historyCursor.get(id, cursor)?.sequence;
    if (sequence === undefined) return problem(400, "INVALID_ROUTINE_CURSOR");
    const rows = history.all(id, sequence, sequence, HISTORY_PAGE_SIZE + 1);
    const page = rows.slice(0, HISTORY_PAGE_SIZE);
    return json({
      runs: page.map(runView),
      nextCursor:
        rows.length > HISTORY_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    });
  }

  async function collectionResponse(request: Request) {
    if (request.method === "GET")
      return json({ routines: all.all().map(routineView) });
    if (request.method !== "POST") return problem(405, "METHOD_NOT_ALLOWED");

    const body = await readObject(request);
    if (body instanceof Response) return body;
    if (closing) return problem(503, "ROUTINES_UNAVAILABLE");
    const input = validatedInput({ timezone: "UTC", enabled: false, ...body });
    if (!input) return problem(400, "INVALID_ROUTINE");

    const time = now();
    const row = insert.get(
      crypto.randomUUID(),
      input.title,
      input.prompt,
      input.timezone,
      Number(input.enabled),
      input.intervalMinutes,
      input.enabled ? time + input.intervalMinutes * MINUTE : null,
      time,
      time,
    );
    if (!row) throw new Error("Routine was not stored");
    return json({ routine: routineView(row) }, 201);
  }

  async function itemResponse(request: Request, id: string, runs: boolean) {
    const body =
      request.method === "PATCH" && !runs ? await readObject(request) : null;
    if (body instanceof Response) return body;
    if (closing) return problem(503, "ROUTINES_UNAVAILABLE");
    const current = get.get(id);
    if (!current) return problem(404, "ROUTINE_NOT_FOUND");
    if (runs)
      return request.method === "GET"
        ? listRuns(id, request)
        : problem(405, "METHOD_NOT_ALLOWED");

    if (request.method === "GET")
      return json({ routine: routineView(current) });
    if (request.method === "DELETE") {
      remove.run(id);
      active.get(id)?.controller.abort("ROUTINE_DELETED");
      return new Response(null, { status: 204, headers });
    }
    if (!body) return problem(405, "METHOD_NOT_ALLOWED");
    const input = validatedInput({
      ...current,
      enabled: current.enabled === 1,
      ...body,
    });
    if (!input) return problem(400, "INVALID_ROUTINE");

    const time = now();
    const nextRunAt = !input.enabled
      ? null
      : current.nextRunAt !== null &&
          current.intervalMinutes === input.intervalMinutes
        ? current.nextRunAt
        : time + input.intervalMinutes * MINUTE;
    const row = update.get(
      input.title,
      input.prompt,
      input.timezone,
      Number(input.enabled),
      input.intervalMinutes,
      nextRunAt,
      time,
      id,
    );
    if (!row) throw new Error("Routine was not updated");
    if (!input.enabled) active.get(id)?.controller.abort("ROUTINE_DISABLED");
    return json({ routine: routineView(row) });
  }

  return {
    async handle(request: Request, pathname: string): Promise<Response | null> {
      const match = routinePath.exec(pathname);
      const id = match?.[1];
      if (pathname !== collection && !id) return null;
      if (closing) return problem(503, "ROUTINES_UNAVAILABLE");
      try {
        return id
          ? await itemResponse(request, id, Boolean(match?.[2]))
          : await collectionResponse(request);
      } catch {
        return problem(500, "ROUTINE_STORAGE_FAILED");
      }
    },

    async tick(): Promise<void> {
      const capacity = MAX_CONCURRENT_RUNS - active.size;
      if (closing || capacity <= 0) return;
      const claims = claimDue.immediate(now(), capacity);
      await Promise.all(
        claims.map((claim) => {
          const controller = new AbortController();
          const task = Promise.resolve().then(() => execute(claim, controller));
          active.set(claim.routineId, { controller, task });
          return task;
        }),
      );
    },

    close(): Promise<void> {
      if (!closing) {
        for (const entry of active.values())
          entry.controller.abort("ROUTINE_STOPPED");
        closing = Promise.allSettled(
          Array.from(active.values(), ({ task }) => task),
        ).then(() => db.close());
      }
      return closing;
    },
  };
}
