import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEEPSEEK_MODEL, type openCodeGo } from "./opencode";

const agent = "openbot-local";
const cliConfig = JSON.stringify({
  autoupdate: false,
  share: "disabled",
  permission: "deny",
  agent: {
    [agent]: {
      mode: "primary",
      permission: "deny",
      prompt:
        "Give programming assistance as text. You cannot access files, invoke tools, or run code. Use the supplied conversation context for the current coding request.",
    },
  },
});

export function findOpenCodeExecutable() {
  const configured = process.env.OPENBOT_OPENCODE_EXECUTABLE?.trim();
  if (configured) return configured;
  const npm =
    process.env.APPDATA &&
    join(
      process.env.APPDATA,
      "npm",
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
  return npm && existsSync(npm)
    ? npm
    : Bun.which(process.platform === "win32" ? "opencode.exe" : "opencode");
}

export function openCodeCli(
  executable: string,
  profile: string,
): ReturnType<typeof openCodeGo> {
  const directory = join(profile, "opencode-runtime");
  mkdirSync(directory, { recursive: true });
  const mapping = new Database(join(directory, "sessions.sqlite"));
  mapping.exec(
    "CREATE TABLE IF NOT EXISTS sessions (conversation_id TEXT PRIMARY KEY, opencode_id TEXT NOT NULL)",
  );
  const lookup = mapping.query<{ id: string }, [string]>(
    "SELECT opencode_id AS id FROM sessions WHERE conversation_id=?",
  );
  const bind = mapping.query(
    "INSERT OR REPLACE INTO sessions (conversation_id, opencode_id) VALUES (?, ?)",
  );
  const forget = mapping.query("DELETE FROM sessions WHERE conversation_id=?");

  return async (turn, signal) => {
    signal.throwIfAborted();
    const session = lookup.get(turn.sessionId)?.id;
    const messages = session
      ? [
          ...turn.messages.filter((item) => item.role === "system"),
          turn.messages.at(-1),
        ]
      : turn.messages;
    const prompt = messages
      .filter(Boolean)
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const child = Bun.spawn(
      [
        executable,
        "run",
        "--pure",
        "--format",
        "json",
        "--model",
        `opencode-go/${DEEPSEEK_MODEL}`,
        "--agent",
        agent,
        "--dir",
        directory,
        "--title",
        "OpenBot Local",
        ...(session ? ["--session", session] : []),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: cliConfig,
          OPENCODE_CONFIG_DIR: directory,
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        },
        stdin: new Blob([prompt]),
        stdout: "pipe",
        stderr: "ignore",
      },
    );

    const encoder = new TextEncoder();
    let abortOutput = false;
    const kill = () => {
      abortOutput = true;
      child.kill();
    };
    signal.addEventListener("abort", kill, { once: true });

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let completed = false;
        let opencodeId: string | undefined;
        let buffer = "";
        const decoder = new TextDecoder();
        const parts = new Set<string>();
        try {
          for await (const chunk of child.stdout) {
            signal.throwIfAborted();
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            if (buffer.length > 1_000_000)
              throw new Error("OPENCODE_OUTPUT_TOO_LARGE");
            for (const line of lines) {
              if (!line.startsWith("{")) continue;
              const event = JSON.parse(line) as {
                type: string;
                sessionID?: string;
                part?: { id?: string; text?: string };
              };
              if (event.type === "error" || event.type === "tool_use")
                throw new Error("OPENCODE_RUN_FAILED");
              if (event.sessionID && /^ses_[A-Za-z0-9]+$/.test(event.sessionID))
                opencodeId = event.sessionID;
              if (
                event.type !== "text" ||
                !event.part?.text ||
                !event.part.id ||
                parts.has(event.part.id)
              )
                continue;
              parts.add(event.part.id);
              const choices = [{ delta: { content: event.part.text } }];
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ choices })}\n\n`),
              );
            }
          }
          if ((await child.exited) !== 0 || !opencodeId || !parts.size) {
            throw new Error("OPENCODE_RUN_FAILED");
          }
          signal.throwIfAborted();
          bind.run(turn.sessionId, opencodeId);
          completed = true;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          if (!abortOutput)
            controller.enqueue(encoder.encode('data: {"error":true}\n\n'));
        } finally {
          if (!completed) {
            forget.run(turn.sessionId);
            child.kill();
          }
          signal.removeEventListener("abort", kill);
          if (!abortOutput) controller.close();
          else if (signal.aborted) {
            try {
              controller.close();
            } catch {
              /* Client already closed the stream. */
            }
          }
        }
      },
      cancel: kill,
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
}
