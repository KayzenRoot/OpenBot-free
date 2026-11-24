import type { ArtifactKind, createBotArtifacts } from "./bot-artifacts";
import {
  BotQueueFatalError,
  BotQueueTransientError,
  type BotWorkflow,
  type JsonObject,
} from "./bot-queue";
import { applyEbookOpening, type createBotRegistry } from "./bot-registry";
import type { createBusinessDraft } from "./business-draft";
import { type createCampaignPilot, renderBundlePage } from "./campaign-pilot";
import { assembleZip } from "./epub";
import type { createProjectPilot } from "./project-pilot";
import type { createStudioPilot } from "./studio-pilot";

type Options = {
  registry: ReturnType<typeof createBotRegistry>;
  artifacts: ReturnType<typeof createBotArtifacts>;
  studio: ReturnType<typeof createStudioPilot>;
  campaign: ReturnType<typeof createCampaignPilot>;
  project: ReturnType<typeof createProjectPilot>;
  draft: ReturnType<typeof createBusinessDraft>;
};

const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const encode = new TextEncoder();

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  throw new BotQueueFatalError("BOT_INVALID_INPUT");
}

function text(input: Record<string, unknown>, key: string, maximum: number) {
  const value = input[key];
  if (typeof value === "string" && value.trim() && value.length <= maximum)
    return value.trim();
  throw new BotQueueFatalError("BOT_INVALID_INPUT");
}

function natural(input: Record<string, unknown>, key: string, minimum: number) {
  const value = input[key];
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
  )
    return value;
  throw new BotQueueFatalError("BOT_INVALID_INPUT");
}

function paths(value: unknown, max: number, required = true) {
  if (
    !Array.isArray(value) ||
    (required && !value.length) ||
    value.length > max
  )
    throw new BotQueueFatalError("BOT_INVALID_INPUT");
  return value.map((path: unknown) => {
    if (typeof path !== "string" || !path.trim() || path.length > 512)
      throw new BotQueueFatalError("BOT_INVALID_INPUT");
    return path.trim();
  });
}

