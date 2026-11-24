import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { json, localErrorMessage, post, RequestError, request } from "./api";
import { CampaignPanel } from "./campaign-panel";
import { type CampaignBook, StudioPanel } from "./studio-panel";
import "./learning.css";
import "./business-panel.css";

type Failure = (error: unknown) => void;
type SocialPlatform = "instagram" | "facebook_group";
type SocialStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "manual_ready"
  | "published"
  | "failed"
  | "needs_review"
  | "cancelled";
type SocialItem = {
  id: string;
  platform: SocialPlatform;
  caption: string;
  imageUrl: string | null;
  groupUrl: string | null;
  status: SocialStatus;
  scheduledAt: string | null;
  revision: number;
  error: string | null;
  containerId?: string | null;
};
type SocialData = {
  items: SocialItem[];
  instagramConfigured: boolean;
  instagramAccountId: string | null;
};

const platforms = {
  instagram: "Instagram",
  facebook_group: "Grupo do Facebook",
};
const socialStatus: Record<SocialStatus, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  publishing: "Publicando",
  manual_ready: "Pronta para publicação manual",
  published: "Publicada",
  failed: "Falhou",
  needs_review: "Requer conferência",
  cancelled: "Cancelada",
};
const emptySocial = {
  platform: "instagram" as SocialPlatform,
  caption: "",
  url: "",
  time: "",
};

