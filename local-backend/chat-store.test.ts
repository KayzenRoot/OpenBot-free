import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatStore } from "./chat-store";

test("stores conversations and keeps each conversation's ordered turns separate", () => {
  const store = createChatStore(":memory:");
  try {
    const first = store.createConversation("First");
    const second = store.createConversation();

    expect(second.title).toBe("New conversation");
    expect(new Set(store.listConversations().map(({ id }) => id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(store.getConversation(first.id)).toEqual(first);
    expect(store.getConversation("missing")).toBeNull();
    expect(store.listTurns("missing")).toEqual([]);
    expect(store.beginTurn("missing", "turn", "Missing")).toBe("missing");

    expect(store.beginTurn(first.id, "z", "First prompt")).toBe("started");
    expect(store.beginTurn(second.id, "z", "Other prompt")).toBe("started");
    expect(store.finishTurn(first.id, "z", "completed", "Answer")).toBe(true);
    expect(store.beginTurn(first.id, "a", "Second prompt")).toBe("started");
    expect(store.listTurns(first.id)).toEqual([
      {
        id: "z",
        prompt: "First prompt",
        answer: "Answer",
        status: "completed",
        error: null,
      },
      {
        id: "a",
        prompt: "Second prompt",
        answer: null,
        status: "running",
        error: null,
      },
    ]);
    expect(store.listTurns(second.id)).toEqual([
      {
        id: "z",
        prompt: "Other prompt",
        answer: null,
        status: "running",
        error: null,
      },
    ]);
  } finally {
    store.close();
  }
});

test("locks a conversation while a turn is running and preserves terminal turns", () => {
  const store = createChatStore(":memory:");
  try {
    const { id } = store.createConversation();

    expect(store.beginTurn(id, "turn-1", "Prompt")).toBe("started");
    expect(store.beginTurn(id, "turn-1", "Prompt")).toBe("duplicate");
    expect(store.beginTurn(id, "turn-1", "Changed prompt")).toBe("conflict");
    expect(store.beginTurn(id, "turn-2", "Next prompt")).toBe("busy");
    expect(store.finishTurn(id, "turn-2", "completed", "Other answer")).toBe(
      false,
    );
    expect(
      store.finishTurn(id, "turn-1", "failed", undefined, "Provider failed"),
    ).toBe(true);
    expect(store.finishTurn(id, "turn-1", "completed", "Late answer")).toBe(
      false,
    );
    expect(store.beginTurn(id, "turn-1", "Prompt")).toBe("duplicate");
    expect(store.beginTurn(id, "turn-2", "Next prompt")).toBe("started");
    expect(store.finishTurn(id, "turn-2", "cancelled")).toBe(true);

    expect(store.listTurns(id)).toEqual([
      {
        id: "turn-1",
        prompt: "Prompt",
        status: "failed",
        answer: null,
        error: "Provider failed",
      },
      {
        id: "turn-2",
        prompt: "Next prompt",
        status: "cancelled",
        answer: null,
        error: null,
      },
    ]);
  } finally {
    store.close();
  }
});

test("persists metadata and finished turns, then releases interrupted work on reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-chat-store-"));
  const dbPath = join(dir, "chat.sqlite");
  try {
    const original = createChatStore(dbPath);
    const conversation = original.createConversation("Persistent");
    try {
      expect(
        original.beginTurn(conversation.id, "done", "Finished prompt"),
      ).toBe("started");
      expect(
        original.finishTurn(
          conversation.id,
          "done",
          "completed",
          "Stored answer",
        ),
      ).toBe(true);
      expect(
        original.beginTurn(conversation.id, "active", "In-flight prompt"),
      ).toBe("started");
    } finally {
      original.close();
    }

    const reopened = createChatStore(dbPath);
    try {
      expect(reopened.getConversation(conversation.id)).toMatchObject({
        title: "Persistent",
        createdAt: conversation.createdAt,
      });
      expect(reopened.listTurns(conversation.id)).toEqual([
        {
          id: "done",
          prompt: "Finished prompt",
          answer: "Stored answer",
          status: "completed",
          error: null,
        },
        {
          id: "active",
          prompt: "In-flight prompt",
          answer: null,
          status: "interrupted",
          error: "The local backend restarted.",
        },
      ]);
      expect(
        reopened.finishTurn(
          conversation.id,
          "active",
          "completed",
          "Stale answer",
        ),
      ).toBe(false);
      expect(reopened.beginTurn(conversation.id, "replacement", "Retry")).toBe(
        "started",
      );
      expect(
        reopened.finishTurn(
          conversation.id,
          "replacement",
          "completed",
          "Result",
        ),
      ).toBe(true);
    } finally {
      reopened.close();
    }

    const db = new Database(dbPath);
    try {
      expect(db.query("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
    } finally {
      db.close();
    }
  } finally {
    for (const file of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
      rmSync(file, { force: true });
    }
    rmdirSync(dir);
  }
});
