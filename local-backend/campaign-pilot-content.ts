import { createHash } from "node:crypto";

export class CampaignError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly row?: number,
  ) {
    super(code);
  }
}

export type CampaignDraft = {
  title: string;
  audience: string;
  promise: string;
  description: string;
  questions: string[];
  answers: string[];
  pageUrl: string;
  checkoutUrl: string;
  sampleUrl: string;
  coverUrl: string;
};

export type CampaignDocument = CampaignDraft & {
  slug: string;
  updatedAt: string;
};

const materialFormats = [
  {
    format: "article",
    contentId: "artigo",
    source: "blog",
    medium: "organico",
  },
  {
    format: "carousel",
    contentId: "carrossel",
    source: "instagram",
    medium: "social",
  },
  {
    format: "video",
    contentId: "video-curto",
    source: "instagram",
    medium: "social",
  },
] as const;

export const attributionKeys = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
] as const;
const tag = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateTag(input: string) {
  return tag.test(input);
}

function invalidCampaign(): never {
  throw new CampaignError(400, "INVALID_CAMPAIGN");
}

function disallowedText(value: string) {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return (
      (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
      point === 127
    );
  });
}

function campaignText(value: unknown, max: number, optional = false) {
  if (optional && (value === undefined || value === "")) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    disallowedText(value)
  ) {
    return invalidCampaign();
  }
  const text = value.trim();
  return text || (optional ? "" : invalidCampaign());
}

function campaignUrl(value: unknown, key: string, allowRelative = false) {
  const input = campaignText(value, 2048, true);
  if (!input) return "";
  if (
    allowRelative &&
    /^\.\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.(?:epub|pdf|png|jpg|jpeg|webp)$/i.test(
      input,
    )
  ) {
    return input;
  }
  try {
    if (!/^https:\/\//i.test(input) || /[\s\\]/.test(input))
      throw new Error("Invalid HTTPS URL");
    const url = new URL(input);
    if (url.username || url.password) throw new Error("Credentials in URL");
    if (key === "PAGE" || key === "CHECKOUT") {
      for (const name of attributionKeys) url.searchParams.delete(name);
    }
    return url.href;
  } catch {
    throw new CampaignError(400, `INVALID_CAMPAIGN_URL_${key}`);
  }
}

export function campaignDraft(body: Record<string, unknown>): CampaignDraft {
  if (!Array.isArray(body.questions) || body.questions.length !== 3)
    return invalidCampaign();
  const questions = body.questions.map((question) =>
    campaignText(question, 240),
  );
  if (new Set(questions.map((question) => question.toLowerCase())).size !== 3)
    return invalidCampaign();

  const inputAnswers = body.answers ?? [];
  if (!Array.isArray(inputAnswers) || inputAnswers.length > 3)
    return invalidCampaign();
  const answers = Array.from({ length: 3 }, (_, index) =>
    campaignText(inputAnswers[index], 1500, true),
  );
  return {
    title: campaignText(body.title, 160),
    audience: campaignText(body.audience, 240),
    promise: campaignText(body.promise, 320),
    description: campaignText(body.description, 2400),
    questions,
    answers,
    pageUrl: campaignUrl(body.pageUrl, "PAGE"),
    checkoutUrl: campaignUrl(body.checkoutUrl, "CHECKOUT"),
    sampleUrl: campaignUrl(body.sampleUrl, "SAMPLE", true),
    coverUrl: campaignUrl(body.coverUrl, "COVER", true),
  };
}

export function campaignSlug(title: string) {
  const normalized = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72)
    .replace(/-$/, "");
  const suffix = createHash("sha256").update(title).digest("hex").slice(0, 8);
  return slug ? `${slug}-${suffix}` : `ebook-${suffix}`;
}

function campaignLink(
  campaign: CampaignDocument,
  material: (typeof materialFormats)[number],
) {
  if (!campaign.pageUrl) return null;
  const url = new URL(campaign.pageUrl);
  url.searchParams.set("utm_source", material.source);
  url.searchParams.set("utm_medium", material.medium);
  url.searchParams.set("utm_campaign", campaign.slug);
  url.searchParams.set("utm_content", material.contentId);
  return url.href;
}

function materialBody(
  format: (typeof materialFormats)[number]["format"],
  question: string,
  answer: string,
  campaign: CampaignDocument,
  cta: string,
) {
  if (format === "article") {
    return [
      `# ${question}`,
      "## Resposta prática",
      answer || "[Escreva uma resposta direta em duas ou três frases.]",
      ...(!answer
        ? [
            "## Como aplicar",
            "[Mostre uma sequência de passos e inclua um exemplo verificável.]",
          ]
        : []),
      "## Próximo passo",
      campaign.promise,
      cta,
    ].join("\n\n");
  }
  if (format === "carousel") {
    const [opening, ...detail] = answer.split(/\r?\n/).filter(Boolean);
    return [
      question,
      "Por onde começar\n" +
        (opening || "[Responda com uma ação que o público possa testar hoje.]"),
      detail.length ? `Na prática\n${detail.join("\n")}` : "",
      `Resultado esperado\n${campaign.promise}`,
      cta,
    ]
      .filter(Boolean)
      .map((slide, index) => `Slide ${index + 1} · ${slide}`)
      .join("\n\n");
  }
  return [
    `0–3 s · Gancho\n${question}`,
    "3–20 s · Resposta\n" +
      (answer || "[Demonstre um primeiro passo com um exemplo.]"),
    `20–25 s · Síntese\n${campaign.promise}`,
    `25–30 s · Encerramento\n${cta}`,
  ].join("\n\n");
}

