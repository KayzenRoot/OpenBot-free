import { chromium } from "playwright-core";
import type { StudioBook } from "./studio-pilot";

export type StudioArtwork = (
  book: StudioBook,
  format: "pdf" | "sample" | "cover",
  signal: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

const palettes = {
  verde: { background: "#142c2b", accent: "#bee6b4", accentSoft: "#d1e4c8" },
  azul: { background: "#19283e", accent: "#bdd8ff", accentSoft: "#d0e1f2" },
  terra: { background: "#43251f", accent: "#ffcca9", accentSoft: "#f0d2bb" },
} as const;

function html(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphs(text: string) {
  return text
    .split(/\r?\n[\t ]*\r?\n/)
    .map(
      (paragraph) => `<p>${html(paragraph).replace(/\r\n?|\n/g, "<br>")}</p>`,
    )
    .join("");
}

function compose(book: StudioBook, format: Parameters<StudioArtwork>[1]) {
  const palette = palettes[book.coverTheme];
  const sample = format === "sample";
  const coverOnly = format === "cover";
  const chapters = sample ? book.chapters.slice(0, 1) : book.chapters;
  const sections = chapters
    .map(({ title, text }, index) => {
      return `<section class="chapter" aria-labelledby="chapter-${index + 1}">
      <h2 id="chapter-${index + 1}">${html(title)}</h2>
      ${paragraphs(text)}
    </section>`;
    })
    .join("");
  const sources =
    !sample && book.sources.length > 0
      ? `<section class="chapter"><h2>Referências</h2><ol>${book.sources
          .map(({ title, url }) =>
            url
              ? `<li><a href="${html(url)}">${html(title)}</a></li>`
              : `<li>${html(title)}</li>`,
          )
          .join("")}</ol></section>`
      : "";
  const toc = !sample
    ? `<nav class="chapter" aria-label="Sumário"><h2>Sumário</h2><ol>
      ${chapters.map(({ title }, index) => `<li><a href="#chapter-${index + 1}">${html(title)}</a></li>`).join("")}
      </ol></nav>`
    : "";
  const content = coverOnly ? "" : toc + sections + sources;
  const title = html(book.title);
  const bookLength = book.title.length;
  const titleSize =
    bookLength > 135
      ? "36px"
      : bookLength > 85
        ? "45px"
        : bookLength > 42
          ? "56px"
          : "72px";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<style>
@page { size: A5; margin: 18mm 17mm 20mm; }
@page cover { size: A5; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { color: #19202a; font-family: Georgia, "Times New Roman", serif; overflow-wrap: anywhere; }
.cover { page: cover; position: relative; height: 209.8mm; padding: 20mm 17mm;
  background: ${palette.background}; color: ${palette.accent}; display: flex; flex-direction: column;
  justify-content: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; overflow: hidden; }
.book-cover .cover { width: 780px; height: 1170px; padding: 105px 98px; }
.cover::before { content: ""; position: absolute; width: 75%; aspect-ratio: 1; border: 1px solid currentColor;
  opacity: .26; border-radius: 50%; right: -28%; top: -10%; }
.cover::after { content: ""; position: absolute; width: 16%; height: 5mm; border-radius: 12px;
  background: currentColor; bottom: 11%; right: 14%; opacity: .84; }
.cover h1 { max-width: 100%; margin: 0; font-weight: 600; font-size: calc(${titleSize} * .7);
  line-height: 1.09; letter-spacing: -.035em; }
.book-cover h1 { font-size: ${titleSize}; }
.promise { max-width: 100%; color: ${palette.accentSoft}; font-size: 12pt; line-height: 1.42; margin: 1.8em 0 0; }
.book-cover .promise { font-size: 25px; }
.credit, .sample-note { font-family: "Segoe UI", Arial, sans-serif; font-size: 10pt; line-height: 1.35;
  font-weight: 600; color: ${palette.accentSoft}; }
.book-cover .credit { font-size: 22px; }
.sample-note { margin: 0 0 2.5em; letter-spacing: .12em; text-transform: uppercase; }
.credit { margin: 2em 0 0; }
.chapter { break-before: page; }
.chapter h2 { font-size: 23pt; line-height: 1.16; font-weight: 600; margin: 0 0 1em; break-after: avoid; }
.chapter p, .chapter li { margin: 0 0 1em; font-size: 11pt; line-height: 1.55; widows: 3; orphans: 3; }
.chapter a { color: #193c62; text-decoration-thickness: 1px; }
.chapter ol { padding-left: 1.4em; }
</style>
</head>
<body${coverOnly ? ' class="book-cover"' : ""}>
<header class="cover">
${sample ? '<p class="sample-note">Amostra</p>' : ""}
<h1>${title}</h1>
${book.promise ? `<p class="promise">${html(book.promise)}</p>` : ""}
${book.author ? `<p class="credit">${html(book.author)}</p>` : ""}
</header>
<main>${content}</main>
</body>
</html>`;
}

export const renderStudioArtwork: StudioArtwork = async (
  book,
  format,
  parentSignal,
) => {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    timeout: 12_000,
    args: ["--disable-background-networking"],
  });
  const closeOnAbort = () => void browser.close().catch(() => {});
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      offline: true,
      javaScriptEnabled: false,
      viewport: { width: 780, height: 1170 },
      deviceScaleFactor: 1,
    });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(compose(book, format), {
      waitUntil: "load",
      timeout: 8_000,
    });
    let result: Buffer;
    if (format === "cover") {
      result = await page
        .locator(".cover")
        .screenshot({ type: "png", timeout: 8_000 });
    } else {
      result = await page.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        tagged: true,
        outline: true,
      });
    }
    signal.throwIfAborted();
    return Uint8Array.from(result);
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await browser.close().catch(() => {});
  }
};
