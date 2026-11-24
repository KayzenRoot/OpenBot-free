import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalLearning,
  type LearningEvidence,
  type LearningProposal,
  type SkillDraft,
} from "./learning";

const instances = new Set<ReturnType<typeof createLocalLearning>>();
const directories = new Set<string>();
const draft: SkillDraft = {
  slug: "review-notes",
  title: "Review notes",
  markdown: "# Review notes\nSummarize with citations and check open items.",
};

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "openbot-learning-"));
  directories.add(directory);
  return join(directory, "learning.sqlite");
}

function learning(
  dbPath = ":memory:",
  propose: Parameters<typeof createLocalLearning>[0]["propose"] = async () =>
    draft,
) {
  const instance = createLocalLearning({ dbPath, propose });
  instances.add(instance);
  return instance;
}

function close(instance: ReturnType<typeof createLocalLearning>) {
  instance.close();
  instances.delete(instance);
}

afterEach(() => {
  for (const instance of instances) close(instance);
  for (const directory of directories) {
    for (const file of [
      "learning.sqlite",
      "learning.sqlite-wal",
      "learning.sqlite-shm",
    ]) {
      rmSync(join(directory, file), { force: true });
    }
    rmdirSync(directory);
  }
  directories.clear();
});

async function call(
  instance: ReturnType<typeof createLocalLearning>,
  path: string,
  key?: string,
  body?: unknown,
) {
  const headers = new Headers();
  if (key) headers.set("idempotency-key", key);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await instance.handle(
    new Request(`http://127.0.0.1/api/local/learning${path}`, {
      method: key || body !== undefined ? "POST" : "GET",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  if (!response) throw new Error("Learning route did not respond");
  return response;
}

async function evidence(instance: ReturnType<typeof createLocalLearning>) {
  const response = await call(instance, "/evidence", "add-note", {
    source: "manual",
    text: "Verify links before sharing.",
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { evidence: LearningEvidence }).evidence;
}

async function proposal(response: Response, status: number) {
  expect(response.status).toBe(status);
  return ((await response.json()) as { proposal: LearningProposal }).proposal;
}

test("sanitizes evidence and generated SKILL.md, replays one request and persists review", async () => {
  const dbPath = databasePath();
  let generated = 0;
  const instance = learning(dbPath, async ({ evidence }) => {
    generated++;
    expect(evidence[0]?.text).toContain("Review the run notes");
    expect(evidence[0]?.text).not.toContain("test-evidence-secret");
    expect(evidence[0]?.text).not.toContain("test-evidence-bearer");
    return {
      ...draft,
      markdown: `${draft.markdown}\nAPI_KEY=test-draft-secret`,
    };
  });
  const raw = {
    source: "recording",
    text: "Review the run notes.\npassword=test-evidence-secret\nAuthorization: Bearer test-evidence-bearer",
  };
  const saved = await call(instance, "/evidence", "record-1", raw);
  expect(saved.status).toBe(201);
  expect(saved.headers.get("cache-control")).toBe("no-store");
  const item = ((await saved.json()) as { evidence: LearningEvidence })
    .evidence;
  expect(item.source).toBe("recording");
  expect(item.text).toContain("password=[redacted]");
  expect(item.text).not.toContain("test-evidence-secret");
  const replay = await call(instance, "/evidence", "record-1", raw);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ evidence: item });
  expect(
    (
      await call(instance, "/evidence", "record-1", {
        ...raw,
        text: "Something else",
      })
    ).status,
  ).toBe(409);

  const candidateRequest = { evidenceIds: [item.id] };
  const candidate = await proposal(
    await call(instance, "/proposals", "learn-1", candidateRequest),
    201,
  );
  expect(candidate.status).toBe("pending");
  expect(candidate.revision).toBe(1);
  expect(candidate.markdown).toStartWith(
    "---\nname: review-notes\ndescription:",
  );
  expect(candidate.markdown).not.toContain("test-draft-secret");
  expect(instance.publishedSkills()).toEqual([]);
  expect(
    await proposal(
      await call(instance, "/proposals", "learn-1", candidateRequest),
      200,
    ),
  ).toEqual(candidate);
  expect(generated).toBe(1);
  expect(await (await call(instance, "/proposals")).json()).toEqual({
    proposals: [candidate],
    nextOffset: null,
  });

  const approvalPath = `/proposals/${candidate.id}/approve`;
  const approved = await proposal(
    await call(instance, approvalPath, "approve-1"),
    200,
  );
  expect(approved.status).toBe("published");
  if (!approved.reviewedAt)
    throw new Error("Publication did not record a date");
  expect(
    await proposal(await call(instance, approvalPath, "approve-1", {}), 200),
  ).toEqual(approved);
  close(instance);
  expect(readFileSync(dbPath, "utf8")).not.toContain("test-evidence-secret");
  expect(readFileSync(dbPath, "utf8")).not.toContain("test-draft-secret");

  const restarted = learning(dbPath, async () => {
    throw new Error("generation should be replayed");
  });
  expect(
    await proposal(
      await call(restarted, "/proposals", "learn-1", candidateRequest),
      200,
    ),
  ).toEqual(approved);
  expect(
    await proposal(await call(restarted, `/proposals/${approved.id}`), 200),
  ).toEqual(approved);
  expect(restarted.publishedSkills()).toEqual([
    {
      slug: draft.slug,
      title: draft.title,
      markdown: approved.markdown,
      revision: 1,
      publishedAt: approved.reviewedAt,
    },
  ]);
  expect(
    (await call(restarted, `/proposals/${approved.id}/reject`, "reject-1"))
      .status,
  ).toBe(409);
});

test("serializes same-key generation, retries failed inference and preserves original evidence", async () => {
  const dbPath = databasePath();
  const generation = Promise.withResolvers<SkillDraft>();
  const entered = Promise.withResolvers<void>();
  const first = learning(dbPath, async () => {
    entered.resolve();
    return generation.promise;
  });
  let retryCalls = 0;
  const second = learning(dbPath, async () => {
    retryCalls++;
    return draft;
  });
  const item = await evidence(first);
  const body = { evidenceIds: [item.id] };
  const processing = call(first, "/proposals", "same", body);
  await entered.promise;
  expect((await call(second, "/proposals", "same", body)).status).toBe(409);
  expect(retryCalls).toBe(0);
  generation.reject(new Error("private provider detail"));
  const failed = await processing;
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "LEARNING_GENERATION_FAILED" });
  expect(
    (
      await call(second, "/proposals", "same", {
        evidenceIds: [crypto.randomUUID()],
      })
    ).status,
  ).toBe(409);
  const candidate = await proposal(
    await call(second, "/proposals", "same", body),
    201,
  );
  expect(retryCalls).toBe(1);
  expect(candidate.status).toBe("pending");
  const rejected = await proposal(
    await call(first, `/proposals/${candidate.id}/reject`, "review-1"),
    200,
  );
  expect(rejected.status).toBe("rejected");
  expect(
    await proposal(
      await call(first, `/proposals/${candidate.id}/reject`, "review-1"),
      200,
    ),
  ).toEqual(rejected);
  expect(
    (await call(second, `/proposals/${candidate.id}/approve`, "review-1"))
      .status,
  ).toBe(409);
  expect(second.publishedSkills()).toEqual([]);
});

