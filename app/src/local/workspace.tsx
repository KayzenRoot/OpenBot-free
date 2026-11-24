import {
  IconArrowUp,
  IconBrain,
  IconBriefcase,
  IconBrowser,
  IconClock,
  IconCode,
  IconLayoutSidebar,
  IconMessageCircle,
  IconPencil,
  IconPlus,
  IconRobot,
  IconSparkles,
  IconSquare,
  IconTrash,
} from "@tabler/icons-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { DemoOrb } from "@/components/onboarding/demo-orb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type Conversation,
  type ConversationDetail,
  conversationPath,
  json,
  localErrorMessage,
  post,
  RequestError,
  readAnswer,
  request,
  type Turn,
} from "./api";
import { ComposerAttachments } from "./attachments";
import { BotsPanel } from "./bots-panel";
import { BrowserPanel } from "./browser-panel";
import { BusinessPanel } from "./business-panel";
import { Learning } from "./learning";
import { MemoryPanel, RoutinesPanel } from "./profile-tools";
import { ProjectPanel } from "./project-panel";

type VisibleRun = { conversationId: string; turn: Turn };
type ActiveRun = {
  conversationId: string;
  id: string;
  controller: AbortController;
};

const profilePanels = [
  { key: "bots", name: "Bots", icon: IconRobot },
  { key: "project", name: "Projeto", icon: IconCode },
  { key: "business", name: "Trabalho", icon: IconBriefcase },
  { key: "browser", name: "Navegador", icon: IconBrowser },
  { key: "learning", name: "Aprendizado", icon: IconSparkles },
  { key: "memory", name: "Memórias", icon: IconBrain },
  { key: "routines", name: "Rotinas", icon: IconClock },
] as const;

function withTurn(turns: Turn[], turn: Turn) {
  return turns.some((previous) => previous.id === turn.id)
    ? turns.map((previous) => (previous.id === turn.id ? turn : previous))
    : [...turns, turn];
}

function showConversationInUrl(id: string | null) {
  const url = new URL(window.location.href);
  url.hash = id ? new URLSearchParams({ conversation: id }).toString() : "";
  window.history.replaceState(null, "", url);
}

