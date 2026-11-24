import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { json, post, RequestError } from "./api";
import { downloadLocalFile } from "./pilot-download";
import "./learning.css";
import "./business-panel.css";
import "./pilot-panels.css";

type PilotTest = {
  command?: string[] | string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  status?: string;
};
type Pilot = {
  id: string;
  repoPath: string;
  baseCommit: string;
  worktree: string;
  paths: string[];
  status: string;
  patch: string;
  test: PilotTest | null;
};

const base = "/project-pilots";

export function ProjectPanel({ onLock }: { onLock: () => void }) {
  const [repo, setRepo] = useState("");
  const [paths, setPaths] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pilots, setPilots] = useState<Pilot[]>([]);
  const [selected, setSelected] = useState<Pilot>();
  const [testFiles, setTestFiles] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const fail = useCallback(
    (failure: unknown) => {
      if (failure instanceof RequestError && failure.status === 401) onLock();
      setError(
        failure instanceof Error
          ? failure.message
          : "Falha ao executar o projeto.",
      );
    },
    [onLock],
  );

  useEffect(() => {
    const controller = new AbortController();
    void json<{ pilots: Pilot[] }>(base, { signal: controller.signal })
      .then(({ pilots }) => setPilots(pilots))
      .catch((failure) => {
        if (!controller.signal.aborted) fail(failure);
      });
    return () => controller.abort();
  }, [fail]);

  function show(pilot: Pilot) {
    setSelected(pilot);
    setPilots((previous) => [
      pilot,
      ...previous.filter(({ id }) => id !== pilot.id),
    ]);
    setConfirmed(false);
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy("generate");
    try {
      const result = await json<{ pilot: Pilot }>(
        base,
        post({
          repoPath: repo.trim(),
          prompt: prompt.trim(),
          paths: paths
            .split(/\r?\n/)
            .map((path) => path.trim())
            .filter(Boolean),
        }),
      );
      show(result.pilot);
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  }

  async function runTests(event: FormEvent) {
    event.preventDefault();
    if (!selected || !confirmed) return;
    setBusy("test");
    setError("");
    try {
      const { pilot } = await json<{ pilot: Pilot }>(
        `${base}/${encodeURIComponent(selected.id)}/test`,
        post({
          confirmed: true,
          paths: testFiles
            .split(/\r?\n/)
            .map((path) => path.trim())
            .filter(Boolean),
        }),
      );
      show(pilot);
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="learning-page">
      <div className="learning-content">
        <header className="learning-heading">
          <h1>Projeto</h1>
          <p>
            Gere uma alteração com o DeepSeek V4.1 Flash em uma cópia isolada do
            Git.
          </p>
        </header>
        {error && (
          <p className="learning-block" role="alert">
            {error}
          </p>
        )}
        <section className="learning-block">
          <h2>Nova tarefa de programação</h2>
          <form className="profile-form business-form" onSubmit={generate}>
            <label htmlFor="project-path">
              Pasta do repositório
              <Input
                id="project-path"
                required
                value={repo}
                maxLength={1024}
                placeholder="D:\\Projetos\\meu-repo"
                onChange={(event) => setRepo(event.target.value)}
              />
            </label>
            <label>
              Arquivos de código, um caminho relativo por linha
              <textarea
                required
                rows={3}
                maxLength={2400}
                value={paths}
                placeholder="src/app.ts"
                onChange={(event) => setPaths(event.target.value)}
              />
            </label>
            <label>
              Tarefa
              <textarea
                required
                rows={4}
                maxLength={4000}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <p>
              O OpenCode recebe a tarefa e o conteúdo Git dos arquivos
              escolhidos. A proposta é salva em uma worktree para revisão.
            </p>
            <Button type="submit" disabled={Boolean(busy)}>
              {busy === "generate" ? "Preparando alteração…" : "Gerar proposta"}
            </Button>
          </form>
        </section>
        {pilots.length > 0 && (
          <section className="learning-block">
            <h2>Tarefas salvas</h2>
            {pilots.map((pilot) => (
              <Button
                key={pilot.id}
                variant="outline"
                disabled={Boolean(busy)}
                onClick={async () => {
                  setError("");
                  try {
                    show(
                      (
                        await json<{ pilot: Pilot }>(
                          `${base}/${encodeURIComponent(pilot.id)}`,
                        )
                      ).pilot,
                    );
                  } catch (failure) {
                    fail(failure);
                  }
                }}
              >
                {pilot.repoPath} · {pilot.id.slice(0, 8)}
              </Button>
            ))}
          </section>
        )}
        {selected && (
          <section className="learning-block">
            <h2>Revisar alterações</h2>
            <dl className="pilot-details">
              <dt>Commit de origem</dt>
              <dd>
                <code>{selected.baseCommit}</code>
              </dd>
              <dt>Worktree</dt>
              <dd>
                <code>{selected.worktree}</code>
              </dd>
              <dt>Arquivos autorizados</dt>
              <dd>{selected.paths.join(", ")}</dd>
            </dl>
            {selected.patch ? (
              <>
                <pre className="pilot-output">{selected.patch}</pre>
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadLocalFile(
                      new Blob([selected.patch], { type: "text/plain" }),
                      `openbot-${selected.id.slice(0, 8)}.patch`,
                    )
                  }
                >
                  Baixar patch
                </Button>
              </>
            ) : (
              <p>A tarefa não tem alterações para revisar.</p>
            )}
            <form className="profile-form business-form" onSubmit={runTests}>
              <label>
                Arquivos de teste Bun aprovados, um caminho relativo por linha
                <textarea
                  required
                  rows={2}
                  value={testFiles}
                  onChange={(event) => setTestFiles(event.target.value)}
                />
              </label>
              <label className="pilot-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Confirmo que confio nos testes selecionados e nas dependências
                que eles executam.
              </label>
              <Button
                type="submit"
                variant="outline"
                disabled={!confirmed || Boolean(busy)}
              >
                {busy === "test"
                  ? "Executando testes…"
                  : "Executar testes na worktree"}
              </Button>
            </form>
            {selected.test && (
              <div className="business-confirm" role="status">
                <strong>
                  {selected.test.status === "passed"
                    ? "Testes passaram"
                    : "A execução precisa de revisão"}
                </strong>
                <pre className="pilot-output">
                  {[
                    Array.isArray(selected.test.command)
                      ? selected.test.command.join(" ")
                      : selected.test.command,
                    selected.test.stdout,
                    selected.test.stderr,
                  ]
                    .filter(Boolean)
                    .join("\n")}
                </pre>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
