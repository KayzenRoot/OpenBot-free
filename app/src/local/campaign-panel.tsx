import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { json, post, request } from "./api";
import { campaignPilot } from "./ebook-pilot-template";
import { downloadLocalFile, downloadResponse } from "./pilot-download";
import type { CampaignBook } from "./studio-panel";

type CampaignFields = typeof campaignPilot;
type Material = {
  format: "article" | "carousel" | "video";
  source: string;
  medium: string;
  contentId: string;
  title: string;
  body: string;
  url: string | null;
};
type Campaign = CampaignFields & { slug: string; materials: Material[] };
type Metrics = {
  orders: number;
  purchases: number;
  refunds: number;
  netCents: number;
  clicks: number | null;
};
type Report = {
  summary: Metrics;
  bySource: (Metrics & {
    source: string | null;
    medium: string | null;
    content: string | null;
  })[];
  attributedOrders: number;
  unattributedOrders: number;
};
type Fail = (error: unknown) => void;
const base = "/business/campaign";
const empty: CampaignFields = {
  title: "",
  audience: "",
  promise: "",
  description: "",
  questions: ["", "", ""],
  answers: ["", "", ""],
  pageUrl: "",
  checkoutUrl: "",
  sampleUrl: "",
  coverUrl: "",
};
const formats = {
  article: "Artigo",
  carousel: "Carrossel",
  video: "Vídeo curto",
};
const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function campaignFields({
  title,
  audience,
  promise,
  description,
  questions,
  answers,
  pageUrl,
  checkoutUrl,
  sampleUrl,
  coverUrl,
}: Campaign) {
  return {
    title,
    audience,
    promise,
    description,
    questions,
    answers,
    pageUrl,
    checkoutUrl,
    sampleUrl,
    coverUrl,
  };
}

function ImportMetrics({
  endpoint,
  title,
  help,
  fail,
  onImport,
}: {
  endpoint: "orders" | "clicks";
  title: string;
  help: string;
  fail: Fail;
  onImport: (report: Report, message: string) => void;
}) {
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await json<{
        report: Report;
        imported: number;
        duplicates?: number;
        skipped?: number;
      }>(`${base}/${endpoint}`, post({ csv }));
      const details = [
        result.duplicates ? `${result.duplicates} duplicadas` : "",
        result.skipped ? `${result.skipped} ignoradas` : "",
      ].filter(Boolean);
      onImport(
        result.report,
        [`${result.imported} linhas importadas`, ...details].join(" · "),
      );
      setCsv("");
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="profile-form business-form business-confirm"
      onSubmit={submit}
    >
      <h3>{title}</h3>
      <p>{help}</p>
      <label htmlFor={`campaign-file-${endpoint}`}>
        Arquivo CSV
        <Input
          id={`campaign-file-${endpoint}`}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 120_000)
              return fail(new Error("O CSV deve ter até 120 KB."));
            void file.text().then(setCsv).catch(fail);
          }}
        />
      </label>
      <label>
        Conteúdo CSV
        <textarea
          required
          rows={4}
          maxLength={120000}
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
        />
      </label>
      <Button type="submit" disabled={busy}>
        {busy ? "Importando…" : title}
      </Button>
    </form>
  );
}

