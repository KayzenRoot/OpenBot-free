import { describe, expect, test } from "bun:test";
import { createBusinessContentRoutes } from "./business-content";

const sales = "/api/local/business/sales/analyze";
const ebooks = "/api/local/business/ebooks/export";
const header = "data,produto,quantidade,valor_total";
const routes = createBusinessContentRoutes();

async function post(path: string, data: unknown) {
  const response = await routes.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    path,
  );
  if (!response) throw new Error(`No route for ${path}`);
  return response;
}

describe("local sales analysis", () => {
  test("calculates exact cents, net units, and grouped results for Brazilian CSV", async () => {
    const response = await post(sales, {
      csv: [
        '\uFEFF"PRODUTO";quantidade;valor_total;data;origem',
        '"Café; especial";2;"R$ 1.234,56";28/02/2024;loja',
        '"Café; especial";-1;-34,56;2024-02-29;loja',
        '"Pão ""da casa""";3;0,30;2024-02-28;loja',
      ].join("\r\n"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      summary: {
        rows: 3,
        units: 4,
        totalCents: 120030,
        productCount: 2,
        firstDate: "2024-02-28",
        lastDate: "2024-02-29",
      },
      byProduct: [
        { product: "Café; especial", rows: 2, units: 1, totalCents: 120000 },
        { product: 'Pão "da casa"', rows: 1, units: 3, totalCents: 30 },
      ],
      byDate: [
        { date: "2024-02-28", rows: 2, units: 5, totalCents: 123486 },
        { date: "2024-02-29", rows: 1, units: -1, totalCents: -3456 },
      ],
    });
  });

  test("reads quoted commas, embedded newlines, grouped decimals, and blank rows", async () => {
    const response = await post(sales, {
      csv: `\n${header}\n2025-12-10,"café, torra média\n250 g",1,"2,000.07"\n\n`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      byProduct: [{ product: "café, torra média\n250 g", totalCents: 200007 }],
    });
  });

  test("returns an empty report for a valid header without sales", async () => {
    const response = await post(sales, { csv: header });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      summary: {
        rows: 0,
        units: 0,
        totalCents: 0,
        productCount: 0,
        firstDate: null,
        lastDate: null,
      },
      byProduct: [],
      byDate: [],
    });
  });

  test("detects a comma delimiter with a semicolon and a newline in optional header names", async () => {
    const response = await post(sales, {
      csv: `"edição\nfonte",loja;filial,${header}\nsegunda,varejo,2025-12-10,Pão,1,3.20`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      byProduct: [{ product: "Pão", totalCents: 320 }],
    });
  });

  test.each([
    ["data,produto,produto,quantidade,valor_total", "CSV_INVALID_HEADER", 1],
    [`${header}\n31/02/2025,Café,1,1`, "CSV_INVALID_DATE", 2],
    [`${header}\n2025-12-10,"Café,1,1`, "CSV_INVALID_QUOTING", 2],
    [`${header}\n2025-12-10,"Café"inválido,1,1`, "CSV_INVALID_QUOTING", 2],
    [`${header}\n2025-12-10,Café,1`, "CSV_INVALID_COLUMNS", 2],
    [`${header}\n2025-12-10,Café,1.5,1`, "CSV_INVALID_QUANTITY", 2],
    [`${header}\n2025-12-10,Café,1,4.1999`, "CSV_INVALID_TOTAL", 2],
    [
      `${header}\n2025-12-10,Café,1,90071992547409.91\n2025-12-10,Café,1,0.01`,
      "CSV_TOTAL_OVERFLOW",
      3,
    ],
  ] as const)(
    "reports invalid sales file %# with its row",
    async (csv, error, row) => {
      const response = await post(sales, { csv });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error, row });
    },
  );
});

