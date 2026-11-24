import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const manifestName = "manifest.json";
const currentVersion = 6;
const databases = [
  {
    file: "conversations.sqlite",
    since: 1,
    userVersion: 1,
    tables: {
      chat_turns: [
        "sequence",
        "conversation_id",
        "id",
        "prompt",
        "answer",
        "status",
        "error",
      ],
      conversations: ["id", "title", "created_at", "updated_at"],
    },
  },
  {
    file: "learning.sqlite",
    since: 1,
    userVersion: 0,
    tables: {
      local_learning_evidence: [
        "id",
        "key_hash",
        "source",
        "text",
        "created_at",
      ],
      local_learning_proposal_requests: [
        "key_hash",
        "evidence_ids",
        "claim",
        "lease_until",
        "proposal_id",
      ],
      local_learning_proposals: [
        "id",
        "evidence_ids",
        "slug",
        "title",
        "markdown",
        "revision",
        "status",
        "created_at",
        "reviewed_at",
      ],
      local_learning_reviews: ["action", "key_hash", "proposal_id"],
    },
  },
  {
    file: "attachments.sqlite",
    since: 2,
    userVersion: 1,
    tables: {
      local_attachments: [
        "sequence",
        "conversation_id",
        "id",
        "filename",
        "mime_type",
        "size",
        "created_at",
        "body",
      ],
    },
  },
  {
    file: "memory.sqlite",
    since: 3,
    userVersion: 1,
    tables: {
      local_memories: [
        "id",
        "text",
        "normalized_text",
        "search_terms",
        "created_at",
        "updated_at",
      ],
    },
  },
  {
    file: "routines.sqlite",
    since: 3,
    userVersion: 1,
    tables: {
      local_routines: [
        "id",
        "title",
        "prompt",
        "timezone",
        "enabled",
        "interval_minutes",
        "next_run_at",
        "created_at",
        "updated_at",
      ],
      local_routine_runs: [
        "sequence",
        "id",
        "routine_id",
        "scheduled_at",
        "started_at",
        "finished_at",
        "status",
        "answer",
        "error",
      ],
    },
  },
  {
    file: "social.sqlite",
    since: 4,
    userVersion: 1,
    tables: {
      local_social_posts: [
        "id",
        "platform",
        "caption",
        "image_url",
        "group_url",
        "scheduled_at",
        "status",
        "revision",
        "instagram_account_id",
        "approved_at",
        "claimed_at",
        "updated_at",
        "created_at",
        "finished_at",
        "container_id",
        "remote_id",
        "result_url",
        "result_source",
        "error",
      ],
    },
  },
  {
    file: "studio.sqlite",
    since: 5,
    userVersion: 1,
    tables: {
      local_studio_books: ["id", "revision", "created_at", "updated_at"],
      local_studio_revisions: [
        "book_id",
        "revision",
        "title",
        "content",
        "created_at",
      ],
    },
  },
  {
    file: "campaign.sqlite",
    since: 5,
    userVersion: 1,
    tables: {
      campaign_state: ["id", "slug", "document", "updated_at"],
      campaign_orders: [
        "order_hash",
        "status",
        "amount_cents",
        "source",
        "medium",
        "content",
      ],
      campaign_clicks: ["day", "source", "medium", "content", "clicks"],
    },
  },
  {
    file: "bot-runs.sqlite",
    since: 6,
    userVersion: 1,
    tables: {
      bot_runs: [
        "id",
        "workflow",
        "workflow_version",
        "plan",
        "input",
        "request_key_hash",
        "status",
        "stage_index",
        "attempt",
        "outputs",
        "active_recovery",
        "lease_token",
        "lease_until",
        "control",
        "error",
        "next_attempt_at",
        "created_at",
        "updated_at",
      ],
      bot_run_events: [
        "id",
        "job_id",
        "type",
        "stage",
        "attempt",
        "detail",
        "at",
      ],
    },
  },
  {
    file: "bot-registry.sqlite",
    since: 6,
    userVersion: 1,
    tables: {
      local_bots: ["id", "created_at", "updated_at"],
      local_bot_versions: [
        "bot_id",
        "version",
        "name",
        "request",
        "template",
        "workflow",
        "capabilities_json",
        "status",
        "simulation_json",
        "created_at",
        "activated_at",
      ],
      local_bot_feedback: [
        "sequence",
        "id",
        "bot_id",
        "bot_version",
        "run_id",
        "before_text",
        "after_text",
        "example_text",
        "example_hash",
        "qualifies",
        "created_at",
      ],
      local_bot_skills: [
        "id",
        "bot_id",
        "version",
        "rule",
        "status",
        "last_sequence",
        "evidence_json",
        "comparison_json",
        "created_at",
        "reviewed_at",
      ],
    },
  },
  {
    file: "bot-artifacts.sqlite",
    since: 6,
    userVersion: 1,
    tables: {
      local_bot_artifacts: [
        "job_id",
        "kind",
        "filename",
        "media_type",
        "sha256",
        "contents",
        "created_at",
      ],
    },
  },
] as const;

