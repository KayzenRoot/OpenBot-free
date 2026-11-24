import { type createBrowserRecorder, RecorderError } from "./browser-recorder";
import { jsonError } from "./conversation-routes";
import type { createLocalLearning } from "./learning";
import {
  importRecordingEvidence,
  RecordingImportError,
} from "./recording-import";

const START = "/api/local/learning/recording/start";
const STATUS = "/api/local/learning/recording";
const STOP = "/api/local/learning/recording/stop";
const IMPORT = "/api/local/learning/recordings";

export function createLearningRoutes(
  learning: Pick<ReturnType<typeof createLocalLearning>, "handle">,
  recorder: ReturnType<typeof createBrowserRecorder>,
) {
  let lastStopped: { key: string; response: Response } | undefined;

  function send(request: Request, path: string, body: object, key: string) {
    const target = new URL(`/api/local/learning/${path}`, request.url);
    return learning.handle(
      new Request(target, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
        signal: request.signal,
      }),
    );
  }

  async function save(request: Request, content: unknown, key: string) {
    const evidence = importRecordingEvidence(content);
    return (
      (await send(request, "evidence", evidence, key)) ??
      jsonError(500, "RECORDING_NOT_SAVED")
    );
  }

  return async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (path === STATUS && request.method === "GET") {
      return Response.json({ recording: recorder.status() });
    }
    if (request.method !== "POST" || ![START, STOP, IMPORT].includes(path)) {
      return learning.handle(request);
    }

    const key = request.headers.get("idempotency-key")?.trim();
    if (path !== START && !key)
      return jsonError(400, "IDEMPOTENCY_KEY_REQUIRED");
    try {
      if (path === START) {
        return Response.json(
          { recording: await recorder.start() },
          { status: 201 },
        );
      }
      if (path === IMPORT && key) {
        return await save(request, await request.text(), key);
      }
      if (lastStopped && lastStopped.key === key && !recorder.status()) {
        return lastStopped.response.clone();
      }
      const recording = await recorder.stop();
      if (!recording.events.length) {
        recorder.clear(recording.id);
        return jsonError(400, "RECORDING_EMPTY");
      }
      const response = await save(
        request,
        recording,
        `recording-${recording.id}`,
      );
      if (!response.ok) return response;

      const { evidence } = (await response.json()) as {
        evidence: { id: string };
      };
      const generated = await send(
        request,
        "proposals",
        { evidenceIds: [evidence.id] },
        `draft-${evidence.id}`,
      );
      let result: Response;
      if (generated?.ok) {
        const { proposal } = (await generated.json()) as { proposal: unknown };
        result = Response.json({ evidence, proposal }, { status: 201 });
      } else {
        await generated?.body?.cancel();
        result = Response.json(
          { evidence, draftError: "RECORDING_DRAFT_FAILED" },
          { status: 201 },
        );
      }
      recorder.clear(recording.id);
      if (key) lastStopped = { key, response: result.clone() };
      return result;
    } catch (error) {
      if (
        error instanceof RecorderError ||
        error instanceof RecordingImportError
      ) {
        return jsonError(error.status, error.code);
      }
      return jsonError(500, "RECORDING_NOT_SAVED");
    }
  };
}
