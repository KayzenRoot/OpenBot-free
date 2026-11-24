import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioPilot, type StudioBook } from "./studio-pilot";

const root = "/api/local/studio/books";
const sampleBook = {
  title: "Gestão & ação",
  author: "Autora brasileira",
  audience: "Pessoas que trabalham em casa",
  promise: "Passos & exemplos práticos",
  coverTheme: "azul",
  sources: [
    { title: "Referência <1>", url: "https://example.test/publicacao?x=1&y=2" },
  ],
  outline: ["Revisão do dia", "Organização de tarefas"],
  chapters: [
    {
      title: "Em casa",
      text: "Uma ação simples.\n\nOutra ação & seus passos.",
    },
    { title: "No escritório", text: "Trecho secreto do segundo capítulo." },
  ],
};

async function call(
  studio: ReturnType<typeof createStudioPilot>,
  path = root,
  method = "GET",
  data?: object,
) {
  const url = new URL(path, "http://localhost");
  return studio.handle(
    new Request(url, {
      method,
      headers: data ? { "content-type": "application/json" } : undefined,
      body: data ? JSON.stringify(data) : undefined,
    }),
    url.pathname,
  );
}

async function add(
  studio: ReturnType<typeof createStudioPilot>,
  data: object = sampleBook,
) {
  const response = await call(studio, root, "POST", data);
  expect(response?.status).toBe(201);
  const { book } = (await response!.json()) as { book: StudioBook };
  return `${root}/${book.id}`;
}

