import { Database } from "bun:sqlite";
import {
  type InstagramOutcome,
  instagramId,
  instagramImageUrl,
  type PublishInstagram,
} from "./social-instagram";

const collection = "/api/local/social";
const itemPath =
  /^\/api\/local\/social\/([a-zA-Z0-9_-]{1,128})(?:\/(approve|cancel|record|verify))?$/;
const headers = { "cache-control": "private, no-store" };
const publicFacebook = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
]);
const knownPublisherErrors = new Set([
  "INVALID_INSTAGRAM_IMAGE",
  "INSTAGRAM_CONTAINER_FAILED",
  "INSTAGRAM_PUBLISH_NOT_SENT",
  "INSTAGRAM_PUBLISH_REJECTED",
  "INSTAGRAM_PUBLISH_OUTCOME_UNKNOWN",
]);
const dayMs = 24 * 60 * 60_000;
const maxAttemptsPerDay = 100;

export type SocialPlatform = "instagram" | "facebook_group";
export type SocialStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "manual_ready"
  | "published"
  | "failed"
  | "needs_review"
  | "cancelled";

type Draft = {
  platform: SocialPlatform;
  caption: string;
  imageUrl: string | null;
  groupUrl: string | null;
  scheduledAt: number | null;
};

type PostRow = Draft & {
  id: string;
  status: SocialStatus;
  revision: number;
  instagramAccountId: string | null;
  approvedAt: number | null;
  claimedAt: number | null;
  updatedAt: number;
  createdAt: number;
  finishedAt: number | null;
  containerId: string | null;
  remoteId: string | null;
  resultUrl: string | null;
  resultSource: "api" | "manual" | null;
  error: string | null;
};

const columns = `id, platform, caption, image_url AS imageUrl, group_url AS groupUrl,
  scheduled_at AS scheduledAt, status, revision, instagram_account_id AS instagramAccountId,
  approved_at AS approvedAt, claimed_at AS claimedAt, updated_at AS updatedAt, created_at AS createdAt,
  finished_at AS finishedAt, container_id AS containerId, remote_id AS remoteId, result_url AS resultUrl,
  result_source AS resultSource, error`;

function iso(time: number): string;
function iso(time: number | null): string | null;
function iso(time: number | null): string | null {
  return time === null ? null : new Date(time).toISOString();
}

function view(row: PostRow) {
  return {
    ...row,
    scheduledAt: iso(row.scheduledAt),
    approvedAt: iso(row.approvedAt),
    claimedAt: iso(row.claimedAt),
    updatedAt: iso(row.updatedAt),
    createdAt: iso(row.createdAt),
    finishedAt: iso(row.finishedAt),
  };
}

export type LocalSocialPost = ReturnType<typeof view>;

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
  const value: unknown = await request.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : problem(400, "INVALID_SOCIAL_ITEM");
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url
      : null;
  } catch {
    return null;
  }
}

function facebookGroupUrl(value: unknown) {
  const url = httpsUrl(value);
  if (!url || !publicFacebook.has(url.hostname)) return null;
  const match = /^\/groups\/([a-zA-Z0-9._-]{1,128})\/?$/.exec(url.pathname);
  if (!match || match[1] === "." || match[1] === "..") return null;
  return `https://www.facebook.com/groups/${match[1]}/`;
}

function manualResultUrl(platform: SocialPlatform, input: unknown) {
  const url = httpsUrl(input);
  if (!url) return null;
  const valid =
    platform === "instagram"
      ? ["instagram.com", "www.instagram.com"].includes(url.hostname) &&
        /^\/p\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
      : publicFacebook.has(url.hostname) &&
        /^\/groups\/[a-zA-Z0-9._-]+\/(posts|permalink)\/[a-zA-Z0-9_-]+\/?$/.test(
          url.pathname,
        );
  if (!valid) return null;
  url.search = "";
  url.hash = "";
  return url.href;
}