test("selects the latest explicitly approved version and never supplies pending versions", async () => {
  const instance = learning();
  const item = await evidence(instance);
  const body = { evidenceIds: [item.id] };
  const first = await proposal(
    await call(instance, "/proposals", "first", body),
    201,
  );
  const second = await proposal(
    await call(instance, "/proposals", "second", body),
    201,
  );
  expect([first.revision, second.revision]).toEqual([1, 2]);
  await proposal(
    await call(instance, `/proposals/${second.id}/approve`, "review-second"),
    200,
  );
  expect(
    (await call(instance, `/proposals/${first.id}/approve`, "review-second"))
      .status,
  ).toBe(409);
  await proposal(
    await call(instance, `/proposals/${first.id}/approve`, "review-first"),
    200,
  );
  await proposal(await call(instance, "/proposals", "third", body), 201);
  expect(instance.publishedSkills().map((skill) => skill.revision)).toEqual([
    2,
  ]);
  const history = (await (await call(instance, "/skills?limit=1")).json()) as {
    skills: { revision: number }[];
    nextOffset: number | null;
  };
  expect(history.skills.map((skill) => skill.revision)).toEqual([2]);
  expect(history.nextOffset).toBe(1);
  expect(await (await call(instance, "/evidence?limit=0")).json()).toEqual({
    error: "INVALID_LEARNING_PAGE",
  });
});

test("rejects raw recording fields, invalid references and writes missing an idempotency key", async () => {
  const instance = learning();
  expect(
    (
      await call(instance, "/evidence", "invalid", {
        source: "recording",
        text: "Summary",
        cookie: "raw",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(instance, "/evidence", undefined, {
        source: "manual",
        text: "Summary",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(instance, "/proposals", "missing", {
        evidenceIds: [crypto.randomUUID()],
      })
    ).status,
  ).toBe(404);
  expect(
    await instance.handle(new Request("http://127.0.0.1/api/local/chat")),
  ).toBeNull();
});
