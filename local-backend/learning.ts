import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const ROOT = "/api/local/learning";
const MAX_EVIDENCE_TEXT = 16_000;
const MAX_SKILL_BODY = 20_000;
const MAX_EVIDENCE_IDS = 8;
const LEASE_MS = 120_000;
const REDACTED = "[redacted]";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type LearningEvidence = {
  id: string;
  source: "manual" | "recording";
  text: string;
  createdAt: string;
};

export type SkillDraft = { slug: string; title: string; markdown: string };

export type PublishedSkill = SkillDraft & {
  revision: number;
  publishedAt: string;
};

export type LearningProposal = SkillDraft & {
  id: string;
  evidenceIds: string[];
  revision: number;
  status: "pending" | "published" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
};

type ProposalRow = Omit<LearningProposal, "evidenceIds"> & {
  evidenceIds: string;
};

type LearnOptions = {
  dbPath: string;
  propose: (input: {
    evidence: readonly LearningEvidence[];
    signal: AbortSignal;
  }) => Promise<SkillDraft>;
};

class LearningError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function operationKey(request: Request) {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) {
    throw new LearningError(400, "IDEMPOTENCY_KEY_REQUIRED");
  }
  return hash(key);
}

async function inputObject(request: Request) {
  if (!request.body) return {};
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new LearningError(415, "JSON_REQUIRED");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 128 * 1024) {
    throw new LearningError(413, "LEARNING_BODY_TOO_LARGE");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new LearningError(400, "INVALID_LEARNING_BODY");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LearningError(400, "INVALID_LEARNING_BODY");
  }
  return body as Record<string, unknown>;
}

function redact(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/gi,
      REDACTED,
    )
    .replace(
      /^\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\n]*/gim,
      REDACTED,
    )
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi, REDACTED)
    .replace(
      /\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|xox[baprs]-|AIza|AKIA|ASIA)[a-z0-9_-]{12,}\b/gi,
      REDACTED,
    )
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, REDACTED)
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi,
      (prefix) => `${prefix.slice(0, prefix.indexOf("://") + 3)}${REDACTED}@`,
    )
    .replace(
      /\b([a-z0-9_.-]*(?:password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|credential|signature|session[-_]?token|token)[a-z0-9_.-]*)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]]+)/gi,
      `$1=${REDACTED}`,
    )
    .trim();
}

function evidenceInput(body: Record<string, unknown>) {
  const { source, text } = body;
  if (
    Object.keys(body).length !== 2 ||
    (source !== "manual" && source !== "recording") ||
    typeof text !== "string" ||
    text.length > MAX_EVIDENCE_TEXT
  ) {
    throw new LearningError(400, "INVALID_LEARNING_EVIDENCE");
  }
  const safeText = redact(text);
  if (!safeText || safeText.length > MAX_EVIDENCE_TEXT) {
    throw new LearningError(400, "INVALID_LEARNING_EVIDENCE");
  }
  return { source, text: safeText };
}

function evidenceIdsInput(body: Record<string, unknown>) {
  const { evidenceIds } = body;
  if (
    Object.keys(body).length !== 1 ||
    !Array.isArray(evidenceIds) ||
    evidenceIds.length === 0 ||
    evidenceIds.length > MAX_EVIDENCE_IDS ||
    !evidenceIds.every(
      (id): id is string => typeof id === "string" && UUID.test(id),
    ) ||
    new Set(evidenceIds).size !== evidenceIds.length
  ) {
    throw new LearningError(400, "INVALID_LEARNING_EVIDENCE_IDS");
  }
  return [...evidenceIds].sort();
}

function safeDraft(draft: SkillDraft): SkillDraft {
  if (
    !draft ||
    typeof draft.slug !== "string" ||
    !SLUG.test(draft.slug) ||
    draft.slug.length > 64 ||
    typeof draft.title !== "string" ||
    typeof draft.markdown !== "string" ||
    draft.title.length > 160 ||
    draft.markdown.length > MAX_SKILL_BODY
  ) {
    throw new LearningError(502, "INVALID_LEARNING_DRAFT");
  }
  const title = redact(draft.title.replace(/\s+/g, " "));
  const markdown = redact(
    draft.markdown.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*/, ""),
  );
  if (
    !title ||
    title.length > 160 ||
    !markdown ||
    markdown.length > MAX_SKILL_BODY ||
    redact(draft.slug) !== draft.slug
  ) {
    throw new LearningError(502, "INVALID_LEARNING_DRAFT");
  }
  return {
    slug: draft.slug,
    title,
    markdown: `---\nname: ${draft.slug}\ndescription: ${JSON.stringify(title)}\n---\n\n${markdown}\n`,
  };
}

