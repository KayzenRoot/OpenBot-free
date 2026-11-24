import {
  IconFileUpload,
  IconPointFilled,
  IconSparkles,
  IconSquare,
} from "@tabler/icons-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { json, post, RequestError } from "./api";
import "./learning.css";

type Evidence = {
  id: string;
  source: "manual" | "recording";
  text: string;
};

type Proposal = {
  id: string;
  evidenceIds: string[];
  slug: string;
  title: string;
  markdown: string;
  revision: number;
  status: "pending" | "published" | "rejected";
};

type Skill = {
  slug: string;
  title: string;
  markdown: string;
  revision: number;
};

type LiveRecording = {
  id: string;
  active: boolean;
  events: number;
  dropped: number;
};

type LearningData = {
  evidence: Evidence[];
  proposals: Proposal[];
  skills: Skill[];
};

type Page<K extends keyof LearningData> = Pick<LearningData, K> & {
  nextOffset: number | null;
};

const reviewStatus: Record<Proposal["status"], string> = {
  pending: "Em revisão",
  published: "Publicada",
  rejected: "Rejeitada",
};
const maximumEvidence = 8;
const initialData: LearningData = { evidence: [], proposals: [], skills: [] };

export function Learning({ onLock }: { onLock: () => void }) {
  const [data, setData] = useState(initialData);
  const [offsets, setOffsets] = useState<
    Record<keyof LearningData, number | null>
  >({
    evidence: null,
    proposals: null,
    skills: null,
  });
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [recording, setRecording] = useState<File>();
  const [live, setLive] = useState<LiveRecording | null>();
  const [selected, setSelected] = useState<string[]>([]);
  const [proposal, setProposal] = useState<Proposal>();
  const [editDraft, setEditDraft] = useState<{
    title: string;
    markdown: string;
  }>();
  const [busy, setBusy] = useState("");
  const recordingInput = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const keys = useRef(new Map<string, { body: string; key: string }>());
  const recordingVersion = useRef(0);

  const handleFailure = useCallback(
    (failure: unknown) => {
      if (failure instanceof RequestError && failure.status === 401) onLock();
      setError(
        failure instanceof Error
          ? failure.message
          : "Não foi possível concluir essa operação de aprendizado.",
      );
    },
    [onLock],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError("");
      try {
        const [evidence, proposals, skills] = await Promise.all([
          json<Page<"evidence">>("/learning/evidence", { signal }),
          json<Page<"proposals">>("/learning/proposals", { signal }),
          json<Page<"skills">>("/learning/skills", { signal }),
        ]);
        if (signal?.aborted) return;
        setData({
          evidence: evidence.evidence,
          proposals: proposals.proposals,
          skills: skills.skills,
        });
        setOffsets({
          evidence: evidence.nextOffset,
          proposals: proposals.nextOffset,
          skills: skills.nextOffset,
        });
        setLoaded(true);
      } catch (failure) {
        if (!signal?.aborted) handleFailure(failure);
      }
    },
    [handleFailure],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refreshRecording = useCallback(async (signal?: AbortSignal) => {
    const version = ++recordingVersion.current;
    try {
      const result = await json<{ recording: LiveRecording | null }>(
        "/learning/recording",
        { signal },
      );
      if (!signal?.aborted && recordingVersion.current === version)
        setLive(result.recording);
    } catch {
      // Recorder availability does not prevent JSON import.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshRecording(controller.signal);
    return () => controller.abort();
  }, [refreshRecording]);

  const recordingActive = live?.active === true;
  useEffect(() => {
    if (!recordingActive) return;
    const controller = new AbortController();
    const timer = window.setInterval(
      () => void refreshRecording(controller.signal),
      1500,
    );
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [recordingActive, refreshRecording]);

  async function perform(action: string, run: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      await run();
    } catch (failure) {
      handleFailure(failure);
    } finally {
      working.current = false;
      setBusy("");
    }
  }

  async function mutate<T>(path: string, value: object) {
    const init = post(value);
    const body = String(init.body);
    let current = keys.current.get(path);
    if (current?.body !== body) {
      current = { body, key: crypto.randomUUID() };
      keys.current.set(path, current);
    }
    const result = await json<T>(path, {
      ...init,
      headers: { "Idempotency-Key": current.key },
    });
    keys.current.delete(path);
    return result;
  }

  function noteAdded(evidence: Evidence) {
    setData((current) => ({
      ...current,
      evidence: [
        evidence,
        ...current.evidence.filter((item) => item.id !== evidence.id),
      ],
    }));
    setSelected((current) =>
      current.includes(evidence.id) || current.length >= maximumEvidence
        ? current
        : [...current, evidence.id],
    );
    setMessage("Evidência adicionada.");
  }

  async function beginRecording() {
    await perform("record-start", async () => {
      const result = await json<{ recording: LiveRecording }>(
        "/learning/recording/start",
        post({}),
      );
      recordingVersion.current += 1;
      setLive(result.recording);
    });
  }

  async function endRecording() {
    await perform("record-stop", async () => {
      try {
        const result = await mutate<{
          evidence: Evidence;
          proposal?: Proposal;
        }>("/learning/recording/stop", {});
        noteAdded(result.evidence);
        if (result.proposal) {
          showProposal(result.proposal);
          setMessage("Gravação salva e proposta pronta para revisão.");
        }
        recordingVersion.current += 1;
        setLive(null);
      } finally {
        await refreshRecording();
      }
    });
  }

  async function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!note.trim()) return;
    await perform("note", async () => {
      const result = await mutate<{ evidence: Evidence }>(
        "/learning/evidence",
        {
          source: "manual",
          text: note.trim(),
        },
      );
      noteAdded(result.evidence);
      setNote("");
    });
  }

  async function saveRecording(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recording) return;
    await perform("recording", async () => {
      if (recording.size > 128 * 1024) {
        throw new Error("O arquivo da gravação deve ter até 128 KB.");
      }
      const value: unknown = await recording.text().then((content) => {
        try {
          return JSON.parse(content);
        } catch {
          throw new Error("Selecione um arquivo de gravação em JSON válido.");
        }
      });
      if (!value || typeof value !== "object") {
        throw new Error(
          "O arquivo deve conter uma gravação estruturada em JSON.",
        );
      }
      const result = await mutate<{ evidence: Evidence }>(
        "/learning/recordings",
        value,
      );
      noteAdded(result.evidence);
      setRecording(undefined);
      if (recordingInput.current) recordingInput.current.value = "";
    });
  }

  function showProposal(updated: Proposal) {
    setEditDraft(undefined);
    setProposal(updated);
    setData((current) => ({
      ...current,
      proposals: [
        updated,
        ...current.proposals.filter((item) => item.id !== updated.id),
      ],
    }));
  }

  async function generate() {
    await perform("generate", async () => {
      const result = await mutate<{ proposal: Proposal }>(
        "/learning/proposals",
        {
          evidenceIds: [...selected].sort(),
        },
      );
      showProposal(result.proposal);
      setMessage("Proposta pronta para revisão.");
    });
  }

  async function inspect(id: string) {
    await perform("inspect", async () => {
      const result = await json<{ proposal: Proposal }>(
        `/learning/proposals/${encodeURIComponent(id)}`,
      );
      setEditDraft(undefined);
      setProposal(result.proposal);
    });
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!proposal || !editDraft) return;
    await perform("edit", async () => {
      const result = await json<{ proposal: Proposal }>(
        `/learning/proposals/${encodeURIComponent(proposal.id)}`,
        {
          ...post({
            ...editDraft,
            previousTitle: proposal.title,
            previousMarkdown: proposal.markdown,
          }),
          method: "PATCH",
        },
      );
      showProposal(result.proposal);
      setMessage("Alterações salvas.");
    });
  }

  async function review(action: "approve" | "reject") {
    if (!proposal) return;
    await perform(action, async () => {
      const result = await mutate<{ proposal: Proposal }>(
        `/learning/proposals/${encodeURIComponent(proposal.id)}/${action}`,
        {},
      );
      showProposal(result.proposal);
      setMessage(
        action === "approve" ? "Skill publicada." : "Proposta rejeitada.",
      );
      if (action === "approve") {
        const listing = await json<Page<"skills">>("/learning/skills");
        setData((current) => ({ ...current, skills: listing.skills }));
        setOffsets((current) => ({ ...current, skills: listing.nextOffset }));
      }
    });
  }

  async function loadMore<K extends keyof LearningData>(kind: K) {
    const offset = offsets[kind];
    if (offset == null) return;
    await perform("more", async () => {
      const page = await json<Page<K>>(`/learning/${kind}?offset=${offset}`);
      setData((current) => {
        const previous = current[kind];
        const itemKey = (item: Evidence | Proposal | Skill) =>
          "id" in item ? item.id : item.slug;
        const existing = new Set(previous.map(itemKey));
        return {
          ...current,
          [kind]: [
            ...previous,
            ...page[kind].filter((item) => !existing.has(itemKey(item))),
          ],
        };
      });
      setOffsets((current) => ({ ...current, [kind]: page.nextOffset }));
    });
  }

  return (
    <section className="learning-page" aria-labelledby="learning-title">
      <div className="learning-content">
        <header className="learning-heading">
          <h1 id="learning-title">Aprendizado</h1>
          <p>Crie e revise skills a partir de suas anotações e gravações.</p>
        </header>
        <div className="learning-feedback">
          {message && <p role="status">{message}</p>}
          {error && (
            <p role="alert" className="local-error">
              {error}
            </p>
          )}
        </div>
        {!loaded ? (
          error ? (
            <Button variant="outline" onClick={() => void load()}>
              Tentar novamente
            </Button>
          ) : (
            <p role="status">Carregando aprendizado…</p>
          )
        ) : (
          <>
            <section
              className="learning-block"
              aria-labelledby="learning-evidence"
            >
              <h2 id="learning-evidence">Evidências</h2>
              <div className="learning-evidence-forms">
                <form onSubmit={(event) => void saveNote(event)}>
                  <label htmlFor="learning-note">Anotação manual</label>
                  <textarea
                    id="learning-note"
                    maxLength={16000}
                    rows={4}
                    value={note}
                    onChange={(event) => setNote(event.currentTarget.value)}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!!busy || !note.trim()}
                  >
                    {busy === "note" ? "Salvando…" : "Salvar evidência"}
                  </Button>
                </form>
                <form onSubmit={(event) => void saveRecording(event)}>
                  <label htmlFor="learning-recording">Gravação em JSON</label>
                  <input
                    id="learning-recording"
                    ref={recordingInput}
                    type="file"
                    accept=".json,application/json"
                    onChange={(event) =>
                      setRecording(event.currentTarget.files?.[0])
                    }
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!!busy || !recording}
                  >
                    <IconFileUpload aria-hidden="true" />
                    {busy === "recording" ? "Importando…" : "Importar gravação"}
                  </Button>
                </form>
              </div>
              {live !== undefined && (
                <div className="learning-recorder">
                  {live ? (
                    <>
                      <p role="status">
                        {live.events}{" "}
                        {live.events === 1
                          ? "ação registrada"
                          : "ações registradas"}
                        {live.dropped > 0 && ` · ${live.dropped} ignoradas`}
                      </p>
                      <Button
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => void endRecording()}
                      >
                        <IconSquare aria-hidden="true" />
                        {busy === "record-stop"
                          ? "Salvando…"
                          : "Salvar gravação"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <p>O gravador abre uma janela de navegador separada.</p>
                      <Button
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => void beginRecording()}
                      >
                        <IconPointFilled aria-hidden="true" />
                        {busy === "record-start"
                          ? "Abrindo navegador…"
                          : "Gravar no navegador"}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {data.evidence.length > 0 && (
                <fieldset className="learning-selector">
                  <legend>Selecione até {maximumEvidence} evidências</legend>
                  {data.evidence.map((item) => (
                    <label key={item.id} className="learning-evidence-row">
                      <input
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        disabled={
                          !!busy ||
                          (selected.length >= maximumEvidence &&
                            !selected.includes(item.id))
                        }
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSelected((current) =>
                            checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id),
                          );
                        }}
                      />
                      <span>
                        {item.source === "recording" ? "Gravação" : "Anotação"}
                      </span>
                      <span>
                        {item.text.replace(/\s+/g, " ").slice(0, 150)}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="learning-actions">
                {offsets.evidence != null && (
                  <Button
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => void loadMore("evidence")}
                  >
                    Mais evidências
                  </Button>
                )}
                <Button
                  disabled={!!busy || !selected.length}
                  onClick={() => void generate()}
                >
                  <IconSparkles aria-hidden="true" />
                  {busy === "generate"
                    ? "Preparando proposta…"
                    : "Gerar proposta"}
                </Button>
              </div>
            </section>
            <section
              className="learning-block"
              aria-labelledby="learning-proposals"
            >
              <h2 id="learning-proposals">Propostas</h2>
              <p>
                O OpenBot prepara rascunhos locais de gravações a cada 30
                segundos enquanto estiver aberto. Revise cada rascunho antes de
                publicar a skill.
              </p>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void load()}
              >
                Atualizar propostas
              </Button>
              {!data.proposals.length && <p>Nenhuma proposta gerada.</p>}
              {data.proposals.map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  className="learning-proposal-row"
                  aria-pressed={proposal?.id === item.id}
                  disabled={!!busy}
                  onClick={() => void inspect(item.id)}
                >
                  <span>{item.title}</span>
                  <span>{reviewStatus[item.status]}</span>
                </Button>
              ))}
              {offsets.proposals != null && (
                <Button
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => void loadMore("proposals")}
                >
                  Mais propostas
                </Button>
              )}
              {proposal && (
                <article className="learning-review">
                  <div className="learning-review-title">
                    <h3>{proposal.title}</h3>
                    <span>{reviewStatus[proposal.status]}</span>
                  </div>
                  {editDraft ? (
                    <form
                      className="learning-block profile-form"
                      onSubmit={(event) => void saveEdit(event)}
                    >
                      <label htmlFor="proposal-title">Título da skill</label>
                      <input
                        id="proposal-title"
                        value={editDraft.title}
                        maxLength={160}
                        required
                        onChange={(event) =>
                          setEditDraft({
                            ...editDraft,
                            title: event.currentTarget.value,
                          })
                        }
                      />
                      <label htmlFor="proposal-markdown">
                        Conteúdo da skill
                      </label>
                      <textarea
                        id="proposal-markdown"
                        value={editDraft.markdown}
                        maxLength={20000}
                        rows={10}
                        required
                        onChange={(event) =>
                          setEditDraft({
                            ...editDraft,
                            markdown: event.currentTarget.value,
                          })
                        }
                      />
                      <div className="learning-actions">
                        <Button type="submit" disabled={!!busy}>
                          Salvar proposta
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() => setEditDraft(undefined)}
                        >
                          Cancelar edição
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <pre>{proposal.markdown}</pre>
                  )}
                  {proposal.status === "pending" && !editDraft && (
                    <div className="learning-actions">
                      <Button
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          setEditDraft({
                            title: proposal.title,
                            markdown: proposal.markdown.replace(
                              /^\s*---\r?\n[\s\S]*?\r?\n---\s*/,
                              "",
                            ),
                          })
                        }
                      >
                        Editar proposta
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => void review("reject")}
                      >
                        Rejeitar
                      </Button>
                      <Button
                        disabled={!!busy}
                        onClick={() => void review("approve")}
                      >
                        Aprovar e publicar
                      </Button>
                    </div>
                  )}
                </article>
              )}
            </section>
            <section
              className="learning-block"
              aria-labelledby="learning-skills"
            >
              <h2 id="learning-skills">Skills publicadas</h2>
              {!data.skills.length && <p>Nenhuma skill publicada.</p>}
              {data.skills.map((skill) => (
                <details key={skill.slug} className="learning-skill">
                  <summary>
                    {skill.title} <span>Versão {skill.revision}</span>
                  </summary>
                  <pre>{skill.markdown}</pre>
                </details>
              ))}
              {offsets.skills != null && (
                <Button
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => void loadMore("skills")}
                >
                  Mais skills
                </Button>
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