export function campaignWithMaterials(campaign: CampaignDocument) {
  return {
    ...campaign,
    materials: materialFormats.map((material, index) => {
      const url = campaignLink(campaign, material);
      const title = campaign.questions[index] ?? campaign.title;
      const answer = campaign.answers[index] ?? "";
      const cta = `Conheça ${campaign.title}${url ? ` · ${url}` : "."}`;
      return {
        ...material,
        title,
        body: materialBody(material.format, title, answer, campaign, cta),
        url,
      };
    }),
  };
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Copies only the known, bounded attribution parameters onto a validated checkout URL.
const checkoutTracking =
  "const checkout = document.getElementById('checkout');" +
  "if (checkout) {" +
  "const source = new URLSearchParams(location.search);" +
  "const target = new URL(checkout.href);" +
  "const campaign = document.body.dataset.campaign;" +
  "const formats = " +
  JSON.stringify(
    materialFormats.map(({ contentId, source, medium }) => [
      contentId,
      source,
      medium,
    ]),
  ) +
  ";" +
  "const matched = formats.some(([content, name, medium]) => source.get('utm_content') === content && source.get('utm_source') === name && source.get('utm_medium') === medium);" +
  "if (matched && source.get('utm_campaign') === campaign) {" +
  "for (const key of ['utm_source','utm_medium','utm_campaign','utm_content']) {" +
  "const value = source.get(key);" +
  "if (value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) target.searchParams.set(key, value);" +
  "}" +
  "checkout.href = target.href;" +
  "}" +
  "}";

export function landingPage(campaign: CampaignDocument) {
  const title = escapeHtml(campaign.title);
  const audience = escapeHtml(campaign.audience);
  const promise = escapeHtml(campaign.promise);
  const description = escapeHtml(campaign.description);
  const scriptHash = createHash("sha256")
    .update(checkoutTracking)
    .digest("base64");
  const cover = campaign.coverUrl
    ? '<img class="cover" alt="Capa de ' +
      title +
      '" src="' +
      escapeHtml(campaign.coverUrl) +
      '">'
    : "";
  const sample = campaign.sampleUrl
    ? '<a class="button outline" href="' +
      escapeHtml(campaign.sampleUrl) +
      '">Ler uma amostra</a>'
    : "";
  const checkout = campaign.checkoutUrl
    ? '<a class="button" id="checkout" href="' +
      escapeHtml(campaign.checkoutUrl) +
      '">Comprar ebook</a>'
    : '<p class="availability">Venda em preparação</p>';
  const canonical = campaign.pageUrl
    ? `<link rel="canonical" href="${escapeHtml(campaign.pageUrl)}">`
    : "";
  const list = campaign.questions
    .map((question) => `<li>${escapeHtml(question)}</li>`)
    .join("\n");

  return [
    "<!doctype html>",
    '<html lang="pt-BR">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="description" content="' +
      escapeHtml(campaign.promise.slice(0, 170)) +
      '">',
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src 'sha256-" +
      scriptHash +
      "'\">",
    `<title>${title}</title>`,
    canonical,
    "<style>",
    ":root{color-scheme:light;font-family:system-ui,sans-serif;background:#f6f3ea;color:#152820}",
    "*{box-sizing:border-box}body{margin:0;line-height:1.6}main{width:min(100% - 2.5rem,64rem);margin:0 auto;padding:clamp(3rem,8vw,7rem) 0}",
    ".intro{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:clamp(1.5rem,6vw,5rem);align-items:start}.intro.single{grid-template-columns:minmax(0,40rem)}",
    "h1{font-family:Georgia,serif;line-height:1.04;font-size:clamp(2.5rem,7vw,5rem);letter-spacing:-.04em;margin:0 0 1rem;overflow-wrap:anywhere}",
    "h2{font-size:1.35rem;line-height:1.3;margin:0 0 1rem}p{margin:0 0 1rem;overflow-wrap:anywhere}.promise{font-size:clamp(1.2rem,3vw,1.6rem);line-height:1.4}.description{white-space:pre-wrap}",
    ".cover{width:100%;max-width:23rem;max-height:39rem;object-fit:contain;object-position:top center;border-radius:.5rem;display:block}",
    ".actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin:1.75rem 0}.button{background:#214b39;color:#fff;font-weight:700;padding:.65rem 1rem;border-radius:.35rem;text-decoration:none;border:2px solid #214b39}",
    ".outline{background:transparent;color:#214b39}.button:focus-visible{outline:3px solid #a35416;outline-offset:3px}.availability{margin:0}.details{border-top:1px solid #c1cbbd;margin-top:3rem;padding-top:1.5rem}.details li{margin:.35rem 0;overflow-wrap:anywhere}",
    "@media(max-width:650px){.intro{grid-template-columns:1fr}.cover{width:min(65vw,18rem);margin-inline:auto}}",
    "</style>",
    "</head>",
    `<body data-campaign="${escapeHtml(campaign.slug)}">`,
    '<main><section class="intro' +
      (cover ? "" : " single") +
      '" aria-labelledby="ebook-title"><div>',
    `<h1 id="ebook-title">${title}</h1>`,
    `<p class="promise">${promise}</p>`,
    `<p class="description">${description}</p>`,
    `<div class="actions">${checkout}${sample}</div>`,
    `</div>${cover}</section>`,
    '<section class="details" aria-labelledby="audience-title"><h2 id="audience-title">Para quem é este ebook</h2><p>' +
      audience +
      "</p>",
    `<h2>Perguntas abordadas</h2><ul>${list}</ul></section>`,
    "</main>",
    campaign.checkoutUrl ? `<script>${checkoutTracking}</script>` : "",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}
