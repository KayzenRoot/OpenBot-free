import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentRoutes, type LocalAttachment } from "./attachments";
import { createChatStore } from "./chat-store";
import { createLocalLearning } from "./learning";
import { createLocalRoutines } from "./local-routines";
import { createLocalMemory } from "./memory";
import { backupProfile, restoreProfile } from "./profile-backup";
import { createLocalSocial } from "./social-queue";

const roots = new Set<string>();
const fixtureDirectories = ["active", "backup", "restored", "broken"];
const fixtureFiles = [
  "attachments.sqlite",
  "attachments.sqlite-wal",
  "attachments.sqlite-shm",
  "attachments.sqlite-journal",
  "conversations.sqlite",
  "conversations.sqlite-wal",
  "conversations.sqlite-shm",
  "conversations.sqlite-journal",
  "learning.sqlite",
  "learning.sqlite-wal",
  "learning.sqlite-shm",
  "learning.sqlite-journal",
  "memory.sqlite",
  "memory.sqlite-wal",
  "memory.sqlite-shm",
  "memory.sqlite-journal",
  "routines.sqlite",
  "routines.sqlite-wal",
  "routines.sqlite-shm",
  "routines.sqlite-journal",
  "social.sqlite",
  "social.sqlite-wal",
  "social.sqlite-shm",
  "social.sqlite-journal",
  "manifest.json",
  "credentials.json",
];

afterEach(() => {
  for (const root of roots) {
    for (const name of fixtureDirectories) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      for (const file of fixtureFiles)
        rmSync(join(path, file), { force: true });
      rmdirSync(path);
    }
    rmdirSync(root);
  }
  roots.clear();
});

function profileFixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-profile-test-"));
  roots.add(root);
  const active = join(root, "active");
  mkdirSync(active);
  const chat = createChatStore(join(active, "conversations.sqlite"));
  const attachments = createAttachmentRoutes({
    dbPath: join(active, "attachments.sqlite"),
    conversationExists: (id) => chat.getConversation(id) !== null,
  });
  const learning = createLocalLearning({
    dbPath: join(active, "learning.sqlite"),
    propose: async () => {
      throw new Error("The backup test should not use a model");
    },
  });
  const memory = createLocalMemory({ dbPath: join(active, "memory.sqlite") });
  let now = 1_800_000_000_000;
  const routines = createLocalRoutines({
    dbPath: join(active, "routines.sqlite"),
    now: () => now,
    run: async () => "Kept routine result",
  });
  const social = createLocalSocial({
    dbPath: join(active, "social.sqlite"),
    now: () => now,
    publishInstagram: Object.assign(
      async () => {
        throw new Error("Unexpected external publish");
      },
      { accountId: "17841400000000000" },
    ),
  });
  return {
    root,
    active,
    chat,
    learning,
    attachments,
    memory,
    routines,
    social,
    advance(minutes: number) {
      now += minutes * 60_000;
    },
    async close() {
      chat.close();
      learning.close();
      attachments.close();
      memory.close();
      await routines.close();
      await social.close();
    },
  };
}

