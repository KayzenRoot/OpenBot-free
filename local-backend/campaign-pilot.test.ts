import { expect, test } from "bun:test";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createCampaignPilot, renderBundlePage } from "./campaign-pilot";

const route = "/api/local/business/campaign";
const requestOrigin = "http://127.0.0.1";
const fixture = {
  title: "Git e IA <guia>",
  audience: "Pessoas começando a programar",
  promise: "Revise a primeira alteração com autonomia",
  description:
    "Aprenda um fluxo que você pode reproduzir hoje.\nCom testes pelo terminal.",
  questions: [
    "Como revisar um diff?",
    "Que teste devo rodar?",
    "Como voltar a uma versão?",
  ],
  answers: [
    "Abra a alteração com git diff.",
    "Comece pelo teste do módulo.",
    "Identifique a revisão.",
  ],
  pageUrl: "https://vitrine.example/guia?lang=pt",
  checkoutUrl: "https://pagamento.example/checkout?produto=git",
  sampleUrl: "./amostra.epub",
  coverUrl: "./capa.jpg",
};

function app(dbPath = ":memory:") {
  const campaign = createCampaignPilot({ dbPath });
  return {
    close: campaign.close,
    read: campaign.getCampaign,
    async call(path: string, method = "GET", value?: object) {
      const pathname = route + path;
      const response = await campaign.handle(
        new Request(requestOrigin + pathname, {
          method,
          ...(value
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(value),
              }
            : {}),
        }),
        pathname,
      );
      if (!response) throw new Error(`Handler did not match ${pathname}`);
      return response;
    },
  };
}

test("saves a reproducible campaign and exports a safe mobile sale page", async () => {
  const campaign = app();
  try {
    expect(await (await campaign.call("")).json()).toEqual({ campaign: null });
    expect((await campaign.call("/page")).status).toBe(409);
    const { campaign: stored } = await (
      await campaign.call("", "PUT", fixture)
    ).json();
    expect(
      stored.materials.map(({ format }: { format: string }) => format),
    ).toEqual(["article", "carousel", "video"]);
    const urls = stored.materials.map(
      ({ url }: { url: string }) => new URL(url),
    );
    expect(new Set(urls.map(({ href }: URL) => href)).size).toBe(3);
    expect(urls[1].searchParams.get("utm_campaign")).toBe(stored.slug);
    expect(urls[1].searchParams.get("utm_content")).toBe("carrossel");
    expect(urls[1].searchParams.get("lang")).toBe("pt");
    expect(stored.materials[0].body).toContain(
      "Abra a alteração com git diff.",
    );
    expect(stored.materials[1].body).toContain("Slide 2");
    expect(stored.materials[2].body).toContain("3–20 s");

    const page = await campaign.call("/page");
    expect(page.headers.get("content-disposition")).toEqual(
      `attachment; filename="${stored.slug}.html"`,
    );
    const html = await page.text();
    expect(html).toContain("Git e IA &lt;guia&gt;");
    expect(html).toContain('href="./amostra.epub"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("script-src 'sha256-");
    expect(html).toContain(
      'id="checkout" href="https://pagamento.example/checkout?produto=git"',
    );
    expect(html).not.toContain("Abra a alteração com git diff.");
    const saved = campaign.read();
    if (!saved) throw new Error("Campaign must be stored");
    const bundled = renderBundlePage(saved);
    expect(bundled).toContain('href="./amostra.pdf"');
    expect(bundled).toContain('src="./capa.png"');
    expect(campaign.read()?.sampleUrl).toBe("./amostra.epub");

    for (const checkoutUrl of [
      "javascript:alert(1)",
      "https://user:password@checkout.example/",
      "https:\\\\spoof.example/",
    ]) {
      const invalid = await campaign.call("", "PUT", {
        ...fixture,
        checkoutUrl,
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: "INVALID_CAMPAIGN_URL_CHECKOUT",
      });
    }
    const renamed = await campaign.call("", "PUT", {
      ...fixture,
      title: "Aprender Git",
      checkoutUrl: "",
    });
    expect((await renamed.json()).campaign.slug).toBe(stored.slug);
    const withoutCheckout = await (await campaign.call("/page")).text();
    expect(withoutCheckout).toContain("Venda em preparação");
    expect(withoutCheckout).not.toContain('id="checkout"');
  } finally {
    campaign.close();
  }
});

test("keeps recorded attribution, deduplicates orders and never regresses a refund", async () => {
  const campaign = app();
  try {
    const {
      campaign: { slug },
    } = await (await campaign.call("", "PUT", fixture)).json();
    const header =
      "order_id;status;value;utm_source;utm_medium;utm_campaign;utm_content";
    const csv = [
      header,
      `C-1;paid;39,90;instagram;social;${slug};carrossel`,
      "C-2;paid;19,90;;;;",
      "C-3;paid;99,00;blog;organico;outra-campanha;artigo",
    ].join("\r\n");

    const imported = await (
      await campaign.call("/orders", "POST", { csv })
    ).json();
    expect(imported).toMatchObject({
      imported: 2,
      skipped: 1,
      duplicates: 0,
      report: {
        summary: {
          orders: 2,
          purchases: 2,
          refunds: 0,
          netCents: 5980,
          clicks: null,
        },
        attributedOrders: 1,
        unattributedOrders: 1,
        bySource: [
          {
            source: "instagram",
            medium: "social",
            content: "carrossel",
            netCents: 3990,
          },
          { source: null, medium: null, content: null, netCents: 1990 },
        ],
      },
    });
    const repeat = await (
      await campaign.call("/orders", "POST", { csv })
    ).json();
    expect(repeat).toMatchObject({ imported: 0, duplicates: 2, skipped: 1 });
    const refund = await (
      await campaign.call("/orders", "POST", {
        csv: "order_id,status,value\nC-1,refunded,39.90",
      })
    ).json();
    expect(refund).toMatchObject({
      imported: 1,
      report: {
        summary: { orders: 2, purchases: 1, refunds: 1, netCents: 1990 },
      },
    });
    expect(refund.report.bySource).toContainEqual({
      source: "instagram",
      medium: "social",
      content: "carrossel",
      orders: 1,
      purchases: 0,
      refunds: 1,
      netCents: 0,
      clicks: null,
    });
    const stale = await (
      await campaign.call("/orders", "POST", { csv })
    ).json();
    expect(stale.report.summary).toEqual(refund.report.summary);

    const conflict = await campaign.call("/orders", "POST", {
      csv: "order_id,status,value\nC-4,paid,20\nC-1,paid,31",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "CAMPAIGN_ORDER_CONFLICT",
      row: 3,
    });
    expect(
      (await (await campaign.call("/orders")).json()).report.summary,
    ).toEqual(refund.report.summary);
    const extra = await campaign.call("/orders", "POST", {
      csv: "order_id,status,value,email\nC-4,paid,20,data@example.org",
    });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({
      error: "CAMPAIGN_CSV_INVALID_HEADER",
      row: 1,
    });
  } finally {
    campaign.close();
  }
});

test("reports only imported clicks and replaces existing daily totals", async () => {
  const campaign = app();
  try {
    const {
      campaign: { slug },
    } = await (await campaign.call("", "PUT", fixture)).json();
    const header = "date,clicks,utm_source,utm_medium,utm_campaign,utm_content";
    const line = (count: number, date = "2026-11-23", campaign = slug) =>
      [date, count, "blog", "organico", campaign, "artigo"].join(",");
    const first = await (
      await campaign.call("/clicks", "POST", {
        csv: [
          header,
          line(10),
          line(10),
          line(5, "2026-11-22"),
          line(1000, "2026-11-23", "outro"),
        ].join("\n"),
      })
    ).json();
    expect(first).toMatchObject({
      imported: 2,
      duplicates: 1,
      skipped: 1,
      report: {
        summary: {
          orders: 0,
          purchases: 0,
          refunds: 0,
          netCents: 0,
          clicks: 15,
        },
        bySource: [{ source: "blog", content: "artigo", clicks: 15 }],
      },
    });
    const update = await (
      await campaign.call("/clicks", "POST", {
        csv: [header, line(11)].join("\n"),
      })
    ).json();
    expect(update.report.summary.clicks).toBe(16);
    const invalid = await campaign.call("/clicks", "POST", {
      csv: [header, line(1), line(2)].join("\n"),
    });
    expect(invalid.status).toBe(409);
    expect(
      (await (await campaign.call("/orders")).json()).report.summary.clicks,
    ).toBe(16);
  } finally {
    campaign.close();
  }
});

test("restores draft and order history from SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-campaign-test-"));
  const dbPath = join(directory, "campaign.sqlite");
  let campaign = app(dbPath);
  try {
    const {
      campaign: { slug },
    } = await (await campaign.call("", "PUT", fixture)).json();
    await campaign.call("/orders", "POST", {
      csv: "order_id,status,value\nE-11,paid,6.00",
    });
    campaign.close();
    campaign = app(dbPath);
    expect((await (await campaign.call("")).json()).campaign.slug).toBe(slug);
    expect(
      (await (await campaign.call("/orders")).json()).report.summary.netCents,
    ).toBe(600);
  } finally {
    campaign.close();
    for (const name of [
      "campaign.sqlite",
      "campaign.sqlite-wal",
      "campaign.sqlite-shm",
    ]) {
      rmSync(join(directory, name), { force: true });
    }
    rmdirSync(directory);
  }
});

