import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type BotStage = {
  id: string;
  recovery: "replayable" | "review";
  maxAttempts?: number;
  timeoutMs?: number;
  allowManualCompletion?: boolean;
  run(input: {
    jobId: string;
    input: JsonObject;
    outputs: Readonly<Record<string, JsonObject>>;
    signal: AbortSignal;
  }): Promise<JsonObject>;
};

export type BotWorkflow = {
  version?: number;
  prepare(input: unknown): JsonObject;
  stages: readonly BotStage[];
};

function errorCode(code: string, fallback: string) {
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}

export class BotQueueTransientError extends Error {
  constructor(code = "BOT_STAGE_TRANSIENT") {
    super(errorCode(code, "BOT_STAGE_TRANSIENT"));
  }
}

export class BotQueueFatalError extends Error {
  constructor(code = "BOT_STAGE_FAILED") {
    super(errorCode(code, "BOT_STAGE_FAILED"));
  }
}

export type BotStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "paused"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";

type Control = "pause" | "cancel" | null;
type Recovery = BotStage["recovery"];
type RunRow = {
  id: string;
  workflow: string;
  workflow_version: number;
  plan: string;
  input: string;
  request_key_hash: string | null;
  status: BotStatus;
  stage_index: number;
  attempt: number;
  outputs: string;
  active_recovery: Recovery | null;
  lease_token: string | null;
  lease_until: number | null;
  control: Control;
  error: string | null;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
};

type EventRow = {
  id: number;
  job_id: string;
  type: string;
  stage: string | null;
  attempt: number;
  detail: string | null;
  at: number;
};

type StageReceipt = Pick<BotStage, "id" | "recovery">;
type Registered = {
  version: number;
  workflow: BotWorkflow;
  plan: string;
};

const collection = "/api/local/bot-runs";
const jobPath =
  /^\/api\/local\/bot-runs\/([a-f\d-]{36})(?:\/(events|pause|resume|cancel|resolve))?$/i;
const label = /^[a-z][a-z0-9_-]{0,63}$/;
const idempotencyKey = /^[a-zA-Z0-9_.:-]{1,128}$/;
const responseHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
const maxRequestBytes = 128 * 1024;
const maxInputBytes = 32 * 1024;
const maxOutputBytes = 32 * 1024;
const maxCheckpointBytes = 128 * 1024;
const defaultAttempts = 3;
const defaultTimeout = 120_000;

function iso(time: number | null) {
  return time === null ? null : new Date(time).toISOString();
}

function stageFor(row: RunRow) {
  return (JSON.parse(row.plan) as StageReceipt[])[row.stage_index];
}

function view(row: RunRow) {
  return {
    id: row.id,
    workflow: row.workflow,
    input: JSON.parse(row.input) as JsonObject,
    status: row.status,
    outputs: JSON.parse(row.outputs) as Record<string, JsonObject>,
    currentStage: stageFor(row)?.id ?? null,
    attempt: row.attempt,
    nextAttemptAt: iso(row.next_attempt_at),
    control: row.control,
    error: row.error,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  };
}

export type BotJob = ReturnType<typeof view>;

function json(payload: object, status = 200) {
  return Response.json(payload, { status, headers: responseHeaders });
}

function problem(status: number, error: string) {
  return json({ error }, status);
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedObject(value: unknown, maxBytes: number) {
  let count = 0;
  function format(candidate: unknown, depth: number): JsonValue {
    count += 1;
    if (depth > 16 || count > 8_000)
      throw new BotQueueFatalError("BOT_JOB_VALUE_TOO_COMPLEX");
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    )
      return candidate;
    if (Array.isArray(candidate))
      return candidate.map((entry) => format(entry, depth + 1));
    if (
      !object(candidate) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(candidate))
    )
      throw new BotQueueFatalError("BOT_JOB_INVALID_VALUE");
    return Object.fromEntries(
      Object.entries(candidate)
        .sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
        .map(([key, entry]) => [key, format(entry, depth + 1)]),
    );
  }
  if (!object(value)) throw new BotQueueFatalError("BOT_JOB_INVALID_VALUE");
  const serialized = JSON.stringify(format(value, 0));
  if (Buffer.byteLength(serialized, "utf8") > maxBytes)
    throw new BotQueueFatalError("BOT_JOB_VALUE_TOO_LARGE");
  return serialized;
}