test("backs up committed WAL data and restores chat, learning, attachments, memory and routines", async () => {
  const fixture = profileFixture();
  try {
    const {
      active,
      chat,
      root,
      learning,
      attachments,
      memory,
      routines,
      social,
    } = fixture;
    const conversation = chat.createConversation("Kept conversation");
    chat.beginTurn(conversation.id, "turn", "Kept prompt");
    chat.finishTurn(conversation.id, "turn", "completed", "Kept answer");
    const evidence = await learning.handle(
      new Request("http://127.0.0.1/api/local/learning/evidence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "evidence",
        },
        body: JSON.stringify({ source: "manual", text: "Kept evidence" }),
      }),
    );
    expect(evidence?.status).toBe(201);
    const attachmentPath = `/api/local/conversations/${conversation.id}/attachments`;
    const form = new FormData();
    form.set(
      "file",
      new File(["Retained file bytes"], "retained.txt", { type: "text/plain" }),
    );
    const upload = await attachments.handle(
      new Request(`http://127.0.0.1${attachmentPath}`, {
        method: "POST",
        body: form,
      }),
      attachmentPath,
    );
    expect(upload?.status).toBe(201);
    const uploaded = (await upload?.json()) as { attachment: LocalAttachment };
    const downloadPath = `${attachmentPath}/${uploaded.attachment.id}`;
    const memoryPath = "/api/local/memory";
    const savedMemory = await memory.handle(
      new Request(`http://127.0.0.1${memoryPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Use the agreed sprint agenda." }),
      }),
      memoryPath,
    );
    expect(savedMemory?.status).toBe(201);
    const memoryId = ((await savedMemory!.json()) as { memory: { id: string } })
      .memory.id;

    const routinesPath = "/api/local/routines";
    const savedRoutine = await routines.handle(
      new Request(`http://127.0.0.1${routinesPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Kept routine",
          prompt: "Summarize notes",
          timezone: "America/Sao_Paulo",
          intervalMinutes: 15,
          enabled: true,
        }),
      }),
      routinesPath,
    );
    expect(savedRoutine?.status).toBe(201);
    const routineId = (
      (await savedRoutine!.json()) as { routine: { id: string } }
    ).routine.id;
    fixture.advance(15);
    await routines.tick();
    const socialPath = "/api/local/social";
    const postSocial = (path: string, body: object) =>
      social.handle(
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        path,
      );
    const draft = await postSocial(socialPath, {
      platform: "instagram",
      caption: "Saved draft",
      imageUrl: "https://example.com/image.jpg",
      scheduledAt: "2030-01-01T09:00:00.000Z",
    });
    expect(draft?.status).toBe(201);
    const { item } = (await draft!.json()) as {
      item: { id: string; revision: number };
    };
    const approved = await postSocial(`${socialPath}/${item.id}/approve`, {
      revision: item.revision,
    });
    expect(await approved?.json()).toMatchObject({
      item: { status: "scheduled" },
    });
    writeFileSync(join(active, "credentials.json"), '{"test":"excluded"}');

    const copy = await backupProfile(active, join(root, "backup"));
    expect(readdirSync(copy.directory).sort()).toEqual([
      "attachments.sqlite",
      "conversations.sqlite",
      "learning.sqlite",
      "manifest.json",
      "memory.sqlite",
      "routines.sqlite",
      "social.sqlite",
    ]);
    expect(JSON.parse(readFileSync(copy.manifestPath, "utf8"))).toMatchObject({
      version: 4,
      databases: [
        {
          file: "conversations.sqlite",
          userVersion: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          file: "learning.sqlite",
          userVersion: 0,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          file: "attachments.sqlite",
          userVersion: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          file: "memory.sqlite",
          userVersion: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          file: "routines.sqlite",
          userVersion: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          file: "social.sqlite",
          userVersion: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });

    chat.createConversation("Created after backup");
    const removed = await attachments.handle(
      new Request(`http://127.0.0.1${downloadPath}`, { method: "DELETE" }),
      downloadPath,
    );
    expect(removed?.status).toBe(204);
    const restored = await restoreProfile(
      copy.directory,
      join(root, "restored"),
    );
    expect(restored.databases).toEqual([
      join(restored.directory, "conversations.sqlite"),
      join(restored.directory, "learning.sqlite"),
      join(restored.directory, "attachments.sqlite"),
      join(restored.directory, "memory.sqlite"),
      join(restored.directory, "routines.sqlite"),
      join(restored.directory, "social.sqlite"),
    ]);
    const schedule = (directory: string) => {
      const db = new Database(join(directory, "social.sqlite"), {
        readonly: true,
      });
      try {
        return db
          .query("SELECT status, error FROM local_social_posts WHERE id = ?")
          .get(item.id);
      } finally {
        db.close();
      }
    };
    expect(schedule(active)).toEqual({ status: "scheduled", error: null });
    expect(schedule(restored.directory)).toEqual({
      status: "needs_review",
      error: "SOCIAL_BACKUP_NEEDS_REVIEW",
    });
    expect(readFileSync(restored.manifestPath)).toEqual(
      readFileSync(copy.manifestPath),
    );
    expect(existsSync(join(restored.directory, "credentials.json"))).toBe(
      false,
    );
    expect(existsSync(join(active, "credentials.json"))).toBe(true);
    expect(chat.listConversations()).toHaveLength(2);
    const restoredChat = createChatStore(
      join(restored.directory, "conversations.sqlite"),
    );
    const restoredAttachments = createAttachmentRoutes({
      dbPath: join(restored.directory, "attachments.sqlite"),
      conversationExists: (id) => restoredChat.getConversation(id) !== null,
    });
    const restoredLearning = new Database(
      join(restored.directory, "learning.sqlite"),
      { readonly: true },
    );
    const restoredMemory = createLocalMemory({
      dbPath: join(restored.directory, "memory.sqlite"),
    });
    const restoredRoutines = createLocalRoutines({
      dbPath: join(restored.directory, "routines.sqlite"),
      run: async () => {
        throw new Error("Restore should not run a routine");
      },
    });
    try {
      expect(
        restoredChat.listConversations().map(({ title }) => title),
      ).toEqual(["Kept conversation"]);
      expect(restoredChat.listTurns(conversation.id)[0]?.answer).toBe(
        "Kept answer",
      );
      expect(
        restoredLearning
          .query("SELECT text FROM local_learning_evidence")
          .get(),
      ).toEqual({ text: "Kept evidence" });
      const download = await restoredAttachments.handle(
        new Request(`http://127.0.0.1${downloadPath}`),
        downloadPath,
      );
      expect(download?.status).toBe(200);
      expect(await download?.text()).toBe("Retained file bytes");
      expect(restoredMemory.relevant("sprint agenda")).toEqual([
        { id: memoryId, text: "Use the agreed sprint agenda." },
      ]);
      const historyPath = `${routinesPath}/${routineId}/runs`;
      const history = await restoredRoutines.handle(
        new Request(`http://127.0.0.1${historyPath}`),
        historyPath,
      );
      expect(await history?.json()).toMatchObject({
        runs: [{ status: "completed", answer: "Kept routine result" }],
      });
    } finally {
      restoredAttachments.close();
      restoredLearning.close();
      restoredChat.close();
      restoredMemory.close();
      await restoredRoutines.close();
    }
  } finally {
    await fixture.close();
  }
});