function localDateInput(time: string | null) {
  if (!time) return "";
  const date = new Date(time);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function DraftGenerator({
  kind,
  configured,
  onDraft,
  fail,
}: {
  kind: "caption" | "ebook";
  configured: boolean;
  onDraft: (draft: { caption: string; chapters: ChapterText[] }) => void;
  fail: Failure;
}) {
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  if (!configured)
    return (
      <p>
        Para gerar rascunhos com DeepSeek, configure o OpenCode Console no
        OpenBot.
      </p>
    );
  return (
    <form
      className="profile-form business-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          onDraft(await json("/business/draft", post({ kind, brief })));
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Orientação para o DeepSeek
        <textarea
          required
          rows={2}
          maxLength={4000}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
        />
      </label>
      <p>O texto deste campo é enviado ao provedor do modelo.</p>
      <Button type="submit" variant="outline" disabled={busy || !brief.trim()}>
        {busy ? "Gerando…" : "Gerar rascunho"}
      </Button>
    </form>
  );
}

function SocialPanel({
  fail,
  configured,
}: {
  fail: Failure;
  configured: boolean;
}) {
  const [data, setData] = useState<SocialData>();
  const [form, setForm] = useState(emptySocial);
  const [editing, setEditing] = useState<SocialItem>();
  const [confirming, setConfirming] = useState<SocialItem>();
  const [verification, setVerification] = useState<{
    id: string;
    text: string;
  }>();
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setData(await json<SocialData>("/social"));
  }, []);
  useEffect(() => {
    void refresh().catch(fail);
    const timer = window.setInterval(() => void refresh().catch(fail), 15_000);
    return () => window.clearInterval(timer);
  }, [fail, refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const payload = {
      platform: form.platform,
      caption: form.caption,
      ...(form.platform === "instagram"
        ? { imageUrl: form.url }
        : { groupUrl: form.url }),
      scheduledAt: form.time ? new Date(form.time).toISOString() : null,
    };
    void run(async () => {
      await json(editing ? `/social/${editing.id}` : "/social", {
        ...post(payload),
        method: editing ? "PATCH" : "POST",
      });
      setEditing(undefined);
      setForm(emptySocial);
    });
  }

  const instagram = form.platform === "instagram";
  return (
    <>
      <section className="learning-block">
        <h2>Publicações</h2>
        <p>
          {data?.instagramConfigured
            ? `Instagram configurado para a conta ${data.instagramAccountId}.`
            : "Configure a conta profissional do Instagram para agendar publicações."}
        </p>
        <p>
          Para grupos do Facebook, o OpenBot prepara a legenda e abre o grupo
          para publicação manual.
        </p>
        <DraftGenerator
          kind="caption"
          configured={configured}
          fail={fail}
          onDraft={({ caption }) =>
            setForm((previous) => ({ ...previous, caption }))
          }
        />
        <form className="profile-form business-form" onSubmit={submit}>
          <label>
            Destino
            <select
              value={form.platform}
              disabled={busy}
              onChange={(event) =>
                setForm({
                  ...form,
                  platform: event.target.value as SocialPlatform,
                  url: "",
                })
              }
            >
              <option value="instagram">Instagram</option>
              <option value="facebook_group">Grupo do Facebook</option>
            </select>
          </label>
          <label>
            Legenda
            <textarea
              required
              rows={4}
              maxLength={2200}
              value={form.caption}
              onChange={(event) =>
                setForm({ ...form, caption: event.target.value })
              }
            />
          </label>
          <label htmlFor="business-social-url">
            {instagram ? "URL pública HTTPS da imagem" : "URL do grupo"}
            <Input
              id="business-social-url"
              required
              type="url"
              maxLength={2048}
              value={form.url}
              onChange={(event) =>
                setForm({ ...form, url: event.target.value })
              }
            />
          </label>
          <label htmlFor="business-social-time">
            {instagram
              ? "Data e hora local da publicação"
              : "Data e hora local para liberar o rascunho"}
            <Input
              id="business-social-time"
              type="datetime-local"
              value={form.time}
              onChange={(event) =>
                setForm({ ...form, time: event.target.value })
              }
            />
          </label>
          <div className="business-actions">
            <Button type="submit" disabled={busy}>
              {editing ? "Salvar alterações" : "Salvar rascunho"}
            </Button>
            {editing && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setEditing(undefined);
                  setForm(emptySocial);
                }}
              >
                Cancelar edição
              </Button>
            )}
          </div>
        </form>
      </section>
      <section className="learning-block">
        <h2>Fila de publicações</h2>
        {data?.items.length === 0 && <p>Nenhum rascunho salvo.</p>}
        {data?.items.map((item) => (
          <article
            key={item.id}
            className="business-item"
            aria-label={platforms[item.platform]}
          >
            <strong>
              {platforms[item.platform]} · {socialStatus[item.status]}
            </strong>
            <p className="profile-text">{item.caption}</p>
            {item.scheduledAt && (
              <p>{new Date(item.scheduledAt).toLocaleString("pt-BR")}</p>
            )}
            {item.error && <p>{localErrorMessage(item.error)}</p>}
            <div className="business-actions">
              {item.status === "draft" && (
                <>
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => {
                      setConfirming(undefined);
                      setEditing(item);
                      setForm({
                        platform: item.platform,
                        caption: item.caption,
                        url: item.imageUrl || item.groupUrl || "",
                        time: localDateInput(item.scheduledAt),
                      });
                    }}
                  >
                    Editar rascunho
                  </Button>
                  <Button
                    disabled={
                      busy ||
                      (item.platform === "instagram" &&
                        (!data.instagramConfigured || !item.scheduledAt))
                    }
                    onClick={() => setConfirming(item)}
                  >
                    Revisar e aprovar
                  </Button>
                </>
              )}
              {["draft", "scheduled", "manual_ready"].includes(item.status) && (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      await json(`/social/${item.id}/cancel`, post({}));
                    })
                  }
                >
                  Cancelar rascunho
                </Button>
              )}
              {item.status === "manual_ready" && item.groupUrl && (
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(item.caption)
                        .catch(fail)
                    }
                  >
                    Copiar legenda
                  </Button>
                  <Button
                    variant="outline"
                    render={
                      <a
                        href={item.groupUrl}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    Abrir grupo
                  </Button>
                </>
              )}
              {item.status === "needs_review" &&
                item.platform === "instagram" &&
                item.containerId && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await json<{
                          verification:
                            | "confirmed"
                            | "unconfirmed"
                            | "unavailable";
                        }>(`/social/${item.id}/verify`, post({}));
                        setVerification({
                          id: item.id,
                          text: {
                            confirmed: "Publicação confirmada pelo Instagram.",
                            unconfirmed:
                              "O Instagram ainda não confirmou a publicação.",
                            unavailable:
                              "O Instagram está indisponível para conferência agora.",
                          }[result.verification],
                        });
                      })
                    }
                  >
                    Conferir no Instagram
                  </Button>
                )}
              {verification?.id === item.id && (
                <p role="status">{verification.text}</p>
              )}
              {["manual_ready", "needs_review"].includes(item.status) && (
                <form
                  className="profile-form business-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const formData = new FormData(event.currentTarget);
                    const button = (event.nativeEvent as SubmitEvent).submitter;
                    const outcome =
                      button instanceof HTMLButtonElement
                        ? button.value
                        : "published";
                    void run(async () => {
                      const resultUrl = String(
                        formData.get("resultUrl") ?? "",
                      ).trim();
                      await json(
                        `/social/${item.id}/record`,
                        post({
                          outcome,
                          ...(outcome === "published" && resultUrl
                            ? { resultUrl }
                            : {}),
                        }),
                      );
                    });
                  }}
                >
                  <label htmlFor={`business-result-${item.id}`}>
                    Link da publicação (opcional)
                    <Input
                      id={`business-result-${item.id}`}
                      type="url"
                      name="resultUrl"
                      maxLength={2048}
                    />
                  </label>
                  <div className="business-actions">
                    <Button type="submit" value="published" disabled={busy}>
                      Registrar publicação
                    </Button>
                    <Button
                      type="submit"
                      value="not_published"
                      variant="outline"
                      disabled={busy}
                    >
                      Registrar que não publicou
                    </Button>
                  </div>
                </form>
              )}
            </div>
            {confirming?.id === item.id && (
              <div className="business-confirm">
                <p>
                  {item.platform === "instagram"
                    ? `Confirmar a publicação da imagem em ${item.imageUrl} na conta ${data.instagramAccountId} no horário acima?`
                    : `Liberar o rascunho para o grupo ${item.groupUrl}?`}
                </p>
                <div className="business-actions">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await json(
                          `/social/${item.id}/approve`,
                          post({ revision: confirming.revision }),
                        );
                        setConfirming(undefined);
                      })
                    }
                  >
                    Confirmar aprovação
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirming(undefined)}
                  >
                    Voltar
                  </Button>
                </div>
              </div>
            )}
          </article>
        ))}
      </section>
    </>
  );
}

