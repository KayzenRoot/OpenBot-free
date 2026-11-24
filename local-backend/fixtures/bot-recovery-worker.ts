import { createHash } from "node:crypto";
import { join } from "node:path";
import { createBotArtifacts } from "../bot-artifacts";
import { type BotJob, createBotQueue } from "../bot-queue";
import { createBotRegistry } from "../bot-registry";
import { createBotWorkflows } from "../bot-workflows";
import { createCampaignPilot } from "../campaign-pilot";
import { createStudioPilot } from "../studio-pilot";
import type { StudioArtwork } from "../studio-pilot-artwork";

export type RecoveryKind = "epub" | "pdf" | "sales";
export type CrashPoint = "started" | "stored";
export type CrashProbe = {
  job: BotJob;
  storedSha256: string | null;
  writes: number;
};
export type ResumeProbe = {
  job: BotJob;
  events: { type: string; stage: string | null; detail?: string }[];
  artifacts: { kind: RecoveryKind; sha256: string }[];
  contentType: string | null;
  signature: string;
  digest: string;
  report: unknown;
  writes: number;
};

const runs = "/api/local/bot-runs";
const bots = "/api/local/bots";
const books = "/api/local/studio/books";
const campaignPath = "/api/local/business/campaign";
const requestKey = "recovery-fixture-v1";

function request(path: string, method = "GET", body?: object, key?: string) {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(key && { "Idempotency-Key": key }),
    },
    body: body && JSON.stringify(body),
  });
}

async function json<T>(response: Response | null, status?: number): Promise<T> {
  if (!response?.ok || (status !== undefined && response.status !== status)) {
    throw new Error(
      `Unexpected fixture API response ${response?.status}: ${await response?.text()}`,
    );
  }
  return (await response.json()) as T;
}

// Use deterministic rendering to isolate durability from browser startup.
const syntheticArtwork: StudioArtwork = async (_book, format) =>
  format === "cover"
    ? Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/P1sAAAAASUVORK5CYII=",
          "base64",
        ),
      )
    : new TextEncoder().encode("%PDF-1.7\n% synthetic layout fixture\n%%EOF\n");

async function fixtureInput(
  kind: RecoveryKind,
  registry: ReturnType<typeof createBotRegistry>,
  studio: ReturnType<typeof createStudioPilot>,
  campaign: ReturnType<typeof createCampaignPilot>,
) {
  const { bot } = await json<{ bot: { id: string; version: number } }>(
    await registry.handle(
      request(bots, "POST", {
        template: kind === "sales" ? "sales" : "ebook",
        request: "Gerar resultado sintético da fila",
      }),
      bots,
    ),
  );
  for (const action of ["simulate", "activate"]) {
    const path = `${bots}/${bot.id}/${action}`;
    await json(
      await registry.handle(
        request(path, "POST", { version: bot.version }),
        path,
      ),
    );
  }

  if (kind !== "sales") {
    const { book } = await json<{ book: { id: string; revision: number } }>(
      await studio.handle(
        request(books, "POST", {
          title: "Edição de recuperação",
          author: "Autora de teste",
          coverTheme: "azul",
          chapters: [
            {
              title: "Capítulo sintético",
              text: "Conteúdo determinístico para EPUB e PDF.",
            },
          ],
        }),
        books,
      ),
      201,
    );
    return {
      botId: bot.id,
      mode: "export",
      bookId: book.id,
      revision: book.revision,
    };
  }

  const {
    campaign: { slug },
  } = await json<{ campaign: { slug: string } }>(
    await campaign.handle(
      request(campaignPath, "PUT", {
        title: "Campanha de recuperação",
        audience: "Equipe de teste",
        promise: "Medir a receita sintética",
        description: "Uma venda que pode ser conferida após a retomada.",
        questions: [
          "Quanto foi pago?",
          "Qual foi o canal?",
          "Qual é a receita líquida?",
        ],
        answers: [
          "Doze reais e cinquenta centavos.",
          "Blog.",
          "Doze reais e cinquenta centavos.",
        ],
        pageUrl: "https://example.test/campanha",
      }),
      campaignPath,
    ),
  );
  const orders = `${campaignPath}/orders`;
  await json(
    await campaign.handle(
      request(orders, "POST", {
        csv: [
          "order_id;status;value;utm_source;utm_medium;utm_campaign;utm_content",
          `order-test;paid;12.50;blog;organico;${slug};artigo`,
        ].join("\n"),
      }),
      orders,
    ),
  );
  return { botId: bot.id };
}

