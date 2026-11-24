import { expect, test } from "bun:test";
import { createBotQueue } from "./bot-queue";
import {
  createLocalLifecycle,
  createLocalOperations,
} from "./local-operations";
import { startLocalBackend } from "./server";

test("returns service unavailable when shutdown overtakes a queued request body", async () => {
  const queue = createBotQueue({ dbPath: ":memory:", workflows: {} });
  const path = "/api/local/bot-runs";
  const { promise, resolve } =
    Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const body = new ReadableStream<Uint8Array>({ start: resolve });
  const pending = queue.handle(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    path,
  );
  await queue.close();
  const stream = await promise;
  stream.enqueue(new TextEncoder().encode('{"workflow":"missing","input":{}}'));
  stream.close();
  expect((await pending)?.status).toBe(503);
});

test("stops new work and releases resources after draining active work and HTTP", async () => {
  const lifecycle = createLocalLifecycle({ timeoutMs: 1000 });
  const requests = Promise.withResolvers<void>();
  const activeWork = Promise.withResolvers<void>();
  const called: string[] = [];

  lifecycle.periodic(
    "fixture",
    async () => {
      called.push("started");
      await activeWork.promise;
      called.push("checkpoint");
    },
    20,
    true,
  );
  lifecycle.addWorker(() => called.push("worker-closed"));
  lifecycle.addResource(() => called.push("resource-closed"));
  await Promise.resolve();
  const server = {
    stop(force?: boolean) {
      called.push(force ? "forced" : "listener-drained");
      return requests.promise;
    },
  };

  const result = lifecycle.stop(server);
  expect(lifecycle.isStopping()).toBe(true);
  expect(lifecycle.stop(server)).toBe(result);
  await Bun.sleep(30);
  expect(called).toEqual(["started", "listener-drained", "worker-closed"]);

  requests.resolve();
  activeWork.resolve();
  expect(await result).toBe("closed");
  expect(called).toEqual([
    "started",
    "listener-drained",
    "worker-closed",
    "checkpoint",
    "resource-closed",
  ]);
});

test("forces the listener closed after a bounded graceful wait", async () => {
  const lifecycle = createLocalLifecycle({ timeoutMs: 25 });
  const requests = Promise.withResolvers<void>();
  const calls: (boolean | undefined)[] = [];
  const result = await lifecycle.stop({
    stop(force) {
      calls.push(force);
      if (force) requests.resolve();
      return requests.promise;
    },
  });
  expect(result).toBe("forced");
  expect(calls).toEqual([false, true]);
});

test("reports configuration without probing connections and requires explicit shutdown confirmation", async () => {
  const notified = Promise.withResolvers<void>();
  let calls = 0;
  const handle = createLocalOperations({
    connections: {
      programming: "detected",
      editorial: "missing",
      instagram: "invalid",
    },
    isStopping: () => false,
    requestShutdown() {
      calls += 1;
      notified.resolve();
    },
  });
  const base = "/api/local/operations";
  function send(route: string, payload?: object) {
    return handle(
      new Request(
        `http://127.0.0.1${route}`,
        payload && {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      ),
      route,
    );
  }
  const response = await send(base);
  expect(await response?.json()).toEqual({
    phase: "ready",
    connections: {
      programming: "detected",
      editorial: "missing",
      instagram: "invalid",
    },
  });
  expect((await send(`${base}/shutdown`, {}))?.status).toBe(422);
  expect(calls).toBe(0);
  for (let index = 0; index < 2; index += 1)
    expect((await send(`${base}/shutdown`, { confirmed: true }))?.status).toBe(
      202,
    );
  expect(await (await send(base))?.json()).toMatchObject({ phase: "stopping" });
  await notified.promise;
  expect(calls).toBe(1);
});

test("keeps operations and shutdown behind the local session boundary", async () => {
  const token = "local-operations-test-token-not-a-secret";
  const server = startLocalBackend({
    token,
    port: 0,
    complete: async () => new Response(null, { status: 424 }),
    createPersistentRoutes() {
      return {
        conversations: async () => null,
        operations: createLocalOperations({
          connections: {
            programming: "missing",
            editorial: "missing",
            instagram: "missing",
          },
          isStopping: () => false,
          requestShutdown() {
            throw new Error("Test must not shut down the server");
          },
        }),
      };
    },
  });
  const root = `${server.url.origin}/api/local/operations`;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  try {
    expect((await fetch(root)).status).toBe(401);
    expect(
      (
        await fetch(`${root}/shutdown`, {
          method: "POST",
          headers: { ...headers, origin: "https://other.example" },
          body: '{"confirmed":true}',
        })
      ).status,
    ).toBe(403);
    expect((await fetch(root, { headers })).status).toBe(200);
  } finally {
    await server.stop(true);
  }
});
