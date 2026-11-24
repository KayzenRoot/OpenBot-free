import { Database } from "bun:sqlite";
import {
  type CampaignDocument,
  CampaignError,
  campaignDraft,
  campaignSlug,
  campaignWithMaterials,
  landingPage,
} from "./campaign-pilot-content";
import {
  type ClickRow,
  campaignReport,
  type OrderRow,
  readClicks,
  readOrders,
} from "./campaign-pilot-metrics";

const root = "/api/local/business/campaign";
const maxRequestBytes = 128 * 1024;
const maxStoredRows = 50_000;
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    throw new CampaignError(415, "JSON_REQUIRED");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new CampaignError(400, "INVALID_JSON");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxRequestBytes) {
        void reader.cancel().catch(() => {});
        throw new CampaignError(413, "REQUEST_BODY_TOO_LARGE");
      }
      text += decoder.decode(next.value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CampaignError(400, "INVALID_JSON");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CampaignError) throw error;
    throw new CampaignError(400, "INVALID_JSON");
  } finally {
    reader.releaseLock();
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

function invalidMethod(methods: string) {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED" },
    { status: 405, headers: { ...headers, allow: methods } },
  );
}

function mergeOrder(
  previous: OrderRow,
  current: OrderRow,
  row: number,
): OrderRow {
  const keys = ["source", "medium", "content"] as const;
  if (
    previous.amountCents !== current.amountCents ||
    keys.some(
      (key) => previous[key] && current[key] && previous[key] !== current[key],
    )
  ) {
    throw new CampaignError(409, "CAMPAIGN_ORDER_CONFLICT", row);
  }
  return {
    ...current,
    status: previous.status === "refunded" ? "refunded" : current.status,
    source: previous.source ?? current.source,
    medium: previous.medium ?? current.medium,
    content: previous.content ?? current.content,
  };
}

export function renderBundlePage(campaign: CampaignDocument) {
  return landingPage({
    ...campaign,
    sampleUrl: "./amostra.pdf",
    coverUrl: "./capa.png",
  });
}

