import { MAX_TIMESTAMP_MS } from "../shared/recorder-masking";

export const MAX_RECORDING_IMPORT_BYTES = 128 * 1024;
export const MAX_RECORDING_IMPORT_EVENTS = 256;

export type RecordingLearningEvidence = { source: "recording"; text: string };

type ImportErrorCode =
  | "INVALID_RECORDING_JSON"
  | "INVALID_RECORDING_EVENTS"
  | "INVALID_RECORDING_EVENT"
  | "RECORDING_EVENTS_OUT_OF_ORDER"
  | "RECORDING_IMPORT_TOO_LARGE"
  | "NO_RECORDING_ACTIONS";

export class RecordingImportError extends Error {
  readonly status: 400 | 413;

  constructor(readonly code: ImportErrorCode) {
    super(code);
    this.status = code === "RECORDING_IMPORT_TOO_LARGE" ? 413 : 400;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseJson(input: string): unknown {
  if (
    input.length > MAX_RECORDING_IMPORT_BYTES ||
    new TextEncoder().encode(input).byteLength > MAX_RECORDING_IMPORT_BYTES
  ) {
    throw new RecordingImportError("RECORDING_IMPORT_TOO_LARGE");
  }
  try {
    return JSON.parse(input.replace(/^\uFEFF/, ""));
  } catch {
    throw new RecordingImportError("INVALID_RECORDING_JSON");
  }
}

function readBatch(input: unknown): { events: unknown[]; dropped: boolean } {
  const value = typeof input === "string" ? parseJson(input) : input;
  if (Array.isArray(value)) return { events: value, dropped: false };
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new RecordingImportError("INVALID_RECORDING_EVENTS");
  }
  if (Object.hasOwn(value, "dropped") && !isCount(value.dropped)) {
    throw new RecordingImportError("INVALID_RECORDING_EVENTS");
  }
  return {
    events: value.events,
    dropped: isCount(value.dropped) && value.dropped > 0,
  };
}

function readEvent(input: unknown) {
  if (
    !isRecord(input) ||
    input.type !== "CUSTOM" ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    typeof input.timestamp !== "number" ||
    !Number.isFinite(input.timestamp) ||
    input.timestamp <= 0 ||
    input.timestamp > MAX_TIMESTAMP_MS ||
    !Object.hasOwn(input, "value")
  ) {
    throw new RecordingImportError("INVALID_RECORDING_EVENT");
  }

  // Recorder's stream writes seq into value. Raw collector events can precede that step.
  const value = isRecord(input.value) ? input.value : {};
  const seq = value.seq;
  if (Object.hasOwn(value, "seq") && !isCount(seq)) {
    throw new RecordingImportError("INVALID_RECORDING_EVENT");
  }
  return {
    name: input.name,
    timestamp: input.timestamp,
    value,
    seq: isCount(seq) ? seq : null,
  };
}

function describeClick(target: unknown) {
  const tag = isRecord(target) ? target.tag : null;
  switch (tag) {
    case "a":
      return "Activated a link.";
    case "button":
      return "Activated a button.";
    case "input":
    case "select":
    case "textarea":
      return "Selected a form control.";
    default:
      return "Activated a page control.";
  }
}

function describeNavigation(kind: unknown) {
  switch (kind) {
    case "start":
      return "Started on a browser page.";
    case "reload":
      return "Reloaded a browser page.";
    case "traverse":
      return "Navigated through browser history.";
    default:
      return "Navigated to another browser page.";
  }
}

function describeAction(event: ReturnType<typeof readEvent>) {
  switch (event.name) {
    case "navigation":
      return describeNavigation(event.value.navigationType);
    case "click":
      return describeClick(event.value.target);
    case "input":
      return "Edited a form field.";
    case "submit":
      return "Submitted a form.";
    // The Recorder emits key only for its Enter action.
    case "key":
      return event.value.key === "Enter"
        ? "Pressed Enter in a form field."
        : null;
    default:
      return null;
  }
}

/** Accepts Recorder CapturedEvents or a single wire batch. No captured text is reused. */
export function importRecordingEvidence(
  input: unknown,
): RecordingLearningEvidence {
  const { events, dropped } = readBatch(input);
  if (events.length > MAX_RECORDING_IMPORT_EVENTS) {
    throw new RecordingImportError("RECORDING_IMPORT_TOO_LARGE");
  }

  const steps: string[] = [];
  let previous: ReturnType<typeof readEvent> | undefined;
  for (const raw of events) {
    const event = readEvent(raw);
    if (previous) {
      const compatible = (event.seq === null) === (previous.seq === null);
      // Capture timestamps can arrive late. The stream's seq decides order when supplied.
      const ordered =
        event.seq === null || previous.seq === null
          ? event.timestamp >= previous.timestamp
          : event.seq > previous.seq;
      if (!compatible || !ordered) {
        throw new RecordingImportError("RECORDING_EVENTS_OUT_OF_ORDER");
      }
    }
    previous = event;
    const step = describeAction(event);
    if (step) steps.push(`${steps.length + 1}. ${step}`);
  }
  if (!steps.length) throw new RecordingImportError("NO_RECORDING_ACTIONS");

  const lines = [
    "Recorder demonstration (interaction metadata only)",
    "",
    ...steps,
  ];
  if (dropped) lines.push("", "The Recorder reported omitted events.");
  return { source: "recording", text: lines.join("\n") };
}