type ProfileDatabase = (typeof databases)[number];

type DatabaseEntry = {
  file: ProfileDatabase["file"];
  userVersion: number;
  sha256: string;
};

type Manifest = {
  version: 1 | 2 | 3 | 4 | 5 | typeof currentVersion;
  createdAt: string;
  databases: DatabaseEntry[];
};

export type ProfileCopy = {
  directory: string;
  manifestPath: string;
  databases: string[];
};

function requireRegularFile(path: string) {
  if (!lstatSync(path).isFile())
    throw new Error(`Expected a regular file at ${path}`);
}

function checkDatabase(db: Database, definition: ProfileDatabase) {
  const check = db
    .query<{ quick_check: string }, []>("PRAGMA quick_check")
    .all();
  if (check.length !== 1 || check[0]?.quick_check !== "ok") {
    throw new Error(`SQLite integrity check failed for ${definition.file}`);
  }
  if (db.query("PRAGMA foreign_key_check").get()) {
    throw new Error(`SQLite foreign-key check failed for ${definition.file}`);
  }
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  if (version?.user_version !== definition.userVersion) {
    throw new Error(`Unsupported schema version for ${definition.file}`);
  }
  const entries = db
    .query<{ name: string; type: string }, []>(
      `SELECT name, type FROM sqlite_schema
     WHERE type <> 'index' AND substr(name, 1, 7) <> 'sqlite_'`,
    )
    .all();
  if (
    entries.length !== Object.keys(definition.tables).length ||
    entries.some(
      ({ name, type }) =>
        type !== "table" || !Object.hasOwn(definition.tables, name),
    )
  ) {
    throw new Error(`Unexpected tables or objects in ${definition.file}`);
  }
  const tableColumns = db.query<{ name: string }, [string]>(
    "SELECT name FROM pragma_table_xinfo(?) ORDER BY cid",
  );
  for (const [table, columns] of Object.entries(definition.tables)) {
    const actual = tableColumns.all(table).map(({ name }) => name);
    if (
      actual.length !== columns.length ||
      actual.some((name, index) => name !== columns[index])
    ) {
      throw new Error(`Unexpected columns in ${definition.file}:${table}`);
    }
  }
}

function withDatabase(path: string, action: (db: Database) => void) {
  requireRegularFile(path);
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
    action(db);
  } finally {
    db.close();
  }
}

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function databaseDefinitions(version: Manifest["version"]) {
  return databases.filter(({ since }) => since <= version);
}

function manifestFrom(path: string): Manifest {
  requireRegularFile(path);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== 5 &&
      value.version !== currentVersion) ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !("databases" in value) ||
    !Array.isArray(value.databases)
  ) {
    throw new Error("Unsupported or invalid profile backup manifest");
  }
  const entries: unknown[] = value.databases;
  const definitions = databaseDefinitions(value.version);
  if (entries.length !== definitions.length) {
    throw new Error("Unexpected database count in profile backup manifest");
  }
  return {
    version: value.version,
    createdAt: value.createdAt,
    databases: definitions.map(({ file, userVersion }) => {
      const entry = entries.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "file" in item &&
          item.file === file,
      );
      if (
        !entry ||
        typeof entry !== "object" ||
        !("userVersion" in entry) ||
        entry.userVersion !== userVersion ||
        !("sha256" in entry) ||
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)
      ) {
        throw new Error(`Missing or invalid manifest entry for ${file}`);
      }
      return { file, userVersion, sha256: entry.sha256 };
    }),
  };
}