export function createCampaignPilot({ dbPath }: { dbPath: string }) {
  const db = new Database(dbPath);
  try {
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA trusted_schema = OFF",
    );
    db.transaction(() => {
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version === 1) return;
      if (version !== 0) throw new Error("Unsupported campaign schema version");
      db.exec(
        "CREATE TABLE campaign_state (" +
          "id INTEGER PRIMARY KEY CHECK(id = 1), slug TEXT NOT NULL, document TEXT NOT NULL, updated_at TEXT NOT NULL);" +
          "CREATE TABLE campaign_orders (" +
          "order_hash TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK(status IN ('paid','refunded')), " +
          "amount_cents INTEGER NOT NULL, source TEXT, medium TEXT, content TEXT);" +
          "CREATE TABLE campaign_clicks (" +
          "day TEXT NOT NULL, source TEXT NOT NULL, medium TEXT NOT NULL, content TEXT NOT NULL, clicks INTEGER NOT NULL," +
          "PRIMARY KEY(day, source, medium, content)); PRAGMA user_version = 1;",
      );
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const findCampaign = db.query<
    { slug: string; document: string; updatedAt: string },
    []
  >(
    "SELECT slug, document, updated_at AS updatedAt FROM campaign_state WHERE id = 1",
  );
  const saveCampaign = db.query(
    "INSERT INTO campaign_state (id, slug, document, updated_at) VALUES (1, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at",
  );
  const orderColumns =
    "order_hash AS orderHash, status, amount_cents AS amountCents, source, medium, content";
  const allOrders = db.query<OrderRow, []>(
    `SELECT ${orderColumns} FROM campaign_orders`,
  );
  const findOrder = db.query<OrderRow, [string]>(
    `SELECT ${orderColumns} FROM campaign_orders WHERE order_hash = ?`,
  );
  const putOrder = db.query(
    "INSERT INTO campaign_orders (order_hash, status, amount_cents, source, medium, content) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(order_hash) DO UPDATE SET status = excluded.status, source = excluded.source, medium = excluded.medium, content = excluded.content",
  );
  const allClicks = db.query<ClickRow, []>(
    "SELECT day, source, medium, content, clicks FROM campaign_clicks",
  );
  const findClicks = db.query<
    { clicks: number },
    [string, string, string, string]
  >(
    "SELECT clicks FROM campaign_clicks WHERE day = ? AND source = ? AND medium = ? AND content = ?",
  );
  const putClicks = db.query(
    "INSERT INTO campaign_clicks (day, source, medium, content, clicks) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(day, source, medium, content) DO UPDATE SET clicks = excluded.clicks",
  );
  const orderCount = db.query<{ count: number }, []>(
    "SELECT count(*) AS count FROM campaign_orders",
  );
  const clicksCount = db.query<{ count: number }, []>(
    "SELECT count(*) AS count FROM campaign_clicks",
  );

  function readCampaign(): CampaignDocument | null {
    const record = findCampaign.get();
    if (!record) return null;
    return {
      ...JSON.parse(record.document),
      slug: record.slug,
      updatedAt: record.updatedAt,
    };
  }

  function requiredCampaign() {
    const existing = readCampaign();
    if (!existing) throw new CampaignError(409, "CAMPAIGN_REQUIRED");
    return existing;
  }

  const store = db.transaction((data: Record<string, unknown>) => {
    const fields = campaignDraft(data);
    const slug = findCampaign.get()?.slug ?? campaignSlug(fields.title);
    const now = new Date().toISOString();
    saveCampaign.run(slug, JSON.stringify(fields), now);
    return campaignWithMaterials({ ...fields, slug, updatedAt: now });
  });

  function report() {
    return campaignReport(allOrders.iterate(), allClicks.iterate());
  }

  const importOrders = db.transaction(
    (raw: string, campaign: CampaignDocument) => {
      const { orders, skipped } = readOrders(raw, campaign.slug);
      let imported = 0;
      let duplicates = 0;
      let total = orderCount.get()?.count ?? 0;
      for (const { order, row } of orders) {
        const existing = findOrder.get(order.orderHash);
        const next = existing ? mergeOrder(existing, order, row) : order;
        if (
          existing &&
          existing.status === next.status &&
          existing.source === next.source &&
          existing.medium === next.medium &&
          existing.content === next.content
        ) {
          duplicates += 1;
          continue;
        }
        if (!existing) {
          total += 1;
          if (total > maxStoredRows)
            throw new CampaignError(409, "CAMPAIGN_ORDER_LIMIT");
        }
        putOrder.run(
          next.orderHash,
          next.status,
          next.amountCents,
          next.source,
          next.medium,
          next.content,
        );
        imported += 1;
      }
      return { imported, duplicates, skipped, report: report() };
    },
  );

  const importTraffic = db.transaction(
    (raw: string, campaign: CampaignDocument) => {
      const { clicks, skipped } = readClicks(raw, campaign.slug);
      const seen = new Map<string, number>();
      let imported = 0;
      let duplicates = 0;
      let total = clicksCount.get()?.count ?? 0;
      for (const { click, row } of clicks) {
        const key = [
          click.day,
          click.source,
          click.medium,
          click.content,
        ] as const;
        const mapKey = JSON.stringify(key);
        const previous = seen.get(mapKey);
        if (previous !== undefined && previous !== click.clicks) {
          throw new CampaignError(409, "CAMPAIGN_CLICKS_CONFLICT", row);
        }
        seen.set(mapKey, click.clicks);
        const existing = findClicks.get(...key);
        if (existing?.clicks === click.clicks) {
          duplicates += 1;
          continue;
        }
        if (!existing) {
          total += 1;
          if (total > maxStoredRows)
            throw new CampaignError(409, "CAMPAIGN_CLICKS_LIMIT");
        }
        putClicks.run(...key, click.clicks);
        imported += 1;
      }
      return { imported, duplicates, skipped, report: report() };
    },
  );

  return {
    close: () => db.close(),
    getCampaign: readCampaign,
    async handle(request: Request, pathname: string): Promise<Response | null> {
      try {
        if (pathname === root) {
          if (request.method === "PUT") {
            const data = await jsonBody(request);
            return json({ campaign: store.immediate(data) });
          }
          if (request.method !== "GET") return invalidMethod("GET, PUT");
          const campaign = readCampaign();
          return json({
            campaign: campaign && campaignWithMaterials(campaign),
          });
        }

        if (pathname === `${root}/page`) {
          if (request.method !== "GET") return invalidMethod("GET");
          const campaign = requiredCampaign();
          return new Response(landingPage(campaign), {
            headers: {
              ...headers,
              "content-type": "text/html; charset=utf-8",
              "content-disposition": `attachment; filename="${campaign.slug}.html"`,
            },
          });
        }

        if (pathname === `${root}/orders` || pathname === `${root}/clicks`) {
          if (request.method === "GET") return json({ report: report() });
          if (request.method !== "POST") return invalidMethod("GET, POST");
          const campaign = requiredCampaign();
          const data = await jsonBody(request);
          if (typeof data.csv !== "string" || !data.csv.trim()) {
            throw new CampaignError(400, "CAMPAIGN_CSV_REQUIRED");
          }
          const importRows = pathname.endsWith("/orders")
            ? importOrders
            : importTraffic;
          return json(importRows.immediate(data.csv, campaign));
        }
        return null;
      } catch (error) {
        if (error instanceof CampaignError)
          return json({ error: error.code, row: error.row }, error.status);
        throw error;
      }
    },
  };
}
