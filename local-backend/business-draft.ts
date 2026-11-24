import { randomUUID } from "node:crypto";
import { jsonError, jsonObject, modelStream } from "./conversation-routes";
import { readModelText } from "./model-stream";
import type { openCodeGo } from "./opencode";

const draftPrompts = {
  caption:
    "Return JSON with one string key caption, at most 2200 characters. Write a social caption in the requested language (default Brazilian Portuguese). Avoid unsupported claims and invented product details.",
  ebook:
    "Return JSON with one key chapters, an array of 3 to 6 objects with string keys title and text. Each title must be at most 120 characters. Use short paragraphs separated by blank lines. Write in the requested language (default Brazilian Portuguese).",
  chapter:
    "Return JSON with one string key text, at most 8000 characters. Draft only the requested chapter, with examples relevant to the audience and short paragraphs separated by blank lines. Use the supplied source titles and URLs only as references. Do not claim to have read URLs, invent citations, or present unsupported facts as verified. Write in the requested language (default Brazilian Portuguese).",
} as const;

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

export function createBusinessDraft(complete?: ReturnType<typeof openCodeGo>) {
  let busy = false;
  return async (
    request: Request,
    pathname: string,
  ): Promise<Response | null> => {
    if (pathname !== "/api/local/business/draft") return null;
    if (request.method === "GET")
      return Response.json({ configured: Boolean(complete) });
    if (request.method !== "POST") return jsonError(405, "METHOD_NOT_ALLOWED");
    if (!complete) return jsonError(424, "BUSINESS_MODEL_NOT_CONFIGURED");
    const body = await jsonObject(request);
    if (
      (body?.kind !== "caption" &&
        body?.kind !== "ebook" &&
        body?.kind !== "chapter") ||
      !validText(body.brief, 4_000)
    )
      return jsonError(400, "INVALID_BUSINESS_BRIEF");
    if (busy) return jsonError(409, "BUSINESS_DRAFT_IN_PROGRESS");

    busy = true;
    try {
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(110_000),
      ]);
      const response = await complete(
        {
          sessionId: `business-${randomUUID()}`,
          messages: [
            {
              role: "system",
              content: `Produce a draft for human review. Do not take actions or claim any action was taken. Respond only with valid JSON. ${draftPrompts[body.kind]}`,
            },
            { role: "user", content: body.brief.trim() },
          ],
        },
        signal,
      );
      const answer = await readModelText(await modelStream(response), signal);
      const value = JSON.parse(
        answer
          .trim()
          .replace(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i, "$1"),
      );
      if (body.kind === "caption" && validText(value?.caption, 2_200)) {
        return Response.json({ caption: value.caption.trim() });
      }
      if (body.kind === "chapter" && validText(value?.text, 8_000)) {
        return Response.json({ text: value.text.trim() });
      }
      const chapters: unknown = value?.chapters;
      if (
        body.kind === "ebook" &&
        Array.isArray(chapters) &&
        chapters.length >= 1 &&
        chapters.length <= 8 &&
        chapters.every(
          (chapter) =>
            validText(chapter?.title, 120) && validText(chapter?.text, 8_000),
        )
      ) {
        return Response.json({
          chapters: chapters.map(({ title, text }) => ({
            title: title.trim(),
            text: text.trim(),
          })),
        });
      }
      return jsonError(502, "BUSINESS_DRAFT_INVALID");
    } catch {
      return jsonError(502, "BUSINESS_DRAFT_FAILED");
    } finally {
      busy = false;
    }
  };
}
