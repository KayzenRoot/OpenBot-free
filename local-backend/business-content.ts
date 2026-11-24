import { type Ebook, exportEpub } from "./epub";

const salesPath = "/api/local/business/sales/analyze";
const ebookPath = "/api/local/business/ebooks/export";
const maxRequestBytes = 128 * 1024;
const salesColumns = ["data", "produto", "quantidade", "valor_total"] as const;

class BusinessContentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly row?: number,
  ) {
    super(code);
  }
}

function csvError(code: string, row: number): never {
  throw new BusinessContentError(400, code, row);
}

function salesDelimiter(input: string) {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (const character of input.trimStart()) {
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === "\r" || character === "\n") break;
    if (character === ",") commas += 1;
    if (character === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

function readCsv(csv: string) {
  const input = csv.replace(/^\uFEFF/, "");
  const delimiter = salesDelimiter(input);
  const records: { row: number; fields: string[] }[] = [];
  let row = 1;
  let fields: string[] = [];
  let field = "";
  let quoting: "quoted" | "closed" | "unquoted" = "unquoted";

  function finishField() {
    fields.push(field);
    field = "";
    quoting = "unquoted";
  }

  function finishRecord() {
    finishField();
    if (fields.length > 1 || fields[0]?.trim()) records.push({ row, fields });
    row += 1;
    fields = [];
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input.charAt(index);
    if (quoting === "quoted") {
      if (character !== '"') {
        field += character;
      } else if (input.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
      } else {
        quoting = "closed";
      }
      continue;
    }
    if (character === delimiter) {
      finishField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input.charAt(index + 1) === "\n") index += 1;
      finishRecord();
    } else if (quoting === "closed") {
      if (character !== " " && character !== "\t")
        csvError("CSV_INVALID_QUOTING", row);
    } else if (character === '"') {
      if (field.length) csvError("CSV_INVALID_QUOTING", row);
      quoting = "quoted";
    } else {
      field += character;
    }
  }
  if (quoting === "quoted") csvError("CSV_INVALID_QUOTING", row);
  finishRecord();
  return records;
}

function saleDate(value: string, row: number) {
  let date = value.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(date))
    date = `${date.slice(6)}-${date.slice(3, 5)}-${date.slice(0, 2)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) csvError("CSV_INVALID_DATE", row);
  const timestamp = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    !timestamp.toISOString().startsWith(date)
  ) {
    csvError("CSV_INVALID_DATE", row);
  }
  return date;
}

function saleUnits(value: string, row: number) {
  const units = Number(value);
  if (!/^[+-]?\d+$/.test(value.trim()) || !Number.isSafeInteger(units))
    csvError("CSV_INVALID_QUANTITY", row);
  return units;
}

function saleCents(value: string, row: number) {
  const amount = value.trim().replace(/^([+-]?)\s*R\$\s*/i, "$1");
  const sign = amount.startsWith("-") ? -1 : 1;
  const digits = amount.replace(/^[+-]/, "");
  let normalized: string;
  if (/^\d+(?:[.,]\d{1,2})?$/.test(digits)) {
    normalized = digits.replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(digits)) {
    normalized = digits.replaceAll(".", "").replace(",", ".");
  } else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(digits)) {
    normalized = digits.replaceAll(",", "");
  } else {
    return csvError("CSV_INVALID_TOTAL", row);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = sign * Number(`${whole}${fraction.padEnd(2, "0")}`);
  if (!Number.isSafeInteger(cents)) csvError("CSV_INVALID_TOTAL", row);
  return cents;
}

type Totals = { rows: number; units: number; totalCents: number };

function accumulate(totals: Totals, units: number, cents: number, row: number) {
  const nextUnits = totals.units + units;
  const nextTotal = totals.totalCents + cents;
  if (!Number.isSafeInteger(nextUnits) || !Number.isSafeInteger(nextTotal))
    csvError("CSV_TOTAL_OVERFLOW", row);
  totals.rows += 1;
  totals.units = nextUnits;
  totals.totalCents = nextTotal;
}

function addBreakdown(
  groups: Map<string, Totals>,
  key: string,
  units: number,
  cents: number,
  row: number,
) {
  const totals = groups.get(key) ?? { rows: 0, units: 0, totalCents: 0 };
  accumulate(totals, units, cents, row);
  groups.set(key, totals);
}

export function analyzeSales(csv: string) {
  const [header, ...records] = readCsv(csv);
  const columns =
    header?.fields.map((field) => field.trim().toLowerCase()) ?? [];
  if (
    salesColumns.some(
      (name) =>
        columns.indexOf(name) === -1 ||
        columns.indexOf(name) !== columns.lastIndexOf(name),
    )
  ) {
    csvError("CSV_INVALID_HEADER", header?.row ?? 1);
  }

  const [dateIndex, productIndex, quantityIndex, totalIndex] = salesColumns.map(
    (name) => columns.indexOf(name),
  );
  const products = new Map<string, Totals>();
  const dates = new Map<string, Totals>();
  const summary: Totals = { rows: 0, units: 0, totalCents: 0 };
  for (const { row, fields } of records) {
    if (fields.length !== columns.length) csvError("CSV_INVALID_COLUMNS", row);
    const date = saleDate(fields[dateIndex ?? -1] ?? "", row);
    const product = fields[productIndex ?? -1]?.trim();
    if (!product) csvError("CSV_INVALID_PRODUCT", row);
    const units = saleUnits(fields[quantityIndex ?? -1] ?? "", row);
    const cents = saleCents(fields[totalIndex ?? -1] ?? "", row);

    accumulate(summary, units, cents, row);
    addBreakdown(products, product, units, cents, row);
    addBreakdown(dates, date, units, cents, row);
  }
  const orderedDates = [...dates.keys()].sort();
  return {
    summary: {
      ...summary,
      productCount: products.size,
      firstDate: orderedDates[0] ?? null,
      lastDate: orderedDates.at(-1) ?? null,
    },
    byProduct: [...products].map(([product, totals]) => ({
      product,
      ...totals,
    })),
    byDate: orderedDates.map((date) => ({ date, ...dates.get(date) })),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validXmlText(value: unknown, maxLength?: number): value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    (maxLength !== undefined && value.length > maxLength)
  )
    return false;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (
      (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point === 0xfffe ||
      point === 0xffff
    ) {
      return false;
    }
  }
  return true;
}

function asEbook(data: Record<string, unknown>): Ebook {
  const { title, author, chapters } = data;
  if (
    !validXmlText(title, 200) ||
    !validXmlText(author, 200) ||
    !Array.isArray(chapters) ||
    chapters.length === 0 ||
    chapters.length > 80
  ) {
    throw new BusinessContentError(400, "INVALID_EBOOK");
  }
  const ebookChapters = chapters.map((chapter: unknown) => {
    if (
      !isObject(chapter) ||
      !validXmlText(chapter.title, 200) ||
      !validXmlText(chapter.text)
    ) {
      throw new BusinessContentError(400, "INVALID_EBOOK_CHAPTER");
    }
    return { title: chapter.title.trim(), text: chapter.text };
  });
  return {
    title: title.trim(),
    author: author.trim(),
    chapters: ebookChapters,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new BusinessContentError(400, "INVALID_JSON");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxRequestBytes) {
        void reader.cancel().catch(() => {});
        throw new BusinessContentError(413, "REQUEST_BODY_TOO_LARGE");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    const value: unknown = JSON.parse(body + decoder.decode());
    if (isObject(value)) return value;
  } catch (error) {
    if (error instanceof BusinessContentError) throw error;
  } finally {
    reader.releaseLock();
  }
  throw new BusinessContentError(400, "INVALID_JSON");
}

function ebookResponse(book: Ebook) {
  const name = [...book.title.replace(/[<>:"/\\|?*\r\n\t]/g, "-")]
    .slice(0, 80)
    .join("");
  const encodedName = encodeURIComponent(`${name}.epub`).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Response(exportEpub(book), {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="ebook.epub"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "no-store",
    },
  });
}

export function createBusinessContentRoutes() {
  return {
    async handle(request: Request, pathname: string): Promise<Response | null> {
      if (pathname !== salesPath && pathname !== ebookPath) return null;
      if (request.method !== "POST") {
        return Response.json(
          { error: "METHOD_NOT_ALLOWED" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      try {
        const data = await readJson(request);
        if (pathname === ebookPath) return ebookResponse(asEbook(data));
        if (typeof data.csv !== "string")
          throw new BusinessContentError(400, "CSV_REQUIRED");
        return Response.json(analyzeSales(data.csv), {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        if (!(error instanceof BusinessContentError)) throw error;
        return Response.json(
          { error: error.code, row: error.row },
          { status: error.status },
        );
      }
    },
  };
}
