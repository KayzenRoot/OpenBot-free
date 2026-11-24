import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { json, localApiPath, post, RequestError, request } from "./api";

type Tab = { id: string; title: string; url: string };
type BrowserState = { open: boolean; tabs: Tab[] };

function tabPath(id: string) {
  return `/browser/tabs/${encodeURIComponent(id)}`;
}

export function BrowserPanel({
  onLock,
  onUseText,
}: {
  onLock: () => void;
  onUseText: (text: string) => void;
}) {
  const [state, setState] = useState<BrowserState>();
  const [address, setAddress] = useState("");
  const [chosen, setChosen] = useState<string>();
  const [screen, setScreen] = useState<{ tabId: string; url: string }>();
  const [excerpt, setExcerpt] = useState<{ tabId: string; text: string }>();
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingScreen, setLoadingScreen] = useState(false);
  const [followingTab, setFollowingTab] = useState<string>();

  const showError = useCallback(
    (error: unknown) => {
      if (error instanceof RequestError && error.status === 401) onLock();
      setFailure(
        error instanceof Error
          ? error.message
          : "Não foi possível acessar o navegador local.",
      );
    },
    [onLock],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await json<BrowserState>("/browser", { signal });
        if (!signal?.aborted) setState(next);
      } catch (error) {
        if (!signal?.aborted) showError(error);
      }
    },
    [showError],
  );

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function poll() {
      if (pending || document.hidden) return;
      pending = true;
      await refresh(controller.signal);
      pending = false;
    }
    void poll();
    const timer = setInterval(() => void poll(), 3_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  const tab = state?.tabs.find(({ id }) => id === chosen) ?? state?.tabs[0];
  const activeScreen = screen?.tabId === tab?.id ? screen : undefined;
  const activeExcerpt = excerpt?.tabId === tab?.id ? excerpt : undefined;
  const pendingScreen = loadingScreen && !!activeScreen;

  const capture = useCallback((id: string) => {
    setFailure("");
    setLoadingScreen(true);
    setScreen({
      tabId: id,
      url: localApiPath(`${tabPath(id)}/screen?capture=${Date.now()}`),
    });
  }, []);

  const tabId = tab?.id;
  const followingScreen = !!tabId && followingTab === tabId;
  useEffect(() => {
    if (!followingScreen || !tabId || pendingScreen) return;
    const timer = setInterval(() => {
      if (!document.hidden) capture(tabId);
    }, 2_000);
    return () => clearInterval(timer);
  }, [capture, followingScreen, pendingScreen, tabId]);

  async function operate(callback: () => Promise<void>) {
    if (busy) return;
    setFailure("");
    setBusy(true);
    try {
      await callback();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = address.trim();
    void operate(async () => {
      await request("/browser/open", post(url ? { url } : {}));
      setAddress("");
      await refresh();
    });
  }

  function activate(id: string) {
    setChosen(id);
    setScreen(undefined);
    setExcerpt(undefined);
    setLoadingScreen(false);
    setFollowingTab(undefined);
  }

  return (
    <section className="learning-page" aria-labelledby="browser-panel-title">
      <div className="learning-content">
        <header className="learning-heading">
          <h1 id="browser-panel-title">Navegador local</h1>
          <p>Abra páginas em uma janela separada do Edge.</p>
        </header>
        {failure && (
          <p className="local-error" role="alert">
            {failure}
          </p>
        )}
        <form className="learning-block profile-form" onSubmit={open}>
          <label htmlFor="browser-address">Endereço da página</label>
          <Input
            id="browser-address"
            maxLength={2048}
            placeholder="https://exemplo.com"
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
          />
          <div className="learning-actions">
            <Button type="submit" disabled={busy}>
              {state?.open ? "Abrir aba" : "Abrir navegador"}
            </Button>
            {state?.open && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void operate(async () => {
                    await request("/browser/close", post({}));
                    setChosen(undefined);
                    setScreen(undefined);
                    setExcerpt(undefined);
                    setLoadingScreen(false);
                    setFollowingTab(undefined);
                    await refresh();
                  })
                }
              >
                Fechar navegador
              </Button>
            )}
          </div>
        </form>
        {state?.open && (
          <section className="learning-block">
            <h2>Abas abertas</h2>
            {!state.tabs.length && <p>Nenhuma aba aberta.</p>}
            {state.tabs.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                className="learning-proposal-row"
                aria-pressed={item.id === tab?.id}
                onClick={() => activate(item.id)}
              >
                <span>{item.title || "Nova aba"}</span>
                <span>{item.url}</span>
              </Button>
            ))}
            {tab && (
              <>
                <div className="learning-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void operate(async () => {
                        await request(`${tabPath(tab.id)}/focus`, post({}));
                      })
                    }
                  >
                    Mostrar aba no Edge
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || pendingScreen}
                    onClick={() => capture(tab.id)}
                  >
                    {pendingScreen ? "Capturando…" : "Capturar tela"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={followingScreen}
                    onClick={() => {
                      if (!followingScreen && !pendingScreen) capture(tab.id);
                      setFollowingTab(followingScreen ? undefined : tab.id);
                    }}
                  >
                    {followingScreen ? "Pausar tela" : "Acompanhar tela"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void operate(async () => {
                        const { text } = await json<{ text: string }>(
                          `${tabPath(tab.id)}/text`,
                        );
                        setExcerpt({ tabId: tab.id, text });
                      })
                    }
                  >
                    Ler texto da página
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void operate(async () => {
                        await request(`${tabPath(tab.id)}/close`, post({}));
                        setScreen(undefined);
                        setExcerpt(undefined);
                        setLoadingScreen(false);
                        setFollowingTab(undefined);
                        await refresh();
                      })
                    }
                  >
                    Fechar aba
                  </Button>
                </div>
                {activeScreen && (
                  <img
                    className="local-browser-screen"
                    src={activeScreen.url}
                    alt="Captura da aba do navegador local"
                    onLoad={() => setLoadingScreen(false)}
                    onError={() => {
                      setScreen(undefined);
                      setLoadingScreen(false);
                      setFollowingTab(undefined);
                      setFailure("Não foi possível capturar a tela desta aba.");
                    }}
                  />
                )}
                {activeExcerpt && (
                  <div className="learning-review profile-form">
                    <label htmlFor="browser-excerpt">Trecho da página</label>
                    <textarea
                      id="browser-excerpt"
                      rows={8}
                      maxLength={8000}
                      value={activeExcerpt.text}
                      onChange={(event) =>
                        setExcerpt({
                          tabId: tab.id,
                          text: event.currentTarget.value,
                        })
                      }
                    />
                    <div className="learning-actions">
                      <Button
                        type="button"
                        disabled={!activeExcerpt.text.trim()}
                        onClick={() => onUseText(activeExcerpt.text.trim())}
                      >
                        Preparar na conversa
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