function validDraft(data: Record<string, unknown>): Draft | null {
  const { platform, caption, scheduledAt } = data;
  if (
    (platform !== "instagram" && platform !== "facebook_group") ||
    typeof caption !== "string"
  )
    return null;
  if (
    platform === "instagram"
      ? Array.from(caption).length > 2_200
      : !caption.trim() || caption.length > 16_000
  ) {
    return null;
  }

  let schedule: number | null = null;
  if (scheduledAt !== undefined && scheduledAt !== null) {
    if (
      typeof scheduledAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        scheduledAt,
      )
    )
      return null;
    schedule = Date.parse(scheduledAt);
    if (!Number.isFinite(schedule)) return null;
  }

  const imageUrl =
    platform === "instagram" ? instagramImageUrl(data.imageUrl) : null;
  const groupUrl =
    platform === "facebook_group" ? facebookGroupUrl(data.groupUrl) : null;
  if (!imageUrl && !groupUrl) return null;
  return { platform, caption, imageUrl, groupUrl, scheduledAt: schedule };
}

export function createLocalSocial({
  dbPath,
  publishInstagram,
  now = Date.now,
}: {
  dbPath: string;
  publishInstagram?: PublishInstagram;
  now?: () => number;
}) {
  const accountId = publishInstagram?.accountId ?? null;
  if (publishInstagram && !instagramId(accountId))
    throw new Error("Invalid Instagram account");
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    db.transaction(() => {
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version === 0) {
        db.exec(`
          CREATE TABLE local_social_posts (
            id TEXT PRIMARY KEY NOT NULL,
            platform TEXT NOT NULL CHECK(platform IN ('instagram', 'facebook_group')),
            caption TEXT NOT NULL,
            image_url TEXT,
            group_url TEXT,
            scheduled_at INTEGER,
            status TEXT NOT NULL CHECK(status IN ('draft', 'scheduled', 'publishing', 'manual_ready', 'published', 'failed', 'needs_review', 'cancelled')),
            revision INTEGER NOT NULL,
            instagram_account_id TEXT,
            approved_at INTEGER,
            claimed_at INTEGER,
            updated_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            finished_at INTEGER,
            container_id TEXT,
            remote_id TEXT,
            result_url TEXT,
            result_source TEXT CHECK(result_source IN ('api', 'manual')),
            error TEXT,
            CHECK(
              (platform = 'instagram' AND image_url IS NOT NULL AND group_url IS NULL) OR
              (platform = 'facebook_group' AND group_url IS NOT NULL AND image_url IS NULL)
            )
          );
          CREATE INDEX local_social_due ON local_social_posts(platform, scheduled_at) WHERE status = 'scheduled';
          CREATE INDEX local_social_attempts ON local_social_posts(instagram_account_id, claimed_at) WHERE claimed_at IS NOT NULL;
          CREATE UNIQUE INDEX local_social_single_publish ON local_social_posts(status) WHERE status = 'publishing';
          PRAGMA user_version = 1;
        `);
      } else if (version !== 1) {
        throw new Error(`Unsupported social database version ${version}`);
      }

      // Restart cannot prove what happened after the previous process issued its request.
      const time = now();
      db.run(
        `UPDATE local_social_posts SET status = 'needs_review', error = 'SOCIAL_RESTART_DURING_PUBLISH',
          updated_at = ?, finished_at = ? WHERE status = 'publishing'`,
        [time, time],
      );
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const all = db.query<PostRow, []>(
    `SELECT ${columns} FROM local_social_posts ORDER BY created_at DESC, rowid DESC`,
  );
  const get = db.query<PostRow, [string]>(
    `SELECT ${columns} FROM local_social_posts WHERE id = ?`,
  );
  const insert = db.query<
    PostRow,
    [
      string,
      SocialPlatform,
      string,
      string | null,
      string | null,
      number | null,
      number,
      number,
    ]
  >(
    `INSERT INTO local_social_posts (id, platform, caption, image_url, group_url, scheduled_at, updated_at, created_at, status, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1) RETURNING ${columns}`,
  );
  const edit = db.query<
    PostRow,
    [
      SocialPlatform,
      string,
      string | null,
      string | null,
      number | null,
      number,
      string,
    ]
  >(
    `UPDATE local_social_posts SET platform = ?, caption = ?, image_url = ?, group_url = ?, scheduled_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'draft' RETURNING ${columns}`,
  );
  const approve = db.query<
    PostRow,
    [SocialStatus, string | null, number, number, string, number]
  >(
    `UPDATE local_social_posts SET status = ?, instagram_account_id = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'draft' RETURNING ${columns}`,
  );
  const cancel = db.query<PostRow, [number, number, string]>(
    `UPDATE local_social_posts SET status = 'cancelled', updated_at = ?, finished_at = ?
      WHERE id = ? AND status IN ('draft', 'scheduled', 'manual_ready') RETURNING ${columns}`,
  );
  const record = db.query<
    PostRow,
    [SocialStatus, string | null, string | null, number, number, string]
  >(
    `UPDATE local_social_posts SET status = ?, result_source = 'manual', result_url = ?, error = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND status IN ('manual_ready', 'needs_review') RETURNING ${columns}`,
  );
  const makeManualReady = db.query<unknown, [number, number]>(
    `UPDATE local_social_posts SET status = 'manual_ready', updated_at = ?
      WHERE platform = 'facebook_group' AND status = 'scheduled' AND scheduled_at <= ?`,
  );
  const rejectChangedAccount = db.query<unknown, [number, number, string]>(
    `UPDATE local_social_posts SET status = 'needs_review', error = 'INSTAGRAM_ACCOUNT_CHANGED', updated_at = ?, finished_at = ?
      WHERE platform = 'instagram' AND status = 'scheduled' AND instagram_account_id IS NOT ?`,
  );
  const findPublishing = db.query<{ id: string }, []>(
    "SELECT id FROM local_social_posts WHERE status = 'publishing'",
  );
  const attempts = db.query<{ total: number }, [string, number]>(
    "SELECT count(*) AS total FROM local_social_posts WHERE instagram_account_id = ? AND claimed_at >= ?",
  );
  const ready = db.query<{ id: string }, [string, number]>(
    `SELECT id FROM local_social_posts WHERE platform = 'instagram' AND status = 'scheduled'
      AND instagram_account_id = ? AND scheduled_at <= ? ORDER BY scheduled_at, created_at, id LIMIT 1`,
  );
  const claim = db.query<PostRow, [number, number, string]>(
    `UPDATE local_social_posts SET status = 'publishing', updated_at = ?, claimed_at = ?
      WHERE id = ? AND status = 'scheduled' RETURNING ${columns}`,
  );
  const saveContainer = db.query<unknown, [string, number, string]>(
    "UPDATE local_social_posts SET container_id = ?, updated_at = ? WHERE id = ? AND status = 'publishing' AND container_id IS NULL",
  );
  const finish = db.query<
    unknown,
    [SocialStatus, string | null, string | null, number, number, string]
  >(
    `UPDATE local_social_posts SET status = ?, remote_id = ?, error = ?, result_source = 'api', updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'publishing'`,
  );
  const confirmPublication = db.query<
    PostRow,
    [number, number, string, string]
  >(
    `UPDATE local_social_posts SET status='published', result_source='api', error=NULL, updated_at=?, finished_at=?
     WHERE id=? AND status='needs_review' AND container_id=? RETURNING ${columns}`,
  );
  const verifiedAt = new Map<string, number>();
  const checking = new Set<string>();

  function markCheck(id: string) {
    const time = now();
    for (const [previous, at] of verifiedAt) {
      if (time - at >= 60_000) verifiedAt.delete(previous);
    }
    if (verifiedAt.has(id)) return false;
    verifiedAt.set(id, time);
    return true;
  }

  const claimDue = db.transaction(
    (time: number, enabledAccount: string | null) => {
      makeManualReady.run(time, time);
      if (!enabledAccount) return null;
      rejectChangedAccount.run(time, time, enabledAccount);
      if (
        findPublishing.get() ||
        (attempts.get(enabledAccount, time - dayMs)?.total ?? 0) >=
          maxAttemptsPerDay
      ) {
        return null;
      }
      const post = ready.get(enabledAccount, time);
      return post ? claim.get(time, time, post.id) : null;
    },
  );

  let active: { controller: AbortController; task: Promise<void> } | null =
    null;
  let closing: Promise<void> | undefined;

  async function publish(
    post: PostRow,
    publisher: PublishInstagram,
    controller: AbortController,
  ) {
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(60_000),
    ]);
    let abortListener: (() => void) | undefined;
    let result: InstagramOutcome = {
      kind: "needs_review",
      error: "INSTAGRAM_PUBLISH_OUTCOME_UNKNOWN",
    };
    try {
      signal.throwIfAborted();
      if (!post.imageUrl) throw new Error("Missing scheduled image");
      const interrupted = new Promise<never>((_, reject) => {
        abortListener = () => reject(signal.reason);
        signal.addEventListener("abort", abortListener, { once: true });
      });
      result = await Promise.race([
        publisher({
          caption: post.caption,
          imageUrl: post.imageUrl,
          signal,
          recordContainer(containerId) {
            signal.throwIfAborted();
            if (
              !instagramId(containerId) ||
              saveContainer.run(containerId, now(), post.id).changes !== 1
            ) {
              throw new Error("Could not record Instagram container");
            }
          },
        }),
        interrupted,
      ]);
    } catch {
      // Unknown outcomes stay terminal until the user checks the destination.
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }

    const time = now();
    try {
      const container =
        result.kind === "needs_review" && get.get(post.id)?.containerId;
      const confirmed =
        container &&
        publisher.verify &&
        !controller.signal.aborted &&
        markCheck(post.id) &&
        (await publisher
          .verify(container, controller.signal)
          .catch(() => "unavailable")) === "confirmed";
      if (confirmed) {
        const checkedAt = now();
        finish.run("published", null, null, checkedAt, checkedAt, post.id);
      } else if (result.kind === "published" && instagramId(result.mediaId)) {
        finish.run("published", result.mediaId, null, time, time, post.id);
      } else {
        const status = result.kind === "failed" ? "failed" : "needs_review";
        const error =
          "error" in result && knownPublisherErrors.has(result.error)
            ? result.error
            : "INSTAGRAM_PUBLISH_OUTCOME_UNKNOWN";
        finish.run(status, null, error, time, time, post.id);
      }
    } finally {
      active = null;
    }
  }

  async function add(request: Request) {
    const data = await readObject(request);
    if (data instanceof Response) return data;
    if (closing) return problem(503, "SOCIAL_UNAVAILABLE");
    const draft = validDraft(data);
    if (!draft) return problem(400, "INVALID_SOCIAL_ITEM");
    const time = now();
    const row = insert.get(
      crypto.randomUUID(),
      draft.platform,
      draft.caption,
      draft.imageUrl,
      draft.groupUrl,
      draft.scheduledAt,
      time,
      time,
    );
    if (!row) throw new Error("Social item insert did not return a row");
    return json({ item: view(row) }, 201);
  }

  async function change(
    request: Request,
    id: string,
    action: string | undefined,
  ) {
    const data =
      action === "cancel" || action === "verify" || request.method === "GET"
        ? null
        : await readObject(request);
    if (data instanceof Response) return data;
    if (closing) return problem(503, "SOCIAL_UNAVAILABLE");
    const current = get.get(id);
    if (!current) return problem(404, "SOCIAL_ITEM_NOT_FOUND");
    if (request.method === "GET") return json({ item: view(current) });

    let row: PostRow | null;
    const time = now();
    switch (action) {
      case "verify": {
        if (
          current.platform !== "instagram" ||
          current.status !== "needs_review" ||
          current.instagramAccountId !== accountId ||
          !current.containerId ||
          !publishInstagram?.verify
        ) {
          return problem(409, "INSTAGRAM_VERIFICATION_NOT_AVAILABLE");
        }
        if (checking.has(id))
          return problem(409, "INSTAGRAM_VERIFICATION_BUSY");
        if (!markCheck(id))
          return problem(429, "INSTAGRAM_VERIFICATION_COOLDOWN");
        checking.add(id);
        try {
          const verification = await publishInstagram
            .verify(current.containerId, request.signal)
            .catch(() => "unavailable" as const);
          if (closing) return problem(503, "SOCIAL_UNAVAILABLE");
          const verified =
            verification === "confirmed"
              ? confirmPublication.get(now(), now(), id, current.containerId)
              : get.get(id);
          return verified
            ? json({ item: view(verified), verification })
            : problem(409, "SOCIAL_ITEM_CHANGED");
        } finally {
          checking.delete(id);
        }
      }
      case "approve": {
        if (!data || !Number.isSafeInteger(data.revision))
          return problem(400, "SOCIAL_APPROVAL_REVISION_REQUIRED");
        if (current.status !== "draft" || data.revision !== current.revision)
          return problem(409, "SOCIAL_ITEM_CHANGED");
        if (current.platform === "instagram") {
          if (!accountId) return problem(409, "INSTAGRAM_NOT_CONFIGURED");
          if (current.scheduledAt === null)
            return problem(409, "SOCIAL_SCHEDULE_REQUIRED");
          row = approve.get(
            "scheduled",
            accountId,
            time,
            time,
            id,
            current.revision,
          );
        } else {
          const status =
            current.scheduledAt === null || current.scheduledAt <= time
              ? "manual_ready"
              : "scheduled";
          row = approve.get(status, null, time, time, id, current.revision);
        }
        break;
      }
      case "cancel":
        row = cancel.get(time, time, id);
        break;
      case "record": {
        const outcome = data?.outcome;
        if (outcome !== "published" && outcome !== "not_published")
          return problem(400, "INVALID_SOCIAL_RESULT");
        const inputUrl = data?.resultUrl;
        const url =
          inputUrl === null || inputUrl === undefined
            ? null
            : manualResultUrl(current.platform, inputUrl);
        if (
          (inputUrl !== null && inputUrl !== undefined && !url) ||
          (outcome === "not_published" && url)
        ) {
          return problem(400, "INVALID_SOCIAL_RESULT_URL");
        }
        row = record.get(
          outcome === "published" ? "published" : "failed",
          url,
          outcome === "published" ? null : "USER_CONFIRMED_NOT_PUBLISHED",
          time,
          time,
          id,
        );
        break;
      }
      default: {
        if (current.status !== "draft")
          return problem(409, "SOCIAL_ITEM_CHANGED");
        const draft = validDraft({ ...view(current), ...data });
        if (!draft) return problem(400, "INVALID_SOCIAL_ITEM");
        row = edit.get(
          draft.platform,
          draft.caption,
          draft.imageUrl,
          draft.groupUrl,
          draft.scheduledAt,
          time,
          id,
        );
      }
    }
    return row
      ? json({ item: view(row) })
      : problem(409, "SOCIAL_ITEM_CHANGED");
  }

  return {
    async handle(request: Request, pathname: string): Promise<Response | null> {
      const match = itemPath.exec(pathname);
      const id = match?.[1];
      const action = match?.[2];
      if (pathname !== collection && !id) return null;
      if (closing) return problem(503, "SOCIAL_UNAVAILABLE");
      try {
        if (!id) {
          if (request.method === "GET") {
            return json({
              items: all.all().map(view),
              instagramConfigured: Boolean(accountId),
              instagramAccountId: accountId,
            });
          }
          if (request.method === "POST") return await add(request);
        } else if (
          action
            ? request.method === "POST"
            : request.method === "GET" || request.method === "PATCH"
        ) {
          return await change(request, id, action);
        }
        return problem(405, "METHOD_NOT_ALLOWED");
      } catch {
        return problem(500, "SOCIAL_STORAGE_FAILED");
      }
    },

    async tick(): Promise<void> {
      if (closing) return;
      const post = claimDue.immediate(now(), active ? null : accountId);
      if (!post || !publishInstagram) return;
      const controller = new AbortController();
      const task = Promise.resolve().then(() =>
        publish(post, publishInstagram, controller),
      );
      active = { controller, task };
      await task;
    },

    close(): Promise<void> {
      if (!closing) {
        active?.controller.abort();
        closing = Promise.allSettled(active ? [active.task] : []).then(() =>
          db.close(),
        );
      }
      return closing;
    },
  };
}