async function run(
  directory: string,
  kind: RecoveryKind,
  mode: CrashPoint | "resume",
  existingJobId?: string,
) {
  let clock = mode === "resume" ? 10_000 : 1_000;
  let writes = 0;
  let queue: ReturnType<typeof createBotQueue> | undefined;
  const artifacts = createBotArtifacts(
    join(directory, "artifacts.sqlite"),
    (id) => Boolean(queue?.getJob(id)),
  );
  const registry = createBotRegistry({
    dbPath: join(directory, "registry.sqlite"),
  });
  const studio = createStudioPilot({
    dbPath: join(directory, "studio.sqlite"),
    render: syntheticArtwork,
  });
  const campaign = createCampaignPilot({
    dbPath: join(directory, "campaign.sqlite"),
  });

  async function interrupt(jobId: string): Promise<never> {
    const job = queue?.getJob(jobId);
    if (!job) throw new Error("The fixture lease was never acquired.");
    const probe: CrashProbe = {
      job,
      storedSha256: artifacts.get(jobId, kind)?.sha256 ?? null,
      writes,
    };
    console.log(JSON.stringify(probe));
    await Bun.sleep(30_000);
    throw new Error("The parent process did not interrupt the fixture worker.");
  }

  const workflows = createBotWorkflows({
    artifacts: {
      ...artifacts,
      put(...args) {
        writes++;
        return artifacts.put(...args);
      },
    },
    registry,
    studio,
    campaign,
    project: {
      async handle() {
        throw new Error("Unexpected Project call in recovery fixture.");
      },
      close() {},
    },
    draft: async () => {
      throw new Error("Unexpected model call in recovery fixture.");
    },
  });
  const workflow = kind === "sales" ? workflows.sales : workflows.ebook;
  const productionStage = workflow.stages.find(({ id }) => id === kind);
  if (!productionStage) throw new Error(`Missing production stage ${kind}.`);
  const runner = createBotQueue({
    dbPath: join(directory, "queue.sqlite"),
    now: () => clock,
    leaseMs: 400,
    retryBaseMs: 10,
    workflows: {
      recovery: {
        ...workflow,
        stages: [
          {
            id: "prepared",
            recovery: "replayable",
            async run() {
              return { revision: 1 };
            },
          },
          {
            ...productionStage,
            async run(input) {
              if (mode === "started") return interrupt(input.jobId);
              const result = await productionStage.run(input);
              if (mode === "stored") return interrupt(input.jobId);
              return result;
            },
          },
        ],
      },
    },
  });
  queue = runner;

  try {
    if (mode !== "resume") {
      const input = await fixtureInput(kind, registry, studio, campaign);
      await json(
        await runner.handle(
          request(runs, "POST", { workflow: "recovery", input }, requestKey),
          runs,
        ),
        201,
      );
      await runner.tick();
      await runner.tick();
      throw new Error(
        "The fixture stage unexpectedly returned a final checkpoint.",
      );
    }

    if (!existingJobId) throw new Error("A job ID is required for recovery.");
    await runner.tick();
    clock += 100;
    await runner.tick();
    const job = runner.getJob(existingJobId);
    if (!job) throw new Error("The job was lost across worker restart.");
    const jobPath = `${runs}/${job.id}`;
    const eventPath = `${jobPath}/events`;
    const artifactPath = `${jobPath}/artifacts`;
    const { events } = await json<{ events: ResumeProbe["events"] }>(
      await runner.handle(request(eventPath), eventPath),
    );
    const { artifacts: stored } = await json<{
      artifacts: ResumeProbe["artifacts"];
    }>(artifacts.handle(request(artifactPath), artifactPath));
    const filePath = `${artifactPath}/${kind}`;
    const response = artifacts.handle(request(filePath), filePath);
    if (!response?.ok)
      throw new Error(
        `The resumed job did not publish its artifact: ${job.status} (${job.error ?? "no error code"}).`,
      );
    const data = Buffer.from(await response.arrayBuffer());
    const probe: ResumeProbe = {
      job,
      events,
      artifacts: stored,
      contentType: response.headers.get("content-type"),
      signature: data.subarray(0, 5).toString("hex"),
      digest: createHash("sha256").update(data).digest("hex"),
      report: kind === "sales" ? JSON.parse(data.toString("utf8")) : null,
      writes,
    };
    console.log(JSON.stringify(probe));
  } finally {
    await runner.close();
    campaign.close();
    studio.close();
    registry.close();
    artifacts.close();
  }
}

if (import.meta.main) {
  const [directory, kind, mode, jobId, ...extra] = process.argv.slice(2);
  if (
    !directory ||
    extra.length ||
    (kind !== "epub" && kind !== "pdf" && kind !== "sales") ||
    (mode !== "started" && mode !== "stored" && mode !== "resume")
  ) {
    throw new Error("Invalid recovery fixture arguments.");
  }
  await run(directory, kind, mode, jobId);
}
