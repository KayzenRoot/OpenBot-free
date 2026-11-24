import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type Ebook, exportEpub } from "./epub";
import {
  renderStudioArtwork,
  type StudioArtwork,
} from "./studio-pilot-artwork";

const root = "/api/local/studio/books";
const bookPath =
  /^([a-z0-9-]{36})(?:\/(revisions|export)(?:\/([a-z0-9-]+))?)?$/;
const maxBody = 128 * 1024;
const maxBookBytes = 126 * 1024;
const pageSize = 100;
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export type CoverTheme = "verde" | "azul" | "terra";

type StudioSource = { title: string; url: string };
type Fields = Ebook & {
  audience: string;
  promise: string;
  coverTheme: CoverTheme;
  sources: StudioSource[];
  outline: string[];
};

export type StudioBook = Fields & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type StudioSummary = Pick<
  StudioBook,
  "id" | "title" | "author" | "revision" | "createdAt" | "updatedAt"
>;
type BookRow = Pick<
  StudioBook,
  "id" | "revision" | "createdAt" | "updatedAt"
> & {
  content: string;
};

const defaults: Fields = {
  title: "",
  author: "",
  audience: "",
  promise: "",
  coverTheme: "verde",
  sources: [],
  outline: [],
  chapters: [],
};

class StudioError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function json(data: object, status = 200) {
  return Response.json(data, { status, headers });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new StudioError(415, "JSON_REQUIRED");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new StudioError(400, "STUDIO_INVALID_JSON");
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let input = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBody) {
        void reader.cancel().catch(() => {});
        throw new StudioError(413, "STUDIO_BODY_TOO_LARGE");
      }
      input += decoder.decode(result.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(input + decoder.decode());
    if (object(parsed)) return parsed;
  } catch (error) {
    if (error instanceof StudioError) throw error;
  } finally {
    reader.releaseLock();
  }
  throw new StudioError(400, "STUDIO_INVALID_JSON");
}

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max) {
    throw new StudioError(400, "STUDIO_INVALID_BOOK");
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (
      (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point === 0xfffe ||
      point === 0xffff
    ) {
      throw new StudioError(400, "STUDIO_INVALID_BOOK");
    }
  }
  const normalized = value.trim();
  if (required && !normalized)
    throw new StudioError(400, "STUDIO_INVALID_BOOK");
  return normalized;
}

function array<T>(
  value: unknown,
  maximum: number,
  validate: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new StudioError(400, "STUDIO_INVALID_BOOK");
  }
  return value.map(validate);
}

function source(value: unknown): StudioSource {
  if (!object(value)) throw new StudioError(400, "STUDIO_INVALID_BOOK");
  const title = text(value.title, 200, true);
  const url = text(value.url, 1_500);
  if (!url) return { title, url };
  try {
    const parsed = new URL(url);
    if (
      /^https?:$/.test(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    ) {
      return { title, url: parsed.href };
    }
  } catch {
    // Use the same response for malformed and unsupported URLs.
  }
  throw new StudioError(400, "STUDIO_INVALID_SOURCE");
}

function bookFields(
  data: Record<string, unknown>,
  previous: Fields = defaults,
): Fields {
  const raw = { ...previous, ...data };
  const { coverTheme } = raw;
  if (
    coverTheme !== "verde" &&
    coverTheme !== "azul" &&
    coverTheme !== "terra"
  ) {
    throw new StudioError(400, "STUDIO_INVALID_BOOK");
  }
  const fields: Fields = {
    title: text(raw.title, 180, true),
    author: text(raw.author, 180),
    audience: text(raw.audience, 2_000),
    promise: text(raw.promise, 750),
    coverTheme,
    sources: array(raw.sources, 50, source),
    outline: array(raw.outline, 80, (item) => text(item, 220, true)),
    chapters: array(raw.chapters, 60, (item) => {
      if (!object(item)) throw new StudioError(400, "STUDIO_INVALID_BOOK");
      return {
        title: text(item.title, 180, true),
        text: text(item.text, 80_000),
      };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(fields)) > maxBookBytes) {
    throw new StudioError(413, "STUDIO_BOOK_TOO_LARGE");
  }
  return fields;
}

function revisionNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new StudioError(400, "STUDIO_INVALID_REVISION");
  }
  return value;
}

