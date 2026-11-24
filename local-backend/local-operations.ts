import { jsonError, jsonObject } from "./conversation-routes";

export type LocalConnections = {
  programming: "configured" | "detected" | "missing";
  editorial: "configured" | "missing";
  instagram: "configured" | "invalid" | "missing";
};

type StopServer = (force?: boolean) => unknown;

export function createLocalLifecycle({
  timeoutMs = 20_000,
}: {
  timeoutMs?: number;
} = {}) {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const active = new Set<Promise<unknown>>();
  const workers: (() => unknown)[] = [];
  const resources: (() => unknown)[] = [];
  let stopping = false;
  let shutdown: Promise<"closed" | "forced"> | undefined;

  function periodic(
    name: string,
    task: () => Promise<unknown>,
    interval: number,
    immediately = false,
  ) {
    let current: Promise<unknown> | undefined;
    function tick() {
      if (current || stopping) return;
      const run = Promise.resolve()
        .then(task)
        .catch(() => {
          console.error(`Local ${name} tick failed`);
        })
        .finally(() => {
          active.delete(run);
          if (current === run) current = undefined;
        });
      current = run;
      active.add(run);
    }
    timers.add(setInterval(tick, interval).unref());
    if (immediately) tick();
  }

  function stop(server: { stop: StopServer }) {
    if (shutdown) return shutdown;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    timers.clear();

    shutdown = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = async () => {
        const drain = Promise.resolve().then(() => server.stop(false));
        const workersDone = workers.map((close) =>
          Promise.resolve().then(close),
        );
        const tasks = await Promise.allSettled([
          drain,
          ...workersDone,
          ...active,
        ]);
        const closed = await Promise.allSettled(
          resources.map((close) => Promise.resolve().then(close)),
        );
        return [...tasks, ...closed].every(
          ({ status }) => status === "fulfilled",
        )
          ? ("closed" as const)
          : ("forced" as const);
      };
      const deadline = new Promise<"forced">((resolve) => {
        timer = setTimeout(() => {
          void Promise.resolve()
            .then(() => server.stop(true))
            .catch(() => undefined);
          resolve("forced");
        }, timeoutMs);
      });
      try {
        return await Promise.race([settle(), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return shutdown;
  }

  return {
    periodic,
    stop,
    isStopping: () => stopping,
    addWorker: (...close: (() => unknown)[]) => {
      workers.push(...close);
    },
    addResource: (...close: (() => unknown)[]) => {
      resources.push(...close);
    },
  };
}

export function createLocalOperations(options: {
  connections: LocalConnections;
  requestShutdown(): void;
  isStopping(): boolean;
}) {
  let scheduled = false;
  return async (request: Request, pathname: string) => {
    const route = "/api/local/operations";
    if (pathname === route && request.method === "GET") {
      return Response.json(
        {
          phase: scheduled || options.isStopping() ? "stopping" : "ready",
          connections: options.connections,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (pathname !== `${route}/shutdown`) return null;
    if (request.method !== "POST") return jsonError(405, "METHOD_NOT_ALLOWED");
    const body = await jsonObject(request);
    if (body?.confirmed !== true)
      return jsonError(422, "LOCAL_SHUTDOWN_CONFIRMATION_REQUIRED");
    if (!scheduled && !options.isStopping()) {
      scheduled = true;
      setTimeout(options.requestShutdown, 100);
    }
    return Response.json(
      { phase: "stopping" },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  };
}
