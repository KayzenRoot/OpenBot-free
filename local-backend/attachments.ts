import { Database } from "bun:sqlite";
import {
  DOWNLOAD_CONTENT_TYPE,
  downloadHeaders,
} from "../shared/file-download";

export const LOCAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const LOCAL_ATTACHMENT_REQUEST_BYTES =
  LOCAL_ATTACHMENT_BYTES + 64 * 1024;

export type LocalAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

const attachmentPath =
  /^\/api\/local\/conversations\/([A-Za-z0-9_-]{1,128})\/attachments(?:\/([A-Za-z0-9_-]{1,128}))?$/;
const noStore = { "cache-control": "private, no-store" };
const metadataColumns =
  "id, filename, mime_type AS mimeType, size, created_at AS createdAt";

function problem(status: number, error: string, allow?: string) {
  return Response.json(
    { error },
    {
      status,
      headers: allow ? { ...noStore, allow } : noStore,
    },
  );
}

function safeFilename(name: string): string {
  const leaf = name.toWellFormed().split(/[\\/]/).at(-1) ?? "";
  const normalized = Array.from(leaf.normalize("NFC"), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 ||
      code === 127 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      '<>"|?*:'.includes(char)
      ? "_"
      : char;
  })
    .join("")
    .trim();
  const safe = Array.from(normalized)
    .slice(0, 180)
    .join("")
    .replace(/[. ]+$/, "");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe))
    return `_${safe}`;
  return safe || "download";
}

function safeMimeType(value: string): string {
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  const token = "[a-z0-9][a-z0-9!#$&^_.+*-]*";
  return mime.length <= 127 && new RegExp(`^${token}/${token}$`).test(mime)
    ? mime
    : DOWNLOAD_CONTENT_TYPE;
}

async function readUpload(request: Request): Promise<File | Response> {
  const type = request.headers.get("content-type");
  if (type?.split(";")[0]?.trim().toLowerCase() !== "multipart/form-data") {
    return problem(415, "MULTIPART_REQUIRED");
  }
  if (
    Number(request.headers.get("content-length")) >
    LOCAL_ATTACHMENT_REQUEST_BYTES
  ) {
    return problem(413, "ATTACHMENT_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) return problem(400, "INVALID_ATTACHMENT");

  try {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > LOCAL_ATTACHMENT_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return problem(413, "ATTACHMENT_TOO_LARGE");
      }
      chunks.push(result.value);
    }
    const form = await new Response(new Blob(chunks), {
      headers: { "content-type": type },
    }).formData();
    const values = form.getAll("file");
    const file = values[0];
    if (values.length !== 1 || !(file instanceof File)) {
      return problem(400, "INVALID_ATTACHMENT");
    }
    if (file.size > LOCAL_ATTACHMENT_BYTES)
      return problem(413, "ATTACHMENT_TOO_LARGE");
    return file;
  } catch {
    return problem(400, "INVALID_ATTACHMENT");
  } finally {
    reader.releaseLock();
  }
}

export function createAttachmentRoutes(options: {
  dbPath: string;
  conversationExists: (conversationId: string) => boolean;
}) {
  const db = new Database(options.dbPath);

  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    db.transaction(() => {
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version === 1) return;
      if (version !== 0)
        throw new Error(`Unsupported attachment database version ${version}`);
      db.exec(`CREATE TABLE local_attachments (
        sequence INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size BETWEEN 0 AND ${LOCAL_ATTACHMENT_BYTES}),
        created_at TEXT NOT NULL,
        body BLOB NOT NULL CHECK(length(body) = size),
        UNIQUE (conversation_id, id)
      );
      CREATE INDEX local_attachments_by_conversation ON local_attachments(conversation_id, sequence);
      PRAGMA user_version = 1;`);
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const list = db.query<LocalAttachment, [string]>(
    `SELECT ${metadataColumns} FROM local_attachments WHERE conversation_id = ? ORDER BY sequence`,
  );
  const insert = db.query<
    unknown,
    [string, string, string, string, number, string, Uint8Array]
  >(
    `INSERT INTO local_attachments (conversation_id, id, filename, mime_type, size, created_at, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.query<
    { filename: string; size: number; body: Uint8Array<ArrayBuffer> },
    [string, string]
  >(
    "SELECT filename, size, body FROM local_attachments WHERE conversation_id = ? AND id = ?",
  );
  const remove = db.query<unknown, [string, string]>(
    "DELETE FROM local_attachments WHERE conversation_id = ? AND id = ?",
  );
  const removeAll = db.query<unknown, [string]>(
    "DELETE FROM local_attachments WHERE conversation_id = ?",
  );
  const attachmentConversations = db.query<{ id: string }, []>(
    "SELECT DISTINCT conversation_id AS id FROM local_attachments",
  );
  db.transaction(() => {
    for (const { id } of attachmentConversations.all()) {
      if (!options.conversationExists(id)) removeAll.run(id);
    }
  }).immediate();

  async function upload(request: Request, conversationId: string) {
    const file = await readUpload(request);
    if (file instanceof Response) return file;
    const body = new Uint8Array(await file.arrayBuffer());
    if (!options.conversationExists(conversationId))
      return problem(404, "CONVERSATION_NOT_FOUND");

    const attachment: LocalAttachment = {
      id: crypto.randomUUID(),
      filename: safeFilename(file.name),
      mimeType: safeMimeType(file.type),
      size: body.byteLength,
      createdAt: new Date().toISOString(),
    };
    insert.run(
      conversationId,
      attachment.id,
      attachment.filename,
      attachment.mimeType,
      attachment.size,
      attachment.createdAt,
      body,
    );
    return Response.json({ attachment }, { status: 201, headers: noStore });
  }

  return {
    close: () => db.close(),
    removeConversationFiles: (id: string) => removeAll.run(id),
    async handle(request: Request, pathname: string): Promise<Response | null> {
      const match = attachmentPath.exec(pathname);
      const conversationId = match?.[1];
      if (!conversationId) return null;
      const attachmentId = match?.[2];

      try {
        if (!options.conversationExists(conversationId))
          return problem(404, "CONVERSATION_NOT_FOUND");
        if (!attachmentId) {
          if (request.method === "GET") {
            return Response.json(
              { attachments: list.all(conversationId) },
              { headers: noStore },
            );
          }
          if (request.method === "POST")
            return await upload(request, conversationId);
          return problem(405, "METHOD_NOT_ALLOWED", "GET, POST");
        }
        if (request.method === "GET") {
          const file = get.get(conversationId, attachmentId);
          return file
            ? new Response(file.body, {
                headers: downloadHeaders(file.filename, file.size),
              })
            : problem(404, "ATTACHMENT_NOT_FOUND");
        }
        if (request.method === "DELETE") {
          const result = remove.run(conversationId, attachmentId);
          return result.changes === 1
            ? new Response(null, { status: 204, headers: noStore })
            : problem(404, "ATTACHMENT_NOT_FOUND");
        }
        return problem(405, "METHOD_NOT_ALLOWED", "GET, DELETE");
      } catch {
        return problem(500, "ATTACHMENT_STORAGE_FAILED");
      }
    },
  };
}
