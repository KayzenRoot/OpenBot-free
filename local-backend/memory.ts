import { Database } from "bun:sqlite";

const ROOT = "/api/local/memory";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SCHEMA_VERSION = 1;
export const MAX_MEMORY_TEXT = 2_000;
const MAX_MEMORIES = 500;
const MAX_QUERY = 16_000;
const CONTEXT_RESULTS = 5;
const STOP_WORDS = new Set(
  `ainda ajude ajudar algo algum alguma apenas aqui assim bem cada coisa com como das deles dela depois dos ela ele elas eles
   entre essa esse esta este esses estas esses fazer fale favor fez fora foi isso isto mas mais menos muito nao nos nossa nosso
   obrigado onde para pela pelo pode poderia porque por que qual quando quanto quem quero seja sem sim sob sobre sua seu suas seus
   tem tenha tudo uma umas uns voce voces
   about after all also and any are because before between both but can could does doing down each else even every explain few for
   from get got had has have help here how into just know like many may more most much must need only other our out over please
   same say see she should some such take tell than that their them then there these they this those through too use very want was
   way well were what when where which who why will with would yes you your`
    .trim()
    .split(/\s+/),
);

export type MemoryEntry = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryContext = Pick<MemoryEntry, "id" | "text">;

class MemoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function dedupKey(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function searchTerms(text: string) {
  const normalized = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const terms = new Set<string>();
  for (const [term] of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (
      term.length < 3 ||
      term.length > 48 ||
      !/\p{L}/u.test(term) ||
      STOP_WORDS.has(term)
    )
      continue;
    terms.add(term);
    if (terms.size === 128) break;
  }
  return [...terms];
}

async function memoryText(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new MemoryError(415, "JSON_REQUIRED");
  }
  const source = await request.text();
  if (Buffer.byteLength(source) > 16 * 1024) {
    throw new MemoryError(413, "MEMORY_BODY_TOO_LARGE");
  }
  let body: unknown;
  try {
    body = JSON.parse(source);
  } catch {
    throw new MemoryError(400, "INVALID_MEMORY");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("text" in body) ||
    typeof body.text !== "string"
  ) {
    throw new MemoryError(400, "INVALID_MEMORY");
  }
  const text = body.text.trim().replace(/\r\n?/g, "\n");
  if (!text || text.length > MAX_MEMORY_TEXT || text.includes("\u0000")) {
    throw new MemoryError(400, "INVALID_MEMORY");
  }
  return text;
}

function pageRequest(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? "25");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const query = url.searchParams.get("q");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new MemoryError(400, "INVALID_MEMORY_PAGE");
  }
  if (query !== null && query.length > MAX_QUERY)
    throw new MemoryError(400, "MEMORY_QUERY_TOO_LARGE");
  return { limit, offset, query };
}