function pageRequest(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? "25");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new LearningError(400, "INVALID_LEARNING_PAGE");
  }
  return { limit, offset };
}

function nextOffset<T>(rows: T[], limit: number, offset: number) {
  return rows.length > limit ? offset + limit : null;
}

function proposalFrom(row: ProposalRow): LearningProposal {
  return { ...row, evidenceIds: JSON.parse(row.evidenceIds) as string[] };
}

export function createLocalLearning({ dbPath, propose }: LearnOptions) {
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS local_learning_evidence (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL CHECK(source IN ('manual', 'recording')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_learning_proposal_requests (
      key_hash TEXT PRIMARY KEY,
      evidence_ids TEXT NOT NULL,
      claim TEXT,
      lease_until INTEGER NOT NULL,
      proposal_id TEXT REFERENCES local_learning_proposals(id)
    );
    CREATE TABLE IF NOT EXISTS local_learning_proposals (
      id TEXT PRIMARY KEY,
      evidence_ids TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'rejected')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      UNIQUE(slug, revision)
    );
    CREATE TABLE IF NOT EXISTS local_learning_reviews (
      action TEXT NOT NULL CHECK(action IN ('approve', 'reject')),
      key_hash TEXT NOT NULL,
      proposal_id TEXT NOT NULL REFERENCES local_learning_proposals(id),
      PRIMARY KEY(action, key_hash)
    );
  `);

  const evidenceColumns = "id, source, text, created_at AS createdAt";
  const proposalColumns = `id, evidence_ids AS evidenceIds, slug, title, markdown, revision, status,
    created_at AS createdAt, reviewed_at AS reviewedAt`;

  function getProposal(id: string) {
    const row = db
      .query<ProposalRow, [string]>(`
      SELECT ${proposalColumns} FROM local_learning_proposals WHERE id = ?
    `)
      .get(id);
    if (!row) throw new LearningError(404, "LEARNING_PROPOSAL_NOT_FOUND");
    return proposalFrom(row);
  }

  const saveEvidence = db.transaction(
    (key: string, input: ReturnType<typeof evidenceInput>) => {
      const result = db
        .query(`
      INSERT INTO local_learning_evidence (id, key_hash, source, text, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(key_hash) DO NOTHING
    `)
        .run(
          crypto.randomUUID(),
          key,
          input.source,
          input.text,
          new Date().toISOString(),
        );
      const evidence = db
        .query<LearningEvidence, [string]>(`
      SELECT ${evidenceColumns} FROM local_learning_evidence WHERE key_hash = ?
    `)
        .get(key);
      if (
        !evidence ||
        evidence.source !== input.source ||
        evidence.text !== input.text
      ) {
        throw new LearningError(409, "LEARNING_IDEMPOTENCY_CONFLICT");
      }
      return json({ evidence }, result.changes ? 201 : 200);
    },
  );

  const claimProposal = db.transaction((key: string, ids: string[]) => {
    const encodedIds = JSON.stringify(ids);
    const existing = db
      .query<
        { evidenceIds: string; proposalId: string | null; leaseUntil: number },
        [string]
      >(`
      SELECT evidence_ids AS evidenceIds, proposal_id AS proposalId, lease_until AS leaseUntil
      FROM local_learning_proposal_requests WHERE key_hash = ?
    `)
      .get(key);
    if (existing) {
      if (existing.evidenceIds !== encodedIds)
        throw new LearningError(409, "LEARNING_IDEMPOTENCY_CONFLICT");
      if (existing.proposalId)
        return { proposal: getProposal(existing.proposalId) };
      if (existing.leaseUntil > Date.now())
        throw new LearningError(409, "LEARNING_GENERATION_IN_PROGRESS");
    }
    const find = db.query<LearningEvidence, [string]>(`
      SELECT ${evidenceColumns} FROM local_learning_evidence WHERE id = ?
    `);
    const evidence = ids.map((id) => {
      const item = find.get(id);
      if (!item) throw new LearningError(404, "LEARNING_EVIDENCE_NOT_FOUND");
      return item;
    });
    const claim = crypto.randomUUID();
    db.query(`
      INSERT INTO local_learning_proposal_requests (key_hash, evidence_ids, claim, lease_until)
      VALUES (?, ?, ?, ?) ON CONFLICT(key_hash) DO UPDATE
      SET claim = excluded.claim, lease_until = excluded.lease_until
    `).run(key, encodedIds, claim, Date.now() + LEASE_MS);
    return { claim, evidence, encodedIds };
  });

  const finishProposal = db.transaction(
    (key: string, claim: string, ids: string, draft: SkillDraft) => {
      const row = db
        .query<{ claim: string }, [string]>(`
      SELECT claim FROM local_learning_proposal_requests WHERE key_hash = ?
    `)
        .get(key);
      if (row?.claim !== claim)
        throw new LearningError(409, "LEARNING_GENERATION_IN_PROGRESS");
      const id = crypto.randomUUID();
      db.query(`
      INSERT INTO local_learning_proposals (id, evidence_ids, slug, title, markdown, revision, status, created_at)
      VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(revision), 0) + 1 FROM local_learning_proposals WHERE slug = ?), 'pending', ?)
    `).run(
        id,
        ids,
        draft.slug,
        draft.title,
        draft.markdown,
        draft.slug,
        new Date().toISOString(),
      );
      db.query(`
      UPDATE local_learning_proposal_requests SET proposal_id = ?, claim = NULL, lease_until = 0
      WHERE key_hash = ? AND claim = ?
    `).run(id, key, claim);
      return getProposal(id);
    },
  );

  async function generateProposal(
    key: string,
    ids: string[],
    proposer = propose,
  ) {
    const held = claimProposal.immediate(key, ids);
    if (held.proposal) return json({ proposal: held.proposal });
    try {
      const signal = AbortSignal.timeout(90_000);
      const draft = safeDraft(
        await proposer({ evidence: held.evidence, signal }),
      );
      signal.throwIfAborted();
      return json(
        {
          proposal: finishProposal.immediate(
            key,
            held.claim,
            held.encodedIds,
            draft,
          ),
        },
        201,
      );
    } catch (error) {
      db.query(`
        UPDATE local_learning_proposal_requests SET claim = NULL, lease_until = 0
        WHERE key_hash = ? AND claim = ?
      `).run(key, held.claim);
      if (error instanceof LearningError) throw error;
      throw new LearningError(502, "LEARNING_GENERATION_FAILED");
    }
  }

  const review = db.transaction(
    (key: string, id: string, action: "approve" | "reject") => {
      const receipt = db
        .query<{ id: string }, [string, string]>(`
      SELECT proposal_id AS id FROM local_learning_reviews WHERE action = ? AND key_hash = ?
    `)
        .get(action, key);
      if (receipt && receipt.id !== id)
        throw new LearningError(409, "LEARNING_IDEMPOTENCY_CONFLICT");
      const proposal = getProposal(id);
      const status = action === "approve" ? "published" : "rejected";
      if (proposal.status !== "pending" && proposal.status !== status) {
        throw new LearningError(409, "LEARNING_PROPOSAL_ALREADY_REVIEWED");
      }
      if (proposal.status === "pending") {
        db.query(
          "UPDATE local_learning_proposals SET status = ?, reviewed_at = ? WHERE id = ?",
        ).run(status, new Date().toISOString(), id);
      }
      if (!receipt) {
        db.query(
          "INSERT INTO local_learning_reviews (action, key_hash, proposal_id) VALUES (?, ?, ?)",
        ).run(action, key, id);
      }
      return json({ proposal: getProposal(id) });
    },
  );

  const edit = db.transaction((id: string, body: Record<string, unknown>) => {
    const proposal = getProposal(id);
    if (proposal.status !== "pending") {
      throw new LearningError(409, "LEARNING_PROPOSAL_ALREADY_REVIEWED");
    }
    const { title, markdown, previousTitle, previousMarkdown } = body;
    if (
      typeof title !== "string" ||
      typeof markdown !== "string" ||
      typeof previousTitle !== "string" ||
      typeof previousMarkdown !== "string"
    ) {
      throw new LearningError(400, "INVALID_LEARNING_DRAFT");
    }
    let draft: SkillDraft;
    try {
      draft = safeDraft({ slug: proposal.slug, title, markdown });
    } catch {
      throw new LearningError(400, "INVALID_LEARNING_DRAFT");
    }
    if (
      draft.title === proposal.title &&
      draft.markdown === proposal.markdown
    ) {
      return json({ proposal });
    }
    if (
      previousTitle !== proposal.title ||
      previousMarkdown !== proposal.markdown
    ) {
      throw new LearningError(409, "LEARNING_PROPOSAL_CHANGED");
    }
    db.run(
      "UPDATE local_learning_proposals SET title = ?, markdown = ? WHERE id = ?",
      [draft.title, draft.markdown, id],
    );
    return json({ proposal: getProposal(id) });
  });

  const skillColumns =
    "slug, title, markdown, revision, reviewed_at AS publishedAt";

  function publishedSkills(): PublishedSkill[] {
    return db
      .query<PublishedSkill, []>(`
      SELECT ${skillColumns} FROM local_learning_proposals AS skill
      WHERE status = 'published' AND revision = (
        SELECT MAX(revision) FROM local_learning_proposals WHERE slug = skill.slug AND status = 'published'
      ) ORDER BY slug
    `)
      .all();
  }

  async function draftNextRecording(proposer: LearnOptions["propose"]) {
    const candidate = db
      .query<{ id: string }, [number]>(`
      SELECT evidence.id FROM local_learning_evidence AS evidence
      WHERE evidence.source = 'recording'
        AND NOT EXISTS (
          SELECT 1 FROM local_learning_proposals AS proposal, json_each(proposal.evidence_ids) AS linked
          WHERE linked.value = evidence.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM local_learning_proposal_requests AS request, json_each(request.evidence_ids) AS linked
          WHERE request.lease_until > ? AND linked.value = evidence.id
        )
      ORDER BY evidence.created_at, evidence.id LIMIT 1
    `)
      .get(Date.now());
    if (!candidate) return false;
    const response = await generateProposal(
      hash(`draft-${candidate.id}`),
      [candidate.id],
      proposer,
    );
    await response.body?.cancel();
    return response.status === 201;
  }

  return {
    publishedSkills,
    draftNextRecording,
    close: () => db.close(),
    // The caller authenticates the local account before dispatching a request here.
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`))
        return null;
      const path = url.pathname.slice(ROOT.length);
      try {
        const proposalId = path.match(/^\/proposals\/([^/]+)$/)?.[1];
        if (request.method === "PATCH" && proposalId && UUID.test(proposalId)) {
          return edit.immediate(proposalId, await inputObject(request));
        }
        if (request.method === "GET") {
          if (path === "/evidence") {
            const { limit, offset } = pageRequest(url);
            const rows = db
              .query<LearningEvidence, [number, number]>(`
              SELECT ${evidenceColumns} FROM local_learning_evidence ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
            `)
              .all(limit + 1, offset);
            return json({
              evidence: rows.slice(0, limit),
              nextOffset: nextOffset(rows, limit, offset),
            });
          }
          if (path === "/proposals") {
            const { limit, offset } = pageRequest(url);
            const rows = db
              .query<ProposalRow, [number, number]>(`
              SELECT ${proposalColumns} FROM local_learning_proposals ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
            `)
              .all(limit + 1, offset);
            return json({
              proposals: rows.slice(0, limit).map(proposalFrom),
              nextOffset: nextOffset(rows, limit, offset),
            });
          }
          if (path === "/skills") {
            const { limit, offset } = pageRequest(url);
            const rows = db
              .query<PublishedSkill, [number, number]>(`
              SELECT ${skillColumns} FROM local_learning_proposals WHERE status = 'published' ORDER BY slug, revision DESC LIMIT ? OFFSET ?
            `)
              .all(limit + 1, offset);
            return json({
              skills: rows.slice(0, limit),
              nextOffset: nextOffset(rows, limit, offset),
            });
          }
          if (proposalId && UUID.test(proposalId))
            return json({ proposal: getProposal(proposalId) });
        }
        if (request.method === "POST") {
          if (path === "/evidence")
            return saveEvidence.immediate(
              operationKey(request),
              evidenceInput(await inputObject(request)),
            );
          if (path === "/proposals")
            return await generateProposal(
              operationKey(request),
              evidenceIdsInput(await inputObject(request)),
            );
          const match = path.match(/^\/proposals\/([^/]+)\/(approve|reject)$/);
          const id = match?.[1];
          const action = match?.[2];
          if (
            id &&
            UUID.test(id) &&
            (action === "approve" || action === "reject")
          ) {
            const key = operationKey(request);
            if (Object.keys(await inputObject(request)).length)
              throw new LearningError(400, "INVALID_LEARNING_BODY");
            return review.immediate(key, id, action);
          }
        }
        return json({ error: "LEARNING_ROUTE_NOT_FOUND" }, 404);
      } catch (error) {
        if (error instanceof LearningError)
          return json({ error: error.code }, error.status);
        return json({ error: "LEARNING_STORAGE_FAILED" }, 500);
      }
    },
  };
}