function request(path: string, signal: AbortSignal, body?: object) {
  return new Request(`http://127.0.0.1${path}`, {
    signal,
    ...(body && {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

async function accepted(
  result: Response | null,
  fallback: string,
  transientCodes: readonly string[] = [],
) {
  if (result?.ok) return result;
  const error = result ? await result.json().catch(() => null) : null;
  const code =
    typeof error?.error === "string" && /^[A-Z0-9_]{2,80}$/.test(error.error)
      ? error.error
      : fallback;
  if (transientCodes.includes(code)) throw new BotQueueTransientError(code);
  throw new BotQueueFatalError(code);
}

type SalesReport = {
  summary: {
    purchases: number;
    refunds: number;
    netCents: number;
    clicks: number | null;
  };
  bySource: {
    source: string | null;
    medium: string | null;
    content: string | null;
    purchases: number;
    netCents: number;
    clicks: number | null;
  }[];
  unattributedOrders: number;
};
function salesAdvice(report: SalesReport) {
  const confirmed = report.bySource.filter(
    ({ source, purchases }) => source && purchases > 0,
  );
  const best = confirmed.reduce<(typeof confirmed)[number] | null>(
    (current, item) =>
      !current ||
      item.purchases > current.purchases ||
      (item.purchases === current.purchases && item.netCents > current.netCents)
        ? item
        : current,
    null,
  );
  if (!best) {
    return "Importe compras pagas com origem registrada para comparar os canais da campanha.";
  }
  return `Priorize uma nova peça em ${best.source} com base nas ${best.purchases} compras pagas atribuídas a ${best.content || "esse canal"}. Compare uma variação de tema e acompanhe compras, cliques e reembolsos nas próximas importações.`;
}

export function createBotWorkflows({
  registry,
  artifacts,
  studio,
  campaign,
  project,
  draft,
}: Options) {
  function pin(raw: unknown, template: "programming" | "ebook" | "sales") {
    const input = object(raw);
    const botId = text(input, "botId", 36);
    const active = uuid.test(botId) && registry.getActive(botId);
    if (!active || active.template !== template)
      throw new BotQueueFatalError("BOT_ACTIVE_REQUIRED");
    return {
      input,
      pinned: { botId, botVersion: active.version, botName: active.name },
    };
  }

  function requireBook(input: Record<string, unknown>) {
    const id = text(input, "bookId", 36);
    const revision = natural(input, "revision", 1);
    const book = uuid.test(id) && studio.getBook(id, revision);
    if (!book) throw new BotQueueFatalError("STUDIO_BOOK_NOT_FOUND");
    return book;
  }

  function file(jobId: string, kind: ArtifactKind, bytes: Uint8Array) {
    try {
      const value = artifacts.put(jobId, kind, bytes);
      return { artifact: value.kind, size: value.size, sha256: value.sha256 };
    } catch {
      throw new BotQueueFatalError("BOT_ARTIFACT_FAILED");
    }
  }

  function savedFile(jobId: string, kind: ArtifactKind) {
    const value = artifacts.get(jobId, kind);
    return value
      ? { artifact: value.kind, size: value.size, sha256: value.sha256 }
      : null;
  }

  function ebookAsset(kind: "epub" | "pdf" | "sample" | "cover") {
    return {
      id: kind,
      recovery: "replayable",
      maxAttempts: 3,
      async run({ jobId, input, signal }) {
        if (input.mode !== "export") return { skipped: true };
        const saved = savedFile(jobId, kind);
        if (saved) return saved;
        const path = `/api/local/studio/books/${text(input, "bookId", 36)}/export/${kind}`;
        const req = request(
          `${path}?revision=${natural(input, "revision", 1)}`,
          signal,
        );
        const response = await accepted(
          await studio.handle(req, path),
          "STUDIO_EXPORT_FAILED",
          ["STUDIO_EXPORT_FAILED", "STUDIO_EXPORT_IN_PROGRESS"],
        );
        return file(jobId, kind, new Uint8Array(await response.arrayBuffer()));
      },
    } satisfies BotWorkflow["stages"][number];
  }

  const ebook: BotWorkflow = {
    prepare(raw) {
      const { input, pinned } = pin(raw, "ebook");
      const book = requireBook(input);
      const base = {
        ...pinned,
        bookId: book.id,
        revision: book.revision,
        title: book.title,
      };
      if (input.mode === "draft") {
        const chapterIndex = natural(input, "chapterIndex", 0);
        const chapter = book.chapters[chapterIndex];
        if (!chapter?.title)
          throw new BotQueueFatalError("BOT_CHAPTER_REQUIRED");
        const skill = registry.getSkill(pinned.botId);
        const example = skill ? text(input, "practicalExample", 500) : "";
        return {
          ...base,
          mode: "draft",
          chapterIndex,
          brief: text(input, "brief", 2_600),
          practicalExample: example,
          skillVersion: skill?.version ?? null,
        };
      }
      if (input.mode !== "export")
        throw new BotQueueFatalError("BOT_INVALID_INPUT");
      const selectedCampaign =
        input.includeKit === true ? campaign.getCampaign() : null;
      if (input.includeKit === true && selectedCampaign?.title !== book.title)
        throw new BotQueueFatalError("CAMPAIGN_KIT_BOOK_MISMATCH");
      return {
        ...base,
        mode: "export",
        publicPage: selectedCampaign ? renderBundlePage(selectedCampaign) : "",
      };
    },
    stages: [
      {
        id: "draft",
        recovery: "replayable",
        maxAttempts: 3,
        async run({ jobId, input, signal }) {
          if (input.mode !== "draft") return { skipped: true };
          const saved = savedFile(jobId, "draft");
          if (saved) return saved;
          const book = requireBook(input);
          const chapter = book.chapters[natural(input, "chapterIndex", 0)];
          if (!chapter) throw new BotQueueFatalError("BOT_CHAPTER_REQUIRED");
          const path = "/api/local/business/draft";
          const brief = [
            `Ebook ${book.title}. Capítulo ${chapter.title}.`,
            `Público ${book.audience}. Proposta ${book.promise}.`.slice(0, 450),
            `Orientação ${text(input, "brief", 2_600)}`,
            `Referências ${book.sources
              .map((source) => `${source.title} ${source.url}`)
              .join("; ")
              .slice(0, 550)}`,
          ]
            .join("\n")
            .slice(0, 4_000);
          const req = request(path, signal, { kind: "chapter", brief });
          const response = await accepted(
            await draft(req, path),
            "BUSINESS_DRAFT_FAILED",
            ["BUSINESS_DRAFT_FAILED", "BUSINESS_DRAFT_IN_PROGRESS"],
          );
          const result = object(await response.json());
          const drafted = text(result, "text", 8_000);
          const output = input.skillVersion
            ? applyEbookOpening(drafted, text(input, "practicalExample", 500))
            : drafted;
          return file(jobId, "draft", encode.encode(output));
        },
      },
      ebookAsset("epub"),
      ebookAsset("pdf"),
      ebookAsset("sample"),
      ebookAsset("cover"),
      {
        id: "kit",
        recovery: "replayable",
        async run({ jobId, input }) {
          if (typeof input.publicPage !== "string" || !input.publicPage)
            return { skipped: true };
          const existing = savedFile(jobId, "kit");
          if (existing) return existing;
          const sample = artifacts.bytes(jobId, "sample");
          const cover = artifacts.bytes(jobId, "cover");
          if (!sample || !cover)
            throw new BotQueueFatalError("BOT_ARTIFACT_NOT_FOUND");
          return file(
            jobId,
            "kit",
            assembleZip([
              ["index.html", input.publicPage],
              ["amostra.pdf", sample],
              ["capa.png", cover],
            ]),
          );
        },
      },
    ],
  };

  const programming: BotWorkflow = {
    prepare(raw) {
      const { input, pinned } = pin(raw, "programming");
      const testPaths = paths(input.testPaths ?? [], 5, false);
      if (testPaths.length && input.testConfirmed !== true) {
        throw new BotQueueFatalError(
          "PROJECT_PILOT_TEST_CONFIRMATION_REQUIRED",
        );
      }
      return {
        ...pinned,
        repoPath: text(input, "repoPath", 1024),
        prompt: text(input, "prompt", 4000),
        paths: paths(input.paths, 6),
        testPaths,
      };
    },
    stages: [
      {
        id: "proposal",
        recovery: "review",
        async run({ input, jobId, signal }) {
          const path = "/api/local/project-pilots";
          const req = request(path, signal, {
            repoPath: input.repoPath,
            prompt: input.prompt,
            paths: input.paths,
          });
          const response = await accepted(
            await project.handle(req, path),
            "PROJECT_PILOT_FAILED",
          );
          const generated = object(await response.json());
          const pilot = object(generated.pilot);
          const projectId = text(pilot, "id", 36);
          const patch =
            typeof pilot.patch === "string" && pilot.patch
              ? file(jobId, "patch", encode.encode(pilot.patch)).artifact
              : null;
          return {
            projectId,
            patch,
            proposed: Boolean(patch),
            baseCommit: text(pilot, "baseCommit", 64),
          };
        },
      },
      {
        id: "tests",
        recovery: "replayable",
        async run({ input, outputs, signal }): Promise<JsonObject> {
          const testPaths = paths(input.testPaths, 5, false);
          if (!testPaths.length) return { skipped: true };
          const id = text(object(outputs.proposal), "projectId", 36);
          if (!uuid.test(id))
            throw new BotQueueFatalError("PROJECT_PILOT_NOT_FOUND");
          const path = `/api/local/project-pilots/${id}/test`;
          const req = request(path, signal, {
            confirmed: true,
            paths: testPaths,
          });
          const result = await accepted(
            await project.handle(req, path),
            "PROJECT_PILOT_FAILED",
            ["PROJECT_PILOT_BUSY"],
          );
          const pilot = object(object(await result.json()).pilot);
          const test = object(pilot.test);
          if (test.status !== "passed")
            throw new BotQueueFatalError("BOT_PROGRAM_TEST_FAILED");
          return { projectId: id, status: "passed" };
        },
      },
    ],
  };

  const sales: BotWorkflow = {
    prepare(raw) {
      const { pinned } = pin(raw, "sales");
      const current = campaign.getCampaign();
      if (!current) throw new BotQueueFatalError("CAMPAIGN_REQUIRED");
      return { ...pinned, campaign: current.slug };
    },
    stages: [
      {
        id: "sales",
        recovery: "replayable",
        async run({ jobId, input, signal }) {
          const existing = savedFile(jobId, "sales");
          if (existing) return existing;
          if (campaign.getCampaign()?.slug !== input.campaign)
            throw new BotQueueFatalError("CAMPAIGN_REQUIRED");
          const path = "/api/local/business/campaign/orders";
          const result = await accepted(
            await campaign.handle(request(path, signal), path),
            "CAMPAIGN_REQUIRED",
          );
          const { report } = (await result.json()) as { report: SalesReport };
          const recommendation = salesAdvice(report);
          return {
            ...file(
              jobId,
              "sales",
              encode.encode(
                JSON.stringify({ report, recommendation }, null, 2),
              ),
            ),
            recommendation,
            purchases: report.summary.purchases,
            refunds: report.summary.refunds,
          };
        },
      },
    ],
  };

  return { programming, ebook, sales };
}