export function createLocalMemory({ dbPath }: { dbPath: string }) {
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;",
    );
    db.transaction(() => {
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version === undefined || version > SCHEMA_VERSION) {
        throw new Error("Unsupported local memory database version");
      }
      if (version === 0) {
        db.exec(`
          CREATE TABLE local_memories (
            id TEXT PRIMARY KEY NOT NULL,
            text TEXT NOT NULL,
            normalized_text TEXT NOT NULL UNIQUE,
            search_terms TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          PRAGMA user_version = 1;
        `);
      }
      db.query("SELECT id FROM local_memories LIMIT 0").get();
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const columns =
    "m.id, m.text, m.created_at AS createdAt, m.updated_at AS updatedAt";
  const byId = db.query<MemoryEntry, [string]>(
    `SELECT ${columns} FROM local_memories AS m WHERE m.id = ?`,
  );
  const byText = db.query<MemoryEntry, [string]>(
    `SELECT ${columns} FROM local_memories AS m WHERE m.normalized_text = ?`,
  );
  const list = db.query<MemoryEntry, [number, number]>(`
    SELECT ${columns} FROM local_memories AS m ORDER BY m.updated_at DESC, m.id ASC LIMIT ? OFFSET ?
  `);
  const search = db.query<MemoryEntry, [string, number, number]>(`
    SELECT ${columns} FROM local_memories AS m
    JOIN json_each(m.search_terms) AS term ON term.value IN (SELECT value FROM json_each(?))
    GROUP BY m.id ORDER BY COUNT(*) DESC, m.updated_at DESC, m.id ASC LIMIT ? OFFSET ?
  `);
  const count = db.query<{ total: number }, []>(
    "SELECT COUNT(*) AS total FROM local_memories",
  );
  const insert = db.query<
    unknown,
    [string, string, string, string, string, string]
  >(`
    INSERT INTO local_memories (id, text, normalized_text, search_terms, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const update = db.query<unknown, [string, string, string, string, string]>(`
    UPDATE local_memories SET text = ?, normalized_text = ?, search_terms = ?, updated_at = ? WHERE id = ?
  `);
  const remove = db.query<unknown, [string]>(
    "DELETE FROM local_memories WHERE id = ?",
  );

  function get(id: string) {
    const memory = byId.get(id);
    if (!memory) throw new MemoryError(404, "MEMORY_NOT_FOUND");
    return memory;
  }

  function matching(prompt: string, limit: number, offset: number) {
    const terms = searchTerms(prompt.slice(0, MAX_QUERY));
    return terms.length ? search.all(JSON.stringify(terms), limit, offset) : [];
  }

  const addMemory = db.transaction((text: string) => {
    const normalized = dedupKey(text);
    const previous = byText.get(normalized);
    if (previous) return response({ memory: previous });
    if ((count.get()?.total ?? MAX_MEMORIES) >= MAX_MEMORIES) {
      throw new MemoryError(409, "MEMORY_LIMIT_REACHED");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    insert.run(
      id,
      text,
      normalized,
      JSON.stringify(searchTerms(text)),
      now,
      now,
    );
    return response({ memory: get(id) }, 201);
  });

  const editMemory = db.transaction((id: string, text: string) => {
    const previous = get(id);
    if (previous.text === text) return previous;
    const normalized = dedupKey(text);
    const duplicate = byText.get(normalized);
    if (duplicate && duplicate.id !== id)
      throw new MemoryError(409, "MEMORY_DUPLICATE");
    update.run(
      text,
      normalized,
      JSON.stringify(searchTerms(text)),
      new Date().toISOString(),
      id,
    );
    return get(id);
  });

  return {
    close: () => db.close(),
    relevant(prompt: string): MemoryContext[] {
      return matching(prompt, CONTEXT_RESULTS, 0).map(({ id, text }) => ({
        id,
        text,
      }));
    },
    // The caller authenticates the local account before dispatching here.
    async handle(request: Request, pathname: string): Promise<Response | null> {
      if (pathname !== ROOT && !pathname.startsWith(`${ROOT}/`)) return null;
      try {
        if (pathname === ROOT) {
          if (request.method === "POST")
            return addMemory.immediate(await memoryText(request));
          if (request.method === "GET") {
            const { limit, offset, query } = pageRequest(new URL(request.url));
            const rows =
              query === null
                ? list.all(limit + 1, offset)
                : matching(query, limit + 1, offset);
            return response({
              memories: rows.slice(0, limit),
              nextOffset: rows.length > limit ? offset + limit : null,
            });
          }
          return response({ error: "MEMORY_METHOD_NOT_ALLOWED" }, 405);
        }

        const id = pathname.slice(ROOT.length + 1);
        if (!UUID.test(id)) return response({ error: "MEMORY_NOT_FOUND" }, 404);
        if (request.method === "GET") return response({ memory: get(id) });
        if (request.method === "PATCH")
          return response({
            memory: editMemory.immediate(id, await memoryText(request)),
          });
        if (request.method === "DELETE") {
          remove.run(id);
          return new Response(null, {
            status: 204,
            headers: { "cache-control": "no-store" },
          });
        }
        return response({ error: "MEMORY_METHOD_NOT_ALLOWED" }, 405);
      } catch (error) {
        if (error instanceof MemoryError)
          return response({ error: error.code }, error.status);
        return response({ error: "MEMORY_STORAGE_FAILED" }, 500);
      }
    },
  };
}