async function writeProfileCopy(
  destination: string,
  definitions: readonly ProfileDatabase[],
  populate: (directory: string) => Promise<Manifest>,
): Promise<ProfileCopy> {
  const directory = resolve(destination);
  const manifestPath = join(directory, manifestName);
  const paths = definitions.map(({ file }) => join(directory, file));
  mkdirSync(directory, { mode: 0o700 });
  try {
    const manifest = await populate(directory);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return { directory, manifestPath, databases: paths };
  } catch (error) {
    for (const path of paths) {
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-journal`, { force: true });
      rmSync(path, { force: true });
    }
    rmSync(manifestPath, { force: true });
    rmdirSync(directory);
    throw error;
  }
}

export async function backupProfile(sourceProfile: string, newBackup: string) {
  const source = resolve(sourceProfile);
  const hasStudio = existsSync(join(source, "studio.sqlite"));
  const hasCampaign = existsSync(join(source, "campaign.sqlite"));
  if (hasStudio !== hasCampaign)
    throw new Error(
      "Open the current OpenBot package once to initialize the studio and campaign before taking a backup",
    );
  const botFiles = databases.filter(({ since }) => since === currentVersion);
  const existingBots = botFiles.filter(({ file }) =>
    existsSync(join(source, file)),
  ).length;
  if (existingBots && existingBots !== botFiles.length)
    throw new Error(
      "Open the current OpenBot package once to finish initializing the bot profile before backup",
    );
  const version = existingBots
    ? currentVersion
    : hasStudio
      ? 5
      : existsSync(join(source, "social.sqlite"))
        ? 4
        : 3;
  const definitions = databaseDefinitions(version);
  return writeProfileCopy(newBackup, definitions, async (directory) => {
    const entries: DatabaseEntry[] = [];
    for (const definition of definitions) {
      const { file, userVersion } = definition;
      const destination = join(directory, file);
      withDatabase(join(source, file), (db) => {
        checkDatabase(db, definition);
        db.query("VACUUM main INTO ?").run(destination);
      });
      chmodSync(destination, 0o600);
      if (file === "social.sqlite") {
        const db = new Database(destination);
        try {
          db.exec("PRAGMA trusted_schema = OFF;");
          const now = Date.now();
          // The original profile may publish after the snapshot is taken.
          db.query(`UPDATE local_social_posts
            SET status = 'needs_review', error = 'SOCIAL_BACKUP_NEEDS_REVIEW',
                updated_at = ?, finished_at = ?
            WHERE platform = 'instagram' AND status IN ('scheduled', 'publishing')`).run(
            now,
            now,
          );
        } finally {
          db.close();
        }
      }
      if (file === "bot-runs.sqlite") {
        const db = new Database(destination);
        try {
          db.exec("PRAGMA trusted_schema = OFF;");
          db.query(`UPDATE bot_runs SET status='review', active_recovery=NULL, lease_token=NULL,
            lease_until=NULL, next_attempt_at=NULL, control=NULL, error='BOT_PROJECT_RESTORE_REVIEW',
            updated_at=? WHERE workflow='programming' AND status IN ('queued', 'running', 'retry_wait', 'paused')`).run(
            Date.now(),
          );
        } finally {
          db.close();
        }
      }
      withDatabase(destination, (db) => checkDatabase(db, definition));
      entries.push({ file, userVersion, sha256: await digest(destination) });
    }
    return {
      version,
      createdAt: new Date().toISOString(),
      databases: entries,
    };
  });
}

export async function restoreProfile(sourceBackup: string, newProfile: string) {
  const source = resolve(sourceBackup);
  const manifest = manifestFrom(join(source, manifestName));
  const definitions = databaseDefinitions(manifest.version);
  return writeProfileCopy(newProfile, definitions, async (directory) => {
    for (const definition of definitions) {
      const sourceFile = join(source, definition.file);
      const destination = join(directory, definition.file);
      requireRegularFile(sourceFile);
      copyFileSync(sourceFile, destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      const entry = manifest.databases.find(
        ({ file }) => file === definition.file,
      );
      if ((await digest(destination)) !== entry?.sha256) {
        throw new Error(`Checksum mismatch for ${definition.file}`);
      }
      withDatabase(destination, (db) => checkDatabase(db, definition));
    }
    return manifest;
  });
}

if (import.meta.main) {
  const [operation, source, destination, ...extra] = process.argv.slice(2);
  if (
    (operation !== "backup" && operation !== "restore") ||
    !source ||
    !destination ||
    extra.length
  ) {
    console.error(
      "Usage: bun local-backend/profile-backup.ts backup|restore <source> <new-destination>",
    );
    process.exitCode = 2;
  } else {
    try {
      const copy = await (operation === "backup"
        ? backupProfile
        : restoreProfile)(source, destination);
      console.log(JSON.stringify(copy, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
