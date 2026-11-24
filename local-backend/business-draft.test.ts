import { expect, test } from "bun:test";
import { createBusinessDraft } from "./business-draft";

const route = "/api/local/business/draft";
const draftRequest = (kind: string) =>
  new Request(`http://127.0.0.1${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, brief: "Texto da pessoa usuária" }),
  });

function stream(content: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

test("validates generated ebook and caption as drafts", async () => {
  const chapter = { title: "Capítulo", text: "Primeiro parágrafo." };
  const fenced = [
    "\x60\x60\x60json",
    JSON.stringify({ chapters: [{ ...chapter, undeclared: "field" }] }),
    "\x60\x60\x60",
  ].join("\n");
  const generate = createBusinessDraft(async ({ messages, tools }) => {
    expect(tools).toBeUndefined();
    expect(messages[1]).toEqual({
      role: "user",
      content: "Texto da pessoa usuária",
    });
    return stream(
      messages[0]?.content.includes("chapters")
        ? fenced
        : '{"caption":"Legenda de teste"}',
    );
  });
  expect(await (await generate(draftRequest("ebook"), route))?.json()).toEqual({
    chapters: [chapter],
  });
  expect(
    await (await generate(draftRequest("caption"), route))?.json(),
  ).toEqual({ caption: "Legenda de teste" });
});

test("returns a clear error for absent credentials and rejects malformed model drafts", async () => {
  const unavailable = createBusinessDraft();
  expect((await unavailable(draftRequest("caption"), route))?.status).toBe(424);
  const generate = createBusinessDraft(async () =>
    stream('{"chapters":[{"title":"Sem conteúdo","text":""}]}'),
  );
  expect(await (await generate(draftRequest("ebook"), route))?.json()).toEqual({
    error: "BUSINESS_DRAFT_INVALID",
  });
});
