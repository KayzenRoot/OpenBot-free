import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { json, localErrorMessage, post, RequestError, request } from "./api";
import { downloadResponse } from "./pilot-download";
import "./business-panel.css";
import "./learning.css";
import "./pilot-panels.css";

type Template = "programming" | "ebook" | "sales";
type Bot = {
  id: string;
  name: string;
  request: string;
  template: Template;
  version: number;
  status: "draft" | "simulated" | "active" | "retired";
  capabilities: string[];
  simulation: {
    passed: boolean;
    checks: { name: string; passed: boolean }[];
  } | null;
};
type Job = {
  id: string;
  workflow: Template;
  input: { botId: string; botVersion: number; botName: string };
  status:
    | "queued"
    | "running"
    | "retry_wait"
    | "paused"
    | "review"
    | "completed"
    | "failed"
    | "cancelled";
  currentStage: string | null;
  attempt: number;
  nextAttemptAt: string | null;
  control: "pause" | "cancel" | null;
  error: string | null;
  createdAt: string;
  outputs: Record<string, Record<string, unknown>>;
};
type Skill = {
  id: string;
  version: number;
  status: "proposed" | "active" | "retired" | "rejected";
  comparison: {
    baseline: { passed: number; total: number };
    candidate: { passed: number; total: number };
    heldOut: number;
    regressions: number;
  };
};
type Artifact = { kind: string; filename: string; size: number };
type Event = {
  id: number;
  type: string;
  stage: string | null;
  detail: string | null;
  at: string;
};
type Book = { id: string; title: string; revision: number };
type Action = (work: () => Promise<void>) => Promise<void>;
type Operations = {
  phase: "ready" | "stopping";
  connections: {
    programming: "configured" | "detected" | "missing";
    editorial: "configured" | "missing";
    instagram: "configured" | "invalid" | "missing";
  };
};

const templates: Record<Template, string> = {
  programming: "Programador",
  ebook: "Editor de ebooks",
  sales: "Analista de vendas",
};
const botScopes: Record<Template, string> = {
  programming:
    "Prepara patches e pode executar os testes selecionados e aprovados.",
  ebook: "Gera rascunhos e arquivos do Estúdio.",
  sales:
    "Analisa os registros de campanhas, pedidos e reembolsos do perfil local.",
};
const connectionLabels = {
  configured: "Configuração presente",
  detected: "CLI local detectada",
  invalid: "Configuração inválida",
  missing: "Configuração ausente",
};
const statusText: Record<Job["status"], string> = {
  queued: "Na fila",
  running: "Executando",
  retry_wait: "Aguardando nova tentativa",
  paused: "Pausada",
  review: "Requer revisão",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
};
const stages: Record<string, string> = {
  draft: "Redação",
  epub: "EPUB",
  pdf: "PDF",
  sample: "Amostra",
  cover: "Capa",
  kit: "Kit público",
  proposal: "Proposta de código",
  tests: "Testes isolados",
  sales: "Relatório de vendas",
};
const eventNames: Record<string, string> = {
  queued: "Adicionada à fila",
  stage_started: "Etapa iniciada",
  stage_completed: "Etapa salva",
  retry_scheduled: "Nova tentativa agendada",
  resumed: "Retomada",
  paused: "Pausada",
  completed: "Concluída",
  failed: "Falhou",
  review_required: "Revisão necessária",
  cancelled: "Cancelada",
  pause_requested: "Pausa solicitada",
  cancel_requested: "Cancelamento solicitado",
  checkpoint_recovered: "Etapa recuperada",
  review_failed: "Revisão encerrou a execução",
};
const botStatuses = {
  draft: "Rascunho",
  simulated: "Simulado",
  active: "Ativo",
  retired: "Arquivado",
};
const base = "/bot-runs";
const bookPath = "/studio/books";

