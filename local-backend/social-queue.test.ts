import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishInstagram } from "./social-instagram";
import { createLocalSocial, type LocalSocialPost } from "./social-queue";

const collection = "/api/local/social";
const time = Date.parse("2026-11-23T12:00:00Z");
const due = time + 60_000;
const account = "1784000000000000";
const media = "1793000000000000";
const container = "1793000000000001";
const draft = {
  platform: "instagram",
  caption: "A photo with an approved caption",
  imageUrl: "https://images.example.com/image.jpg",
  scheduledAt: new Date(due).toISOString(),
};

type Store = ReturnType<typeof createLocalSocial>;
type Runner = (
  input: Parameters<PublishInstagram>[0],
) => ReturnType<PublishInstagram>;

function publisher(publish: Runner, accountId = account): PublishInstagram {
  return Object.assign(publish, { accountId });
}

async function call(store: Store, method: string, suffix = "", data?: object) {
  const path = collection + suffix;
  const response = await store.handle(
    new Request(`http://127.0.0.1${path}`, {
      method,
      ...(data
        ? {
            body: JSON.stringify(data),
            headers: { "content-type": "application/json" },
          }
        : {}),
    }),
    path,
  );
  if (!response) throw new Error("The social route did not respond");
  return response;
}

async function readItem(response: Response, status = 200) {
  expect(response.status).toBe(status);
  return ((await response.json()) as { item: LocalSocialPost }).item;
}

async function add(store: Store, body: object = draft) {
  return readItem(await call(store, "POST", "", body), 201);
}

async function approve(store: Store, post: LocalSocialPost) {
  return readItem(
    await call(store, "POST", `/${post.id}/approve`, {
      revision: post.revision,
    }),
  );
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openbot-social-"));
  const dbPath = join(directory, "social.sqlite");
  return {
    dbPath,
    cleanup() {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
        rmSync(path, { force: true });
      rmdirSync(directory);
    },
  };
}

test("requires approval of the current draft revision and claims a scheduled item only once", async () => {
  let clock = time;
  let calls = 0;
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Awaited<ReturnType<Runner>>>();
  const store = createLocalSocial({
    dbPath: ":memory:",
    now: () => clock,
    publishInstagram: publisher(
      async ({ caption, imageUrl, recordContainer }) => {
        calls += 1;
        expect(caption).toBe("Edited text");
        expect(imageUrl).toBe(draft.imageUrl);
        recordContainer(container);
        reached.resolve();
        return release.promise;
      },
    ),
  });
  try {
    const original = await add(store, {
      ...draft,
      status: "scheduled",
      approvedAt: draft.scheduledAt,
    });
    expect(original.status).toBe("draft");
    expect(original.approvedAt).toBeNull();
    const edited = await readItem(
      await call(store, "PATCH", `/${original.id}`, { caption: "Edited text" }),
    );
    expect(edited.revision).toBe(original.revision + 1);
    expect(
      (
        await call(store, "POST", `/${original.id}/approve`, {
          revision: original.revision,
        })
      ).status,
    ).toBe(409);
    const approved = await approve(store, edited);
    expect(approved).toMatchObject({
      status: "scheduled",
      instagramAccountId: account,
    });
    expect(
      (await call(store, "PATCH", `/${edited.id}`, { caption: "Too late" }))
        .status,
    ).toBe(409);
    await store.tick();
    expect(calls).toBe(0);

    clock = due;
    const tick = store.tick();
    await reached.promise;
    await store.tick();
    expect(calls).toBe(1);
    expect(
      await readItem(await call(store, "GET", `/${edited.id}`)),
    ).toMatchObject({
      status: "publishing",
      containerId: container,
      claimedAt: new Date(due).toISOString(),
    });
    expect((await call(store, "POST", `/${edited.id}/cancel`)).status).toBe(
      409,
    );

    release.resolve({ kind: "published", mediaId: media });
    await tick;
    clock += 60_000;
    await store.tick();
    expect(calls).toBe(1);
    expect(
      await readItem(await call(store, "GET", `/${edited.id}`)),
    ).toMatchObject({
      status: "published",
      remoteId: media,
      containerId: container,
      resultSource: "api",
    });
  } finally {
    release.resolve({ kind: "published", mediaId: media });
    await store.close();
  }
});

