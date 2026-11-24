import { Database } from "bun:sqlite";

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type TerminalTurnStatus = "completed" | "failed" | "cancelled";

export type ChatTurn = {
  id: string;
  prompt: string;
  answer: string | null;
  status: "running" | "interrupted" | TerminalTurnStatus;
  error: string | null;
};

export type BeginTurnResult =
  | "started"
  | "missing"
  | "busy"
  | "duplicate"
  | "conflict";

const migrations = [
  `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE chat_turns (
      sequence INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      answer TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')
      ),
      error TEXT,
      UNIQUE (conversation_id, id)
    );

    CREATE UNIQUE INDEX one_running_turn_per_conversation
      ON chat_turns(conversation_id) WHERE status = 'running';
  `,
];

export function createChatStore(dbPath: string) {
  const db = new Database(dbPath);

  try {
    db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;",
    );
    db.transaction(() => {
      const revision = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get();
      if (!revision)
        throw new Error("Could not read the chat database version");
      const version = revision.user_version;
      if (version > migrations.length) {
        throw new Error(`Unsupported chat database version ${version}`);
      }

      for (const [index, migration] of migrations.slice(version).entries()) {
        db.exec(migration);
        db.exec(`PRAGMA user_version = ${version + index + 1}`);
      }

      // One backend process owns a profile. Running rows from a previous process cannot resume.
      db.run(
        `UPDATE conversations SET updated_at = ?
         WHERE id IN (SELECT conversation_id FROM chat_turns WHERE status = 'running')`,
        [new Date().toISOString()],
      );
      db.run(
        `UPDATE chat_turns SET status = 'interrupted', error = 'The local backend restarted.'
         WHERE status = 'running'`,
      );
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const conversationColumns =
    "id, title, created_at AS createdAt, updated_at AS updatedAt";
  const insertConversation = db.query<
    unknown,
    [string, string, string, string]
  >(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  const allConversations = db.query<Conversation, []>(
    `SELECT ${conversationColumns} FROM conversations ORDER BY updated_at DESC, rowid DESC`,
  );
  const conversationById = db.query<Conversation, [string]>(
    `SELECT ${conversationColumns} FROM conversations WHERE id = ?`,
  );
  const touchConversation = db.query<unknown, [string, string]>(
    "UPDATE conversations SET updated_at = ? WHERE id = ?",
  );
  const turnsByConversation = db.query<ChatTurn, [string]>(
    `SELECT id, prompt, answer, status, error FROM chat_turns
     WHERE conversation_id = ? ORDER BY sequence`,
  );
  const turnById = db.query<{ prompt: string }, [string, string]>(
    "SELECT prompt FROM chat_turns WHERE conversation_id = ? AND id = ?",
  );
  const runningTurn = db.query<{ id: string }, [string]>(
    "SELECT id FROM chat_turns WHERE conversation_id = ? AND status = 'running'",
  );
  const insertTurn = db.query<unknown, [string, string, string]>(
    "INSERT INTO chat_turns (conversation_id, id, prompt, status) VALUES (?, ?, ?, 'running')",
  );
  const updateTurn = db.query<
    unknown,
    [TerminalTurnStatus, string | null, string | null, string, string]
  >(
    `UPDATE chat_turns SET status = ?, answer = ?, error = ?
     WHERE conversation_id = ? AND id = ? AND status = 'running'`,
  );

  const beginTurn = db.transaction(
    (conversationId: string, id: string, prompt: string): BeginTurnResult => {
      if (!conversationById.get(conversationId)) return "missing";

      const existing = turnById.get(conversationId, id);
      if (existing)
        return existing.prompt === prompt ? "duplicate" : "conflict";
      if (runningTurn.get(conversationId)) return "busy";

      insertTurn.run(conversationId, id, prompt);
      touchConversation.run(new Date().toISOString(), conversationId);
      return "started";
    },
  );

  const finishTurn = db.transaction(
    (
      conversationId: string,
      id: string,
      status: TerminalTurnStatus,
      answer?: string,
      error?: string,
    ) => {
      const result = updateTurn.run(
        status,
        answer ?? null,
        error ?? null,
        conversationId,
        id,
      );
      if (result.changes !== 1) return false;

      touchConversation.run(new Date().toISOString(), conversationId);
      return true;
    },
  );

  const removeConversation = db.transaction((id: string) => {
    if (runningTurn.get(id)) return "busy";
    db.run("DELETE FROM conversations WHERE id = ?", [id]);
    return "removed";
  });

  return {
    close: () => db.close(),
    createConversation(title?: string): Conversation {
      const id = crypto.randomUUID();
      const name = title?.trim() || "New conversation";
      const now = new Date().toISOString();
      insertConversation.run(id, name, now, now);
      return { id, title: name, createdAt: now, updatedAt: now };
    },
    listConversations: () => allConversations.all(),
    getConversation: (id: string) => conversationById.get(id),
    renameConversation(id: string, title: string) {
      return db
        .query<Conversation, [string, string, string]>(
          `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? RETURNING ${conversationColumns}`,
        )
        .get(title.trim(), new Date().toISOString(), id);
    },
    removeConversation: removeConversation.immediate,
    listTurns: (conversationId: string) =>
      turnsByConversation.all(conversationId),
    beginTurn: beginTurn.immediate,
    finishTurn: finishTurn.immediate,
  };
}