function filename(title: string, suffix: string) {
  const base = [...title.replace(/[<>:"/\\|?*\r\n\t]/g, "-")]
    .slice(0, 80)
    .join("");
  return encodeURIComponent(`${base}${suffix}`).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function download(
  book: StudioBook,
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
  suffix: string,
) {
  const ext = suffix.split(".").at(-1);
  return new Response(bytes, {
    headers: {
      ...headers,
      "content-type": type,
      "content-disposition": `attachment; filename="ebook.${ext}"; filename*=UTF-8''${filename(book.title, suffix)}`,
    },
  });
}

function materialize({ content, ...row }: BookRow): StudioBook {
  return { ...(JSON.parse(content) as Fields), ...row };
}

const currentBook = `SELECT book.id, book.revision, book.created_at AS createdAt, book.updated_at AS updatedAt,
  revision.content FROM local_studio_books AS book JOIN local_studio_revisions AS revision
  ON revision.book_id = book.id AND revision.revision = book.revision`;
const historicalBook = `SELECT book.id, revision.revision, book.created_at AS createdAt, revision.created_at AS updatedAt,
  revision.content FROM local_studio_revisions AS revision JOIN local_studio_books AS book ON book.id = revision.book_id`;
const summary = `book.id, revision.title, json_extract(revision.content, '$.author') AS author,
  revision.revision, book.created_at AS createdAt, revision.created_at AS updatedAt`;

export function createStudioPilot({
  dbPath,
  render = renderStudioArtwork,
  now = Date.now,
}: {
  dbPath: string;
  render?: StudioArtwork;
  now?: () => number;
}) {
  const db = new Database(dbPath);
  try {
    db.exec(
      "PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
    );
    db.transaction(() => {
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version === 0) {
        db.exec(`
          CREATE TABLE local_studio_books (
            id TEXT PRIMARY KEY NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE local_studio_revisions (
            book_id TEXT NOT NULL REFERENCES local_studio_books(id),
            revision INTEGER NOT NULL CHECK(revision >= 1),
            title TEXT NOT NULL,
            content TEXT NOT NULL CHECK(json_valid(content)),
            created_at TEXT NOT NULL,
            PRIMARY KEY(book_id, revision)
          );
          PRAGMA user_version = 1;
        `);
      } else if (version !== 1) {
        throw new Error("Unsupported Studio schema");
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const list = db.query<StudioSummary, [number]>(`SELECT ${summary}
    FROM local_studio_books AS book JOIN local_studio_revisions AS revision
    ON revision.book_id = book.id AND revision.revision = book.revision
    ORDER BY book.updated_at DESC, book.id LIMIT ?`);
  const history = db.query<
    StudioSummary,
    [string, number, number]
  >(`SELECT ${summary}
    FROM local_studio_revisions AS revision JOIN local_studio_books AS book ON book.id = revision.book_id
    WHERE book.id = ? AND revision.revision < ? ORDER BY revision.revision DESC LIMIT ?`);
  const find = db.query<BookRow, [string]>(`${currentBook} WHERE book.id = ?`);
  const at = db.query<BookRow, [string, number]>(
    `${historicalBook} WHERE book.id = ? AND revision.revision = ?`,
  );
  const insertBook = db.query(
    "INSERT INTO local_studio_books(id,revision,created_at,updated_at) VALUES (?,1,?,?)",
  );
  const insertRevision = db.query(
    "INSERT INTO local_studio_revisions(book_id,revision,title,content,created_at) VALUES (?,?,?,?,?)",
  );
  const advance = db.query(
    "UPDATE local_studio_books SET revision = ?, updated_at = ? WHERE id = ?",
  );

  function getBook(id: string, revision?: number): StudioBook | null {
    const row = revision === undefined ? find.get(id) : at.get(id, revision);
    return row ? materialize(row) : null;
  }

  const add = db.transaction((fields: Fields) => {
    const id = randomUUID();
    const time = new Date(now()).toISOString();
    insertBook.run(id, time, time);
    insertRevision.run(id, 1, fields.title, JSON.stringify(fields), time);
    return { ...fields, id, revision: 1, createdAt: time, updatedAt: time };
  });

  const edit = db.transaction((id: string, input: Record<string, unknown>) => {
    const row = find.get(id);
    if (!row) throw new StudioError(404, "STUDIO_BOOK_NOT_FOUND");
    if (row.revision !== revisionNumber(input.revision)) {
      throw new StudioError(409, "STUDIO_STALE_REVISION");
    }
    const fields = bookFields(input, JSON.parse(row.content) as Fields);
    const content = JSON.stringify(fields);
    if (row.content === content) return materialize(row);
    const time = new Date(now()).toISOString();
    const revision = row.revision + 1;
    insertRevision.run(id, revision, fields.title, content, time);
    advance.run(revision, time, id);
    return {
      ...fields,
      id,
      revision,
      createdAt: row.createdAt,
      updatedAt: time,
    };
  });

  let rendering = false;
  async function exportBook(
    book: StudioBook,
    format: string,
    includeCover: boolean,
    signal: AbortSignal,
  ) {
    if (
      format !== "epub" &&
      format !== "pdf" &&
      format !== "sample" &&
      format !== "cover"
    ) {
      throw new StudioError(404, "STUDIO_EXPORT_NOT_FOUND");
    }
    const chapters =
      format === "sample" ? book.chapters.slice(0, 1) : book.chapters;
    if (
      format !== "cover" &&
      (!book.author ||
        chapters.length === 0 ||
        chapters.some(({ text: draft }) => !draft))
    ) {
      throw new StudioError(422, "STUDIO_INCOMPLETE_DRAFT");
    }
    function epub(cover?: Uint8Array<ArrayBuffer>) {
      const references = book.sources.map(({ title, url }) =>
        url ? `${title}\n${url}` : title,
      );
      const ebook = {
        title: book.title,
        author: book.author,
        chapters: references.length
          ? [
              ...chapters,
              { title: "Referências", text: references.join("\n\n") },
            ]
          : chapters,
      };
      const output = exportEpub(ebook, {
        cover,
        description: book.promise,
        identifier: `urn:uuid:${book.id}`,
        modified: book.updatedAt,
      });
      return download(book, output, "application/epub+zip", ".epub");
    }
    if (format === "epub" && !includeCover) return epub();
    if (rendering) throw new StudioError(409, "STUDIO_EXPORT_IN_PROGRESS");
    rendering = true;
    try {
      const output = await render(
        book,
        format === "epub" ? "cover" : format,
        signal,
      );
      if (format === "epub") return epub(output);
      if (format === "cover")
        return download(book, output, "image/png", "-capa.png");
      return download(
        book,
        output,
        "application/pdf",
        format === "sample" ? "-amostra.pdf" : ".pdf",
      );
    } catch {
      throw new StudioError(503, "STUDIO_EXPORT_FAILED");
    } finally {
      rendering = false;
    }
  }

  async function handle(
    request: Request,
    pathname: string,
  ): Promise<Response | null> {
    if (pathname !== root && !pathname.startsWith(`${root}/`)) return null;
    try {
      if (pathname === root) {
        if (request.method === "GET")
          return json({ books: list.all(pageSize) });
        if (request.method === "POST")
          return json(
            { book: add.immediate(bookFields(await body(request))) },
            201,
          );
        return json({ error: "METHOD_NOT_ALLOWED" }, 405);
      }
      const match = bookPath.exec(pathname.slice(root.length + 1));
      if (!match?.[1]) return json({ error: "STUDIO_BOOK_NOT_FOUND" }, 404);
      const [, id, action, slug] = match;
      if (!action && request.method === "PUT")
        return json({ book: edit.immediate(id, await body(request)) });
      if (request.method !== "GET")
        return json({ error: "METHOD_NOT_ALLOWED" }, 405);
      const params = new URL(request.url).searchParams;
      if (action === "revisions" && slug === undefined) {
        const book = getBook(id);
        if (!book) return json({ error: "STUDIO_BOOK_NOT_FOUND" }, 404);
        const before = params.get("before");
        const revisions = history.all(
          id,
          before === null
            ? Number.MAX_SAFE_INTEGER
            : revisionNumber(Number(before)),
          pageSize + 1,
        );
        return json({
          revisions: revisions.slice(0, pageSize),
          nextBefore:
            revisions.length > pageSize
              ? revisions[pageSize - 1]?.revision
              : null,
        });
      }
      const rawRevision =
        action === "revisions" ? slug : params.get("revision");
      const revision =
        rawRevision === undefined || rawRevision === null
          ? undefined
          : revisionNumber(Number(rawRevision));
      const book = getBook(id, revision);
      if (!book) return json({ error: "STUDIO_BOOK_NOT_FOUND" }, 404);
      if (action === "export")
        return await exportBook(
          book,
          slug ?? "",
          params.get("cover") !== "0",
          request.signal,
        );
      return json({ book });
    } catch (error) {
      if (error instanceof StudioError)
        return json({ error: error.code }, error.status);
      return json({ error: "STUDIO_STORAGE_FAILED" }, 500);
    }
  }

  return { getBook, handle, close: () => db.close() };
}