test("disables Instagram without configuration and supports an approved manual Facebook handoff", async () => {
  let clock = time;
  const store = createLocalSocial({ dbPath: ":memory:", now: () => clock });
  try {
    expect(await (await call(store, "GET")).json()).toMatchObject({
      instagramConfigured: false,
      instagramAccountId: null,
    });
    const instagram = await add(store);
    expect(
      (
        await call(store, "POST", `/${instagram.id}/approve`, {
          revision: instagram.revision,
        })
      ).status,
    ).toBe(409);

    const input = {
      platform: "facebook_group",
      caption: "Link to verify",
      groupUrl: "https://m.facebook.com/groups/team.name?tracking=stop#notice",
      scheduledAt: draft.scheduledAt,
    };
    for (const groupUrl of [
      "https://www.facebook.com.evil.invalid/groups/admin",
      "https://www.facebook.com/group/admin",
      "https://www.facebook.com/groups/team/posts/101",
    ]) {
      expect(
        (await call(store, "POST", "", { ...input, groupUrl })).status,
      ).toBe(400);
    }

    const group = await add(store, input);
    expect(group.groupUrl).toBe("https://www.facebook.com/groups/team.name/");
    expect((await approve(store, group)).status).toBe("scheduled");
    expect(
      (
        await call(store, "POST", `/${group.id}/record`, {
          outcome: "published",
        })
      ).status,
    ).toBe(409);
    clock = due;
    await store.tick();
    expect(
      await readItem(await call(store, "GET", `/${group.id}`)),
    ).toMatchObject({ status: "manual_ready", remoteId: null });
    const result = await readItem(
      await call(store, "POST", `/${group.id}/record`, {
        outcome: "published",
        resultUrl:
          "https://www.facebook.com/groups/team.name/posts/123?context=hidden",
      }),
    );
    expect(result).toMatchObject({
      status: "published",
      resultSource: "manual",
      resultUrl: "https://www.facebook.com/groups/team.name/posts/123",
      remoteId: null,
    });
  } finally {
    await store.close();
  }
});

test("keeps an indeterminate acknowledgement in review and permits explicit resolution", async () => {
  let calls = 0;
  const store = createLocalSocial({
    dbPath: ":memory:",
    now: () => due,
    publishInstagram: publisher(async ({ recordContainer }) => {
      calls += 1;
      recordContainer(container);
      throw new Error("Private transport error");
    }),
  });
  try {
    const post = await add(store);
    await approve(store, post);
    await store.tick();
    await store.tick();
    expect(calls).toBe(1);
    expect(
      await readItem(await call(store, "GET", `/${post.id}`)),
    ).toMatchObject({
      status: "needs_review",
      containerId: container,
      remoteId: null,
      error: "INSTAGRAM_PUBLISH_OUTCOME_UNKNOWN",
    });
    expect(
      (
        await call(store, "POST", `/${post.id}/approve`, {
          revision: post.revision,
        })
      ).status,
    ).toBe(409);
    const reviewed = await readItem(
      await call(store, "POST", `/${post.id}/record`, {
        outcome: "not_published",
      }),
    );
    expect(reviewed).toMatchObject({
      status: "failed",
      resultSource: "manual",
      error: "USER_CONFIRMED_NOT_PUBLISHED",
    });
  } finally {
    await store.close();
  }
});

test("cancels unclaimed items, and requires an explicit schedule for Instagram", async () => {
  let calls = 0;
  const store = createLocalSocial({
    dbPath: ":memory:",
    now: () => due,
    publishInstagram: publisher(async () => {
      calls += 1;
      return { kind: "published", mediaId: media };
    }),
  });
  try {
    const unscheduled = await add(store, { ...draft, scheduledAt: null });
    const rejected = await call(store, "POST", `/${unscheduled.id}/approve`, {
      revision: unscheduled.revision,
    });
    expect(await rejected.json()).toEqual({
      error: "SOCIAL_SCHEDULE_REQUIRED",
    });
    const scheduled = await add(store);
    await approve(store, scheduled);
    expect(
      (await readItem(await call(store, "POST", `/${scheduled.id}/cancel`)))
        .status,
    ).toBe("cancelled");
    await store.tick();
    expect(calls).toBe(0);
  } finally {
    await store.close();
  }
});

test("reopening keeps in-flight publications in review and never retargets approved posts", async () => {
  const { dbPath, cleanup } = fixture();
  let calls = 0;
  const emit: Runner = async () => {
    calls += 1;
    return { kind: "published", mediaId: media };
  };
  try {
    const before = createLocalSocial({
      dbPath,
      now: () => time,
      publishInstagram: publisher(emit),
    });
    let previous: LocalSocialPost;
    let scheduled: LocalSocialPost;
    try {
      previous = await approve(before, await add(before));
      scheduled = await approve(before, await add(before));
    } finally {
      await before.close();
    }

    const db = new Database(dbPath);
    try {
      db.run(
        "UPDATE local_social_posts SET status = 'publishing', claimed_at = ?, container_id = ? WHERE id = ?",
        [due, container, previous.id],
      );
    } finally {
      db.close();
    }

    const restarted = createLocalSocial({
      dbPath,
      now: () => due + 60_000,
      publishInstagram: publisher(emit, "1234"),
    });
    try {
      await restarted.tick();
      expect(calls).toBe(0);
      expect(
        await readItem(await call(restarted, "GET", `/${previous.id}`)),
      ).toMatchObject({
        status: "needs_review",
        containerId: container,
        error: "SOCIAL_RESTART_DURING_PUBLISH",
      });
      expect(
        await readItem(await call(restarted, "GET", `/${scheduled.id}`)),
      ).toMatchObject({
        status: "needs_review",
        instagramAccountId: account,
        error: "INSTAGRAM_ACCOUNT_CHANGED",
      });
    } finally {
      await restarted.close();
    }
  } finally {
    cleanup();
  }
});