type SalesRow = { rows: number; units: number; totalCents: number };
type SalesReport = {
  summary: SalesRow & {
    productCount: number;
    firstDate: string | null;
    lastDate: string | null;
  };
  byProduct: (SalesRow & { product: string })[];
  byDate: (SalesRow & { date: string })[];
};
type SalesInbox = {
  directory: string;
  status: "waiting" | "ready" | "error";
  report?: SalesReport;
  updatedAt?: string;
};
const salesValue = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function SalesPanel({ fail }: { fail: Failure }) {
  const [csv, setCsv] = useState("");
  const [manualReport, setReport] = useState<SalesReport>();
  const [inbox, setInbox] = useState<SalesInbox>();
  const [busy, setBusy] = useState(false);
  const report = manualReport ?? inbox?.report;
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const current = await json<SalesInbox>("/business/sales/inbox");
        if (active) setInbox(current);
      } catch (error) {
        if (active) fail(error);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [fail]);
  return (
    <section className="learning-block">
      <h2>Análise de vendas</h2>
      <p>
        Use um CSV com data, produto, quantidade e valor_total. Os dados são
        processados no computador.
      </p>
      {inbox && (
        <div className="business-confirm">
          <h3>Importação automática</h3>
          <p>
            Salve um arquivo UTF-8 chamado <code>vendas.csv</code> na pasta
            abaixo. Com o OpenBot aberto, a atualização é feita a cada 30
            segundos.
          </p>
          <code>{inbox.directory}</code>
          <div className="business-actions">
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(inbox.directory).catch(fail)
              }
            >
              Copiar pasta
            </Button>
            {manualReport && inbox.report && (
              <Button variant="outline" onClick={() => setReport(undefined)}>
                Exibir relatório automático
              </Button>
            )}
          </div>
          {inbox.status === "waiting" && <p>Aguardando arquivo.</p>}
          {inbox.status === "error" && (
            <p role="status">
              Confira o formato UTF-8, o cabeçalho e o limite de 128 KB do
              arquivo.
            </p>
          )}
          {inbox.updatedAt && (
            <p>
              Última atualização{" "}
              {new Date(inbox.updatedAt).toLocaleString("pt-BR")}
            </p>
          )}
        </div>
      )}
      <form
        className="profile-form business-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setReport(undefined);
          try {
            setReport(await json("/business/sales/analyze", post({ csv })));
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="business-csv-file">
          Importar CSV
          <Input
            id="business-csv-file"
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 120_000)
                return fail(new Error("O arquivo CSV deve ter até 120 KB."));
              void file.text().then(setCsv).catch(fail);
            }}
          />
        </label>
        <label>
          Dados CSV
          <textarea
            required
            rows={6}
            value={csv}
            maxLength={120000}
            placeholder={
              "data;produto;quantidade;valor_total\n2026-01-01;Produto A;2;50,00"
            }
            onChange={(event) => setCsv(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy}>
          Analisar CSV
        </Button>
      </form>
      {report && (
        <>
          <h3>
            {manualReport ? "Análise do CSV importado" : "Relatório automático"}
          </h3>
          <p role="status">
            {report.summary.rows} linhas · {report.summary.productCount}{" "}
            produtos · {report.summary.units} unidades · Total{" "}
            {salesValue.format(report.summary.totalCents / 100)}
          </p>
          {(
            [
              [
                "Por produto",
                report.byProduct.map((item) => ({
                  ...item,
                  label: item.product,
                })),
              ],
              [
                "Por data",
                report.byDate.map((item) => ({ ...item, label: item.date })),
              ],
            ] as const
          ).map(([heading, rows]) => (
            <div key={heading} className="business-table">
              <table>
                <caption>{heading}</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Linhas</th>
                    <th scope="col">Unidades</th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      <td>{row.rows}</td>
                      <td>{row.units}</td>
                      <td>{salesValue.format(row.totalCents / 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

type ChapterText = { title: string; text: string };
type Chapter = ChapterText & { id: number };
let chapterId = 0;
function chapter(text: ChapterText = { title: "", text: "" }): Chapter {
  chapterId += 1;
  return { id: chapterId, ...text };
}

function EbookPanel({
  fail,
  configured,
}: {
  fail: Failure;
  configured: boolean;
}) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [chapters, setChapters] = useState(() => [chapter()]);
  const [busy, setBusy] = useState(false);

  async function exportEbook(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await request(
        "/business/ebooks/export",
        post({
          title,
          author,
          chapters: chapters.map(({ title, text }) => ({ title, text })),
        }),
      );
      const href = URL.createObjectURL(await response.blob());
      const download = document.createElement("a");
      const name = response.headers
        .get("content-disposition")
        ?.split("filename*=UTF-8''")[1];
      download.href = href;
      download.download = name ? decodeURIComponent(name) : "ebook.epub";
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="learning-block">
      <h2>Criar ebook</h2>
      <DraftGenerator
        kind="ebook"
        configured={configured}
        fail={fail}
        onDraft={({ chapters }) => setChapters(chapters.map(chapter))}
      />
      <form className="profile-form business-form" onSubmit={exportEbook}>
        <label htmlFor="business-ebook-title">
          Título do ebook
          <Input
            id="business-ebook-title"
            required
            maxLength={180}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label htmlFor="business-ebook-author">
          Autor
          <Input
            id="business-ebook-author"
            required
            maxLength={180}
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
          />
        </label>
        {chapters.map((current, index) => (
          <fieldset key={current.id} className="business-form">
            <legend>Capítulo {index + 1}</legend>
            <label htmlFor={`business-chapter-${current.id}`}>
              Título do capítulo
              <Input
                id={`business-chapter-${current.id}`}
                required
                value={current.title}
                maxLength={120}
                onChange={(event) => {
                  const value = event.target.value;
                  setChapters((previous) =>
                    previous.map((item) =>
                      item.id === current.id ? { ...item, title: value } : item,
                    ),
                  );
                }}
              />
            </label>
            <label>
              Conteúdo
              <textarea
                required
                rows={6}
                value={current.text}
                maxLength={8000}
                onChange={(event) => {
                  const value = event.target.value;
                  setChapters((previous) =>
                    previous.map((item) =>
                      item.id === current.id ? { ...item, text: value } : item,
                    ),
                  );
                }}
              />
            </label>
            {chapters.length > 1 && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setChapters((previous) =>
                    previous.filter((item) => item.id !== current.id),
                  )
                }
              >
                Remover capítulo
              </Button>
            )}
          </fieldset>
        ))}
        <div className="business-actions">
          <Button
            type="button"
            variant="outline"
            disabled={chapters.length >= 8}
            onClick={() => {
              const next = chapter();
              setChapters((previous) => [...previous, next]);
            }}
          >
            Adicionar capítulo
          </Button>
          <Button type="submit" disabled={busy}>
            Baixar EPUB
          </Button>
        </div>
      </form>
    </section>
  );
}

type PluginSkill = { id: string; name: string; description: string };
type PluginInfo = {
  id: string;
  name: string;
  description: string;
  skills: PluginSkill[];
  dependencies: { app: boolean; mcp: boolean; codexHost: boolean };
};
function PluginsPanel({ fail }: { fail: Failure }) {
  const [catalog, setCatalog] = useState<{
    available: boolean;
    plugins: PluginInfo[];
  }>();
  const [selected, setSelected] = useState<{
    pluginId: string;
    skill: PluginSkill & { markdown: string };
  }>();
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    let active = true;
    void json<{ available: boolean; plugins: PluginInfo[] }>(
      "/business/plugins",
    )
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch(fail);
    return () => {
      active = false;
    };
  }, [fail]);
  const list = catalog?.plugins.filter((plugin) =>
    `${plugin.name} ${plugin.id} ${plugin.description}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const directive =
    selected && `/plugin ${selected.pluginId}/${selected.skill.id}`;
  return (
    <section className="learning-block">
      <h2>Plugins e skills</h2>
      <p>
        As skills de texto podem orientar o chat. Conectores marcados dependem
        de integração própria.
      </p>
      {catalog?.available === false && (
        <p>O catálogo local ainda não foi instalado.</p>
      )}
      <label htmlFor="business-plugin-search">
        Buscar plugin
        <Input
          id="business-plugin-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {selected && (
        <section className="business-confirm">
          <h3>{selected.skill.name}</h3>
          <p>Use a referência na primeira linha da mensagem no chat.</p>
          <code>{directive}</code>
          <div className="business-actions">
            <Button
              variant="outline"
              onClick={() => {
                if (directive)
                  void navigator.clipboard
                    .writeText(directive)
                    .then(() => setCopied(true))
                    .catch(fail);
              }}
            >
              {copied ? "Copiada" : "Copiar referência"}
            </Button>
            <Button variant="outline" onClick={() => setSelected(undefined)}>
              Fechar skill
            </Button>
          </div>
          <details>
            <summary>Ver instruções</summary>
            <pre className="profile-text">{selected.skill.markdown}</pre>
          </details>
        </section>
      )}
      {list?.map((plugin) => (
        <details className="business-item" key={plugin.id}>
          <summary>
            {plugin.name} · {plugin.skills.length} skills
          </summary>
          {plugin.description && <p>{plugin.description}</p>}
          {(plugin.dependencies.app ||
            plugin.dependencies.mcp ||
            plugin.dependencies.codexHost) && (
            <p>
              Dependências registradas{" "}
              {[
                plugin.dependencies.app && "app",
                plugin.dependencies.mcp && "MCP",
                plugin.dependencies.codexHost && "execução no Codex",
              ]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
          )}
          <ul>
            {plugin.skills.map((skill) => (
              <li key={skill.id}>
                <Button
                  variant="link"
                  onClick={() => {
                    setCopied(false);
                    void json<NonNullable<typeof selected>>(
                      `/business/plugins/${encodeURIComponent(plugin.id)}/skills/${encodeURIComponent(skill.id)}`,
                    )
                      .then(setSelected)
                      .catch(fail);
                  }}
                >
                  {skill.name}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

const panels = {
  social: "Publicações",
  sales: "Dados e vendas",
  ebooks: "Ebooks",
  campaign: "Campanha",
  plugins: "Plugins",
} as const;
type Panel = keyof typeof panels;

export function BusinessPanel({ onLock }: { onLock: () => void }) {
  const [panel, setPanel] = useState<Panel>("social");
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState(false);
  const [campaignBook, setCampaignBook] = useState<CampaignBook>();
  const fail = useCallback(
    (failure: unknown) => {
      if (failure instanceof RequestError && failure.status === 401) onLock();
      setError(
        failure instanceof Error
          ? failure.message
          : "Não foi possível concluir a operação.",
      );
    },
    [onLock],
  );

  useEffect(() => {
    void json<{ configured: boolean }>("/business/draft")
      .then((status) => setConfigured(status.configured))
      .catch(fail);
  }, [fail]);

  return (
    <div className="learning-page">
      <div className="learning-content">
        <header className="learning-heading">
          <h1>Trabalho</h1>
        </header>
        <nav className="business-actions" aria-label="Ferramentas de trabalho">
          {(Object.keys(panels) as Panel[]).map((key) => (
            <Button
              key={key}
              variant={panel === key ? "default" : "outline"}
              aria-pressed={panel === key}
              onClick={() => {
                setPanel(key);
                setError("");
              }}
            >
              {panels[key]}
            </Button>
          ))}
        </nav>
        {error && (
          <div className="learning-block business-error" role="alert">
            <p>{error}</p>
            <Button variant="outline" onClick={() => setError("")}>
              Fechar aviso
            </Button>
          </div>
        )}
        {panel === "social" && (
          <SocialPanel fail={fail} configured={configured} />
        )}
        {panel === "sales" && <SalesPanel fail={fail} />}
        {panel === "ebooks" && (
          <>
            <StudioPanel
              fail={fail}
              configured={configured}
              onCampaign={({ id, revision, title, audience, promise }) => {
                setCampaignBook({ id, revision, title, audience, promise });
                setError("");
                setPanel("campaign");
              }}
            />
            <details className="learning-block pilot-asset">
              <summary>Exportação rápida de EPUB</summary>
              <EbookPanel fail={fail} configured={configured} />
            </details>
          </>
        )}
        {panel === "campaign" && (
          <CampaignPanel fail={fail} book={campaignBook} />
        )}
        {panel === "plugins" && <PluginsPanel fail={fail} />}
      </div>
    </div>
  );
}
