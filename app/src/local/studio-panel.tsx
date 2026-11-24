import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { json, post, request } from "./api";
import { ebookPilot } from "./ebook-pilot-template";
import { downloadResponse } from "./pilot-download";

type BookBrief = { title: string; audience: string; promise: string };
export type CampaignBook = BookBrief & { id: string; revision: number };
type Chapter = { title: string; text: string };
type BookFields = BookBrief & {
  author: string;
  sources: { title: string; url: string }[];
  outline: string[];
  coverTheme: "verde" | "azul" | "terra";
  chapters: Chapter[];
};
type Book = BookFields & { id: string; revision: number };
type BookSummary = Pick<Book, "id" | "title" | "author" | "revision">;
type Editor = {
  brief: BookFields;
  sourcesText: string;
  outlineText: string;
  chapters: (Chapter & { key: string })[];
};
type Format = "epub" | "pdf" | "sample" | "cover";
type Fail = (failure: unknown) => void;
const booksPath = "/studio/books";
const exportLabels: Record<Format, string> = {
  epub: "Baixar EPUB",
  pdf: "Baixar PDF",
  sample: "Baixar amostra",
  cover: "Baixar capa",
};

function toEditor(book: BookFields): Editor {
  return {
    brief: book,
    sourcesText: book.sources
      .map(({ title, url }) => `${title} | ${url}`)
      .join("\n"),
    outlineText: book.outline.join("\n"),
    chapters: book.chapters.map((chapter) => ({
      ...chapter,
      key: crypto.randomUUID(),
    })),
  };
}

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function pathFor(id: string) {
  return `${booksPath}/${encodeURIComponent(id)}`;
}

