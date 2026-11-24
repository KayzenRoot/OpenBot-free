export const DEEPSEEK_MODEL = "deepseek-v4.1-flash";
export const OPENCODE_GO_URL =
  "https://opencode.ai/inference/go/openai/v1/chat/completions";
export const OPENCODE_CONSOLE_URL =
  "https://opencode.ai/inference/openai/v1/chat/completions";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type Turn = {
  sessionId: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
};

export function openCodeGo(
  apiKey: string,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
  endpoint = OPENCODE_GO_URL,
) {
  return (turn: Turn, signal: AbortSignal) =>
    send(endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "user-agent": "OpenBotLocal/dev",
        "x-opencode-session": turn.sessionId,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: turn.messages,
        stream: true,
        tools: turn.tools,
      }),
    });
}