describe("ebook studio", () => {
  test("persists edits across reopen and rejects conflicting revisions without overwriting history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-studio-test-"));
    const dbPath = join(directory, "studio.sqlite");
    let studio = createStudioPilot({ dbPath, now: () => 10_000 });
    try {
      const path = await add(studio);
      const changed = await call(studio, path, "PUT", {
        revision: 1,
        title: "Segunda edição",
      });
      expect(await changed?.json()).toMatchObject({
        book: {
          ...sampleBook,
          title: "Segunda edição",
          revision: 2,
          updatedAt: "1970-01-01T00:00:10.000Z",
        },
      });
      const unchanged = await call(studio, path, "PUT", {
        revision: 2,
        title: "Segunda edição",
      });
      expect(await unchanged?.json()).toMatchObject({ book: { revision: 2 } });
      expect(
        (
          await call(studio, path, "PUT", {
            revision: 1,
            title: "Edição em conflito",
          })
        )?.status,
      ).toBe(409);

      studio.close();
      studio = createStudioPilot({ dbPath });
      const listing = await call(studio);
      expect(await listing?.json()).toMatchObject({
        books: [
          { title: "Segunda edição", author: sampleBook.author, revision: 2 },
        ],
      });
      const history = await call(studio, `${path}/revisions`);
      expect(await history?.json()).toMatchObject({
        revisions: [
          { title: "Segunda edição", revision: 2 },
          { title: sampleBook.title, revision: 1 },
        ],
        nextBefore: null,
      });
      const earlier = await call(studio, `${path}/revisions/1`);
      expect(await earlier?.json()).toMatchObject({
        book: { ...sampleBook, revision: 1 },
      });
      expect(studio.getBook(path.split("/").at(-1) ?? "")?.title).toBe(
        "Segunda edição",
      );
    } finally {
      studio.close();
      for (const file of [
        dbPath,
        `${dbPath}-wal`,
        `${dbPath}-shm`,
        `${dbPath}-journal`,
      ])
        rmSync(file, { force: true });
      rmdirSync(directory);
    }
  });

  test("blocks malformed source URLs and handles incomplete drafts", async () => {
    const studio = createStudioPilot({ dbPath: ":memory:" });
    try {
      const path = await add(studio, { title: "Primeiro rascunho" });
      expect(
        await (await call(studio, `${path}/export/epub?cover=0`))?.json(),
      ).toEqual({ error: "STUDIO_INCOMPLETE_DRAFT" });
      expect(
        (
          await call(studio, path, "PUT", {
            revision: 1,
            sources: [{ title: "Registro", url: "javascript:alert(1)" }],
          })
        )?.status,
      ).toBe(400);
      expect(
        (
          await call(studio, path, "PUT", {
            revision: 1,
            sources: [
              { title: "Privado", url: "https://user:secret@example.test/" },
            ],
          })
        )?.status,
      ).toBe(400);
      expect(
        (await call(studio, path, "PUT", { revision: 1, title: "\u0000" }))
          ?.status,
      ).toBe(400);
      expect(await (await call(studio, path))?.json()).toMatchObject({
        book: {
          title: "Primeiro rascunho",
          author: "",
          coverTheme: "verde",
          chapters: [],
          revision: 1,
        },
      });
    } finally {
      studio.close();
    }
  });

  test("packages cover image and historical metadata, and supports EPUB export without Edge", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const calls: string[] = [];
    const studio = createStudioPilot({
      dbPath: ":memory:",
      render: async (book, format) => {
        calls.push(format);
        expect(book.title).toBe(sampleBook.title);
        return png;
      },
    });
    try {
      const path = await add(studio);
      await call(studio, path, "PUT", {
        revision: 1,
        title: "Edição revisada",
      });
      const response = await call(studio, `${path}/export/epub?revision=1`);
      expect(response?.headers.get("content-type")).toBe(
        "application/epub+zip",
      );
      expect(response?.headers.get("content-disposition")).toContain(
        "Gest%C3%A3o%20%26%20a%C3%A7%C3%A3o.epub",
      );
      const output = Buffer.from(await response!.arrayBuffer());
      expect(output.subarray(0, 4).toString("hex")).toBe("504b0304");
      expect(output.includes('properties="cover-image"')).toBe(true);
      expect(output.includes(png)).toBe(true);
      expect(output.includes("Gestão &amp; ação")).toBe(true);
      expect(output.includes("Edição revisada")).toBe(false);
      expect(
        output.includes(
          "<dc:description>Passos &amp; exemplos práticos</dc:description>",
        ),
      ).toBe(true);
      expect(output.includes("Referência &lt;1&gt;")).toBe(true);

      const plain = await call(studio, `${path}/export/epub?cover=0`);
      const plainText = await plain?.text();
      expect(plainText).toContain("Edição revisada");
      expect(plainText).not.toContain("cover-image");
      expect(calls).toEqual(["cover"]);
    } finally {
      studio.close();
    }
  });
});

test.skipIf(process.env.OPENBOT_TEST_EDGE !== "1")(
  "renders local PDF, chapter sample, cover, and illustrated EPUB in Edge",
  async () => {
    const studio = createStudioPilot({ dbPath: ":memory:" });
    try {
      const path = await add(studio);
      const pdf = await call(studio, `${path}/export/pdf`);
      expect(pdf?.status).toBe(200);
      expect(pdf?.headers.get("content-type")).toBe("application/pdf");
      const book = Buffer.from(await pdf!.arrayBuffer());
      expect(book.subarray(0, 5).toString()).toBe("%PDF-");
      expect(book.includes("/StructTreeRoot")).toBe(true);
      const sample = await call(studio, `${path}/export/sample`);
      expect(sample?.headers.get("content-disposition")).toContain(
        "-amostra.pdf",
      );
      expect(
        await sample!.arrayBuffer().then((output) => output.byteLength),
      ).toBeLessThan(book.length);
      const cover = await call(studio, `${path}/export/cover`);
      const png = Buffer.from(await cover!.arrayBuffer());
      expect(cover?.headers.get("content-type")).toBe("image/png");
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(780);
      expect(png.readUInt32BE(20)).toBe(1170);
      const epub = await call(studio, `${path}/export/epub`);
      expect(epub?.status).toBe(200);
      expect(Buffer.from(await epub!.arrayBuffer()).includes(png)).toBe(true);
    } finally {
      studio.close();
    }
  },
  45_000,
);
