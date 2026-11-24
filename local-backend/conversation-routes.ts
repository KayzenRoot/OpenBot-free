import type { createChatStore } from "./chat-store";
import { readModelText } from "./model-stream";
import type { ChatMessage, openCodeGo } from "./opencode";

type Store = ReturnType<typeof createChatStore>;
type Complete = ReturnType<typeof openCodeGo>;

const ID = "([A-Za-z0-9_-]{1,128})";
const COLLECTION = "/api/local/conversations";
const CONVERSATION = new RegExp(`^${COLLECTION}/${ID}$`);
const TURNS = new RegExp(`^${COLLECTION}/${ID}/turns$`);
const CANCEL = new RegExp(`^${COLLECTION}/${ID}/turns/${ID}/cancel$`);
const TURN_ID = /^[A-Za-z0-9_-]{1,128}$/;

const STREAM_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/event-stream; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export function jsonError(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function jsonObject(request: Request) {
  const type = request.headers.get("content-type")?.split(";")[0];
  if (type?.trim().toLowerCase() !== "application/json") return null;
  const value: unknown = await request.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function chatContext(turns: ReturnType<Store["listTurns"]>, prompt: string) {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  let budget = 96_000 - prompt.length;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn?.status !== "completed" || turn.answer === null) continue;
    const size = turn.prompt.length + turn.answer.length;
    if (size > budget || messages.length >= 63) break;
    messages.push(
      { role: "assistant", content: turn.answer },
      { role: "user", content: turn.prompt },
    );
    budget -= size;
  }
  return messages.reverse();
}

class ModelResponseError extends Error {}

export async function modelStream(response: Response) {
  if (
    response.ok &&
    response.body &&
    response.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    return response.body;
  }
  await response.body?.cancel();
  if (response.status === 424) {
    throw new ModelResponseError("OPENCODE_NOT_CONFIGURED");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ModelResponseError("OPENCODE_ACCESS_DENIED");
  }
  if (response.status === 429) {
    throw new ModelResponseError("OPENCODE_RATE_LIMITED");
  }
  throw new ModelResponseError("OPENCODE_UNAVAILABLE");
}

export function createConversationRoutes(options: {
  store: Store;
  complete: Complete;
  publishedInstructions?: (prompt: string) => string;
  removeConversationFiles?: (id: string) => void;
}) {
  const { store, complete } = options;
  const active = new Map<string, { id: string; abort: AbortController }>();

  async function start(request: Request, conversationId: string) {
    const body = await jsonObject(request);
    const incomingId = body?.id;
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (
      typeof incomingId !== "string" ||
      !TURN_ID.test(incomingId) ||
      !prompt ||
      prompt.length > 16_000
    ) {
      return jsonError(400, "INVALID_TURN");
    }
    const id: string = incomingId;
    const result = store.beginTurn(conversationId, id, prompt);
    if (result === "missing") return jsonError(404, "CONVERSATION_NOT_FOUND");
    if (result === "busy") return jsonError(409, "CONVERSATION_BUSY");
    if (result === "conflict") return jsonError(409, "TURN_ID_CONFLICT");
    if (result === "duplicate") return jsonError(409, "TURN_ALREADY_EXISTS");

    const abort = new AbortController();
    const timeout = AbortSignal.timeout(120_000);
    // The turn belongs to the conversation and can outlive its HTTP reader.
    const signal = AbortSignal.any([abort.signal, timeout]);
    active.set(conversationId, { id, abort });

    let disconnected = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        function emit(data: object) {
          if (disconnected) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            disconnected = true;
          }
        }

        async function run() {
          try {
            const messages = chatContext(
              store.listTurns(conversationId),
              prompt,
            );
            const instructions = options.publishedInstructions?.(prompt);
            if (instructions)
              messages.unshift({ role: "system", content: instructions });

            const response = await complete(
              { sessionId: conversationId, messages },
              signal,
            );
            const answer = await readModelText(
              await modelStream(response),
              signal,
              (text) => {
                emit({ type: "delta", text });
              },
            );
            signal.throwIfAborted();
            if (!store.finishTurn(conversationId, id, "completed", answer)) {
              throw new Error("TURN_NOT_RUNNING");
            }
            emit({ type: "done" });
          } catch (error) {
            const cancelled = abort.signal.aborted;
            const reason = cancelled
              ? "TURN_CANCELLED"
              : timeout.aborted
                ? "MODEL_TIMEOUT"
                : error instanceof ModelResponseError
                  ? error.message
                  : "MODEL_RESPONSE_FAILED";
            store.finishTurn(
              conversationId,
              id,
              cancelled ? "cancelled" : "failed",
              undefined,
              reason,
            );
            emit({ type: "error", error: reason });
          } finally {
            active.delete(conversationId);
            if (!disconnected) controller.close();
          }
        }
        return run();
      },
      cancel() {
        disconnected = true;
      },
    });
    return new Response(stream, { headers: STREAM_HEADERS });
  }

  return async (request: Request, path: string): Promise<Response | null> => {
    if (path === COLLECTION && request.method === "GET") {
      return Response.json({ conversations: store.listConversations() });
    }
    if (path === COLLECTION && request.method === "POST") {
      const value = await jsonObject(request);
      const title = value?.title;
      if (
        !value ||
        (title !== undefined &&
          (typeof title !== "string" || title.length > 150))
      ) {
        return jsonError(400, "INVALID_CONVERSATION");
      }
      return Response.json(
        { conversation: store.createConversation(title) },
        { status: 201 },
      );
    }
    const conversationId = CONVERSATION.exec(path)?.[1];
    if (conversationId && request.method === "PATCH") {
      const title = (await jsonObject(request))?.title;
      if (typeof title !== "string" || !title.trim() || title.length > 150) {
        return jsonError(400, "INVALID_CONVERSATION_TITLE");
      }
      const conversation = store.renameConversation(conversationId, title);
      return conversation
        ? Response.json({ conversation })
        : jsonError(404, "CONVERSATION_NOT_FOUND");
    }
    if (conversationId && request.method === "DELETE") {
      if (store.removeConversation(conversationId) === "busy") {
        return jsonError(409, "CONVERSATION_BUSY");
      }
      // Repeating deletion also retries the file cleanup. Startup reclaims any orphan after a crash.
      options.removeConversationFiles?.(conversationId);
      return new Response(null, { status: 204 });
    }
    if (conversationId && request.method === "GET") {
      const conversation = store.getConversation(conversationId);
      return conversation
        ? Response.json({
            conversation,
            turns: store.listTurns(conversationId),
          })
        : jsonError(404, "CONVERSATION_NOT_FOUND");
    }
    if (request.method !== "POST") return null;
    const turnConversationId = TURNS.exec(path)?.[1];
    if (turnConversationId) return start(request, turnConversationId);
    const cancel = CANCEL.exec(path);
    if (cancel?.[1]) {
      const running = active.get(cancel[1]);
      if (running && running.id === cancel[2]) running.abort.abort();
      return new Response(null, { status: 204 });
    }
    return null;
  };
}
