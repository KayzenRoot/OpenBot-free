import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createBotArtifacts } from "./bot-artifacts";
import {
  BotQueueFatalError,
  BotQueueTransientError,
  createBotQueue,
} from "./bot-queue";
import { applyEbookOpening, createBotRegistry } from "./bot-registry";
import { createBotWorkflows } from "./bot-workflows";
import { createCampaignPilot } from "./campaign-pilot";
import { createStudioPilot } from "./studio-pilot";

function http(path: string, body?: object, key?: string) {
  return new Request(`http://127.0.0.1${path}`, {
    ...(body && { method: "POST", body: JSON.stringify(body) }),
    headers: {
      "Content-Type": "application/json",
      ...(key && { "Idempotency-Key": key }),
    },
  });
}

test("persisted stage outputs survive retry and controls, and review forbids invented completion", async () => {
  let now = 1000;
  let failures = 0;
  const queue = createBotQueue({
    dbPath: ":memory:",
    now: () => now,
    retryBaseMs: 10,
    workflows: {
      book: {
        prepare: () => ({ revision: 2 }),
        stages: [
          {
            id: "proof",
            recovery: "replayable",
            async run() {
              return { count: 1 };
            },
          },
          {
            id: "pdf",
            recovery: "replayable",
            async run({ outputs }) {
              expect(outputs.proof).toEqual({ count: 1 });
              if (!failures++)
                throw new BotQueueTransientError("EDGE_TEMPORARY");
              return { exported: true };
            },
          },
          {
            id: "external",
            recovery: "review",
            async run() {
              throw new BotQueueFatalError("OUTCOME_UNCERTAIN");
            },
          },
        ],
      },
    },
  });
  const root = "/api/local/bot-runs";
  const submit = () =>
    queue.handle(
      http(root, { workflow: "book", input: {} }, "checkout-key"),
      root,
    );
  try {
    const created = await submit();
    const { job } = await created!.json();
    expect((await (await submit())!.json()).job.id).toBe(job.id);
    await queue.tick();
    await queue.tick();
    expect(queue.getJob(job.id)?.status).toBe("retry_wait");
    expect(queue.getJob(job.id)?.outputs.proof).toEqual({ count: 1 });
    const pause = `${root}/${job.id}/pause`;
    await queue.handle(http(pause, {}), pause);
    now += 200;
    expect(await queue.tick()).toBe(false);
    const resume = `${root}/${job.id}/resume`;
    await queue.handle(http(resume, {}), resume);
    await queue.tick();
    await queue.tick();
    expect(queue.getJob(job.id)?.status).toBe("review");
    const resolve = `${root}/${job.id}/resolve`;
    expect(
      (
        await queue.handle(
          http(resolve, {
            resolution: "completed",
            output: { observed: true },
          }),
          resolve,
        )
      )?.status,
    ).toBe(409);
    expect(
      (await queue.handle(http(resolve, { resolution: "failed" }), resolve))
        ?.ok,
    ).toBe(true);
    expect(queue.getJob(job.id)?.status).toBe("failed");
    expect(queue.getJob(job.id)?.outputs.pdf).toEqual({ exported: true });
  } finally {
    await queue.close();
  }
});

test("simulates, activates, compares a held-out correction and rolls back a scoped skill", async () => {
  const known: string[] = [randomUUID(), randomUUID(), randomUUID()];
  const registry = createBotRegistry({
    dbPath: ":memory:",
    canLearnFromRun: (_bot, run, version) =>
      known.includes(run) && version === 1,
  });
  async function api(path: string, body?: object) {
    const response = await registry.handle(http(path, body), path);
    return { status: response?.status, value: await response?.json() };
  }
  const bots = "/api/local/bots";
  const feedback = "/api/local/bot-learning/feedback";
  try {
    const {
      value: { bot },
    } = await api(bots, { template: "ebook", request: "Editar meus ebooks" });
    expect(
      (await api(`${bots}/${bot.id}/activate`, { version: 1 })).status,
    ).toBe(409);
    expect(
      (await api(`${bots}/${bot.id}/simulate`, { version: 1 })).value.simulation
        .passed,
    ).toBe(true);
    expect(
      (await api(`${bots}/${bot.id}/activate`, { version: 1 })).status,
    ).toBe(200);
    expect(registry.getActive(bot.id)?.template).toBe("ebook");
    let proposal: {
      id: string;
      version: number;
      comparison: { heldOut: number; regressions: number };
    } | null = null;
    for (const [index, example] of [
      "Uma loja pequena compara vendas por campanha",
      "Uma editora revisa capítulos com leitores beta",
      "Uma consultora acompanha metas sem planilha paralela",
    ].entries()) {
      const response = await api(feedback, {
        botId: bot.id,
        botVersion: 1,
        runId: known[index],
        before: "A teoria vem primeiro.",
        after: `${example}.\n\nAgora vamos consultar as evidências.`,
        example,
      });
      expect(response.status).toBe(201);
      proposal = response.value.proposal;
    }
    expect(proposal?.comparison).toMatchObject({ heldOut: 1, regressions: 0 });
    expect(
      (
        await api(`/api/local/bot-learning/proposals/${proposal!.id}/approve`, {
          version: proposal!.version,
        })
      ).status,
    ).toBe(200);
    expect(registry.getSkill(bot.id)?.rule).toBe("ebook.open-with-example");
    const studio = createStudioPilot({ dbPath: ":memory:" });
    const campaign = createCampaignPilot({ dbPath: ":memory:" });
    const artifacts = createBotArtifacts(":memory:", () => true);
    const queue = createBotQueue({
      dbPath: ":memory:",
      workflows: createBotWorkflows({
        registry,
        artifacts,
        studio,
        campaign,
        project: {
          async handle() {
            throw new Error("Ebook may not access projects");
          },
          close() {},
        },
        draft: async () =>
          Response.json({ text: "Aqui está a análise editorial." }),
      }),
    });
    try {
      const books = "/api/local/studio/books";
      const { book } = await (await studio.handle(
        http(books, {
          title: "Livro",
          author: "Autora",
          chapters: [{ title: "Capítulo", text: "Introdução" }],
        }),
        books,
      ))!.json();
      const root = "/api/local/bot-runs";
      const { job } = await (await queue.handle(
        http(root, {
          workflow: "ebook",
          input: {
            botId: bot.id,
            bookId: book.id,
            revision: book.revision,
            mode: "draft",
            chapterIndex: 0,
            brief: "Escreva a introdução.",
            practicalExample: "Uma autora organiza o sumário antes da revisão.",
          },
        }),
        root,
      ))!.json();
      expect(job.input.skillVersion).toBe(1);
      for (let index = 0; index < 6; index += 1) await queue.tick();
      expect(queue.getJob(job.id)?.status).toBe("completed");
      const output = new TextDecoder().decode(artifacts.bytes(job.id, "draft"));
      expect(output).toStartWith(
        "Exemplo prático: Uma autora organiza o sumário antes da revisão.",
      );
      expect(studio.getBook(book.id)?.chapters[0]?.text).toBe("Introdução");
    } finally {
      await queue.close();
      artifacts.close();
      studio.close();
      campaign.close();
    }
    expect(
      applyEbookOpening(
        "Introdução",
        "Uma loja compara as origens.",
      ).startsWith("Exemplo prático"),
    ).toBe(true);
    expect(
      (
        await api(`/api/local/bot-learning/skills/${bot.id}/rollback`, {
          version: null,
        })
      ).status,
    ).toBe(200);
    expect(registry.getSkill(bot.id)).toBeNull();
  } finally {
    registry.close();
  }
});