describe("local ebook export", () => {
  test("generates a named EPUB 3 with ordered, escaped chapter content", async () => {
    const response = await post(ebooks, {
      title: "Café & história*",
      author: "Lívia <Autora>",
      chapters: [
        {
          title: "Abertura & contexto",
          text: 'Linha 1\nLinha 2\n\n<script>alert("x")</script>',
        },
        { title: "Conclusão", text: "Última página." },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/epub+zip");
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"ebook.epub\"; filename*=UTF-8''Caf%C3%A9%20%26%20hist%C3%B3ria-.epub",
    );

    const archive = await response.arrayBuffer();
    const bytes = new Uint8Array(archive);
    const view = new DataView(archive);
    const decoder = new TextDecoder();
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(6);
    const centralStart = view.getUint32(end + 16, true);
    const entries = new Map<string, string>();
    let central = centralStart;
    for (let index = 0; index < 6; index += 1) {
      expect(view.getUint32(central, true)).toBe(0x02014b50);
      const nameSize = view.getUint16(central + 28, true);
      const offset = view.getUint32(central + 42, true);
      const size = view.getUint32(central + 24, true);
      const name = decoder.decode(
        bytes.subarray(central + 46, central + 46 + nameSize),
      );
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      expect(view.getUint16(offset + 8, true)).toBe(0);
      expect(view.getUint16(offset + 26, true)).toBe(nameSize);
      expect(view.getUint16(offset + 28, true)).toBe(0);
      const contentStart = offset + 30 + nameSize;
      entries.set(
        name,
        decoder.decode(bytes.subarray(contentStart, contentStart + size)),
      );
      if (index === 0) {
        expect(name).toBe("mimetype");
        expect(offset).toBe(0);
      }
      central += 46 + nameSize;
    }
    expect(central).toBe(end);
    expect(entries.get("mimetype")).toBe("application/epub+zip");
    expect(entries.get("META-INF/container.xml")).toContain(
      'full-path="EPUB/package.opf"',
    );
    expect(entries.get("EPUB/package.opf")).toContain(
      "<dc:title>Café &amp; história*</dc:title>",
    );
    expect(entries.get("EPUB/package.opf")).toContain(
      "<dc:creator>Lívia &lt;Autora&gt;</dc:creator>",
    );
    expect(entries.get("EPUB/package.opf")).toContain(
      '<spine><itemref idref="chapter-1"/><itemref idref="chapter-2"/></spine>',
    );
    expect(entries.get("EPUB/nav.xhtml")).toContain(
      '<a href="chapter-1.xhtml">Abertura &amp; contexto</a>',
    );
    expect(entries.get("EPUB/chapter-1.xhtml")).toContain(
      "<p>Linha 1<br/>Linha 2</p>",
    );
    expect(entries.get("EPUB/chapter-1.xhtml")).toContain(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>",
    );
    expect(entries.get("EPUB/chapter-2.xhtml")).toContain(
      "<p>Última página.</p>",
    );
  });

  test("rejects invalid ebook structures and XML characters", async () => {
    expect(
      await (
        await post(ebooks, { title: "Livro", author: "Autor", chapters: [] })
      ).json(),
    ).toEqual({ error: "INVALID_EBOOK" });
    const response = await post(ebooks, {
      title: "Livro",
      author: "Autor",
      chapters: [{ title: "Capítulo", text: "\x00inválido" }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_EBOOK_CHAPTER" });
  });
});

test("rejects too-large requests, malformed JSON, and unsupported methods", async () => {
  expect((await post(sales, { csv: "a".repeat(128 * 1024) })).status).toBe(413);
  expect(
    (
      await routes.handle(
        new Request(`http://localhost${sales}`, {
          method: "POST",
          body: "invalid",
        }),
        sales,
      )
    )?.status,
  ).toBe(400);
  const method = await routes.handle(
    new Request(`http://localhost${sales}`),
    sales,
  );
  expect(method?.status).toBe(405);
  expect(method?.headers.get("allow")).toBe("POST");
  expect(
    await routes.handle(new Request("http://localhost/other"), "/other"),
  ).toBeNull();
});
