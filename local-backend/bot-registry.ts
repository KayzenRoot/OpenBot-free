import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { jsonObject } from "./conversation-routes";

const botsPath = "/api/local/bots";
const learningPath = "/api/local/bot-learning";
const maxHistory = 100;

const templates = {
  programming: {
    name: "Programador",
    capabilities: ["project.inspect", "project.propose", "project.test"],
    sample:
      "Analise os arquivos escolhidos, proponha um patch e verifique com testes.",
  },
  ebook: {
    name: "Editor de ebooks",
    capabilities: [
      "studio.prepare",
      "studio.draft",
      "studio.export",
      "campaign.bundle",
    ],
    sample:
      "Prepare um ebook, valide os formatos e gere uma amostra para revisão.",
  },
  sales: {
    name: "Analista de vendas",
    capabilities: ["sales.analyze", "sales.report"],
    sample: "Some compras e reembolsos e organize o relatório por origem.",
  },
} as const;

type BotTemplate = keyof typeof templates;
type BotStatus = "draft" | "simulated" | "active" | "retired";
type SkillStatus = "proposed" | "active" | "rejected" | "retired";
type Simulation = {
  passed: boolean;
  checks: { name: string; passed: boolean }[];
};
type Comparison = {
  baseline: { passed: number; total: number };
  candidate: { passed: number; total: number };
  heldOut: number;
  regressions: number;
};
type BotRow = {
  id: string;
  version: number;
  name: string;
  request: string;
  template: BotTemplate;
  workflow: BotTemplate;
  capabilities: string;
  status: BotStatus;
  simulation: string | null;
  createdAt: number;
  updatedAt: number;
};
type SkillRow = {
  id: string;
  botId: string;
  version: number;
  rule: "ebook.open-with-example";
  status: SkillStatus;
  evidence: string;
  comparison: string;
  createdAt: number;
  reviewedAt: number | null;
};
type FeedbackRow = {
  sequence: number;
  id: string;
  botId: string;
  botVersion: number;
  runId: string;
  before: string;
  after: string;
  example: string | null;
  qualifies: number;
  createdAt: number;
};
type ProposalEvidence = {
  sampleIds: string[];
  heldOutId: string;
};

const botColumns = `b.id, v.version, v.name, v.request, v.template, v.workflow,
  v.capabilities_json AS capabilities, v.status, v.simulation_json AS simulation,
  v.created_at AS createdAt, b.updated_at AS updatedAt`;
const skillColumns = `id, bot_id AS botId, version, rule, status,
  evidence_json AS evidence, comparison_json AS comparison,
  created_at AS createdAt, reviewed_at AS reviewedAt`;
const feedbackColumns = `sequence, id, bot_id AS botId, bot_version AS botVersion, run_id AS runId,
  before_text AS before, after_text AS after, example_text AS example, qualifies, created_at AS createdAt`;

class RegistryError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}

function fail(status: number, code: string): never {
  throw new RegistryError(status, code);
}