async function readObject(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const type = request.headers.get("content-type")?.split(";")[0];
  if (type?.trim().toLowerCase() !== "application/json")
    return problem(415, "JSON_REQUIRED");
  const reader = request.body?.getReader();
  if (!reader) return problem(400, "BOT_JOB_INVALID_INPUT");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let count = 0;
  let source = "";
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      count += step.value.byteLength;
      if (count > maxRequestBytes) {
        void reader.cancel().catch(() => undefined);
        return problem(413, "REQUEST_BODY_TOO_LARGE");
      }
      source += decoder.decode(step.value, { stream: true });
    }
    const payload: unknown = JSON.parse(source + decoder.decode());
    if (object(payload)) return payload;
  } catch {
    void reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
  return problem(400, "BOT_JOB_INVALID_INPUT");
}

function range(value: number, min: number, max: number) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function register(workflows: Readonly<Record<string, BotWorkflow>>) {
  const registered = new Map<string, Registered>();
  for (const [name, config] of Object.entries(workflows)) {
    const version = config.version ?? 1;
    if (!label.test(name) || !range(version, 1, Number.MAX_SAFE_INTEGER))
      throw new Error("Invalid bot workflow identity");
    if (!range(config.stages.length, 1, 16))
      throw new Error("Invalid bot workflow stage count");
    const stages = config.stages.map((stage) => ({ ...stage }));
    const seen = new Set<string>();
    for (const stage of stages) {
      if (
        !label.test(stage.id) ||
        seen.has(stage.id) ||
        !["replayable", "review"].includes(stage.recovery) ||
        !range(stage.maxAttempts ?? defaultAttempts, 1, 5) ||
        !range(stage.timeoutMs ?? defaultTimeout, 100, 300_000)
      )
        throw new Error("Invalid bot workflow stage settings");
      seen.add(stage.id);
    }
    const plan = JSON.stringify(
      stages.map(({ id, recovery }) => ({ id, recovery })),
    );
    registered.set(name, { version, workflow: { ...config, stages }, plan });
  }
  return registered;
}

function initialize(db: Database) {
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
  );
  db.transaction(() => {
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    if (version === 1) return;
    if (version !== 0) throw new Error("Unsupported bot queue schema");
    db.exec(`
      CREATE TABLE bot_runs (
        id TEXT PRIMARY KEY NOT NULL,
        workflow TEXT NOT NULL,
        workflow_version INTEGER NOT NULL CHECK(workflow_version >= 1),
        plan TEXT NOT NULL CHECK(json_valid(plan)),
        input TEXT NOT NULL CHECK(json_valid(input)),
        request_key_hash TEXT UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('queued','running','retry_wait','paused','review','completed','failed','cancelled')),
        stage_index INTEGER NOT NULL CHECK(stage_index >= 0),
        attempt INTEGER NOT NULL CHECK(attempt >= 0),
        outputs TEXT NOT NULL CHECK(json_valid(outputs)),
        active_recovery TEXT CHECK(active_recovery IN ('replayable','review')),
        lease_token TEXT,
        lease_until INTEGER,
        control TEXT CHECK(control IN ('pause','cancel')),
        error TEXT,
        next_attempt_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_run_events (
        id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES bot_runs(id),
        type TEXT NOT NULL,
        stage TEXT,
        attempt INTEGER NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX bot_runs_due ON bot_runs(status,next_attempt_at,created_at);
      CREATE INDEX bot_runs_lease ON bot_runs(status,lease_until);
      CREATE INDEX bot_runs_history ON bot_runs(created_at DESC,id DESC);
      CREATE INDEX bot_run_events_history ON bot_run_events(job_id,id);
      PRAGMA user_version=1;
    `);
  }).immediate();
}