test("preserves existing destinations and rejects a changed file during restore", async () => {
  const fixture = profileFixture();
  try {
    const { active, root } = fixture;
    const archive = await backupProfile(active, join(root, "backup"));
    await expect(backupProfile(active, archive.directory)).rejects.toThrow();
    await expect(restoreProfile(archive.directory, active)).rejects.toThrow();
    appendFileSync(join(archive.directory, "attachments.sqlite"), "changed");
    const destination = join(root, "broken");
    await expect(
      restoreProfile(archive.directory, destination),
    ).rejects.toThrow("Checksum mismatch for attachments.sqlite");
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(active, "learning.sqlite"))).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("refuses a database with unexpected schema objects", async () => {
  const fixture = profileFixture();
  const db = new Database(join(fixture.active, "learning.sqlite"));
  try {
    db.run("CREATE TABLE unrelated_records (id INTEGER PRIMARY KEY)");
    const destination = join(fixture.root, "broken");
    await expect(backupProfile(fixture.active, destination)).rejects.toThrow(
      "Unexpected tables or objects in learning.sqlite",
    );
    expect(existsSync(destination)).toBe(false);
    expect(db.query("SELECT * FROM unrelated_records").all()).toEqual([]);
  } finally {
    db.close();
    await fixture.close();
  }
});

test.each([1, 2, 3] as const)(
  "restores a version %i manifest with its original database set",
  async (version) => {
    const fixture = profileFixture();
    try {
      const { active, root } = fixture;
      const archive = await backupProfile(active, join(root, "backup"));
      const current = JSON.parse(
        readFileSync(archive.manifestPath, "utf8"),
      ) as {
        createdAt: string;
        databases: { file: string }[];
      };
      const absentFiles = ["social.sqlite"];
      if (version < 3) absentFiles.push("memory.sqlite", "routines.sqlite");
      if (version === 1) absentFiles.push("attachments.sqlite");
      writeFileSync(
        archive.manifestPath,
        JSON.stringify({
          version,
          createdAt: current.createdAt,
          databases: current.databases.filter(
            ({ file }) => !absentFiles.includes(file),
          ),
        }),
      );
      for (const file of absentFiles) rmSync(join(archive.directory, file));

      const restored = await restoreProfile(
        archive.directory,
        join(root, "restored"),
      );
      expect(restored.databases).toHaveLength(version === 3 ? 5 : version + 1);
      expect(existsSync(join(restored.directory, "attachments.sqlite"))).toBe(
        version >= 2,
      );
      for (const file of absentFiles) {
        expect(existsSync(join(restored.directory, file))).toBe(false);
      }
    } finally {
      await fixture.close();
    }
  },
);
