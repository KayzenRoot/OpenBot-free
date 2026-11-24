import { afterEach, expect, test } from "bun:test";
import { DEEPSEEK_MODEL, OPENCODE_GO_URL, openCodeGo } from "./opencode";
import { startLocalBackend } from "./server";

const token = "test-local-token-5ec665c374fc428cad9c";
const turn = {
  sessionId: "ses_test",
  messages: [{ role: "user" as const, content: "Explain this function." }],
};
const stream =
  'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n';
let server: ReturnType<typeof startLocalBackend> | undefined;

afterEach(() => server?.stop(true));

function chat(headers?: HeadersInit, body: unknown = turn) {
  return fetch(new URL("/api/local/chat", server?.url), {
    method: "POST",
    headers: headers ?? {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("relays a DeepSeek stream through the local API", async () => {
  let upstreamRequest: Request | undefined;
  server = startLocalBackend({
    token,
    port: 0,
    complete: openCodeGo("test-upstream-key", async (url, init) => {
      upstreamRequest = new Request(url, init);
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  });

  const health = await fetch(new URL("/health", server.url));
  expect(await health.json()).toEqual({ status: "ok", model: DEEPSEEK_MODEL });
  const response = await chat();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  expect(await response.text()).toBe(stream);
  expect(upstreamRequest?.url).toBe(OPENCODE_GO_URL);
  expect(upstreamRequest?.headers.get("authorization")).toBe(
    "Bearer test-upstream-key",
  );
  expect(upstreamRequest?.headers.get("user-agent")).toBe("OpenBotLocal/dev");
  expect(upstreamRequest?.headers.get("x-opencode-session")).toBe(
    turn.sessionId,
  );
  expect(await upstreamRequest?.json()).toEqual({
    model: DEEPSEEK_MODEL,
    messages: turn.messages,
    stream: true,
  });
});

test("the provider transport preserves declared tools and streamed tool calls", async () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "lookup_example",
        description: "Look up an example",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  const delta =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup_example"}}]}}]}\n\n';
  const complete = openCodeGo("test", async (_url, init) => {
    expect(JSON.parse(String(init.body)).tools).toEqual(tools);
    return new Response(delta);
  });
  const response = await complete(
    { ...turn, tools },
    new AbortController().signal,
  );
  expect(await response.text()).toBe(delta);
});

test("rejects unauthorized, cross-origin and invalid turns before inference", async () => {
  let calls = 0;
  server = startLocalBackend({
    token,
    port: 0,
    complete: async () => {
      calls++;
      return new Response();
    },
  });
  const auth = { authorization: `Bearer ${token}` };
  expect((await chat({ "content-type": "application/json" })).status).toBe(401);
  expect((await chat({ ...auth, origin: "https://example.com" })).status).toBe(
    403,
  );
  expect((await chat(auth)).status).toBe(415);
  expect(
    (await chat(undefined, { ...turn, sessionId: "invalid id" })).status,
  ).toBe(400);
  expect(calls).toBe(0);
});

test.each([
  [403, 502, "OPENCODE_ACCESS_DENIED"],
  [429, 429, "OPENCODE_RATE_LIMITED"],
  [500, 502, "OPENCODE_UNAVAILABLE"],
] as const)(
  "maps upstream %i without returning upstream details",
  async (status, expected, error) => {
    server = startLocalBackend({
      token,
      port: 0,
      complete: async () =>
        new Response("private provider details", { status }),
    });
    const response = await chat();
    expect(response.status).toBe(expected);
    expect(await response.json()).toEqual({ error });
  },
);