export function createBotQueue({
  dbPath,
  workflows,
  now = Date.now,
  leaseMs = 8_000,
  retryBaseMs = 2_000,
}: {
  dbPath: string;
  workflows: Readonly<Record<string, BotWorkflow>>;
  now?: () => number;
  leaseMs?: number;
  retryBaseMs?: number;
}) {
  if (!range(leaseMs, 400, 300_000) || !range(retryBaseMs, 10, 60_000))
    throw new Error("Invalid bot queue timing configuration");
  const registry = register(workflows);
  const db = new Database(dbPath);
  try {
    initialize(db);
  } catch (error) {
    db.close();
    throw error;
  }

  let closing = false;
  let active: { controller: AbortController; task: Promise<boolean> } | null =
    null;
  let closeTask: Promise<void> | undefined;
  const find = db.query<RunRow, [string]>(
    "SELECT * FROM bot_runs WHERE id = ?",
  );
  const due = db.query<RunRow, [number]>(
    `SELECT * FROM bot_runs WHERE status IN ('queued','retry_wait')
     AND next_attempt_at <= ? ORDER BY next_attempt_at, created_at, id LIMIT 1`,
  );
  const expired = db.query<RunRow, [number]>(
    `SELECT * FROM bot_runs WHERE status = 'running'
     AND lease_until <= ? ORDER BY lease_until LIMIT 50`,
  );
  const appendEvent = db.query(
    `INSERT INTO bot_run_events(job_id,type,stage,attempt,detail,at)
     VALUES(?,?,?,?,?,?)`,
  );
  const clearLease = db.query(
    `UPDATE bot_runs SET status=?, active_recovery=?, lease_token=NULL,
     lease_until=NULL, control=?, error=?, next_attempt_at=?, updated_at=?
     WHERE id=?`,
  );

  function configFor(row: RunRow) {
    const config = registry.get(row.workflow);
    return config?.plan === row.plan && config.version === row.workflow_version
      ? config
      : undefined;
  }

  function audit(
    row: RunRow,
    type: string,
    at: number,
    detail: string | null = null,
  ) {
    appendEvent.run(
      row.id,
      type,
      stageFor(row)?.id ?? null,
      row.attempt,
      detail,
      at,
    );
  }

  function followControl(row: RunRow, status: BotStatus) {
    if (row.control === "cancel") return "cancelled";
    if (row.control === "pause" && status !== "completed") return "paused";
    return status;
  }

  function setReleased(
    row: RunRow,
    status: BotStatus,
    at: number,
    event: string,
    error: string | null = null,
    readyAt: number | null = null,
  ) {
    const review = status === "review";
    clearLease.run(
      status,
      review ? row.active_recovery : null,
      review ? row.control : null,
      error,
      readyAt,
      at,
      row.id,
    );
    audit(row, event, at, error);
  }

  function recover(row: RunRow, at: number) {
    if (row.active_recovery === "review" || row.active_recovery === null) {
      setReleased(
        row,
        "review",
        at,
        "review_required",
        "BOT_STAGE_OUTCOME_UNKNOWN",
      );
      return;
    }
    const stage = configFor(row)?.workflow.stages[row.stage_index];
    if (!stage) {
      setReleased(row, "review", at, "review_required", "BOT_WORKFLOW_CHANGED");
      return;
    }
    rerunOrStop(row, stage, at, "BOT_STAGE_INTERRUPTED", true);
  }

  function rerunOrStop(
    row: RunRow,
    stage: BotStage,
    at: number,
    error: string,
    retry: boolean,
  ) {
    const willRetry =
      retry && row.attempt < (stage.maxAttempts ?? defaultAttempts);
    const status = followControl(row, willRetry ? "retry_wait" : "failed");
    const delay = Math.min(
      retryBaseMs * 2 ** Math.max(0, row.attempt - 1),
      600_000,
    );
    const readyAt = status === "retry_wait" ? at + delay : null;
    const event = status === "retry_wait" ? "retry_scheduled" : status;
    setReleased(row, status, at, event, error, readyAt);
  }

  const claim = db.transaction(() => {
    const at = now();
    for (const row of expired.all(at)) recover(row, at);
    const row = due.get(at);
    if (!row) return null;
    const stage = configFor(row)?.workflow.stages[row.stage_index];
    if (!stage) {
      setReleased(row, "review", at, "review_required", "BOT_WORKFLOW_CHANGED");
      return null;
    }
    // A paused run can resume after a transient error or an expired lease.
    if (row.attempt >= (stage.maxAttempts ?? defaultAttempts)) {
      setReleased(
        row,
        "failed",
        at,
        "failed",
        row.error ?? "BOT_STAGE_ATTEMPTS_EXHAUSTED",
      );
      return null;
    }
    const token = randomUUID();
    db.query(
      `UPDATE bot_runs SET status='running', attempt=attempt+1,
       active_recovery=?, lease_token=?, lease_until=?, error=NULL,
       next_attempt_at=NULL, updated_at=? WHERE id=?`,
    ).run(stage.recovery, token, at + leaseMs, at, row.id);
    const claimed = find.get(row.id);
    if (!claimed) throw new Error("Claimed bot job disappeared");
    audit(claimed, "stage_started", at);
    return { row: claimed, stage, token };
  });

  function checkpoint(row: RunRow, output: string, type: string, at: number) {
    const state = JSON.parse(row.outputs) as Record<string, JsonObject>;
    const completedStage = stageFor(row);
    if (!completedStage) throw new BotQueueFatalError("BOT_WORKFLOW_CHANGED");
    const result = boundedObject(
      { ...state, [completedStage.id]: JSON.parse(output) },
      maxCheckpointBytes,
    );
    const plan = JSON.parse(row.plan) as StageReceipt[];
    const hasNext = row.stage_index + 1 < plan.length;
    const status = followControl(row, hasNext ? "queued" : "completed");
    db.query(
      `UPDATE bot_runs SET status=?, stage_index=stage_index+1, attempt=0,
       outputs=?, active_recovery=NULL, lease_token=NULL, lease_until=NULL,
       control=NULL, error=NULL, next_attempt_at=?, updated_at=? WHERE id=?`,
    ).run(status, result, status === "queued" ? at : null, at, row.id);
    audit(row, type, at);
    if (status !== "queued") audit(row, status, at);
  }

  const commit = db.transaction((id: string, token: string, output: string) => {
    const row = find.get(id);
    if (row?.status !== "running" || row.lease_token !== token) return;
    checkpoint(row, output, "stage_completed", now());
  });

  const fail = db.transaction(
    (
      id: string,
      token: string,
      stage: BotStage,
      error: string,
      retry: boolean,
    ) => {
      const row = find.get(id);
      if (row?.status !== "running" || token !== row.lease_token) return;
      const time = now();
      if (row.active_recovery === "review") {
        setReleased(row, "review", time, "review_required", error);
      } else {
        rerunOrStop(row, stage, time, error, retry);
      }
    },
  );

  async function tick(): Promise<boolean> {
    if (closing || active) return false;
    const taken = claim.immediate();
    if (!taken) return false;
    const { row, stage, token } = taken;
    const controller = new AbortController();
    const heartbeat = setInterval(
      () => {
        try {
          const result = db
            .query(
              `UPDATE bot_runs SET lease_until=? WHERE id=? AND status='running' AND lease_token=?`,
            )
            .run(now() + leaseMs, row.id, token);
          if (!result.changes) controller.abort();
        } catch {
          controller.abort();
        }
      },
      Math.floor(leaseMs / 4),
    );
    heartbeat.unref();
    const deadline = AbortSignal.timeout(stage.timeoutMs ?? defaultTimeout);
    const signal = AbortSignal.any([controller.signal, deadline]);
    const task = Promise.resolve()
      .then(async () => {
        try {
          const output = await stage.run({
            jobId: row.id,
            input: JSON.parse(row.input) as JsonObject,
            outputs: JSON.parse(row.outputs) as Record<string, JsonObject>,
            signal,
          });
          commit.immediate(
            row.id,
            token,
            boundedObject(output, maxOutputBytes),
          );
        } catch (failure) {
          const interrupted = signal.aborted;
          const typed =
            failure instanceof BotQueueTransientError ||
            failure instanceof BotQueueFatalError;
          const code = interrupted
            ? "BOT_STAGE_INTERRUPTED"
            : typed
              ? failure.message
              : "BOT_STAGE_FAILED";
          fail.immediate(
            row.id,
            token,
            stage,
            code,
            interrupted || failure instanceof BotQueueTransientError,
          );
        }
        return true;
      })
      .finally(() => {
        clearInterval(heartbeat);
        active = null;
      });
    active = { controller, task };
    return task;
  }

  const addJob = db.transaction(
    (name: string, config: Registered, input: string, key: string | null) => {
      if (key) {
        const before = db
          .query<RunRow, [string]>(
            "SELECT * FROM bot_runs WHERE request_key_hash=?",
          )
          .get(key);
        if (before) {
          if (before.workflow !== name || before.input !== input)
            return problem(409, "BOT_REQUEST_KEY_REUSED");
          return json({ job: view(before) });
        }
      }
      const id = randomUUID();
      const time = now();
      db.query(
        `INSERT INTO bot_runs(id,workflow,workflow_version,plan,input,request_key_hash,
         status,stage_index,attempt,outputs,next_attempt_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,'queued',0,0,'{}',?,?,?)`,
      ).run(
        id,
        name,
        config.version,
        config.plan,
        input,
        key,
        time,
        time,
        time,
      );
      const row = find.get(id);
      if (!row) throw new Error("New bot job disappeared");
      audit(row, "created", time);
      return json({ job: view(row) }, 201);
    },
  );

  const controlJob = db.transaction(
    (id: string, action: "pause" | "resume" | "cancel") => {
      const row = find.get(id);
      if (!row) return problem(404, "BOT_JOB_NOT_FOUND");
      const time = now();
      if (action === "resume") {
        if (row.status !== "paused") return problem(409, "BOT_JOB_NOT_PAUSED");
        setReleased(row, "queued", time, "resumed", null, time);
      } else if (row.status === "running") {
        if (row.control === "cancel" && action === "pause")
          return problem(409, "BOT_JOB_CANCEL_PENDING");
        if (row.control !== action) {
          db.query("UPDATE bot_runs SET control=?,updated_at=? WHERE id=?").run(
            action,
            time,
            id,
          );
          audit(
            row,
            action === "pause" ? "pause_requested" : "cancel_requested",
            time,
          );
        }
      } else if (
        row.status === "queued" ||
        row.status === "retry_wait" ||
        row.status === "paused"
      ) {
        if (action === "cancel")
          setReleased(row, "cancelled", time, "cancelled");
        else if (row.status !== "paused")
          setReleased(row, "paused", time, "paused");
      } else {
        return problem(409, "BOT_JOB_CONTROL_CONFLICT");
      }
      const changed = find.get(id);
      if (!changed) throw new Error("Controlled bot job disappeared");
      return json({ job: view(changed) });
    },
  );

  const resolveReview = db.transaction(
    (id: string, resolution: "completed" | "failed", output: string) => {
      const row = find.get(id);
      if (!row) return problem(404, "BOT_JOB_NOT_FOUND");
      if (row.status !== "review") return problem(409, "BOT_JOB_NOT_IN_REVIEW");
      const time = now();
      if (resolution === "completed") {
        if (
          row.active_recovery !== "review" ||
          !configFor(row)?.workflow.stages[row.stage_index]
            ?.allowManualCompletion
        )
          return problem(409, "BOT_JOB_REVIEW_CANNOT_COMPLETE");
        checkpoint(row, output, "review_completed", time);
      } else {
        setReleased(
          row,
          "failed",
          time,
          "review_failed",
          "BOT_REVIEW_MARKED_FAILED",
        );
      }
      const changed = find.get(id);
      if (!changed) throw new Error("Reviewed bot job disappeared");
      return json({ job: view(changed) });
    },
  );

  function pagination(url: URL, fallback: number) {
    const limit = Number(url.searchParams.get("limit") ?? fallback);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!range(limit, 1, 100) || !range(offset, 0, 100_000)) return null;
    return { limit, offset };
  }

  async function handle(
    request: Request,
    pathname: string,
  ): Promise<Response | null> {
    if (pathname !== collection && !pathname.startsWith(`${collection}/`))
      return null;
    if (closing) return problem(503, "BOT_QUEUE_CLOSING");
    try {
      if (pathname === collection) {
        if (request.method === "GET") {
          const page = pagination(new URL(request.url), 30);
          if (!page) return problem(400, "BOT_INVALID_PAGINATION");
          const rows = db
            .query<RunRow, [number, number]>(
              "SELECT * FROM bot_runs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
            )
            .all(page.limit + 1, page.offset);
          return json({
            jobs: rows.slice(0, page.limit).map(view),
            nextOffset:
              rows.length > page.limit ? page.offset + page.limit : null,
          });
        }
        if (request.method !== "POST")
          return problem(405, "METHOD_NOT_ALLOWED");
        const payload = await readObject(request);
        if (closing) return problem(503, "BOT_QUEUE_CLOSING");
        if (payload instanceof Response) return payload;
        const name = payload.workflow;
        const config = typeof name === "string" && registry.get(name);
        if (typeof name !== "string" || !config)
          return problem(400, "BOT_WORKFLOW_NOT_FOUND");
        const header = request.headers.get("idempotency-key");
        if (header !== null && !idempotencyKey.test(header))
          return problem(400, "BOT_INVALID_REQUEST_KEY");
        const key =
          header === null
            ? null
            : createHash("sha256").update(header).digest("hex");
        let input: string;
        try {
          input = boundedObject(
            config.workflow.prepare(payload.input),
            maxInputBytes,
          );
        } catch (failure) {
          if (failure instanceof BotQueueFatalError)
            return problem(422, failure.message);
          return problem(400, "BOT_JOB_INVALID_INPUT");
        }
        return addJob.immediate(name, config, input, key);
      }
      const path = jobPath.exec(pathname);
      if (!path?.[1]) return problem(404, "BOT_JOB_NOT_FOUND");
      const [, id, action] = path;
      if (action === "events" && request.method === "GET") {
        if (!find.get(id)) return problem(404, "BOT_JOB_NOT_FOUND");
        const page = pagination(new URL(request.url), 100);
        if (!page) return problem(400, "BOT_INVALID_PAGINATION");
        const rows = db
          .query<EventRow, [string, number, number]>(
            "SELECT * FROM bot_run_events WHERE job_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
          )
          .all(id, page.limit + 1, page.offset);
        return json({
          events: rows.slice(0, page.limit).map(({ job_id, at, ...event }) => ({
            ...event,
            jobId: job_id,
            at: iso(at),
          })),
          nextOffset:
            rows.length > page.limit ? page.offset + page.limit : null,
        });
      }
      if (!action && request.method === "GET") {
        const row = find.get(id);
        return row
          ? json({ job: view(row) })
          : problem(404, "BOT_JOB_NOT_FOUND");
      }
      if (request.method !== "POST") return problem(405, "METHOD_NOT_ALLOWED");
      if (action === "pause" || action === "resume" || action === "cancel")
        return controlJob.immediate(id, action);
      if (action !== "resolve") return problem(405, "METHOD_NOT_ALLOWED");
      const payload = await readObject(request);
      if (closing) return problem(503, "BOT_QUEUE_CLOSING");
      if (payload instanceof Response) return payload;
      if (payload.resolution !== "completed" && payload.resolution !== "failed")
        return problem(400, "BOT_INVALID_REVIEW");
      const output = boundedObject(
        payload.output === undefined ? {} : payload.output,
        maxOutputBytes,
      );
      return resolveReview.immediate(id, payload.resolution, output);
    } catch (error) {
      if (error instanceof BotQueueFatalError)
        return problem(422, error.message);
      return problem(500, "BOT_QUEUE_FAILED");
    }
  }

  function close() {
    if (closeTask) return closeTask;
    closing = true;
    const run = active;
    run?.controller.abort();
    closeTask = Promise.resolve().then(async () => {
      try {
        await run?.task;
      } finally {
        db.close();
      }
    });
    return closeTask;
  }

  function getJob(id: string) {
    const row = find.get(id);
    return row ? view(row) : null;
  }

  return { getJob, handle, tick, close };
}
