const epubMediaType = "application/epub+zip";
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
const encoder = new TextEncoder();

export type Ebook = {
  title: string;
  author: string;
  chapters: { title: string; text: string }[];
};

function xml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crcTable[index] = crc;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ArchiveEntry = [
  name: string,
  content: string | Uint8Array<ArrayBuffer>,
];

export function assembleZip(entries: ArchiveEntry[]) {
  const records = entries.map(([name, content]) => ({
    name: encoder.encode(name),
    content: typeof content === "string" ? encoder.encode(content) : content,
  }));
  const centralStart = records.reduce(
    (size, entry) => size + 30 + entry.name.length + entry.content.length,
    0,
  );
  const centralSize = records.reduce(
    (size, entry) => size + 46 + entry.name.length,
    0,
  );
  const archive = new Uint8Array(centralStart + centralSize + 22);
  const header = new DataView(archive.buffer);
  let local = 0;
  let central = centralStart;
  const utf8Flag = 0x0800;
  const dosDate = 0x0021;

  for (const { name, content } of records) {
    const checksum = crc32(content);
    header.setUint32(local, 0x04034b50, true);
    header.setUint16(local + 4, 20, true);
    header.setUint16(local + 6, utf8Flag, true);
    header.setUint16(local + 12, dosDate, true);
    header.setUint32(local + 14, checksum, true);
    header.setUint32(local + 18, content.length, true);
    header.setUint32(local + 22, content.length, true);
    header.setUint16(local + 26, name.length, true);
    archive.set(name, local + 30);
    archive.set(content, local + 30 + name.length);

    header.setUint32(central, 0x02014b50, true);
    header.setUint16(central + 4, 20, true);
    header.setUint16(central + 6, 20, true);
    header.setUint16(central + 8, utf8Flag, true);
    header.setUint16(central + 14, dosDate, true);
    header.setUint32(central + 16, checksum, true);
    header.setUint32(central + 20, content.length, true);
    header.setUint32(central + 24, content.length, true);
    header.setUint16(central + 28, name.length, true);
    header.setUint32(central + 42, local, true);
    archive.set(name, central + 46);
    local += 30 + name.length + content.length;
    central += 46 + name.length;
  }

  header.setUint32(central, 0x06054b50, true);
  header.setUint16(central + 8, records.length, true);
  header.setUint16(central + 10, records.length, true);
  header.setUint32(central + 12, centralSize, true);
  header.setUint32(central + 16, centralStart, true);
  return archive;
}

function xhtml(title: string, body: string) {
  return `${xmlHeader}
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="pt-BR" lang="pt-BR">
  <head><meta charset="utf-8"/><title>${xml(title)}</title></head>
  <body>${body}</body>
</html>`;
}

export function exportEpub(
  book: Ebook,
  options?: {
    cover?: Uint8Array<ArrayBuffer>;
    description?: string;
    identifier?: string;
    modified?: string;
  },
) {
  const chapters = book.chapters.map((chapter, index) => {
    const id = `chapter-${index + 1}`;
    const href = `${id}.xhtml`;
    const paragraphs = chapter.text
      .split(/\r?\n[\t ]*\r?\n/)
      .map(
        (paragraph) => `<p>${xml(paragraph).replace(/\r\n?|\n/g, "<br/>")}</p>`,
      )
      .join("\n");
    return {
      id,
      href,
      title: chapter.title,
      content: xhtml(
        chapter.title,
        `<h1>${xml(chapter.title)}</h1>\n${paragraphs}`,
      ),
    };
  });
  const manifest = chapters.map(
    ({ id, href }) =>
      `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`,
  );
  const spine = chapters.map(({ id }) => `<itemref idref="${id}"/>`);
  const links = chapters.map(
    ({ href, title }) => `<li><a href="${href}">${xml(title)}</a></li>`,
  );
  const identifier = options?.identifier ?? `urn:uuid:${crypto.randomUUID()}`;
  const modified = (options?.modified ?? new Date().toISOString()).replace(
    /\.\d{3}Z$/,
    "Z",
  );
  const description = options?.description
    ? `<dc:description>${xml(options.description)}</dc:description>`
    : "";
  const cover: ArchiveEntry[] = [];
  if (options?.cover) {
    manifest.unshift(
      '<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>',
      '<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>',
    );
    spine.unshift('<itemref idref="cover-page"/>');
    cover.push(
      ["EPUB/cover.png", options.cover],
      [
        "EPUB/cover.xhtml",
        xhtml(
          "Capa",
          `<section epub:type="cover"><img src="cover.png" alt="${xml(`Capa de ${book.title}`)}" style="display:block;width:100%;height:auto"/></section>`,
        ),
      ],
    );
  }

  return assembleZip([
    ["mimetype", epubMediaType],
    [
      "META-INF/container.xml",
      `${xmlHeader}
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    ],
    [
      "EPUB/package.opf",
      `${xmlHeader}
<package version="3.0" unique-identifier="publication-id" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${xml(identifier)}</dc:identifier>
    <dc:title>${xml(book.title)}</dc:title>
    <dc:language>pt-BR</dc:language>
    <dc:creator>${xml(book.author)}</dc:creator>
    ${description}
    <meta property="dcterms:modified">${xml(modified)}</meta>
  </metadata>
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join("")}</manifest>
  <spine>${spine.join("")}</spine>
</package>`,
    ],
    [
      "EPUB/nav.xhtml",
      xhtml(
        "Sumário",
        `<nav epub:type="toc" id="toc"><h1>Sumário</h1><ol>${links.join("")}</ol></nav>`,
      ),
    ],
    ...cover,
    ...chapters.map(
      ({ href, content }): ArchiveEntry => [`EPUB/${href}`, content],
    ),
  ]);
}
