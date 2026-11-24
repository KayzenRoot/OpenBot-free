const MAX_EVENT_CHARS = 1_000_000;
const MAX_ANSWER_CHARS = 500_000;

export async function readModelText(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onText: (delta: string) => void = () => {},
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deltas: string[] = [];
  let answerLength = 0;
  let buffer = "";
  let data: string[] = [];
  let dataLength = 0;
  let finishReason: string | null = null;

  function readLine(line: string) {
    if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      dataLength += value.length;
      if (dataLength > MAX_EVENT_CHARS)
        throw new Error("MODEL_EVENT_TOO_LARGE");
      data.push(value);
    }
    if (line || !data.length) return false;

    const event = data.join("\n");
    data = [];
    dataLength = 0;
    if (event === "[DONE]") return true;
    const frame = JSON.parse(event) as {
      error?: unknown;
      choices?: Array<{
        finish_reason?: string | null;
        delta?: { content?: string | null };
      }>;
    };
    if (frame.error) throw new Error("MODEL_STREAM_ERROR");
    const choice = frame.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const text = choice?.delta?.content;
    if (typeof text !== "string" || !text) return false;

    answerLength += text.length;
    if (answerLength > MAX_ANSWER_CHARS)
      throw new Error("MODEL_OUTPUT_TOO_LARGE");
    deltas.push(text);
    onText(text);
    return false;
  }

  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (readLine(line)) {
          if (finishReason !== null && finishReason !== "stop") {
            throw new Error("MODEL_DID_NOT_COMPLETE");
          }
          const answer = deltas.join("");
          if (!answer.trim()) throw new Error("MODEL_EMPTY_RESPONSE");
          return answer;
        }
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_EVENT_CHARS)
        throw new Error("MODEL_EVENT_TOO_LARGE");
    }
    signal.throwIfAborted();
    throw new Error("MODEL_STREAM_TRUNCATED");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