function value(data: FormData, key: string) {
  return String(data.get(key) ?? "").trim();
}
function filePaths(data: FormData, key: string) {
  return value(data, key)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function OperationsSummary({
  onLock,
  stopping,
  setStopping,
}: {
  onLock: () => void;
  stopping: boolean;
  setStopping: (value: boolean) => void;
}) {
  const [operations, setOperations] = useState<Operations | null>();
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [requestingShutdown, setRequestingShutdown] = useState(false);
  const [shutdownFailure, setShutdownFailure] = useState("");
  const shutdownButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (stopping) return;
    const controller = new AbortController();
    const { signal } = controller;
    const refresh = async () => {
      try {
        const state = await json<Operations>("/operations", { signal });
        if (!signal.aborted) {
          setOperations(state);
          if (state.phase === "stopping") setStopping(true);
        }
      } catch (failure) {
        if (signal.aborted) return;
        if (failure instanceof RequestError && failure.status === 401) onLock();
        else setOperations(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [onLock, setStopping, stopping]);

  async function shutdown() {
    setRequestingShutdown(true);
    setShutdownFailure("");
    try {
      const response = await request(
        "/operations/shutdown",
        post({ confirmed: true }),
      );
      if (response.status !== 202)
        throw new Error("Shutdown was not accepted.");
      setStopping(true);
    } catch (failure) {
      if (failure instanceof RequestError && failure.status === 401) onLock();
      else
        setShutdownFailure(
          "Não foi possível confirmar o encerramento do servidor.",
        );
    } finally {
      setRequestingShutdown(false);
    }
  }

  const phaseLabel = stopping
    ? "Encerramento do servidor em andamento."
    : operations
      ? "Servidor local pronto."
      : operations === undefined
        ? "Consultando o estado das conexões."
        : "Estado das conexões temporariamente indisponível.";

  return (
    <section className="learning-block">
      <h2>Estado da automação local</h2>
      <p role="status">{phaseLabel}</p>
      {operations && !stopping && (
        <>
          <ul>
            <li>
              Programação ·{" "}
              {connectionLabels[operations.connections.programming]}
            </li>
            <li>
              Redação assistida ·{" "}
              {connectionLabels[operations.connections.editorial]}
            </li>
            <li>
              Instagram · {connectionLabels[operations.connections.instagram]}
            </li>
          </ul>
          <Button
            ref={shutdownButton}
            variant="outline"
            aria-expanded={confirmShutdown}
            disabled={requestingShutdown}
            onClick={() => {
              setConfirmShutdown(!confirmShutdown);
              setShutdownFailure("");
            }}
          >
            Encerrar servidor
          </Button>
          {confirmShutdown && (
            <>
              <p id="server-shutdown-description">
                As tarefas recuperáveis podem continuar quando você iniciar o
                servidor novamente.
              </p>
              <div className="business-actions">
                <Button
                  variant="destructive"
                  aria-describedby="server-shutdown-description"
                  disabled={requestingShutdown}
                  onClick={() => void shutdown()}
                >
                  Confirmar encerramento
                </Button>
                <Button
                  variant="outline"
                  disabled={requestingShutdown}
                  onClick={() => {
                    setConfirmShutdown(false);
                    setShutdownFailure("");
                    shutdownButton.current?.focus();
                  }}
                >
                  Voltar
                </Button>
              </div>
              {shutdownFailure && <p role="alert">{shutdownFailure}</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}

function BotRunForm({
  bot,
  busy,
  run,
  onCreated,
}: {
  bot: Bot;
  busy: boolean;
  run: Action;
  onCreated: (id: string) => void;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [bookId, setBookId] = useState("");
  const [chapters, setChapters] = useState<{ title: string }[]>([]);
  const [mode, setMode] = useState("export");
  const [activeSkill, setActiveSkill] = useState(false);
  const previousRequest = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    if (bot.template !== "ebook") return;
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.all([
      json<{ books: Book[] }>(bookPath, { signal }),
      json<{ skills: Skill[] }>(
        `/bot-learning/skills?botId=${encodeURIComponent(bot.id)}`,
        { signal },
      ),
    ])
      .then(([list, rules]) => {
        if (signal.aborted) return;
        setBooks(list.books);
        setActiveSkill(rules.skills.some(({ status }) => status === "active"));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [bot.id, bot.template]);

  useEffect(() => {
    if (!bookId || mode !== "draft") return;
    const controller = new AbortController();
    void json<{ book: { chapters: { title: string }[] } }>(
      `${bookPath}/${encodeURIComponent(bookId)}`,
      { signal: controller.signal },
    )
      .then(({ book }) => {
        if (!controller.signal.aborted) setChapters(book.chapters);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [bookId, mode]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      let payload: object = { botId: bot.id };
      if (bot.template === "ebook") {
        const book = books.find(({ id }) => id === bookId);
        if (!book)
          throw new Error("Salve um ebook no Estúdio e selecione-o aqui.");
        payload = {
          ...payload,
          bookId,
          revision: book.revision,
          mode,
          includeKit: data.has("kit"),
          ...(mode === "draft" && {
            chapterIndex: Number(value(data, "chapter")),
            brief: value(data, "brief"),
            practicalExample: value(data, "practicalExample"),
          }),
        };
      }
      if (bot.template === "programming") {
        payload = {
          ...payload,
          repoPath: value(data, "repo"),
          prompt: value(data, "prompt"),
          paths: filePaths(data, "paths"),
          testPaths: filePaths(data, "testPaths"),
          testConfirmed: data.has("confirmation"),
        };
      }
      const body = JSON.stringify({ workflow: bot.template, input: payload });
      if (previousRequest.current?.body !== body)
        previousRequest.current = { body, key: crypto.randomUUID() };
      const { job } = await json<{ job: Job }>(base, {
        method: "POST",
        headers: { "Idempotency-Key": previousRequest.current.key },
        body,
      });
      previousRequest.current = null;
      onCreated(job.id);
    });
  }

  return (
    <form
      className="learning-block profile-form business-form"
      onSubmit={submit}
    >
      <h2>Executar {bot.name}</h2>
      <fieldset disabled={busy} className="business-form">
        {bot.template === "ebook" && (
          <>
            <label>
              Ebook salvo
              <select
                required
                value={bookId}
                onChange={(event) => {
                  setChapters([]);
                  setBookId(event.target.value);
                }}
              >
                <option value="">Selecione um ebook do Estúdio</option>
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.title} · v{book.revision}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Operação
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="export">Exportar ebook e amostra</option>
                <option value="draft">Gerar rascunho de capítulo</option>
              </select>
            </label>
            {mode === "export" && (
              <label className="pilot-check">
                <input name="kit" type="checkbox" />
                Incluir o kit da campanha do mesmo ebook
              </label>
            )}
            {mode === "draft" && (
              <>
                <label>
                  Capítulo
                  <select name="chapter" required>
                    <option value="">Selecione o capítulo</option>
                    {chapters.map(({ title }, index) => {
                      const chapter = String(index);
                      return (
                        <option key={`${title}:${chapter}`} value={chapter}>
                          {title}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <label>
                  Orientação
                  <textarea
                    name="brief"
                    rows={3}
                    required
                    maxLength={2600}
                    defaultValue={bot.request}
                  />
                </label>
                <label>
                  Exemplo prático para a abertura
                  <textarea
                    name="practicalExample"
                    rows={2}
                    required={activeSkill}
                    maxLength={500}
                  />
                </label>
                <p>
                  O rascunho recebe o contexto indicado e as referências do
                  ebook. A geração usa o OpenCode Console configurado.
                </p>
              </>
            )}
          </>
        )}
        {bot.template === "programming" && (
          <>
            <label htmlFor="bot-run-repo">
              Pasta do repositório
              <Input id="bot-run-repo" name="repo" maxLength={1024} required />
            </label>
            <label>
              Tarefa
              <textarea
                name="prompt"
                rows={3}
                maxLength={4000}
                required
                defaultValue={bot.request}
              />
            </label>
            <label>
              Arquivos de código, um por linha
              <textarea name="paths" rows={3} maxLength={3072} required />
            </label>
            <label>
              Testes Bun opcionais, um por linha
              <textarea name="testPaths" rows={2} maxLength={2560} />
            </label>
            <label className="pilot-check">
              <input name="confirmation" type="checkbox" />
              Aprovo a execução isolada dos testes selecionados
            </label>
            <p>
              O OpenCode recebe a tarefa e o conteúdo Git dos arquivos
              selecionados.
            </p>
          </>
        )}
        {bot.template === "sales" && (
          <p>
            O bot usa as compras, os cliques e os reembolsos importados na
            campanha local.
          </p>
        )}
        <Button type="submit" disabled={bot.template === "ebook" && !bookId}>
          Iniciar execução
        </Button>
      </fieldset>
    </form>
  );
}

function FeedbackForm({
  job,
  run,
  onSaved,
  busy,
}: {
  job: Job;
  run: Action;
  onSaved: (proposal: boolean) => void;
  busy: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      const { proposal } = await json<{ proposal: Skill | null }>(
        "/bot-learning/feedback",
        post({
          botId: job.input.botId,
          botVersion: job.input.botVersion,
          runId: job.id,
          before: value(data, "before"),
          after: value(data, "after"),
          example: value(data, "example"),
        }),
      );
      form.reset();
      onSaved(Boolean(proposal));
    });
  }
  return (
    <details className="business-confirm" key={job.id}>
      <summary>Ensinar a partir desta execução</summary>
      <form className="profile-form business-form" onSubmit={submit}>
        <label>
          Trecho original
          <textarea name="before" rows={2} maxLength={5000} required />
        </label>
        <label>
          Sua correção
          <textarea name="after" rows={2} maxLength={5000} required />
        </label>
        {job.workflow === "ebook" && (
          <label>
            Exemplo novo usado na abertura
            <textarea name="example" rows={2} maxLength={500} />
          </label>
        )}
        <Button type="submit" disabled={busy}>
          Registrar correção
        </Button>
      </form>
    </details>
  );
}

export function BotsPanel({ onLock }: { onLock: () => void }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [activeBots, setActiveBots] = useState<Bot[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedBot, setSelectedBot] = useState("");
  const [selectedRun, setSelectedRun] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [proposals, setProposals] = useState<Skill[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [working, setWorking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const busy = working || stopping;

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

  const load = useCallback(async (signal?: AbortSignal) => {
    const [registry, runs] = await Promise.all([
      json<{ bots: Bot[]; active: Bot[] }>("/bots", { signal }),
      json<{ jobs: Job[] }>(base, { signal }),
    ]);
    if (signal?.aborted) return;
    setBots(registry.bots);
    setActiveBots(registry.active);
    setJobs(runs.jobs);
  }, []);

  useEffect(() => {
    if (stopping) return;
    const controller = new AbortController();
    const refresh = () =>
      void load(controller.signal).catch((failure) => {
        if (!controller.signal.aborted) fail(failure);
      });
    refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [fail, load, stopping]);

  const learning = useCallback(
    async (signal?: AbortSignal) => {
      if (!selectedBot) return;
      const query = `?botId=${encodeURIComponent(selectedBot)}`;
      const [candidates, rules] = await Promise.all([
        json<{ proposals: Skill[] }>(`/bot-learning/proposals${query}`, {
          signal,
        }),
        json<{ skills: Skill[] }>(`/bot-learning/skills${query}`, { signal }),
      ]);
      if (!signal?.aborted) {
        setProposals(candidates.proposals);
        setSkills(rules.skills);
      }
    },
    [selectedBot],
  );

  useEffect(() => {
    if (stopping) return;
    setProposals([]);
    setSkills([]);
    const controller = new AbortController();
    void learning(controller.signal).catch((failure) => {
      if (!controller.signal.aborted) fail(failure);
    });
    return () => controller.abort();
  }, [fail, learning, stopping]);

  useEffect(() => {
    if (stopping) return;
    setArtifacts([]);
    setEvents([]);
    if (!selectedRun) return;
    const controller = new AbortController();
    const path = `${base}/${encodeURIComponent(selectedRun)}`;
    const refresh = async () => {
      try {
        const [downloads, audit] = await Promise.all([
          json<{ artifacts: Artifact[] }>(`${path}/artifacts`, {
            signal: controller.signal,
          }),
          json<{ events: Event[] }>(`${path}/events?limit=30`, {
            signal: controller.signal,
          }),
        ]);
        if (!controller.signal.aborted) {
          setArtifacts(downloads.artifacts);
          setEvents(audit.events);
        }
      } catch (failure) {
        if (!controller.signal.aborted) fail(failure);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [fail, selectedRun, stopping]);

  async function run(work: () => Promise<void>) {
    if (stopping) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await work();
      await load();
    } catch (failure) {
      fail(failure);
    } finally {
      setWorking(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      const name = value(data, "name");
      const template = value(data, "template");
      const { bot } = await json<{ bot: Bot }>(
        "/bots",
        post({
          request: value(data, "description"),
          ...(name && { name }),
          ...(template && { template }),
        }),
      );
      setSelectedBot(bot.id);
      form.reset();
    });
  }

  const chosen = bots.find(({ id }) => id === selectedBot);
  const active = activeBots.find(({ id }) => id === selectedBot);
  const job = jobs.find(({ id }) => id === selectedRun);

  return (
    <div className="learning-page">
      <div className="learning-content">
        <header className="learning-heading">
          <h1>Bots</h1>
        </header>
        <OperationsSummary
          onLock={onLock}
          stopping={stopping}
          setStopping={setStopping}
        />
        {error && !stopping && (
          <p role="alert" className="learning-block">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="learning-block">
            {message}
          </p>
        )}
        <form
          className="learning-block profile-form business-form"
          onSubmit={create}
        >
          <h2>Criar bot</h2>
          <fieldset className="business-form" disabled={busy}>
            <label htmlFor="bot-name">
              Nome opcional
              <Input id="bot-name" name="name" maxLength={80} />
            </label>
            <label>
              Qual trabalho ele deve fazer?
              <textarea name="description" maxLength={2000} required rows={3} />
            </label>
            <label>
              Modelo
              <select name="template" defaultValue="">
                <option value="">Escolher pela descrição</option>
                {Object.entries(templates).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit">Criar rascunho</Button>
          </fieldset>
        </form>
        {bots.length > 0 && (
          <section className="learning-block">
            <h2>Bots salvos</h2>
            <label>
              Selecionar bot
              <select
                value={selectedBot}
                disabled={stopping}
                onChange={(event) => setSelectedBot(event.target.value)}
              >
                <option value="">Escolha um bot</option>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name} · {botStatuses[bot.status]} · v{bot.version}
                  </option>
                ))}
              </select>
            </label>
            {chosen && (
              <>
                <p>
                  {templates[chosen.template]} · {chosen.request}
                </p>
                {chosen.simulation && (
                  <p role="status">
                    Simulação{" "}
                    {chosen.simulation.passed ? "aprovada" : "com falhas"} ·{" "}
                    {
                      chosen.simulation.checks.filter(({ passed }) => passed)
                        .length
                    }
                    /{chosen.simulation.checks.length} verificações
                  </p>
                )}
                <div className="business-actions">
                  {(["simulate", "activate"] as const).map((action) => {
                    if (
                      (action === "simulate" && chosen.status !== "draft") ||
                      (action === "activate" && chosen.status !== "simulated")
                    )
                      return null;
                    return (
                      <Button
                        key={action}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await json(
                              `/bots/${chosen.id}/${action}`,
                              post({ version: chosen.version }),
                            );
                          })
                        }
                      >
                        {action === "simulate" ? "Simular" : "Ativar versão"}
                      </Button>
                    );
                  })}
                  {chosen.status === "active" && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await json(
                            `/bots/${chosen.id}/revise`,
                            post({ version: chosen.version }),
                          );
                          setMessage("Rascunho de revisão criado.");
                        })
                      }
                    >
                      Criar revisão
                    </Button>
                  )}
                </div>
                {active && <p>Versão em uso · v{active.version}</p>}
              </>
            )}
          </section>
        )}
        {active && (
          <BotRunForm
            key={`${active.id}:${active.version}:${skills.find(({ status }) => status === "active")?.version ?? 0}`}
            bot={active}
            busy={busy}
            run={run}
            onCreated={setSelectedRun}
          />
        )}
        {jobs.length > 0 && (
          <section className="learning-block">
            <h2>Fila e histórico</h2>
            {jobs.map((job) => (
              <Button
                key={job.id}
                variant="outline"
                aria-pressed={selectedRun === job.id}
                disabled={stopping}
                onClick={() => setSelectedRun(job.id)}
              >
                {job.input.botName} · {statusText[job.status]} ·{" "}
                {new Date(job.createdAt).toLocaleString("pt-BR")}
              </Button>
            ))}
          </section>
        )}
        {job && (
          <section className="learning-block">
            <h2>
              {job.input.botName} · {statusText[job.status]}
            </h2>
            <p>{botScopes[job.workflow]}</p>
            {job.currentStage && (
              <p>
                Etapa atual · {stages[job.currentStage] ?? job.currentStage}
                {job.attempt > 0 && ` · tentativa ${job.attempt}`}
              </p>
            )}
            {job.status === "retry_wait" && job.nextAttemptAt && (
              <p>
                Próxima tentativa em{" "}
                <time dateTime={job.nextAttemptAt}>
                  {new Date(job.nextAttemptAt).toLocaleString("pt-BR")}
                </time>
                .
              </p>
            )}
            {job.control && (
              <p>
                {job.control === "pause" ? "Pausa" : "Cancelamento"} após o
                checkpoint atual.
              </p>
            )}
            {job.error && <p>{localErrorMessage(job.error)}</p>}
            {typeof job.outputs.sales?.recommendation === "string" && (
              <p>{job.outputs.sales.recommendation}</p>
            )}
            <div className="business-actions">
              {(["pause", "resume", "cancel", "resolve"] as const).map(
                (action) => {
                  const allowed =
                    action === "pause"
                      ? ["queued", "running", "retry_wait"]
                      : action === "resume"
                        ? ["paused"]
                        : action === "cancel"
                          ? ["queued", "running", "retry_wait", "paused"]
                          : ["review"];
                  if (!allowed.includes(job.status)) return null;
                  const labels = {
                    pause: "Pausar",
                    resume: "Retomar",
                    cancel: "Cancelar execução",
                    resolve: "Encerrar revisão como falha",
                  };
                  return (
                    <Button
                      key={action}
                      disabled={busy}
                      variant="outline"
                      onClick={() =>
                        void run(async () => {
                          await json(
                            `${base}/${job.id}/${action}`,
                            post(
                              action === "resolve"
                                ? { resolution: "failed" }
                                : {},
                            ),
                          );
                        })
                      }
                    >
                      {labels[action]}
                    </Button>
                  );
                },
              )}
            </div>
            {artifacts.map((artifact) => (
              <Button
                key={artifact.kind}
                variant="outline"
                disabled={stopping}
                onClick={() =>
                  void run(async () =>
                    downloadResponse(
                      await request(
                        `${base}/${job.id}/artifacts/${artifact.kind}`,
                      ),
                      artifact.filename,
                    ),
                  )
                }
              >
                Baixar {artifact.filename}
              </Button>
            ))}
            {job.status === "completed" && (
              <FeedbackForm
                key={job.id}
                job={job}
                run={run}
                busy={busy}
                onSaved={(proposal) => {
                  setSelectedBot(job.input.botId);
                  setMessage(
                    proposal
                      ? "Proposta de aprendizado criada."
                      : "Correção registrada.",
                  );
                  if (selectedBot === job.input.botId)
                    void learning().catch(fail);
                }}
              />
            )}
            <details>
              <summary>Registro de execução</summary>
              <ul>
                {events.map((event) => (
                  <li key={event.id}>
                    {new Date(event.at).toLocaleString("pt-BR")} ·{" "}
                    {eventNames[event.type] ?? event.type}
                    {event.stage && ` · ${stages[event.stage] ?? event.stage}`}
                    {event.detail && ` · ${localErrorMessage(event.detail)}`}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        )}
        {chosen && (proposals.length > 0 || skills.length > 0) && (
          <section className="learning-block">
            <h2>Aprendizado de {chosen.name}</h2>
            {[...proposals, ...skills].map((skill) => (
              <article className="business-confirm" key={skill.id}>
                <strong>
                  Abrir o capítulo com um exemplo prático · v{skill.version} ·{" "}
                  {
                    {
                      proposed: "Em revisão",
                      rejected: "Rejeitada",
                      active: "Ativa",
                      retired: "Arquivada",
                    }[skill.status]
                  }
                </strong>
                <p>
                  Versão atual {skill.comparison.baseline.passed}/
                  {skill.comparison.baseline.total} · proposta{" "}
                  {skill.comparison.candidate.passed}/
                  {skill.comparison.candidate.total} ·{" "}
                  {skill.comparison.heldOut} exemplo reservado ·{" "}
                  {skill.comparison.regressions} regressões
                </p>
                <div className="business-actions">
                  {skill.status === "proposed" &&
                    (["approve", "reject"] as const).map((decision) => (
                      <Button
                        key={decision}
                        disabled={busy}
                        variant={decision === "approve" ? "default" : "outline"}
                        onClick={() =>
                          void run(async () => {
                            await json(
                              `/bot-learning/proposals/${skill.id}/${decision}`,
                              post({ version: skill.version }),
                            );
                            await learning();
                          })
                        }
                      >
                        {decision === "approve"
                          ? "Aprovar skill"
                          : "Rejeitar proposta"}
                      </Button>
                    ))}
                  {["active", "retired"].includes(skill.status) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await json(
                            `/bot-learning/skills/${chosen.id}/rollback`,
                            post({
                              version:
                                skill.status === "active"
                                  ? null
                                  : skill.version,
                            }),
                          );
                          await learning();
                        })
                      }
                    >
                      {skill.status === "active"
                        ? "Voltar à configuração inicial"
                        : "Restaurar esta versão"}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