function send(body: object, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function iso(value: number) {
  return new Date(value).toISOString();
}

function botSnapshot(row: BotRow) {
  return {
    ...row,
    capabilities: JSON.parse(row.capabilities) as string[],
    simulation: (row.simulation &&
      JSON.parse(row.simulation)) as Simulation | null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function skillSnapshot(row: SkillRow) {
  return {
    ...row,
    evidence: JSON.parse(row.evidence) as ProposalEvidence,
    comparison: JSON.parse(row.comparison) as Comparison,
    createdAt: iso(row.createdAt),
    reviewedAt: row.reviewedAt === null ? null : iso(row.reviewedAt),
  };
}

function feedbackSnapshot({
  sequence: _sequence,
  qualifies,
  createdAt,
  ...details
}: FeedbackRow) {
  return { ...details, qualifies: qualifies === 1, createdAt: iso(createdAt) };
}

const templateKeys = Object.keys(templates) as BotTemplate[];
const cues: Record<BotTemplate, RegExp> = {
  programming:
    /\b(codigo|programacao|programador|coding|patch|bug|repositorio|git|bun|testes?)\b/g,
  ebook:
    /\b(ebooks?|livros?|editorial|capitulos?|epub|revisao editorial|coesao)\b/g,
  sales:
    /\b(vendas?|sales|analytics|receita|conversao|reembolsos?|utm|cliques|pedidos)\b/g,
};

function chooseTemplate(input: unknown, request: string): BotTemplate {
  if (
    typeof input === "string" &&
    templateKeys.includes(input as BotTemplate)
  ) {
    return input as BotTemplate;
  }
  if (input !== undefined) fail(400, "BOT_TEMPLATE_INVALID");
  const normalized = normalize(request);
  const ranked = templateKeys
    .map((template) => ({
      template,
      score: Array.from(normalized.matchAll(cues[template])).length,
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best?.score || best.score === ranked[1]?.score) {
    fail(422, "BOT_TEMPLATE_REQUIRED");
  }
  return best.template;
}

const controlCharacters = /[\p{Cc}\p{Cs}]/gu;

function text(input: unknown, max: number, field: string) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.trim().length > max ||
    input.replace(/[\r\n\t]/g, "").replace(controlCharacters, "") !==
      input.replace(/[\r\n\t]/g, "")
  )
    fail(400, field);
  return input.trim();
}

function version(value: unknown, code = "BOT_VERSION_INVALID") {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(400, code);
  }
  return value;
}

function id(input: unknown, code: string) {
  if (typeof input !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input)) {
    fail(400, code);
  }
  return input;
}

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

function containsSecret(value: string) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/i.test(
    value,
  );
}

function openingHasExample(value: string, example: string) {
  const first = normalize(value.split(/\r?\n\s*\r?\n/, 1)[0] ?? "");
  const expected = normalize(example);
  return (
    Boolean(expected) &&
    (first === expected ||
      first.startsWith(`${expected} `) ||
      first === `exemplo pratico ${expected}` ||
      first.startsWith(`exemplo pratico ${expected} `))
  );
}

export function applyEbookOpening(
  text: string,
  example: string | null | undefined,
) {
  const clean = example?.trim().replace(/\s+/g, " ") ?? "";
  if (
    !clean ||
    clean.length > 500 ||
    containsSecret(clean) ||
    openingHasExample(text, clean)
  ) {
    return text;
  }
  return `Exemplo prático: ${clean}\n\n${text}`;
}

