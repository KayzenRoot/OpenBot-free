import { type Browser, chromium } from "playwright-core";

const MAX_EVENTS = 256;
const MAX_TIME_MS = 30 * 60_000;
const types = ["click", "input", "submit", "key", "navigation"] as const;
type EventType = (typeof types)[number];
type RecorderEvent = {
  type: "CUSTOM";
  name: EventType;
  timestamp: number;
  value: { seq: number; target?: { tag: string }; key?: "Enter" };
};

export class RecorderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

type Recording = {
  id: string;
  browser?: Browser;
  active: boolean;
  starting: boolean;
  events: RecorderEvent[];
  dropped: number;
  timer?: ReturnType<typeof setTimeout>;
};

export function createBrowserRecorder(options?: {
  headless?: boolean;
  initialUrl?: string;
  executablePath?: string;
}) {
  let current: Recording | null = null;

  function status() {
    return (
      current && {
        id: current.id,
        active: current.active,
        events: current.events.length,
        dropped: current.dropped,
      }
    );
  }

  function record(recording: Recording, type: EventType, element?: string) {
    if (!recording.active) return;
    if (recording.events.length >= MAX_EVENTS) {
      recording.dropped = Math.min(recording.dropped + 1, 1_000_000);
      return;
    }
    recording.events.push({
      type: "CUSTOM",
      name: type,
      timestamp: Date.now(),
      value: {
        seq: recording.events.length + 1,
        target: element ? { tag: element } : undefined,
        key: type === "key" ? "Enter" : undefined,
      },
    });
  }

  function markClosed(recording: Recording) {
    recording.active = false;
    clearTimeout(recording.timer);
  }

  async function start() {
    if (current) throw new RecorderError("RECORDING_ALREADY_EXISTS", 409);
    const recording: Recording = {
      id: crypto.randomUUID(),
      active: false,
      starting: true,
      events: [],
      dropped: 0,
    };
    current = recording;
    try {
      const browser = await chromium.launch({
        channel: options?.executablePath ? undefined : "msedge",
        executablePath: options?.executablePath,
        headless: options?.headless ?? false,
        timeout: 20_000,
      });
      recording.browser = browser;
      browser.once("disconnected", () => markClosed(recording));
      const context = await browser.newContext({ acceptDownloads: false });
      await context.exposeBinding(
        "__openbotLocalCapture",
        (source, event: unknown, element: unknown) => {
          if (source.frame !== source.page.mainFrame()) return;
          if (types.includes(event as EventType) && event !== "navigation") {
            const tag =
              typeof element === "string" &&
              ["a", "button", "input", "select", "textarea"].includes(element)
                ? element
                : undefined;
            record(recording, event as EventType, tag);
          }
        },
      );
      await context.addInitScript(() => {
        if (window !== window.top) return;
        const send = (
          window as Window & {
            __openbotLocalCapture?(
              event: string,
              element?: string,
            ): Promise<void>;
          }
        ).__openbotLocalCapture;
        if (!send) return;
        const track = (event: Event) => {
          if (!event.isTrusted) return;
          if (event.type === "keydown") {
            if (!(event instanceof KeyboardEvent) || event.key !== "Enter")
              return;
            void send("key").catch(() => {});
            return;
          }
          if (
            event.target instanceof HTMLInputElement &&
            ["password", "file"].includes(event.target.type)
          )
            return;
          const tag =
            event.target instanceof Element
              ? event.target
                  .closest("a, button, input, select, textarea")
                  ?.tagName.toLowerCase()
              : undefined;
          void send(event.type, tag).catch(() => {});
        };
        for (const name of ["click", "input", "submit", "keydown"]) {
          document.addEventListener(name, track, {
            capture: true,
            passive: true,
          });
        }
      });
      context.on("page", (page) => {
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame() && /^https?:/.test(frame.url())) {
            record(recording, "navigation");
          }
        });
      });
      const page = await context.newPage();
      recording.active = true;
      if (options?.initialUrl) await page.goto(options.initialUrl);
      recording.timer = setTimeout(() => {
        markClosed(recording);
        void browser.close().catch(() => {});
      }, MAX_TIME_MS);
    } catch {
      await recording.browser?.close().catch(() => {});
      current = null;
      throw new RecorderError("RECORDING_BROWSER_UNAVAILABLE", 503);
    } finally {
      recording.starting = false;
    }
    return status();
  }

  async function stop() {
    if (!current) throw new RecorderError("RECORDING_NOT_FOUND", 404);
    const recording = current;
    if (recording.starting) throw new RecorderError("RECORDING_STARTING", 409);
    markClosed(recording);
    await recording.browser?.close().catch(() => {});
    return {
      id: recording.id,
      events: recording.events,
      dropped: recording.dropped,
    };
  }

  function clear(id: string) {
    if (current?.id === id && !current.active) current = null;
  }

  return { start, stop, clear, status };
}
