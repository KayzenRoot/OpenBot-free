import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalMemory, MAX_MEMORY_TEXT, type MemoryEntry } from "./memory";

type Store = ReturnType<typeof createLocalMemory>;

const instances = new Set<Store>();
const directories = new Set<string>();

function create(dbPath = ":memory:") {
  const instance = createLocalMemory({ dbPath });
  instances.add(instance);
  return instance;
}

function path() {
  const directory = mkdtempSync(join(tmpdir(), "openbot-memory-"));
  directories.add(directory);
  return join(directory, "memory.sqlite");
}

function close(instance: Store) {
  instance.close();
  instances.delete(instance);
}

afterEach(() => {
  for (const instance of instances) close(instance);
  for (const directory of directories) {
    for (const file of [
      "memory.sqlite",
      "memory.sqlite-shm",
      "memory.sqlite-wal",
    ]) {
      rmSync(join(directory, file), { force: true });
    }
    rmdirSync(directory);
  }
  directories.clear();
});

async function fetchMemory(
  instance: Store,
  suffix = "",
  method = "GET",
  body?: unknown,
) {
  const url = new URL(`http://127.0.0.1/api/local/memory${suffix}`);
  const response = await instance.handle(
    new Request(url, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    url.pathname,
  );
  if (!response) throw new Error("Memory route did not respond");
  return response;
}

async function save(instance: Store, text: string, status = 201) {
  const response = await fetchMemory(instance, "", "POST", { text });
  expect(response.status).toBe(status);
  return ((await response.json()) as { memory: MemoryEntry }).memory;
}

test("stores deliberate memories, deduplicates and keeps edits across SQLite reopen", async () => {
  const dbPath = path();
  const instance = create(dbPath);
  const item = await save(instance, "  Almoço\r\ncaseiro  ");
  expect(item.text).toBe("Almoço\ncaseiro");
  const duplicate = await save(instance, "ALMOÇO   CASEIRO", 200);
  expect(duplicate).toEqual(item);

  const patch = await fetchMemory(instance, `/${item.id}`, "PATCH", {
    text: "Almoço vegetariano",
  });
  expect(patch.status).toBe(200);
  expect(patch.headers.get("cache-control")).toBe("no-store");
  const changed = ((await patch.json()) as { memory: MemoryEntry }).memory;
  expect(changed).toMatchObject({
    id: item.id,
    text: "Almoço vegetariano",
    createdAt: item.createdAt,
  });
  expect(instance.relevant("caseiro")).toEqual([]);
  close(instance);

  const restored = create(dbPath);
  const read = await fetchMemory(restored, `/${item.id}`);
  expect(await read.json()).toEqual({ memory: changed });
  expect(restored.relevant("sugestão de almoco")).toEqual([
    { id: item.id, text: changed.text },
  ]);
  const observer = new Database(dbPath, { readonly: true });
  try {
    expect(observer.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(observer.query("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
  } finally {
    observer.close();
  }
});

test("ranks selected memories by matching terms and ignores unrelated and generic requests", async () => {
  const instance = create();
  const first = await save(
    instance,
    "As revisões de sprint usam uma pauta objetiva.",
  );
  await save(instance, "Café e açúcar na cafeteria.");
  const stronger = await save(
    instance,
    "Na revisão trimestral, a pauta inclui métricas.",
  );
  const terms = "quero pauta, metricas e revisão";
  expect(instance.relevant(terms)).toEqual([
    { id: stronger.id, text: stronger.text },
    { id: first.id, text: first.text },
  ]);
  expect(instance.relevant("Por favor, você pode ajudar com isso?")).toEqual(
    [],
  );
  expect(instance.relevant("aeroporto")).toEqual([]);
  expect(instance.relevant("1234")).toEqual([]);

  const query = `?limit=1&q=${encodeURIComponent(terms)}`;
  expect(await (await fetchMemory(instance, query)).json()).toEqual({
    memories: [stronger],
    nextOffset: 1,
  });
  expect(
    await (await fetchMemory(instance, `${query}&offset=1`)).json(),
  ).toEqual({ memories: [first], nextOffset: null });
  expect(await (await fetchMemory(instance, "?q=unknown")).json()).toEqual({
    memories: [],
    nextOffset: null,
  });
  for (let number = 0; number < 6; number += 1) {
    await save(instance, `Pauta para a atividade ${number}.`);
  }
  expect(instance.relevant("pauta")).toHaveLength(5);
});

test("deletes idempotently and prevents stale results from a reopened database", async () => {
  const dbPath = path();
  const instance = create(dbPath);
  const item = await save(instance, "Gosto de coletar orquídeas.");
  const destination = `/${item.id}`;
  expect((await fetchMemory(instance, destination, "DELETE")).status).toBe(204);
  expect((await fetchMemory(instance, destination, "DELETE")).status).toBe(204);
  expect((await fetchMemory(instance, destination)).status).toBe(404);
  close(instance);

  const restored = create(dbPath);
  expect((await fetchMemory(restored, destination)).status).toBe(404);
  expect(restored.relevant("orquideas")).toEqual([]);
});

test("querying memory uses SQLite without fetches or writes", async () => {
  const dbPath = path();
  const instance = create(dbPath);
  const item = await save(instance, "Na agenda trimestral, inclua a revisão.");
  const observer = new Database(dbPath, { readonly: true });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("External fetch during memory query");
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    const dataVersion = observer.query("PRAGMA data_version");
    const versionBeforeQuery = dataVersion.get();
    expect(instance.relevant("agenda extraneoquery")).toEqual([
      { id: item.id, text: item.text },
    ]);
    const result = await fetchMemory(instance, "?q=agenda+extraneoquery");
    expect(await result.json()).toEqual({ memories: [item], nextOffset: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(dataVersion.get()).toEqual(versionBeforeQuery);
  } finally {
    fetch.mockRestore();
    observer.close();
  }
});

test("checks bounds, invalid shapes and update collisions", async () => {
  const instance = create();
  const first = await save(instance, "Evite notas duplicadas.");
  const second = await save(instance, "Inclua origem do contexto.");
  const conflict = await fetchMemory(instance, `/${second.id}`, "PATCH", {
    text: first.text.toUpperCase(),
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "MEMORY_DUPLICATE" });
  expect(
    (
      await fetchMemory(instance, "", "POST", {
        text: "a".repeat(MAX_MEMORY_TEXT + 1),
      })
    ).status,
  ).toBe(400);
  expect((await fetchMemory(instance, "", "POST", { text: "  " })).status).toBe(
    400,
  );
  expect(
    (await fetchMemory(instance, "", "POST", { text: "one", source: "chat" }))
      .status,
  ).toBe(400);
  expect((await fetchMemory(instance, "", "POST")).status).toBe(415);
  expect((await fetchMemory(instance, "?limit=0")).status).toBe(400);
  expect((await fetchMemory(instance, "/not-a-uuid")).status).toBe(404);
  expect(
    await instance.handle(
      new Request("http://127.0.0.1/api/local/chat"),
      "/api/local/chat",
    ),
  ).toBeNull();
});