export function StudioPanel({
  fail,
  configured,
  onCampaign,
}: {
  fail: Fail;
  configured: boolean;
  onCampaign: (brief: CampaignBook) => void;
}) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [saved, setSaved] = useState<Book>();
  const [editor, setEditor] = useState<Editor>();
  const [revisions, setRevisions] = useState<BookSummary[]>([]);
  const [historic, setHistoric] = useState<
    Book & { preview: Editor["chapters"] }
  >();
  const [busy, setBusy] = useState("");
  const [edited, setEdited] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void json<{ books: BookSummary[] }>(booksPath, {
      signal: controller.signal,
    })
      .then(({ books }) => setBooks(books))
      .catch((failure) => {
        if (!controller.signal.aborted) fail(failure);
      });
    return () => controller.abort();
  }, [fail]);

  function openBook(book: Book) {
    setSaved(book);
    setEditor(toEditor(book));
    setEdited(false);
    setHistoric(undefined);
    setRevisions([]);
    setPreviewIndex(0);
    setBooks((previous) => [
      book,
      ...previous.filter(({ id }) => id !== book.id),
    ]);
  }

  async function run(action: string, work: () => Promise<void>) {
    setBusy(action);
    setMessage("");
    try {
      await work();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  }

  function update(change: (current: Editor) => Editor) {
    setEdited(true);
    setEditor((current) => current && change(current));
  }

  function changeBrief<K extends keyof BookFields>(
    key: K,
    value: BookFields[K],
  ) {
    update((current) => ({
      ...current,
      brief: { ...current.brief, [key]: value },
    }));
  }

  function changeChapter(key: string, field: keyof Chapter, value: string) {
    update((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) =>
        chapter.key === key ? { ...chapter, [field]: value } : chapter,
      ),
    }));
  }

  async function create(fields: Partial<BookFields>) {
    const { book } = await json<{ book: Book }>(booksPath, post(fields));
    openBook(book);
    setMessage("Projeto criado.");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || !editor) return;
    const current = editor;
    await run("save", async () => {
      const sources = lines(current.sourcesText).map((line) => {
        const separator = line.indexOf("|");
        if (separator < 0) return { title: line, url: "" };
        if (separator === 0)
          throw new Error("Informe um nome para cada fonte.");
        return {
          title: line.slice(0, separator).trim(),
          url: line.slice(separator + 1).trim(),
        };
      });
      const { book } = await json<{ book: Book }>(pathFor(saved.id), {
        ...post({
          title: current.brief.title,
          author: current.brief.author,
          audience: current.brief.audience,
          promise: current.brief.promise,
          coverTheme: current.brief.coverTheme,
          sources,
          outline: lines(current.outlineText),
          chapters: current.chapters.map(({ title, text }) => ({
            title,
            text,
          })),
          revision: saved.revision,
        }),
        method: "PUT",
      });
      openBook(book);
      setMessage(`Versão ${book.revision} salva.`);
    });
  }

  async function draftChapter(chapter: Editor["chapters"][number]) {
    if (!editor || !chapter.title.trim()) return;
    await run("chapter", async () => {
      const { brief, outlineText, sourcesText } = editor;
      const base = [
        `Livro: ${brief.title}`,
        `Público: ${brief.audience}`,
        `Proposta: ${brief.promise}`,
        `Capítulo solicitado: ${chapter.title}`,
        `Sumário: ${outlineText.slice(0, 850)}`,
        `Referências fornecidas: ${sourcesText.slice(0, 1000)}`,
      ].join("\n");
      const { text } = await json<{ text: string }>(
        "/business/draft",
        post({
          kind: "chapter",
          brief:
            `${base}\nTrecho existente para revisão: ${chapter.text}`.slice(
              0,
              4000,
            ),
        }),
      );
      changeChapter(chapter.key, "text", text);
      setMessage("Rascunho gerado. Revise e salve para criar uma versão.");
    });
  }

  const previewChapters = historic?.preview ?? editor?.chapters ?? [];
  const previewChapter = previewChapters[previewIndex];

  return (
    <>
      <section className="learning-block">
        <h2>Estúdio de ebooks</h2>
        <p>Salve versões, revise capítulos e exporte o livro e a amostra.</p>
        <div className="business-actions">
          <Button
            disabled={Boolean(busy) || edited}
            onClick={() =>
              void run("create", () => create({ title: "Novo ebook" }))
            }
          >
            Novo ebook
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(busy) || edited}
            onClick={() => void run("example", () => create(ebookPilot))}
          >
            Criar projeto piloto
          </Button>
        </div>
        <label htmlFor="studio-project">Projetos salvos</label>
        <select
          id="studio-project"
          className="pilot-select"
          value={saved?.id || ""}
          disabled={Boolean(busy) || edited}
          onChange={(event) => {
            const id = event.target.value;
            if (id)
              void run("open", async () =>
                openBook((await json<{ book: Book }>(pathFor(id))).book),
              );
          }}
        >
          <option value="" disabled>
            Selecione um ebook
          </option>
          {books.map((book) => (
            <option value={book.id} key={book.id}>
              {book.title} · v{book.revision}
            </option>
          ))}
        </select>
        {message && <p role="status">{message}</p>}
      </section>
      {saved && editor && (
        <>
          <div className="pilot-columns">
            <form
              className="learning-block profile-form business-form"
              onSubmit={save}
            >
              <h3>Editar ebook</h3>
              <fieldset className="business-form" disabled={Boolean(busy)}>
                <label htmlFor="studio-title">
                  Título
                  <Input
                    id="studio-title"
                    maxLength={180}
                    required
                    value={editor.brief.title}
                    onChange={(event) =>
                      changeBrief("title", event.target.value)
                    }
                  />
                </label>
                <label htmlFor="studio-author">
                  Autor
                  <Input
                    id="studio-author"
                    maxLength={180}
                    value={editor.brief.author}
                    onChange={(event) =>
                      changeBrief("author", event.target.value)
                    }
                  />
                </label>
                <label>
                  Público
                  <textarea
                    rows={2}
                    maxLength={2000}
                    value={editor.brief.audience}
                    onChange={(event) =>
                      changeBrief("audience", event.target.value)
                    }
                  />
                </label>
                <label>
                  Proposta do ebook
                  <textarea
                    rows={2}
                    maxLength={750}
                    value={editor.brief.promise}
                    onChange={(event) =>
                      changeBrief("promise", event.target.value)
                    }
                  />
                </label>
                <label>
                  Tema da capa
                  <select
                    value={editor.brief.coverTheme}
                    onChange={(event) =>
                      changeBrief(
                        "coverTheme",
                        event.target.value as BookFields["coverTheme"],
                      )
                    }
                  >
                    <option value="verde">Verde</option>
                    <option value="azul">Azul</option>
                    <option value="terra">Terra</option>
                  </select>
                </label>
                <label>
                  Sumário planejado, um tópico por linha
                  <textarea
                    rows={3}
                    value={editor.outlineText}
                    onChange={(event) => {
                      const outlineText = event.target.value;
                      update((current) => ({ ...current, outlineText }));
                    }}
                  />
                </label>
                <label>
                  Fontes, uma por linha. Para incluir o link, use Nome |
                  https://link
                  <textarea
                    rows={3}
                    value={editor.sourcesText}
                    onChange={(event) => {
                      const sourcesText = event.target.value;
                      update((current) => ({ ...current, sourcesText }));
                    }}
                  />
                </label>
                {editor.chapters.map((chapter, index) => (
                  <fieldset key={chapter.key} className="business-form">
                    <legend>Capítulo {index + 1}</legend>
                    <label htmlFor={`studio-${chapter.key}`}>
                      Título do capítulo
                      <Input
                        id={`studio-${chapter.key}`}
                        value={chapter.title}
                        maxLength={180}
                        onChange={(event) =>
                          changeChapter(
                            chapter.key,
                            "title",
                            event.target.value,
                          )
                        }
                      />
                    </label>
                    <label>
                      Texto do capítulo
                      <textarea
                        value={chapter.text}
                        rows={7}
                        maxLength={80000}
                        onChange={(event) =>
                          changeChapter(chapter.key, "text", event.target.value)
                        }
                      />
                    </label>
                    <div className="business-actions">
                      {configured && (
                        <Button
                          variant="outline"
                          type="button"
                          disabled={!chapter.title.trim()}
                          onClick={() => void draftChapter(chapter)}
                        >
                          Gerar rascunho com DeepSeek
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => {
                          setPreviewIndex(0);
                          update((current) => ({
                            ...current,
                            chapters: current.chapters.filter(
                              ({ key }) => key !== chapter.key,
                            ),
                          }));
                        }}
                      >
                        Remover capítulo
                      </Button>
                    </div>
                  </fieldset>
                ))}
                <Button
                  variant="outline"
                  type="button"
                  disabled={editor.chapters.length >= 60}
                  onClick={() => {
                    const extra = {
                      key: crypto.randomUUID(),
                      title: "",
                      text: "",
                    };
                    update((current) => ({
                      ...current,
                      chapters: [...current.chapters, extra],
                    }));
                  }}
                >
                  Adicionar capítulo
                </Button>
                {!configured && (
                  <p>
                    Configure o OpenCode Console para gerar rascunhos com
                    DeepSeek.
                  </p>
                )}
                <div className="business-actions">
                  <Button type="submit" disabled={!edited}>
                    Salvar versão
                  </Button>
                  {edited && (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => openBook(saved)}
                    >
                      Descartar alterações locais
                    </Button>
                  )}
                </div>
              </fieldset>
            </form>
            <section className="learning-block">
              <h3>Prévia para celular</h3>
              <label htmlFor="studio-preview">Capítulo da prévia</label>
              <select
                id="studio-preview"
                className="pilot-select"
                value={previewIndex}
                disabled={previewChapters.length === 0}
                onChange={(event) =>
                  setPreviewIndex(Number(event.target.value))
                }
              >
                {previewChapters.length === 0 && (
                  <option value={0}>Sem capítulos</option>
                )}
                {previewChapters.map(({ title, key }, index) => (
                  <option key={key} value={index}>
                    {title || `Capítulo ${index + 1}`}
                  </option>
                ))}
              </select>
              <article className="pilot-preview">
                <strong>{historic?.title ?? editor.brief.title}</strong>
                <h4>{previewChapter?.title}</h4>
                <p>
                  {previewChapter?.text ||
                    "Adicione um capítulo para visualizar o livro."}
                </p>
              </article>
            </section>
          </div>
          <section className="learning-block">
            <h3>Versão {historic?.revision ?? saved.revision}</h3>
            {edited && (
              <p>Salve as alterações para exportar a versão atualizada.</p>
            )}
            <div className="business-actions">
              {(Object.keys(exportLabels) as Format[]).map((format) => (
                <Button
                  key={format}
                  variant="outline"
                  disabled={Boolean(busy) || edited}
                  onClick={() =>
                    void run(format, async () => {
                      const response = await request(
                        `${pathFor(saved.id)}/export/${format}?revision=${historic?.revision ?? saved.revision}`,
                      );
                      await downloadResponse(
                        response,
                        `ebook.${format === "cover" ? "png" : format === "epub" ? "epub" : "pdf"}`,
                      );
                    })
                  }
                >
                  {exportLabels[format]}
                </Button>
              ))}
              <Button
                disabled={Boolean(busy) || edited}
                onClick={() => onCampaign(historic ?? saved)}
              >
                Usar ebook em campanha
              </Button>
            </div>
            <Button
              variant="outline"
              disabled={Boolean(busy) || edited}
              onClick={() =>
                void run("history", async () => {
                  setRevisions(
                    (
                      await json<{ revisions: BookSummary[] }>(
                        `${pathFor(saved.id)}/revisions`,
                      )
                    ).revisions,
                  );
                })
              }
            >
              Mostrar histórico de versões
            </Button>
            {revisions.length > 0 && (
              <div className="business-actions">
                {revisions.map(({ revision }) => (
                  <Button
                    key={revision}
                    variant="ghost"
                    disabled={Boolean(busy) || edited}
                    aria-pressed={
                      (historic?.revision ?? saved.revision) === revision
                    }
                    onClick={() =>
                      void run("revision", async () => {
                        setPreviewIndex(0);
                        if (revision === saved.revision) {
                          setHistoric(undefined);
                          return;
                        }
                        const { book } = await json<{ book: Book }>(
                          `${pathFor(saved.id)}/revisions/${revision}`,
                        );
                        setHistoric({
                          ...book,
                          preview: toEditor(book).chapters,
                        });
                      })
                    }
                  >
                    Versão {revision}
                  </Button>
                ))}
              </div>
            )}
            {historic && (
              <Button
                variant="outline"
                disabled={Boolean(busy) || edited}
                onClick={() => {
                  setEditor(toEditor(historic));
                  setHistoric(undefined);
                  setEdited(true);
                }}
              >
                Editar esta versão como novo rascunho
              </Button>
            )}
          </section>
        </>
      )}
    </>
  );
}