function simulate(bot: ReturnType<typeof botSnapshot>): Simulation {
  const fixture = templates[bot.template];
  const allowed = new Set(bot.capabilities);
  const scoped =
    fixture.capabilities.every((action) => allowed.has(action)) &&
    allowed.size === fixture.capabilities.length;
  const explicitApprovals = [
    "branch.apply",
    "social.publish",
    "payments.charge",
    "payments.change-price",
  ];
  const checks = [
    {
      name: "Usa uma tarefa de exemplo do modelo selecionado",
      passed: bot.workflow === bot.template && fixture.sample.length > 0,
    },
    {
      name: "Conserva somente as ferramentas previstas para o modelo",
      passed: scoped,
    },
    {
      name: "Ações externas ficam fora da simulação",
      passed: explicitApprovals.every((action) => !allowed.has(action)),
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function compare(heldOut: FeedbackRow, trained: FeedbackRow[]): Comparison {
  const heldExample = heldOut.example ?? "";
  if (
    !heldExample ||
    trained.length !== 2 ||
    trained.some(
      (item) => normalize(item.example ?? "") === normalize(heldExample),
    )
  )
    fail(409, "BOT_EVIDENCE_NOT_INDEPENDENT");

  const data = [
    { before: heldOut.before, example: heldExample, shouldOpen: true },
    { before: heldOut.before, example: "", shouldOpen: false },
    {
      before: `Exemplo prático: ${heldExample}\n\n${heldOut.before}`,
      example: heldExample,
      shouldOpen: true,
    },
  ];
  let baseline = 0;
  let candidate = 0;
  let regressions = 0;
  for (const item of data) {
    const revised = applyEbookOpening(item.before, item.example);
    const test = (output: string) =>
      item.shouldOpen
        ? openingHasExample(output, item.example) &&
          output.endsWith(item.before)
        : output === item.before;
    const incumbentPass = test(item.before);
    const candidatePass = test(revised);
    if (incumbentPass) baseline += 1;
    if (candidatePass) candidate += 1;
    if (incumbentPass && !candidatePass) regressions += 1;
  }
  return {
    baseline: { passed: baseline, total: data.length },
    candidate: { passed: candidate, total: data.length },
    heldOut: 1,
    regressions,
  };
}

type RegistryOptions = {
  dbPath: string;
  canLearnFromRun?: (
    botId: string,
    runId: string,
    version: number,
  ) => Promise<boolean> | boolean;
};

export function createBotRegistry({
  dbPath,
  canLearnFromRun,
}: RegistryOptions) {
  const db = new Database(dbPath);
  try {
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;",
    );
    db.transaction(() => {
      const { user_version: schema } = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get() ?? { user_version: -1 };
      if (schema === 1) return;
      if (schema !== 0) throw new Error("Unsupported bot registry schema");
      db.exec(`
        CREATE TABLE local_bots (
          id TEXT PRIMARY KEY NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE local_bot_versions (
          bot_id TEXT NOT NULL REFERENCES local_bots(id),
          version INTEGER NOT NULL CHECK(version >= 1),
          name TEXT NOT NULL,
          request TEXT NOT NULL,
          template TEXT NOT NULL CHECK(template IN ('programming','ebook','sales')),
          workflow TEXT NOT NULL CHECK(workflow = template),
          capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
          status TEXT NOT NULL CHECK(status IN ('draft','simulated','active','retired')),
          simulation_json TEXT CHECK(simulation_json IS NULL OR json_valid(simulation_json)),
          created_at INTEGER NOT NULL,
          activated_at INTEGER,
          PRIMARY KEY(bot_id, version)
        ) STRICT;
        CREATE UNIQUE INDEX local_bot_one_active ON local_bot_versions(bot_id) WHERE status = 'active';
        CREATE TABLE local_bot_feedback (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          bot_id TEXT NOT NULL,
          bot_version INTEGER NOT NULL,
          run_id TEXT NOT NULL,
          before_text TEXT NOT NULL,
          after_text TEXT NOT NULL,
          example_text TEXT,
          example_hash TEXT,
          qualifies INTEGER NOT NULL CHECK(qualifies IN (0,1)),
          created_at INTEGER NOT NULL,
          UNIQUE(bot_id, run_id),
          FOREIGN KEY(bot_id, bot_version) REFERENCES local_bot_versions(bot_id, version)
        ) STRICT;
        CREATE UNIQUE INDEX local_bot_distinct_example ON local_bot_feedback(bot_id, example_hash) WHERE qualifies = 1;
        CREATE TABLE local_bot_skills (
          id TEXT PRIMARY KEY NOT NULL,
          bot_id TEXT NOT NULL REFERENCES local_bots(id),
          version INTEGER NOT NULL CHECK(version >= 1),
          rule TEXT NOT NULL CHECK(rule = 'ebook.open-with-example'),
          status TEXT NOT NULL CHECK(status IN ('proposed','active','rejected','retired')),
          last_sequence INTEGER NOT NULL REFERENCES local_bot_feedback(sequence),
          evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
          comparison_json TEXT NOT NULL CHECK(json_valid(comparison_json)),
          created_at INTEGER NOT NULL,
          reviewed_at INTEGER,
          UNIQUE(bot_id, version)
        ) STRICT;
        CREATE UNIQUE INDEX local_bot_current_skill ON local_bot_skills(bot_id) WHERE status IN ('proposed','active');
        PRAGMA user_version = 1;
      `);
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  function botFrom(row: BotRow | null) {
    return row ? botSnapshot(row) : null;
  }

  function list() {
    return db
      .query<BotRow, []>(`
      SELECT ${botColumns} FROM local_bots b JOIN local_bot_versions v ON b.id = v.bot_id
      WHERE v.version = (SELECT MAX(version) FROM local_bot_versions WHERE bot_id = b.id)
      ORDER BY b.updated_at DESC, b.id LIMIT ${maxHistory}
    `)
      .all()
      .map(botSnapshot);
  }

  function current(botId: string) {
    const row = db
      .query<BotRow, [string]>(`
      SELECT ${botColumns} FROM local_bots b JOIN local_bot_versions v ON b.id = v.bot_id
      WHERE b.id = ? ORDER BY v.version DESC LIMIT 1
    `)
      .get(botId);
    if (!row) fail(404, "BOT_NOT_FOUND");
    return botSnapshot(row);
  }

  function getActive(botId: string, pin?: number) {
    return pin === undefined
      ? botFrom(
          db
            .query<BotRow, [string]>(`
        SELECT ${botColumns} FROM local_bots b JOIN local_bot_versions v ON b.id = v.bot_id
        WHERE b.id = ? AND v.status = 'active'
      `)
            .get(botId),
        )
      : botFrom(
          db
            .query<BotRow, [string, number]>(`
        SELECT ${botColumns} FROM local_bots b JOIN local_bot_versions v ON b.id = v.bot_id
        WHERE b.id = ? AND v.version = ? AND v.activated_at IS NOT NULL
      `)
            .get(botId, pin),
        );
  }

  function listActive() {
    return db
      .query<BotRow, []>(`
      SELECT ${botColumns} FROM local_bots b JOIN local_bot_versions v ON b.id = v.bot_id
      WHERE v.status = 'active'
      ORDER BY v.activated_at DESC, b.id LIMIT ${maxHistory}
    `)
      .all()
      .map(botSnapshot);
  }

  function getSkill(botId: string, pin?: number) {
    const row =
      pin === undefined
        ? db
            .query<
              SkillRow,
              [string]
            >(`SELECT ${skillColumns} FROM local_bot_skills
        WHERE bot_id = ? AND status = 'active'`)
            .get(botId)
        : db
            .query<
              SkillRow,
              [string, number]
            >(`SELECT ${skillColumns} FROM local_bot_skills
        WHERE bot_id = ? AND version = ? AND status IN ('active','retired')`)
            .get(botId, pin);
    return row ? skillSnapshot(row) : null;
  }

  function saveVersion(
    botId: string,
    revision: number,
    name: string,
    description: string,
    template: BotTemplate,
    capabilities: readonly string[],
    now: number,
  ) {
    db.query(`
      INSERT INTO local_bot_versions (bot_id, version, name, request, template, workflow, capabilities_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      botId,
      revision,
      name,
      description,
      template,
      template,
      JSON.stringify(capabilities),
      now,
    );
    db.query("UPDATE local_bots SET updated_at = ? WHERE id = ?").run(
      now,
      botId,
    );
    return current(botId);
  }

  function create(body: Record<string, unknown>) {
    const description = text(body.request, 2400, "BOT_REQUEST_INVALID");
    const template = chooseTemplate(body.template, description);
    const name =
      body.name === undefined
        ? templates[template].name
        : text(body.name, 120, "BOT_NAME_INVALID");
    const botId = randomUUID();
    const now = Date.now();
    return db
      .transaction(() => {
        db.query(
          "INSERT INTO local_bots (id, created_at, updated_at) VALUES (?, ?, ?)",
        ).run(botId, now, now);
        return saveVersion(
          botId,
          1,
          name,
          description,
          template,
          templates[template].capabilities,
          now,
        );
      })
      .immediate();
  }

  function mutateBot(
    botId: string,
    action: string,
    body: Record<string, unknown>,
  ) {
    const expected = version(body.version);
    return db
      .transaction(() => {
        const bot = current(botId);
        if (bot.version !== expected) fail(409, "BOT_VERSION_CHANGED");
        const now = Date.now();
        if (action === "revise") {
          const name =
            body.name === undefined
              ? bot.name
              : text(body.name, 120, "BOT_NAME_INVALID");
          const description =
            body.request === undefined
              ? bot.request
              : text(body.request, 2400, "BOT_REQUEST_INVALID");
          if (body.template !== undefined && body.template !== bot.template)
            fail(409, "BOT_CAPABILITIES_IMMUTABLE");
          return {
            bot: saveVersion(
              botId,
              bot.version + 1,
              name,
              description,
              bot.template,
              bot.capabilities,
              now,
            ),
          };
        }
        if (action === "simulate") {
          const simulation = simulate(bot);
          if (bot.status === "draft" || bot.status === "simulated") {
            db.query(
              "UPDATE local_bot_versions SET simulation_json = ?, status = ? WHERE bot_id = ? AND version = ?",
            ).run(
              JSON.stringify(simulation),
              simulation.passed ? "simulated" : "draft",
              botId,
              expected,
            );
            db.query("UPDATE local_bots SET updated_at = ? WHERE id = ?").run(
              now,
              botId,
            );
          }
          return { bot: current(botId), simulation };
        }
        if (bot.status === "active") return { bot };
        if (bot.status !== "simulated" || !bot.simulation?.passed)
          fail(409, "BOT_SIMULATION_REQUIRED");
        db.query(
          "UPDATE local_bot_versions SET status = 'retired' WHERE bot_id = ? AND status = 'active'",
        ).run(botId);
        db.query(
          "UPDATE local_bot_versions SET status = 'active', activated_at = ? WHERE bot_id = ? AND version = ?",
        ).run(now, botId, bot.version);
        db.query("UPDATE local_bots SET updated_at = ? WHERE id = ?").run(
          now,
          botId,
        );
        return { bot: current(botId) };
      })
      .immediate();
  }

  function maybePropose(botId: string, now: number) {
    if (
      db
        .query(
          "SELECT 1 FROM local_bot_skills WHERE bot_id = ? AND status IN ('active', 'proposed')",
        )
        .get(botId)
    )
      return null;
    const basis = db
      .query<FeedbackRow, [string, string]>(`
      SELECT ${feedbackColumns} FROM local_bot_feedback
      WHERE bot_id = ? AND qualifies = 1 AND sequence > COALESCE(
        (SELECT MAX(last_sequence) FROM local_bot_skills WHERE bot_id = ?), 0
      )
      ORDER BY sequence LIMIT 3
    `)
      .all(botId, botId);
    const heldOut = basis[2];
    if (!heldOut) return null;
    const training = basis.slice(0, 2);
    const comparison = compare(heldOut, training);
    if (
      comparison.regressions ||
      comparison.candidate.passed <= comparison.baseline.passed
    ) {
      return null;
    }
    const skillId = randomUUID();
    const evidence = {
      sampleIds: training.map(({ id }) => id),
      heldOutId: heldOut.id,
    };
    db.query(`INSERT INTO local_bot_skills (id, bot_id, version, rule, status, last_sequence, evidence_json, comparison_json, created_at)
      VALUES (?, ?, COALESCE((SELECT MAX(version) FROM local_bot_skills WHERE bot_id = ?), 0) + 1,
        'ebook.open-with-example', 'proposed', ?, ?, ?, ?)`).run(
      skillId,
      botId,
      botId,
      heldOut.sequence,
      JSON.stringify(evidence),
      JSON.stringify(comparison),
      now,
    );
    return findSkill(skillId);
  }

  function findSkill(skillId: string) {
    const row = db
      .query<SkillRow, [string]>(
        `SELECT ${skillColumns} FROM local_bot_skills WHERE id = ?`,
      )
      .get(skillId);
    if (!row) fail(404, "BOT_SKILL_NOT_FOUND");
    return skillSnapshot(row);
  }

  async function learn(body: Record<string, unknown>) {
    const botId = id(body.botId, "BOT_ID_INVALID");
    const runId = id(body.runId, "BOT_RUN_ID_INVALID");
    const before = text(body.before, 5000, "BOT_FEEDBACK_BEFORE_INVALID");
    const after = text(body.after, 5000, "BOT_FEEDBACK_AFTER_INVALID");
    const example =
      body.example === undefined || body.example === null || body.example === ""
        ? null
        : text(body.example, 500, "BOT_FEEDBACK_EXAMPLE_INVALID");
    if (normalize(before) === normalize(after))
      fail(422, "BOT_FEEDBACK_NO_CHANGE");
    if ([before, after, example ?? ""].some(containsSecret))
      fail(422, "BOT_FEEDBACK_SENSITIVE");
    const sourceBot = getActive(
      botId,
      body.botVersion === undefined ? undefined : version(body.botVersion),
    );
    if (!sourceBot) fail(409, "BOT_NOT_ACTIVE");
    if (
      canLearnFromRun &&
      !(await canLearnFromRun(botId, runId, sourceBot.version))
    )
      fail(409, "BOT_RUN_NOT_ELIGIBLE");
    const feedback = db.transaction(() => {
      const bot = getActive(botId, sourceBot.version);
      if (!bot) fail(409, "BOT_NOT_ACTIVE");
      if (
        db
          .query(
            "SELECT 1 FROM local_bot_feedback WHERE bot_id = ? AND run_id = ?",
          )
          .get(botId, runId)
      ) {
        fail(409, "BOT_FEEDBACK_DUPLICATE");
      }
      const exampleHash = example
        ? createHash("sha256").update(normalize(example)).digest("hex")
        : null;
      const qualifies =
        bot.template === "ebook" &&
        example &&
        normalize(example).length >= 12 &&
        !openingHasExample(before, example) &&
        openingHasExample(after, example) &&
        !db
          .query(
            "SELECT 1 FROM local_bot_feedback WHERE bot_id = ? AND example_hash = ? AND qualifies = 1",
          )
          .get(botId, exampleHash);
      const now = Date.now();
      const feedbackId = randomUUID();
      const row = db
        .query<
          FeedbackRow,
          [
            string,
            string,
            number,
            string,
            string,
            string,
            string | null,
            string | null,
            number,
            number,
          ]
        >(`INSERT INTO local_bot_feedback (id, bot_id, bot_version, run_id, before_text, after_text,
          example_text, example_hash, qualifies, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING ${feedbackColumns}`)
        .get(
          feedbackId,
          botId,
          bot.version,
          runId,
          before,
          after,
          example,
          exampleHash,
          qualifies ? 1 : 0,
          now,
        );
      if (!row) throw new Error("Feedback insert did not return a record");
      return {
        feedback: feedbackSnapshot(row),
        proposal: qualifies ? maybePropose(botId, now) : null,
      };
    });
    return feedback.immediate();
  }

  function review(skillId: string, action: string, expected: number) {
    return db
      .transaction(() => {
        const skill = findSkill(skillId);
        const decided: SkillStatus =
          action === "approve" ? "active" : "rejected";
        if (skill.version !== expected) fail(409, "BOT_SKILL_VERSION_CHANGED");
        if (skill.status === decided) return skill;
        if (skill.status !== "proposed")
          fail(409, "BOT_SKILL_ALREADY_REVIEWED");
        if (
          action === "approve" &&
          (skill.comparison.regressions !== 0 ||
            skill.comparison.candidate.passed <=
              skill.comparison.baseline.passed)
        )
          fail(409, "BOT_SKILL_EVALUATION_FAILED");
        db.query(
          "UPDATE local_bot_skills SET status = ?, reviewed_at = ? WHERE id = ?",
        ).run(decided, Date.now(), skillId);
        return findSkill(skillId);
      })
      .immediate();
  }

  function rollback(botId: string, target: number | null) {
    return db
      .transaction(() => {
        current(botId);
        const selected = target === null ? null : getSkill(botId, target);
        if (target !== null && !selected) fail(404, "BOT_SKILL_NOT_FOUND");
        if (
          db
            .query(
              "SELECT 1 FROM local_bot_skills WHERE bot_id = ? AND status = 'proposed'",
            )
            .get(botId)
        ) {
          fail(409, "BOT_SKILL_REVIEW_PENDING");
        }
        db.query(
          "UPDATE local_bot_skills SET status = 'retired' WHERE bot_id = ? AND status = 'active'",
        ).run(botId);
        if (selected === null) return null;
        db.query(
          "UPDATE local_bot_skills SET status = 'active' WHERE id = ?",
        ).run(selected.id);
        return findSkill(selected.id);
      })
      .immediate();
  }

  async function bodyOf(request: Request) {
    const body = await jsonObject(request);
    if (!body) fail(400, "BOT_BODY_INVALID");
    return body;
  }

  function learningList(request: Request, category: string) {
    const query = new URL(request.url).searchParams.get("botId");
    const botId = query === null ? null : id(query, "BOT_ID_INVALID");
    if (category === "feedback") {
      return send({
        feedback: db
          .query<FeedbackRow, [string | null, string | null]>(`
        SELECT ${feedbackColumns} FROM local_bot_feedback
        WHERE (? IS NULL OR bot_id = ?) ORDER BY sequence DESC LIMIT ${maxHistory}
      `)
          .all(botId, botId)
          .map(feedbackSnapshot),
      });
    }
    const statuses =
      category === "proposals" ? "'proposed','rejected'" : "'active','retired'";
    const entries = db
      .query<SkillRow, [string | null, string | null]>(`
      SELECT ${skillColumns} FROM local_bot_skills
      WHERE (? IS NULL OR bot_id = ?) AND status IN (${statuses})
      ORDER BY created_at DESC, version DESC LIMIT ${maxHistory}
    `)
      .all(botId, botId)
      .map(skillSnapshot);
    return send(
      category === "proposals" ? { proposals: entries } : { skills: entries },
    );
  }

  async function handle(
    request: Request,
    pathname: string,
  ): Promise<Response | null> {
    const matchesBots =
      pathname === botsPath || pathname.startsWith(`${botsPath}/`);
    const matchesLearning = pathname.startsWith(`${learningPath}/`);
    if (!matchesBots && !matchesLearning) return null;

    try {
      if (pathname === botsPath && request.method === "GET") {
        return send({
          bots: list(),
          active: listActive(),
          templates: templateKeys.map((id) => ({ id, ...templates[id] })),
        });
      }
      if (pathname === botsPath && request.method === "POST") {
        return send({ bot: create(await bodyOf(request)) }, 201);
      }

      if (matchesBots) {
        const match =
          /^([a-zA-Z0-9_-]{1,128})(?:\/(simulate|activate|revise))?$/.exec(
            pathname.slice(botsPath.length + 1),
          );
        const botId = match?.[1];
        if (!botId) return send({ error: "BOT_ROUTE_NOT_FOUND" }, 404);
        if (!match[2] && request.method === "GET")
          return send({ bot: current(botId) });
        if (match[2] && request.method === "POST")
          return send(mutateBot(botId, match[2], await bodyOf(request)));
        return send({ error: "METHOD_NOT_ALLOWED" }, 405);
      }

      const suffix = pathname.slice(learningPath.length + 1);
      if (
        request.method === "GET" &&
        ["feedback", "proposals", "skills"].includes(suffix)
      ) {
        return learningList(request, suffix);
      }
      if (request.method === "POST") {
        if (suffix === "feedback")
          return send(await learn(await bodyOf(request)), 201);

        const decision =
          /^proposals\/([a-zA-Z0-9_-]{1,128})\/(approve|reject)$/.exec(suffix);
        if (decision?.[1] && decision[2]) {
          const body = await bodyOf(request);
          return send({
            proposal: review(
              decision[1],
              decision[2],
              version(body.version, "BOT_SKILL_VERSION_INVALID"),
            ),
          });
        }
        const revert = /^skills\/([a-zA-Z0-9_-]{1,128})\/rollback$/.exec(
          suffix,
        );
        if (revert?.[1]) {
          const body = await bodyOf(request);
          return send({
            skill: rollback(
              revert[1],
              body.version === null
                ? null
                : version(body.version, "BOT_SKILL_VERSION_INVALID"),
            ),
          });
        }
      }
      return send({ error: "BOT_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      if (error instanceof RegistryError)
        return send({ error: error.message }, error.status);
      throw error;
    }
  }

  return { handle, getActive, listActive, getSkill, close: () => db.close() };
}
