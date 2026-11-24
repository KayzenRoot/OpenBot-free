import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { json, post, RequestError, request } from "./api";

type Memory = { id: string; text: string };
type Routine = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  timezone: string;
  intervalMinutes: number;
  nextRunAt: string | null;
};
type Run = {
  id: string;
  status: keyof typeof runStatus;
  scheduledAt: string;
  answer: string | null;
  error: string | null;
};
type RoutinePage = { runs: Run[]; nextCursor: string | null };

const runStatus = {
  running: "Em execução",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
  interrupted: "Interrompida",
};

function patch(body: object): RequestInit {
  return { ...post(body), method: "PATCH" };
}

function failureMessage(failure: unknown, onLock: () => void) {
  if (failure instanceof RequestError && failure.status === 401) onLock();
  return failure instanceof Error
    ? failure.message
    : "Não foi possível salvar a alteração.";
}

function formatTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

export function MemoryPanel({ onLock }: { onLock: () => void }) {
  const [page, setPage] = useState<{
    memories: Memory[];
    nextOffset: number | null;
  }>({ memories: [], nextOffset: null });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: writes invalidate the current search page.
  useEffect(() => {
    const controller = new AbortController();
    void json<typeof page>(`/memory?limit=50&q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failureMessage(failure, onLock));
      });
    return () => controller.abort();
  }, [query, refresh, onLock]);

  async function change(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError(failureMessage(failure, onLock));
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    void change(async () => {
      if (editing)
        await json(`/memory/${encodeURIComponent(editing)}`, patch({ text }));
      else await json("/memory", post({ text }));
      setDraft("");
      setEditing(undefined);
      setRefresh((value) => value + 1);
    });
  }

  return (
    <div className="learning-page">
      <div className="learning-content">
        <header className="learning-heading">
          <h1>Memórias</h1>
          <p>
            Notas relevantes podem ser incluídas no contexto do modelo ao
            responder.
          </p>
        </header>
        {error && (
          <p className="local-error" role="alert">
            {error}
          </p>
        )}
        <form className="learning-block profile-form" onSubmit={save}>
          <label htmlFor="memory-text">
            {editing ? "Editar memória" : "Nova memória"}
          </label>
          <textarea
            id="memory-text"
            maxLength={2000}
            rows={4}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            required
          />
          <div className="learning-actions">
            <Button type="submit" disabled={busy || !draft.trim()}>
              Salvar memória
            </Button>
            {editing && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(undefined);
                  setDraft("");
                }}
              >
                Cancelar edição
              </Button>
            )}
          </div>
        </form>
        <section className="learning-block">
          <h2>Memórias salvas</h2>
          <form
            className="learning-actions"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) {
                setError("");
                setQuery(search.trim());
              }
            }}
          >
            <Input
              aria-label="Buscar memórias"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
            <Button type="submit" variant="secondary" disabled={busy}>
              Buscar
            </Button>
          </form>
          {!page.memories.length && <p>Nenhuma memória encontrada.</p>}
          {page.memories.map((item) => (
            <article key={item.id} className="learning-review">
              <p className="profile-text">{item.text}</p>
              <div className="learning-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditing(item.id);
                    setDraft(item.text);
                    document.getElementById("memory-text")?.focus();
                  }}
                >
                  Editar
                </Button>
                {removing === item.id ? (
                  <>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void change(async () => {
                          await request(
                            `/memory/${encodeURIComponent(item.id)}`,
                            { method: "DELETE" },
                          );
                          if (editing === item.id) {
                            setEditing(undefined);
                            setDraft("");
                          }
                          setRemoving(undefined);
                          setRefresh((value) => value + 1);
                        })
                      }
                    >
                      Confirmar exclusão
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRemoving(undefined)}
                    >
                      Cancelar
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRemoving(item.id)}
                  >
                    Excluir
                  </Button>
                )}
              </div>
            </article>
          ))}
          {page.nextOffset !== null && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void change(async () => {
                  const next = await json<typeof page>(
                    `/memory?limit=50&q=${encodeURIComponent(query)}&offset=${page.nextOffset}`,
                  );
                  setPage((before) => ({
                    memories: [...before.memories, ...next.memories],
                    nextOffset: next.nextOffset,
                  }));
                })
              }
            >
              Carregar mais
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}

export function RoutinesPanel({ onLock }: { onLock: () => void }) {
  const [items, setItems] = useState<Routine[]>([]);
  const [editing, setEditing] = useState<Routine>();
  const [removing, setRemoving] = useState<string>();
  const [history, setHistory] = useState<{
    routine: Routine;
    page: RoutinePage;
  }>();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: writes invalidate the routine list.
  useEffect(() => {
    const controller = new AbortController();
    void json<{ routines: Routine[] }>("/routines", {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setItems(result.routines);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failureMessage(failure, onLock));
      });
    return () => controller.abort();
  }, [refresh, onLock]);

  async function change(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError(failureMessage(failure, onLock));
    } finally {
      setBusy(false);
    }
  }

  function clearEditor() {
    setEditing(undefined);
    setTitle("");
    setPrompt("");
    setMinutes("60");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void change(async () => {
      const values = {
        title: title.trim(),
        prompt: prompt.trim(),
        intervalMinutes: Number(minutes),
      };
      if (editing)
        await json(
          `/routines/${encodeURIComponent(editing.id)}`,
          patch(values),
        );
      else
        await json(
          "/routines",
          post({
            ...values,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            enabled: false,
          }),
        );
      clearEditor();
      setRefresh((value) => value + 1);
    });
  }

  function readHistory(routine: Routine, cursor?: string) {
    void change(async () => {
      const path = `/routines/${encodeURIComponent(routine.id)}/runs`;
      const page = await json<RoutinePage>(
        cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
      );
      setHistory((before) => ({
        routine,
        page:
          cursor && before?.routine.id === routine.id
            ? { ...page, runs: [...before.page.runs, ...page.runs] }
            : page,
      }));
    });
  }

  return (
    <div className="learning-page">
      <div className="learning-content">
        <header className="learning-heading">
          <h1>Rotinas</h1>
          <p>
            Executam enquanto o OpenBot está aberto. Com OpenCode Go, use
            rotinas de programação.
          </p>
        </header>
        {error && (
          <p className="local-error" role="alert">
            {error}
          </p>
        )}
        <form className="learning-block profile-form" onSubmit={save}>
          <h2>{editing ? "Editar rotina" : "Nova rotina"}</h2>
          <label htmlFor="routine-title">Nome</label>
          <Input
            id="routine-title"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            required
            maxLength={120}
          />
          <label htmlFor="routine-prompt">Instruções</label>
          <textarea
            id="routine-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            rows={3}
            required
            maxLength={16000}
          />
          <label htmlFor="routine-minutes">Intervalo em minutos</label>
          <Input
            type="number"
            id="routine-minutes"
            min={15}
            max={525600}
            step={1}
            value={minutes}
            onChange={(event) => setMinutes(event.currentTarget.value)}
            required
          />
          <div className="learning-actions">
            <Button type="submit" disabled={busy}>
              Salvar rotina
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={clearEditor}>
                Cancelar edição
              </Button>
            )}
          </div>
        </form>
        <section className="learning-block">
          <h2>Rotinas salvas</h2>
          {!items.length && <p>Nenhuma rotina cadastrada.</p>}
          {items.map((item) => (
            <article key={item.id} className="learning-review">
              <h3>{item.title}</h3>
              <p>
                {item.nextRunAt
                  ? `Próxima execução: ${formatTime(item.nextRunAt, item.timezone)}`
                  : "Desativada"}{" "}
                · {item.intervalMinutes} min
              </p>
              <div className="learning-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void change(async () => {
                      await json(
                        `/routines/${encodeURIComponent(item.id)}`,
                        patch({ enabled: !item.enabled }),
                      );
                      setRefresh((value) => value + 1);
                    })
                  }
                >
                  {item.enabled ? "Desativar" : "Ativar"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditing(item);
                    setTitle(item.title);
                    setPrompt(item.prompt);
                    setMinutes(String(item.intervalMinutes));
                    document.getElementById("routine-title")?.focus();
                  }}
                >
                  Editar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => readHistory(item)}
                >
                  Histórico
                </Button>
                {removing === item.id ? (
                  <>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void change(async () => {
                          await request(
                            `/routines/${encodeURIComponent(item.id)}`,
                            { method: "DELETE" },
                          );
                          if (editing?.id === item.id) clearEditor();
                          if (history?.routine.id === item.id)
                            setHistory(undefined);
                          setRemoving(undefined);
                          setRefresh((value) => value + 1);
                        })
                      }
                    >
                      Confirmar exclusão
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRemoving(undefined)}
                    >
                      Cancelar
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRemoving(item.id)}
                  >
                    Excluir
                  </Button>
                )}
              </div>
            </article>
          ))}
        </section>
        {history && (
          <section className="learning-block">
            <h2>Histórico de {history.routine.title}</h2>
            {!history.page.runs.length && <p>Nenhuma execução registrada.</p>}
            {history.page.runs.map((run) => (
              <article key={run.id} className="learning-review">
                <h3>
                  {runStatus[run.status]} ·{" "}
                  {formatTime(run.scheduledAt, history.routine.timezone)}
                </h3>
                {run.answer && <p className="profile-text">{run.answer}</p>}
                {run.error && (
                  <p className="local-error">A execução encontrou um erro.</p>
                )}
              </article>
            ))}
            {history.page.nextCursor && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  readHistory(
                    history.routine,
                    history.page.nextCursor ?? undefined,
                  )
                }
              >
                Carregar mais
              </Button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
