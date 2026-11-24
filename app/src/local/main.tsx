import { IconLock } from "@tabler/icons-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { json, post } from "./api";
import { Workspace } from "./workspace";
import "./style.css";

type Session = "loading" | "locked" | "open" | "unavailable";

function App() {
  const [session, setSession] = useState<Session>("loading");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useCallback(() => setSession("locked"), []);

  const checkSession = useCallback(async (signal?: AbortSignal) => {
    setSession("loading");
    try {
      const result = await json<{ authenticated: boolean }>("/session", {
        signal,
      });
      if (!signal?.aborted)
        setSession(result.authenticated ? "open" : "locked");
    } catch {
      if (!signal?.aborted) setSession("unavailable");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkSession(controller.signal);
    return () => controller.abort();
  }, [checkSession]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await json("/session", post({ token: token.trim() }));
      setToken("");
      setSession("open");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Não foi possível iniciar a sessão.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (session === "open") return <Workspace onLock={lock} />;

  return (
    <main className="session-screen">
      <section className="session-card" aria-labelledby="session-title">
        <span className="session-mark" aria-hidden="true">
          <IconLock size={21} stroke={1.65} />
        </span>
        <h1 id="session-title">OpenBot Local</h1>
        {session === "loading" && <p role="status">Verificando a sessão…</p>}
        {session === "unavailable" && (
          <>
            <p role="alert">O servidor local está indisponível.</p>
            <Button onClick={() => void checkSession()}>
              Tentar novamente
            </Button>
          </>
        )}
        {session === "locked" && (
          <form onSubmit={(event) => void signIn(event)}>
            <p>Use o token exibido no terminal do servidor local.</p>
            <label htmlFor="session-token">Token local</label>
            <Input
              id="session-token"
              name="token"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              required
            />
            {error && (
              <p className="local-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy || !token.trim()}>
              {busy ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}

const color = window.matchMedia("(prefers-color-scheme: dark)");
function applySystemTheme() {
  document.documentElement.classList.toggle("dark", color.matches);
}
applySystemTheme();
color.addEventListener("change", applySystemTheme);

const root = document.getElementById("root");
if (!root) throw new Error("A página local não encontrou o elemento raiz.");
createRoot(root).render(<App />);
