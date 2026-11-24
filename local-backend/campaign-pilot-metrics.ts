import { createHash } from "node:crypto";
import {
  attributionKeys,
  CampaignError,
  validateTag,
} from "./campaign-pilot-content";

const maxRows = 5000;
const maxCents = 10_000_000_000;
const maxClicks = 10_000_000_000;

type CsvRecord = { row: number; fields: string[] };

type Channel = {
  source: string | null;
  medium: string | null;
  content: string | null;
};

export type OrderRow = Channel & {
  orderHash: string;
  status: "paid" | "refunded";
  amountCents: number;
};

export type ClickRow = {
  day: string;
  source: string;
  medium: string;
  content: string;
  clicks: number;
};

function csvError(code: string, row: number): never {
  throw new CampaignError(400, code, row);
}

function csvDelimiter(header: string) {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (const char of header) {
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === ",") commas += 1;
    if (char === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

function parseCsv(raw: string) {
  const input = raw.replace(/^\uFEFF/, "").trimStart();
  const delimiter = csvDelimiter(input.split(/\r\n?|\n/, 1)[0] ?? "");
  const records: CsvRecord[] = [];
  let row = 1;
  let fields: string[] = [];
  let field = "";
  let state: "plain" | "quoted" | "closed" = "plain";

  function endField() {
    fields.push(field.trim());
    field = "";
    state = "plain";
  }

  function endRow() {
    endField();
    if (fields.length > 1 || fields[0]) records.push({ fields, row });
    if (records.length > maxRows + 1)
      csvError("CAMPAIGN_CSV_TOO_MANY_ROWS", row);
    fields = [];
    row += 1;
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    if (state === "quoted") {
      if (char !== '"') {
        field += char;
      } else if (input.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
      } else {
        state = "closed";
      }
      continue;
    }
    if (char === delimiter) {
      endField();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && input.charAt(index + 1) === "\n") index += 1;
      endRow();
    } else if (state === "closed") {
      if (char !== " " && char !== "\t")
        csvError("CAMPAIGN_CSV_INVALID_QUOTING", row);
    } else if (char === '"') {
      if (field.trim()) csvError("CAMPAIGN_CSV_INVALID_QUOTING", row);
      field = "";
      state = "quoted";
    } else {
      field += char;
    }
  }
  if (state === "quoted") csvError("CAMPAIGN_CSV_INVALID_QUOTING", row);
  endRow();
  return records;
}

function attribution(input: string, row: number) {
  if (!input) return null;
  if (!validateTag(input)) csvError("CAMPAIGN_CSV_INVALID_UTM", row);
  return input;
}

function orderValue(input: string, row: number) {
  if (!/^\d{1,9}(?:[.,]\d{1,2})?$/.test(input))
    csvError("CAMPAIGN_CSV_INVALID_VALUE", row);
  const [integer, fraction = ""] = input.split(/[.,]/);
  const value = Number(integer) * 100 + Number(fraction.padEnd(2, "0"));
  if (value > maxCents) csvError("CAMPAIGN_CSV_INVALID_VALUE", row);
  return value;
}

function csvRows(
  raw: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const [header, ...records] = parseCsv(raw);
  const keys = header?.fields.map((key) => key.toLowerCase()) ?? [];
  const permitted = new Set([...required, ...optional]);
  if (
    keys.length !== new Set(keys).size ||
    keys.some((key) => !permitted.has(key)) ||
    required.some((key) => !keys.includes(key))
  )
    csvError("CAMPAIGN_CSV_INVALID_HEADER", header?.row ?? 1);
  return records.map(({ fields, row }) => {
    if (fields.length !== keys.length)
      csvError("CAMPAIGN_CSV_INVALID_COLUMNS", row);
    return {
      row,
      value: (key: string) => fields[keys.indexOf(key)] ?? "",
    };
  });
}

export function readOrders(raw: string, slug: string) {
  const records = csvRows(
    raw,
    ["order_id", "status", "value"],
    attributionKeys,
  );
  const orders: { order: OrderRow; row: number }[] = [];
  let skipped = 0;
  for (const { value, row } of records) {
    const campaign = attribution(value("utm_campaign"), row);
    if (campaign && campaign !== slug) {
      skipped += 1;
      continue;
    }
    const id = value("order_id");
    if (!/^[#A-Za-z0-9][A-Za-z0-9_.:#-]{0,127}$/.test(id))
      csvError("CAMPAIGN_CSV_INVALID_ORDER_ID", row);
    const status = value("status").toLowerCase();
    if (status !== "paid" && status !== "refunded")
      csvError("CAMPAIGN_CSV_INVALID_STATUS", row);
    const amountCents = orderValue(value("value"), row);
    const orderHash = createHash("sha256")
      .update(`${slug}:${id}`)
      .digest("hex");
    orders.push({
      order: {
        orderHash,
        status,
        amountCents,
        source: attribution(value("utm_source"), row),
        medium: attribution(value("utm_medium"), row),
        content: attribution(value("utm_content"), row),
      },
      row,
    });
  }
  return { orders, skipped };
}

export function readClicks(raw: string, slug: string) {
  const records = csvRows(raw, ["date", "clicks", ...attributionKeys]);
  const clicks: { click: ClickRow; row: number }[] = [];
  let skipped = 0;
  for (const { value, row } of records) {
    const campaign = attribution(value("utm_campaign"), row);
    if (!campaign) csvError("CAMPAIGN_CSV_INVALID_UTM", row);
    if (campaign !== slug) {
      skipped += 1;
      continue;
    }
    const day = value("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
      csvError("CAMPAIGN_CSV_INVALID_DATE", row);
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || !date.toISOString().startsWith(day))
      csvError("CAMPAIGN_CSV_INVALID_DATE", row);
    const count = value("clicks");
    if (!/^\d{1,11}$/.test(count) || Number(count) > maxClicks)
      csvError("CAMPAIGN_CSV_INVALID_CLICKS", row);
    const source = attribution(value("utm_source"), row);
    const medium = attribution(value("utm_medium"), row);
    const content = attribution(value("utm_content"), row);
    if (!source || !medium || !content)
      csvError("CAMPAIGN_CSV_INVALID_UTM", row);
    clicks.push({
      click: { day, source, medium, content, clicks: Number(count) },
      row,
    });
  }
  return { clicks, skipped };
}

type ChannelCounts = {
  orders: number;
  purchases: number;
  refunds: number;
  netCents: number;
  clicks: number | null;
};

type Group = Channel & ChannelCounts;

const emptyCounts = () => ({
  orders: 0,
  purchases: 0,
  refunds: 0,
  netCents: 0,
  clicks: null,
});

function addOrder(counts: ChannelCounts, order: OrderRow) {
  counts.orders += 1;
  if (order.status === "refunded") {
    counts.refunds += 1;
  } else {
    counts.purchases += 1;
    counts.netCents += order.amountCents;
  }
}

export function campaignReport(
  orders: Iterable<OrderRow>,
  traffic: Iterable<ClickRow>,
) {
  const summary: ChannelCounts = emptyCounts();
  const channels = new Map<string, Group>();
  let attributedOrders = 0;

  function bucket({ source, medium, content }: Channel) {
    const key = JSON.stringify([source, medium, content]);
    let group = channels.get(key);
    if (!group) {
      group = { source, medium, content, ...emptyCounts() };
      channels.set(key, group);
    }
    return group;
  }

  for (const order of orders) {
    addOrder(summary, order);
    addOrder(bucket(order), order);
    if (order.source) attributedOrders += 1;
  }

  for (const click of traffic) {
    const group = bucket(click);
    summary.clicks = (summary.clicks ?? 0) + click.clicks;
    group.clicks = (group.clicks ?? 0) + click.clicks;
  }

  return {
    summary,
    bySource: [...channels.values()].sort(
      (a, b) =>
        b.netCents - a.netCents ||
        b.orders - a.orders ||
        (b.clicks ?? 0) - (a.clicks ?? 0) ||
        (a.source ?? "").localeCompare(b.source ?? "") ||
        (a.medium ?? "").localeCompare(b.medium ?? "") ||
        (a.content ?? "").localeCompare(b.content ?? ""),
    ),
    attributedOrders,
    unattributedOrders: summary.orders - attributedOrders,
  };
}
