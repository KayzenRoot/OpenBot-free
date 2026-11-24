import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { jsonError } from "./conversation-routes";

const formats = {
  epub: { filename: "ebook.epub", media: "application/epub+zip" },
  pdf: { filename: "ebook.pdf", media: "application/pdf" },
  sample: { filename: "amostra.pdf", media: "application/pdf" },
  cover: { filename: "capa.png", media: "image/png" },
  kit: { filename: "kit-publico.zip", media: "application/zip" },
  draft: {
    filename: "rascunho-capitulo.txt",
    media: "text/plain; charset=utf-8",
  },
  patch: { filename: "alteracao.patch", media: "text/plain; charset=utf-8" },
  sales: { filename: "relatorio-vendas.json", media: "application/json" },
} as const;

export type ArtifactKind = keyof typeof formats;

type Artifact = {
  kind: ArtifactKind;
  filename: string;
  size: number;
  sha256: string;
  mediaType: string;
};

const maxFileBytes = 16 * 1024 * 1024;
const route =
  /^\/api\/local\/bot-runs\/([a-f\d-]{36})\/artifacts(?:\/([a-z]+))?$/;

export function createBotArtifacts(
  dbPath: string,
  hasJob: (id: string) => boolean,
) {
  const db = new Database(dbPath);
  try {
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;",
    );
    db.transaction(() => {
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version === 1) return;
      if (version !== 0) throw new Error("Unsupported bot artifacts schema");
      db.exec(`CREATE TABLE local_bot_artifacts (
        job_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL,
        media_type TEXT NOT NULL, sha256 TEXT NOT NULL, contents BLOB NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (job_id, kind)
      ); PRAGMA user_version=1;`);
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  const columns =
    "kind, filename, length(contents) AS size, sha256, media_type AS mediaType";
  const find = db.query<Artifact, [string, ArtifactKind]>(
    `SELECT ${columns} FROM local_bot_artifacts WHERE job_id=? AND kind=?`,
  );
  const list = db.query<Artifact, [string]>(
    `SELECT ${columns} FROM local_bot_artifacts WHERE job_id=? ORDER BY created_at, kind`,
  );
  const read = db.query<
    { contents: Uint8Array<ArrayBuffer> },
    [string, ArtifactKind]
  >("SELECT contents FROM local_bot_artifacts WHERE job_id=? AND kind=?");
  const add = db.query(
    "INSERT OR IGNORE INTO local_bot_artifacts (job_id,kind,filename,media_type,sha256,contents,created_at) VALUES (?,?,?,?,?,?,?)",
  );

  function put(jobId: string, kind: ArtifactKind, contents: Uint8Array) {
    if (!contents.length || contents.length > maxFileBytes)
      throw new Error("BOT_ARTIFACT_SIZE_INVALID");
    const { filename, media } = formats[kind];
    add.run(
      jobId,
      kind,
      filename,
      media,
      createHash("sha256").update(contents).digest("hex"),
      contents,
      new Date().toISOString(),
    );
    const saved = find.get(jobId, kind);
    if (!saved) throw new Error("BOT_ARTIFACT_NOT_STORED");
    return saved;
  }

  function handle(request: Request, pathname: string) {
    const match = route.exec(pathname);
    if (!match) return null;
    if (request.method !== "GET") return jsonError(405, "METHOD_NOT_ALLOWED");
    const [, id, kind] = match;
    if (!id || !hasJob(id)) return jsonError(404, "BOT_JOB_NOT_FOUND");
    const cache = {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    if (!kind)
      return Response.json({ artifacts: list.all(id) }, { headers: cache });
    if (!Object.hasOwn(formats, kind))
      return jsonError(404, "BOT_ARTIFACT_NOT_FOUND");
    const typedKind = kind as ArtifactKind;
    const artifact = find.get(id, typedKind);
    const body = read.get(id, typedKind)?.contents;
    if (!artifact || !body) return jsonError(404, "BOT_ARTIFACT_NOT_FOUND");
    return new Response(body, {
      headers: {
        ...cache,
        "content-type": artifact.mediaType,
        "content-disposition": `attachment; filename="${artifact.filename}"`,
      },
    });
  }

  return {
    put,
    get: (id: string, kind: ArtifactKind) => find.get(id, kind),
    bytes: (id: string, kind: ArtifactKind) => read.get(id, kind)?.contents,
    handle,
    close: () => db.close(),
  };
}