test.skipIf(process.env.OPENBOT_TEST_EDGE !== "1")(
  "forwards registered attribution through the actual exported public page in Edge",
  async () => {
    const campaign = app();
    const browser = await chromium.launch({ channel: "msedge" });
    let html = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    try {
      const {
        campaign: { slug },
      } = await (await campaign.call("", "PUT", fixture)).json();
      html = await (await campaign.call("/page")).text();
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      const messages: string[] = [];
      page.on("pageerror", (error) => messages.push(error.message));
      const query =
        "?utm_source=blog&utm_medium=organico&utm_campaign=" +
        slug +
        "&utm_content=artigo&email=secret";
      await page.goto(server.url.href + query);
      const href = await page
        .getByRole("link", { name: "Comprar ebook" })
        .getAttribute("href");
      expect(href).not.toBeNull();
      const target = new URL(href!);
      expect(target.hostname).toBe("pagamento.example");
      expect(target.searchParams.get("produto")).toBe("git");
      expect(target.searchParams.get("utm_campaign")).toBe(slug);
      expect(target.searchParams.get("utm_content")).toBe("artigo");
      expect(target.searchParams.has("email")).toBe(false);
      const horizontal = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(horizontal).toBeLessThanOrEqual(390);
      expect(messages).toEqual([]);
      await page.goto(
        server.url.href + query.replace(slug, "campanha-diferente"),
      );
      expect(
        await page
          .getByRole("link", { name: "Comprar ebook" })
          .getAttribute("href"),
      ).toBe(fixture.checkoutUrl);
    } finally {
      server.stop(true);
      await browser.close();
      campaign.close();
    }
  },
  20000,
);