export function CampaignPanel({
  fail,
  book,
}: {
  fail: Fail;
  book?: CampaignBook;
}) {
  const [fields, setFields] = useState<CampaignFields>(empty);
  const [saved, setSaved] = useState<Campaign>();
  const [report, setReport] = useState<Report>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [edited, setEdited] = useState(false);
  const [message, setMessage] = useState("");
  const bookTitle = book?.title;
  const bookAudience = book?.audience;
  const bookPromise = book?.promise;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function load() {
      try {
        const { campaign } = await json<{ campaign: Campaign | null }>(base, {
          signal,
        });
        if (signal.aborted) return;
        if (campaign) {
          setFields(campaignFields(campaign));
          setSaved(campaign);
          if (bookTitle && bookTitle !== campaign.title) {
            setMessage(
              "Este perfil tem uma campanha salva. Mantive o ebook e as métricas dessa campanha.",
            );
          }
          const { report } = await json<{ report: Report }>(`${base}/orders`, {
            signal,
          });
          if (!signal.aborted) setReport(report);
        } else if (bookTitle) {
          setFields(
            bookTitle === campaignPilot.title
              ? campaignPilot
              : {
                  ...empty,
                  title: bookTitle,
                  audience: bookAudience ?? "",
                  promise: bookPromise ?? "",
                },
          );
          setEdited(true);
        }
      } catch (failure) {
        if (!signal.aborted) fail(failure);
      } finally {
        if (!signal.aborted) setReady(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [bookTitle, bookAudience, bookPromise, fail]);

  function change<K extends keyof CampaignFields>(
    key: K,
    value: CampaignFields[K],
  ) {
    setEdited(true);
    setFields((previous) => ({ ...previous, [key]: value }));
  }

  function changeTopic(
    key: "questions" | "answers",
    index: number,
    value: string,
  ) {
    setEdited(true);
    setFields((previous) => {
      const items = [...previous[key]];
      items[index] = value;
      return { ...previous, [key]: items };
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setMessage("");
    try {
      const { campaign } = await json<{ campaign: Campaign }>(base, {
        ...post(fields),
        method: "PUT",
      });
      setSaved(campaign);
      setFields(campaignFields(campaign));
      setEdited(false);
      setMessage("Campanha salva. Revise os materiais e exporte a página.");
      setReport((await json<{ report: Report }>(`${base}/orders`)).report);
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  }

  async function page() {
    setBusy("page");
    try {
      await downloadResponse(await request(`${base}/page`), "index.html");
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  }

  async function kit() {
    if (!book) return;
    setBusy("kit");
    try {
      await downloadResponse(
        await request(
          `${base}/kit`,
          post({ bookId: book.id, revision: book.revision }),
        ),
        "ebook-site.zip",
      );
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <section className="learning-block">
        <h2>Campanha orgânica</h2>
        <p>
          Prepare a página de venda e três conteúdos. Use a mesma campanha para
          importar resultados.
        </p>
        {!saved && (
          <Button
            variant="outline"
            disabled={!ready || Boolean(busy)}
            onClick={() => {
              setFields(campaignPilot);
              setEdited(true);
            }}
          >
            Preencher com o ebook piloto
          </Button>
        )}
        <form className="profile-form business-form" onSubmit={save}>
          <fieldset
            className="business-form"
            disabled={!ready || Boolean(busy)}
          >
            <label htmlFor="campaign-title">
              Título do ebook
              <Input
                id="campaign-title"
                value={fields.title}
                required
                maxLength={160}
                onChange={(event) => change("title", event.target.value)}
              />
            </label>
            <label>
              Público
              <textarea
                required
                rows={2}
                maxLength={240}
                value={fields.audience}
                onChange={(event) => change("audience", event.target.value)}
              />
            </label>
            <label>
              Proposta
              <textarea
                required
                rows={2}
                maxLength={320}
                value={fields.promise}
                onChange={(event) => change("promise", event.target.value)}
              />
            </label>
            <label>
              Descrição da oferta
              <textarea
                required
                rows={3}
                maxLength={2400}
                value={fields.description}
                onChange={(event) => change("description", event.target.value)}
              />
            </label>
            {(["Artigo", "Carrossel", "Vídeo curto"] as const).map(
              (format, index) => (
                <fieldset
                  key={format}
                  className="business-form business-confirm"
                >
                  <legend>{format}</legend>
                  <label>
                    Pergunta do público
                    <textarea
                      required
                      rows={2}
                      maxLength={240}
                      value={fields.questions[index] || ""}
                      onChange={(event) =>
                        changeTopic("questions", index, event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Resposta, exemplo ou argumento da peça
                    <textarea
                      rows={2}
                      maxLength={1500}
                      value={fields.answers[index] || ""}
                      onChange={(event) =>
                        changeTopic("answers", index, event.target.value)
                      }
                    />
                  </label>
                </fieldset>
              ),
            )}
            <label htmlFor="campaign-page-url">
              URL pública da página
              <Input
                id="campaign-page-url"
                type="url"
                maxLength={1800}
                value={fields.pageUrl}
                placeholder="https://meusite.com/ebook"
                onChange={(event) => change("pageUrl", event.target.value)}
              />
            </label>
            <label htmlFor="campaign-checkout-url">
              URL do checkout
              <Input
                id="campaign-checkout-url"
                type="url"
                maxLength={1800}
                value={fields.checkoutUrl}
                placeholder="https://loja.example/checkout"
                onChange={(event) => change("checkoutUrl", event.target.value)}
              />
            </label>
            <label htmlFor="campaign-sample-url">
              Link ou arquivo da amostra
              <Input
                id="campaign-sample-url"
                maxLength={1800}
                value={fields.sampleUrl}
                placeholder="./amostra.pdf"
                onChange={(event) => change("sampleUrl", event.target.value)}
              />
            </label>
            <label htmlFor="campaign-cover-url">
              Link ou arquivo da capa
              <Input
                id="campaign-cover-url"
                maxLength={1800}
                value={fields.coverUrl}
                placeholder="./capa.png"
                onChange={(event) => change("coverUrl", event.target.value)}
              />
            </label>
            <Button type="submit" disabled={!edited}>
              {busy === "save" ? "Salvando…" : "Salvar campanha"}
            </Button>
          </fieldset>
        </form>
        {message && <p role="status">{message}</p>}
      </section>
      {saved && (
        <>
          <section className="learning-block">
            <h2>Página de venda e conteúdos</h2>
            <p>
              Use o HTML no seu site. O checkout e os links rastreáveis usam as
              URLs públicas salvas na campanha.
            </p>
            {edited && <p>As exportações usam a última versão salva.</p>}
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => void page()}
            >
              Baixar página HTML
            </Button>
            {book?.title === saved.title ? (
              <Button
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => void kit()}
              >
                {busy === "kit"
                  ? "Preparando kit…"
                  : "Baixar kit público com amostra e capa"}
              </Button>
            ) : (
              <p>
                Abra o ebook no Estúdio e use a opção de campanha para incluir
                capa e amostra no kit.
              </p>
            )}
            {saved.materials.map((material) => (
              <details
                className="business-item pilot-asset"
                key={material.format}
              >
                <summary>
                  {formats[material.format]} · {material.title}
                </summary>
                <p className="profile-text">{material.body}</p>
                {material.url ? (
                  <p>
                    <code>{material.url}</code>
                  </p>
                ) : (
                  <p>
                    Cadastre a URL pública da página para gerar o link desta
                    peça.
                  </p>
                )}
                <div className="business-actions">
                  <Button
                    variant="outline"
                    onClick={() =>
                      downloadLocalFile(
                        new Blob(
                          [
                            `# ${material.title}\n\n${material.body}\n\n${material.url || ""}\n`,
                          ],
                          { type: "text/plain" },
                        ),
                        `${material.contentId}.md`,
                      )
                    }
                  >
                    Baixar material
                  </Button>
                  {material.url && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (material.url)
                          void navigator.clipboard
                            .writeText(material.url)
                            .then(() => setMessage("Link copiado."))
                            .catch(fail);
                      }}
                    >
                      Copiar link rastreável
                    </Button>
                  )}
                </div>
              </details>
            ))}
          </section>
          <section className="learning-block">
            <h2>Resultados da campanha</h2>
            <ImportMetrics
              endpoint="orders"
              title="Importar vendas e reembolsos"
              fail={fail}
              help="Use pedidos deste ebook. Cabeçalho order_id,status,value,utm_source,utm_medium,utm_campaign,utm_content. Status paid ou refunded."
              onImport={(data, status) => {
                setReport(data);
                setMessage(status);
              }}
            />
            <ImportMetrics
              endpoint="clicks"
              title="Importar cliques"
              fail={fail}
              help="Use contagens diárias de uma fonte de análise. Cabeçalho date,clicks,utm_source,utm_medium,utm_campaign,utm_content."
              onImport={(data, status) => {
                setReport(data);
                setMessage(status);
              }}
            />
            {report && (
              <>
                <p>
                  {report.summary.clicks ?? "Cliques sem dados"}
                  {report.summary.clicks === null ? "" : " cliques"} ·{" "}
                  {report.summary.purchases} compras pagas ·{" "}
                  {report.summary.refunds} reembolsos ·{" "}
                  {currency.format(report.summary.netCents / 100)}
                </p>
                <p>
                  {report.attributedOrders} pedidos com origem registrada ·{" "}
                  {report.unattributedOrders} sem origem registrada
                </p>
                {report.bySource.length > 0 && (
                  <div className="business-table">
                    <table>
                      <caption>Resultados por canal e conteúdo</caption>
                      <thead>
                        <tr>
                          <th scope="col">Canal</th>
                          <th scope="col">Conteúdo</th>
                          <th scope="col">Cliques</th>
                          <th scope="col">Compras</th>
                          <th scope="col">Reembolsos</th>
                          <th scope="col">Receita após reembolsos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.bySource.map((row) => (
                          <tr
                            key={JSON.stringify([
                              row.source,
                              row.medium,
                              row.content,
                            ])}
                          >
                            <th scope="row">
                              {[row.source, row.medium]
                                .filter(Boolean)
                                .join(" / ") || "Sem origem"}
                            </th>
                            <td>{row.content ?? "—"}</td>
                            <td>{row.clicks ?? "—"}</td>
                            <td>{row.purchases}</td>
                            <td>{row.refunds}</td>
                            <td>{currency.format(row.netCents / 100)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