function TranscriptTurn({ turn }: { turn: Turn }) {
  const status =
    turn.status === "running"
      ? "Respondendo…"
      : turn.status === "cancelled" || turn.status === "canceled"
        ? "Resposta interrompida."
        : turn.status === "interrupted"
          ? "A geração foi interrompida."
          : null;

  return (
    <article className="transcript-turn">
      <div className="sent-message">
        <span className="sr-only">Você</span>
        {turn.prompt}
      </div>
      {(turn.answer || status || turn.error) && (
        <div className="received-message">
          <span className="bot-mark bot-mark-small" aria-hidden="true" />
          <div className="received-content">
            <span className="sr-only">OpenBot</span>
            {turn.answer && <div className="answer-text">{turn.answer}</div>}
            {status && (
              <p className="turn-status" role="status">
                {status}
              </p>
            )}
            {turn.error && (
              <p className="local-error" role="alert">
                {localErrorMessage(turn.error)}
              </p>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export function Workspace({ onLock }: { onLock: () => void }) {
  const [selected, setSelected] = useState(() =>
    new URLSearchParams(window.location.hash.slice(1)).get("conversation"),
  );
  const selectionRef = useRef(selected);
  const detailVersion = useRef(0);
  const active = useRef<ActiveRun | null>(null);
  const submitting = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadedList, setLoadedList] = useState(false);
  const [detail, setDetail] = useState<ConversationDetail>();
  const [detailError, setDetailError] = useState("");
  const [run, setRun] = useState<VisibleRun>();
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState<(typeof profilePanels)[number]["key"]>();
  const [conversationAction, setConversationAction] = useState<
    "rename" | "delete"
  >();
  const [nextTitle, setNextTitle] = useState("");
  const [changingConversation, setChangingConversation] = useState(false);

  const failureMessage = useCallback(
    (failure: unknown) => {
      if (failure instanceof RequestError && failure.status === 401) onLock();
      return failure instanceof Error
        ? failure.message
        : "Não foi possível concluir o pedido.";
    },
    [onLock],
  );

  const attachmentError = useCallback(
    (failure: unknown) => setNotice(failureMessage(failure)),
    [failureMessage],
  );

  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await json<{ conversations: Conversation[] }>(
          "/conversations",
          { signal },
        );
        if (!signal?.aborted) {
          setConversations(result.conversations);
          setLoadedList(true);
        }
      } catch (failure) {
        if (!signal?.aborted) setNotice(failureMessage(failure));
      }
    },
    [failureMessage],
  );

  const loadDetail = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const version = ++detailVersion.current;
      const applies = () =>
        !signal?.aborted &&
        version === detailVersion.current &&
        selectionRef.current === id;
      try {
        const value = await json<ConversationDetail>(conversationPath(id), {
          signal,
        });
        if (applies()) {
          setDetail(value);
          setDetailError("");
        }
        return value;
      } catch (failure) {
        if (applies()) setDetailError(failureMessage(failure));
        return undefined;
      }
    },
    [failureMessage],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => controller.abort();
  }, [loadList]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void loadDetail(selected, controller.signal);
    return () => controller.abort();
  }, [selected, loadDetail]);

  useEffect(() => () => active.current?.controller.abort(), []);

  const visibleRun = run?.conversationId === selected ? run : undefined;
  const recoveredTurn = detail?.turns.find((turn) => turn.status === "running");
  const runningTurn =
    visibleRun?.turn.status === "running" ? visibleRun.turn : recoveredTurn;
  useEffect(() => {
    if (!selected || visibleRun || !recoveredTurn) return;
    const controller = new AbortController();
    const timer = setInterval(
      () => void loadDetail(selected, controller.signal),
      1_500,
    );
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [selected, visibleRun, recoveredTurn, loadDetail]);

  useEffect(() => {
    if (
      (detail?.turns.length || visibleRun) &&
      followLatest.current &&
      transcript.current
    ) {
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }, [detail, visibleRun]);

  function choose(id: string | null) {
    setSidebar(false);
    setPanel(undefined);
    setConversationAction(undefined);
    if (selectionRef.current === id) return;
    selectionRef.current = id;
    followLatest.current = true;
    setSelected(id);
    setDetail(undefined);
    setDetailError("");
    setDraft("");
    setNotice("");
    showConversationInUrl(id);
  }

  async function createConversation() {
    const { conversation } = await json<{ conversation: Conversation }>(
      "/conversations",
      post({}),
    );
    setConversations((previous) => [conversation, ...previous]);
    return conversation.id;
  }

  async function conversationForUpload() {
    if (selectionRef.current) return selectionRef.current;
    if (submitting.current) throw new Error("Aguarde a criação da conversa.");
    submitting.current = true;
    setCreating(true);
    try {
      const id = await createConversation();
      choose(id);
      setDraft(draft);
      return id;
    } finally {
      submitting.current = false;
      setCreating(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || submitting.current || active.current || recoveredTurn)
      return;
    submitting.current = true;
    setCreating(!selectionRef.current);
    setNotice("");
    let conversationId = selectionRef.current;
    try {
      if (!conversationId) {
        conversationId = await createConversation();
        choose(conversationId);
      }
      setDraft("");
      followLatest.current = true;
      const id = crypto.randomUUID();
      const controller = new AbortController();
      active.current = { conversationId, id, controller };
      const turn = {
        id,
        prompt,
        answer: "",
        status: "running",
        error: null,
      } satisfies Turn;
      setRun({ conversationId, turn });
      let answer = "";
      let finalTurn: Turn;
      try {
        const response = await request(
          `${conversationPath(conversationId)}/turns`,
          {
            ...post({ id, prompt }),
            signal: controller.signal,
          },
        );
        await readAnswer(response, (text) => {
          answer += text;
          setRun((current) =>
            current?.turn.id === id
              ? { ...current, turn: { ...current.turn, answer } }
              : current,
          );
        });
        finalTurn = { ...turn, answer, status: "completed" };
      } catch (failure) {
        finalTurn = controller.signal.aborted
          ? { ...turn, answer, status: "cancelled" }
          : {
              ...turn,
              answer,
              status: "failed",
              error: failureMessage(failure),
            };
      }
      if (selectionRef.current === conversationId) {
        setDetail((current) =>
          current && current.conversation.id === conversationId
            ? { ...current, turns: withTurn(current.turns, finalTurn) }
            : current,
        );
        setRun({ conversationId, turn: finalTurn });
        const saved = await loadDetail(conversationId);
        if (
          finalTurn.error &&
          saved &&
          !saved.turns.some((stored) => stored.id === id)
        ) {
          setNotice(finalTurn.error);
          setDraft((current) => current || prompt);
        }
      }
      void loadList();
    } catch (failure) {
      setNotice(failureMessage(failure));
    } finally {
      submitting.current = false;
      active.current = null;
      setRun(undefined);
      setCreating(false);
    }
  }

  async function stop() {
    const pending = active.current;
    const conversationId = pending?.conversationId ?? selected;
    const turnId = pending?.id ?? recoveredTurn?.id;
    if (!conversationId || !turnId || stopping) return;
    setStopping(true);
    try {
      await request(
        `${conversationPath(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`,
        { method: "POST" },
      );
      pending?.controller.abort();
      if (!pending) await loadDetail(conversationId);
    } catch (failure) {
      setNotice(failureMessage(failure));
    } finally {
      setStopping(false);
    }
  }

  async function manageConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !conversationAction || changingConversation) return;
    const id = selected;
    setChangingConversation(true);
    try {
      if (conversationAction === "rename") {
        const result = await json<{ conversation: Conversation }>(
          conversationPath(id),
          {
            ...post({ title: nextTitle.trim() }),
            method: "PATCH",
          },
        );
        setDetail((current) =>
          current?.conversation.id === id
            ? { ...current, conversation: result.conversation }
            : current,
        );
      } else {
        await request(conversationPath(id), { method: "DELETE" });
        if (selectionRef.current === id) choose(null);
      }
      setConversationAction(undefined);
      await loadList();
    } catch (failure) {
      setNotice(failureMessage(failure));
    } finally {
      setChangingConversation(false);
    }
  }

  const savedTurns = detail?.turns ?? [];
  const turns = visibleRun ? withTurn(savedTurns, visibleRun.turn) : savedTurns;
  const title =
    detail?.conversation.title ??
    conversations.find((item) => item.id === selected)?.title;
  const ready = loadedList && (!selected || !!detail);
  const panelName = profilePanels.find(({ key }) => key === panel)?.name;

  return (
    <div className="local-frame" data-sidebar={sidebar ? "open" : "closed"}>
      <aside className="local-sidebar" aria-label="Workspace">
        <div className="workspace-name">
          <span className="bot-mark bot-mark-small" aria-hidden="true" />
          <strong>OpenBot</strong>
          <span className="workspace-label">Local</span>
        </div>
        <Button
          variant="ghost"
          className="new-conversation"
          onClick={() => choose(null)}
        >
          <IconPlus aria-hidden="true" />
          Nova conversa
        </Button>
        {profilePanels.map(({ key, icon: Icon, name }) => (
          <Button
            key={key}
            variant="ghost"
            className="conversation-item"
            aria-current={panel === key ? "page" : undefined}
            onClick={() => {
              setPanel(key);
              setSidebar(false);
            }}
          >
            <Icon aria-hidden="true" />
            {name}
          </Button>
        ))}
        <nav className="conversation-list" aria-label="Conversas">
          <h2>Conversas</h2>
          {loadedList ? (
            conversations.map((conversation) => (
              <Button
                key={conversation.id}
                variant="ghost"
                className="conversation-item"
                aria-current={
                  !panel && selected === conversation.id ? "page" : undefined
                }
                onClick={() => choose(conversation.id)}
              >
                <IconMessageCircle aria-hidden="true" />
                <span>{conversation.title}</span>
              </Button>
            ))
          ) : (
            <Button variant="ghost" size="sm" onClick={() => void loadList()}>
              Atualizar conversas
            </Button>
          )}
        </nav>
      </aside>

      <main
        className="local-panel"
        aria-label={panelName ?? title ?? "Conversa"}
      >
        <header className="local-toolbar">
          <Button
            variant="ghost"
            size="icon"
            className="sidebar-toggle"
            aria-label="Mostrar ou ocultar conversas"
            aria-expanded={sidebar}
            onClick={() => setSidebar((value) => !value)}
          >
            <IconLayoutSidebar aria-hidden="true" />
          </Button>
          {selected && !panel && conversationAction ? (
            <form
              className="local-conversation-edit"
              onSubmit={(event) => void manageConversation(event)}
            >
              {conversationAction === "rename" && (
                <Input
                  aria-label="Nome da conversa"
                  maxLength={150}
                  value={nextTitle}
                  onChange={(event) => setNextTitle(event.currentTarget.value)}
                  required
                />
              )}
              <Button
                size="sm"
                type="submit"
                variant={
                  conversationAction === "delete" ? "destructive" : "default"
                }
                disabled={
                  changingConversation ||
                  (conversationAction === "rename" && !nextTitle.trim())
                }
              >
                {conversationAction === "delete"
                  ? "Confirmar exclusão"
                  : "Salvar nome"}
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                disabled={changingConversation}
                onClick={() => setConversationAction(undefined)}
              >
                Cancelar
              </Button>
            </form>
          ) : (
            <>
              <span>{panelName ?? title ?? "Nova conversa"}</span>
              {selected && title && !panel && (
                <div className="local-conversation-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Renomear conversa"
                    onClick={() => {
                      setNextTitle(title);
                      setConversationAction("rename");
                    }}
                  >
                    <IconPencil aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={!!runningTurn}
                    aria-label="Excluir conversa"
                    onClick={() => setConversationAction("delete")}
                  >
                    <IconTrash aria-hidden="true" />
                  </Button>
                </div>
              )}
            </>
          )}
        </header>
        {panel === "browser" ? (
          <BrowserPanel
            onLock={onLock}
            onUseText={(text) => {
              setPanel(undefined);
              const excerpt = `Trecho da página para revisão:\n${text}`;
              if (draft.length + excerpt.length + 2 > 16_000) {
                setNotice(
                  "O trecho não cabe na mensagem atual. Reduza o rascunho antes de adicioná-lo.",
                );
                return;
              }
              setDraft((current) =>
                current.trim() ? `${current}\n\n${excerpt}` : excerpt,
              );
            }}
          />
        ) : panel === "learning" ? (
          <Learning onLock={onLock} />
        ) : panel === "business" ? (
          <BusinessPanel onLock={onLock} />
        ) : panel === "project" ? (
          <ProjectPanel onLock={onLock} />
        ) : panel === "bots" ? (
          <BotsPanel onLock={onLock} />
        ) : panel === "memory" ? (
          <MemoryPanel onLock={onLock} />
        ) : panel === "routines" ? (
          <RoutinesPanel onLock={onLock} />
        ) : (
          <>
            <div
              className="local-transcript"
              ref={transcript}
              onScroll={(event) => {
                const { scrollHeight, scrollTop, clientHeight } =
                  event.currentTarget;
                followLatest.current =
                  scrollHeight - scrollTop - clientHeight < 80;
              }}
            >
              {turns.length > 0 ? (
                <div className="transcript-content">
                  {turns.map((turn) => (
                    <TranscriptTurn key={turn.id} turn={turn} />
                  ))}
                </div>
              ) : (
                <div className="local-empty">
                  <DemoOrb size={65} />
                  {selected && !detail && !detailError ? (
                    <p role="status">Carregando conversa…</p>
                  ) : (
                    <h1>Como posso ajudar?</h1>
                  )}
                </div>
              )}
            </div>
            <div className="composer-backdrop">
              <div className="composer-wrap">
                {detailError && selected && (
                  <div className="composer-error">
                    <p className="local-error" role="alert">
                      {detailError}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loadDetail(selected)}
                    >
                      Tentar novamente
                    </Button>
                  </div>
                )}
                {notice && (
                  <p className="local-error" role="alert">
                    {notice}
                  </p>
                )}
                <form
                  className="local-composer"
                  onSubmit={(event) => void send(event)}
                >
                  <textarea
                    aria-label="Mensagem"
                    placeholder="Escreva uma mensagem"
                    rows={2}
                    maxLength={16_000}
                    value={draft}
                    disabled={!ready || creating}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <ComposerAttachments
                    conversationId={selected}
                    disabled={!ready || creating || !!run}
                    conversationForUpload={conversationForUpload}
                    onError={attachmentError}
                  >
                    {runningTurn ? (
                      <Button
                        type="button"
                        size="icon-lg"
                        onClick={() => void stop()}
                        disabled={stopping}
                        aria-label="Interromper resposta"
                        title="Interromper resposta"
                      >
                        <IconSquare aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        size="icon-lg"
                        disabled={!ready || creating || !!run || !draft.trim()}
                        aria-label="Enviar mensagem"
                        title="Enviar mensagem"
                      >
                        <IconArrowUp aria-hidden="true" />
                      </Button>
                    )}
                  </ComposerAttachments>
                </form>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
