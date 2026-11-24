import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentRoutes } from "./attachments";
import { createChatStore } from "./chat-store";
import { createConversationRoutes } from "./conversation-routes";
import type { openCodeGo } from "./opencode";
import { startLocalBackend } from "./server";

type Complete = ReturnType<typeof openCodeGo>;
const token = "persistent-server-test-token-123456";
const conversations = "/api/local/conversations";

function modelResponse(parts: string[], done = true) {
  const lines = parts
    .map(
      (content) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`,
    )
    .join("");
  const bytes = new TextEncoder().encode(
    `${lines}${done ? "data: [DONE]\r\n\r\n" : ""}`,
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 3) {
          controller.enqueue(bytes.slice(offset, offset + 3));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function localTest(database: string, complete: Complete) {
  const store = createChatStore(database);
  const server = startLocalBackend({
    token,
    complete,
    port: 0,
    createPersistentRoutes: () => ({
      conversations: createConversationRoutes({ store, complete }),
    }),
  });
  return {
    async request(
      path: string,
      data?: object,
      headers: Record<string, string> = { authorization: `Bearer ${token}` },
    ) {
      return fetch(new URL(path, server.url), {
        method: data ? "POST" : "GET",
        headers: { ...headers, "content-type": "application/json" },
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(4_000),
      });
    },
    async stop() {
      await server.stop(true);
      store.close();
    },
  };
}

test("persists authenticated, deduplicated chat and recovers it after restart", async () => {
  const folder = mkdtempSync(join(tmpdir(), "openbot-api-test-"));
  const database = join(folder, "chat.sqlite");
  const requests: Array<Parameters<Complete>[0]> = [];
  const complete: Complete = async (turn) => {
    requests.push(turn);
    return modelResponse(["Olá ", "você 👍"]);
  };
  let app = localTest(database, complete);
  try {
    const session = await app.request("/api/local/session", { token }, {});
    expect(session.status).toBe(200);
    const header = session.headers.get("set-cookie") ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    const cookie = { cookie: header.split(";")[0] ?? "" };
    expect((await app.request(conversations, undefined, {})).status).toBe(401);
    const create = await app.request(
      conversations,
      { title: "Teste local" },
      cookie,
    );
    expect(create.status).toBe(201);
    const { conversation } = await create.json();
    const path = `${conversations}/${conversation.id}/turns`;
    const turn = { id: "first", prompt: "Diga olá" };
    const stream = await app.request(path, turn, cookie);
    const text = await stream.text();
    expect(text).toContain('"text":"Olá "');
    expect(text).toContain('"text":"você 👍"');
    expect(text).toContain('"type":"done"');
    expect((await app.request(path, turn, cookie)).status).toBe(409);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.sessionId).toBe(conversation.id);

    await app.stop();
    app = localTest(database, complete);
    expect((await app.request(conversations, undefined, cookie)).status).toBe(
      401,
    );
    const loaded = await app.request(`${conversations}/${conversation.id}`);
    const { turns } = await loaded.json();
    expect(turns).toMatchObject([
      {
        id: "first",
        prompt: "Diga olá",
        answer: "Olá você 👍",
        status: "completed",
      },
    ]);
    const next = await app.request(path, { id: "second", prompt: "Continue" });
    await next.text();
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "Diga olá" },
      { role: "assistant", content: "Olá você 👍" },
      { role: "user", content: "Continue" },
    ]);
  } finally {
    await app.stop();
    rmSync(folder, { recursive: true });
  }
});

test("preserves a failed turn when a model stream is truncated", async () => {
  const app = localTest(":memory:", async () =>
    modelResponse(["partial"], false),
  );
  try {
    const { conversation } = await (
      await app.request(conversations, {})
    ).json();
    const path = `${conversations}/${conversation.id}`;
    const response = await app.request(`${path}/turns`, {
      id: "truncated",
      prompt: "Hello",
    });
    const text = await response.text();
    expect(text).toContain('"error":"MODEL_RESPONSE_FAILED"');
    const { turns } = await (await app.request(path)).json();
    expect(turns[0]).toMatchObject({ status: "failed", answer: null });
  } finally {
    await app.stop();
  }
});

test("streams early partial output and cancels the active provider request", async () => {
  let signal: AbortSignal | undefined;
  const app = localTest(":memory:", async (_turn, requestSignal) => {
    signal = requestSignal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            ),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const { conversation } = await (
      await app.request(conversations, {})
    ).json();
    const path = `${conversations}/${conversation.id}`;
    const response = await app.request(`${path}/turns`, {
      id: "cancel",
      prompt: "Hello",
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain(
      '"text":"partial"',
    );
    const parallel = await app.request(`${path}/turns`, {
      id: "parallel",
      prompt: "Another turn",
    });
    expect(parallel.status).toBe(409);
    const cancelled = await app.request(`${path}/turns/cancel/cancel`, {});
    expect(cancelled.status).toBe(204);
    await reader?.read();
    expect(signal?.aborted).toBe(true);
    const { turns } = await (await app.request(path)).json();
    expect(turns[0]).toMatchObject({ status: "cancelled", answer: null });
  } finally {
    await app.stop();
  }
});

test("keeps a turn running when its client reloads and saves the answer", async () => {
  let finish: (() => void) | undefined;
  const app = localTest(":memory:", async () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"first "}}]}\n\n',
            ),
          );
          finish = () => {
            finish = undefined;
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"second"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          };
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const { conversation } = await (
      await app.request(conversations, {})
    ).json();
    const path = `${conversations}/${conversation.id}`;
    const response = await app.request(`${path}/turns`, {
      id: "reload",
      prompt: "Hello",
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "first",
    );
    void reader.cancel().catch(() => {});
    const running = await (await app.request(path)).json();
    expect(running.turns[0]?.status).toBe("running");
    finish?.();
    for (let attempt = 0; attempt < 100; attempt++) {
      const { turns } = await (await app.request(path)).json();
      if (turns[0]?.status === "completed") {
        expect(turns[0].answer).toBe("first second");
        return;
      }
      await Bun.sleep(10);
    }
    throw new Error("Disconnected turn was never saved");
  } finally {
    finish?.();
    await app.stop();
  }
});

test("renames conversations and cleans up local files on explicit deletion", async () => {
  const store = createChatStore(":memory:");
  const complete: Complete = async () => modelResponse(["stub"]);
  const attachments = createAttachmentRoutes({
    dbPath: ":memory:",
    conversationExists: (id) => store.getConversation(id) !== null,
  });
  let filesRemoved = 0;
  const server = startLocalBackend({
    token,
    complete,
    port: 0,
    createPersistentRoutes: () => ({
      conversations: createConversationRoutes({
        store,
        complete,
        removeConversationFiles(id) {
          filesRemoved += attachments.removeConversationFiles(id).changes;
        },
      }),
      attachments: attachments.handle,
    }),
  });
  const conversation = store.createConversation("Before");
  const path = `/api/local/conversations/${conversation.id}`;
  const call = (url: string, init?: RequestInit) =>
    fetch(new URL(url, server.url), {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init?.headers },
    });
  try {
    const renamed = await call(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "  After  " }),
    });
    expect((await renamed.json()).conversation.title).toBe("After");
    const form = new FormData();
    form.set(
      "file",
      new File(["example"], "fixture.txt", { type: "text/plain" }),
    );
    expect(
      (await call(`${path}/attachments`, { method: "POST", body: form }))
        .status,
    ).toBe(201);
    expect(store.beginTurn(conversation.id, "active", "Prompt")).toBe(
      "started",
    );
    expect((await call(path, { method: "DELETE" })).status).toBe(409);
    expect(
      store.finishTurn(conversation.id, "active", "completed", "Answer"),
    ).toBe(true);
    expect((await call(path, { method: "DELETE" })).status).toBe(204);
    expect((await call(path, { method: "DELETE" })).status).toBe(204);
    expect(filesRemoved).toBe(1);
    expect(store.listTurns(conversation.id)).toEqual([]);
    expect((await call(`${path}/attachments`)).status).toBe(404);
  } finally {
    await server.stop(true);
    attachments.close();
    store.close();
  }
});
