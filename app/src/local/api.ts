export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type Turn = {
  id: string;
  prompt: string;
  answer: string | null;
  status: string;
  error: string | null;
};

export type ConversationDetail = { conversation: Conversation; turns: Turn[] };

const errorMessages = new Map([
  ["UNAUTHORIZED", "Token local inválido ou sessão expirada."],
  [
    "UNTRUSTED_ORIGIN",
    "Abra o OpenBot pelo endereço local exibido no terminal.",
  ],
  ["CONVERSATION_NOT_FOUND", "Conversa não encontrada."],
  ["CONVERSATION_BUSY", "Já há uma resposta em andamento nesta conversa."],
  ["INVALID_TURN", "A mensagem é inválida ou excede o limite."],
  ["INVALID_CONVERSATION_TITLE", "Informe um nome de até 150 caracteres."],
  ["INVALID_ATTACHMENT", "Não foi possível ler o arquivo selecionado."],
  ["ATTACHMENT_TOO_LARGE", "O arquivo deve ter até 8 MB."],
  [
    "LEARNING_GENERATION_IN_PROGRESS",
    "A proposta está sendo preparada. Tente novamente em instantes.",
  ],
  [
    "LEARNING_GENERATION_FAILED",
    "Não foi possível gerar a proposta. Verifique a configuração do gerador local.",
  ],
  [
    "INVALID_LEARNING_DRAFT",
    "A proposta gerada não passou na validação. Tente novamente.",
  ],
  [
    "LEARNING_PROPOSAL_CHANGED",
    "A proposta mudou. Abra a revisão novamente antes de salvar.",
  ],
  ["RECORDING_EMPTY", "A gravação não contém ações para adicionar."],
  [
    "INVALID_BROWSER_URL",
    "Informe um endereço HTTP ou HTTPS válido, sem credenciais embutidas.",
  ],
  ["BROWSER_UNAVAILABLE", "Não foi possível abrir a janela separada do Edge."],
  ["BROWSER_TAB_NOT_FOUND", "A aba não está mais aberta."],
  ["BODY_TOO_LARGE", "O pedido completo deve ter até 128 KB."],
  ["REQUEST_BODY_TOO_LARGE", "O pedido completo deve ter até 128 KB."],
  ["INVALID_SOCIAL_ITEM", "Confira o destino, a legenda, o link e o horário."],
  ["SOCIAL_ITEM_CHANGED", "O rascunho mudou. Revise a versão atual."],
  [
    "SOCIAL_BACKUP_NEEDS_REVIEW",
    "O agendamento veio de um backup. Confira a conta antes de registrar o resultado.",
  ],
  ["INSTAGRAM_NOT_CONFIGURED", "Configure a conta profissional do Instagram."],
  [
    "INSTAGRAM_VERIFICATION_COOLDOWN",
    "Aguarde um minuto entre consultas ao Instagram.",
  ],
  [
    "INSTAGRAM_VERIFICATION_NOT_AVAILABLE",
    "Conecte a mesma conta que criou o contêiner para conferir a publicação.",
  ],
  ["SOCIAL_SCHEDULE_REQUIRED", "Informe a data e a hora de publicação."],
  [
    "INVALID_SOCIAL_RESULT_URL",
    "Informe o link da publicação no destino correspondente.",
  ],
  [
    "BUSINESS_MODEL_NOT_CONFIGURED",
    "Configure o OpenCode Console para gerar rascunhos com DeepSeek.",
  ],
  ["INVALID_BUSINESS_BRIEF", "Informe uma orientação de até 4.000 caracteres."],
  ["BUSINESS_DRAFT_IN_PROGRESS", "Já existe um rascunho em geração."],
  [
    "BUSINESS_DRAFT_FAILED",
    "O DeepSeek não conseguiu gerar o rascunho. Confira a conexão do OpenCode Console.",
  ],
  [
    "BUSINESS_DRAFT_INVALID",
    "O rascunho gerado não passou na validação. Tente com uma orientação mais curta.",
  ],
  ["INVALID_EBOOK", "Confira o título, o autor e os capítulos do ebook."],
  ["INVALID_EBOOK_CHAPTER", "Confira o título e o conteúdo dos capítulos."],
  [
    "BOT_ACTIVE_REQUIRED",
    "Ative uma versão simulada do bot antes de iniciar a execução.",
  ],
  [
    "BOT_INVALID_INPUT",
    "Confira os campos da execução e o exemplo prático exigido pela skill ativa.",
  ],
  ["BOT_CHAPTER_REQUIRED", "Escolha um capítulo já salvo no Estúdio."],
  [
    "BOT_STAGE_INTERRUPTED",
    "A etapa anterior foi interrompida. Confira o estado antes de continuar.",
  ],
  [
    "BOT_PROJECT_RESTORE_REVIEW",
    "Confira a proposta no projeto original antes de rodar os testes neste perfil restaurado.",
  ],
  [
    "BOT_PROGRAM_TEST_FAILED",
    "Os testes falharam. Consulte o resultado no painel Projeto.",
  ],
  [
    "BOT_RUN_NOT_ELIGIBLE",
    "A correção deve vir de uma execução concluída da mesma versão do bot.",
  ],
  ["BOT_FEEDBACK_DUPLICATE", "Essa execução já tem uma correção registrada."],
  [
    "BOT_FEEDBACK_NO_CHANGE",
    "A correção deve ser diferente do trecho original.",
  ],
  [
    "PROJECT_PILOT_SANDBOX_REQUIRED",
    "O executor isolado está indisponível. O diff e o patch continuam salvos.",
  ],
  [
    "PROJECT_PILOT_TEST_IMAGE_REQUIRED",
    "A imagem local Bun 1.4.3 é necessária para executar testes isolados.",
  ],
  [
    "PROJECT_PILOT_INVALID_PATHS",
    "Informe caminhos relativos de arquivos versionados, um por linha.",
  ],
  [
    "PROJECT_PILOT_SELECT_REPOSITORY_ROOT",
    "Informe a pasta raiz do repositório Git.",
  ],
  [
    "PROJECT_PILOT_INVALID_REPOSITORY",
    "Não foi possível abrir o repositório Git indicado.",
  ],
  [
    "PROJECT_PILOT_FILE_UNAVAILABLE",
    "Um arquivo selecionado não existe na revisão de origem ou está fora do escopo.",
  ],
  [
    "PROJECT_PILOT_MODEL_REQUIRED",
    "Conecte o OpenCode Go para gerar a proposta.",
  ],
  [
    "PROJECT_PILOT_MODEL_FAILED",
    "O OpenCode não concluiu a proposta. Confira a conexão do modelo.",
  ],
  [
    "PROJECT_PILOT_MODEL_OUTPUT_INVALID",
    "A proposta extrapolou os arquivos escolhidos ou veio incompleta. Reduza a tarefa e tente novamente.",
  ],
  [
    "PROJECT_PILOT_WORKTREE_CHANGED",
    "A worktree mudou desde a proposta. Revise a alteração antes de executar novos testes.",
  ],
  [
    "PROJECT_PILOT_TEST_FILE_CHANGED",
    "O arquivo de teste deve corresponder à versão original do repositório.",
  ],
  [
    "STUDIO_STALE_REVISION",
    "O ebook já tem uma versão mais recente. Abra essa versão antes de salvar.",
  ],
  [
    "STUDIO_INCOMPLETE_DRAFT",
    "Preencha o autor e pelo menos um capítulo completo para exportar.",
  ],
  [
    "STUDIO_INVALID_SOURCE",
    "Confira os links das fontes. Use HTTP ou HTTPS sem credenciais.",
  ],
  [
    "STUDIO_BOOK_TOO_LARGE",
    "O projeto ultrapassa o limite de 126 KB de texto.",
  ],
  [
    "STUDIO_INVALID_BOOK",
    "Confira o tamanho dos campos, o número de capítulos e o sumário.",
  ],
  [
    "STUDIO_EXPORT_FAILED",
    "O Edge não conseguiu exportar o arquivo. Confira se o navegador está instalado.",
  ],
  ["CAMPAIGN_REQUIRED", "Salve a campanha antes de importar resultados."],
  [
    "CAMPAIGN_ORDER_CONFLICT",
    "O CSV contém um pedido já importado com valor ou origem diferente.",
  ],
  [
    "CAMPAIGN_CLICKS_CONFLICT",
    "Há dois totais de cliques diferentes para a mesma data e peça.",
  ],
  [
    "CAMPAIGN_KIT_BOOK_MISMATCH",
    "Use um ebook salvo no Estúdio com o mesmo título da campanha.",
  ],
  [
    "OPENCODE_NOT_CONFIGURED",
    "Configure a chave do OpenCode para enviar mensagens.",
  ],
  ["OPENCODE_ACCESS_DENIED", "O OpenCode recusou a chave configurada."],
  [
    "OPENCODE_RATE_LIMITED",
    "O OpenCode atingiu o limite de solicitações. Tente novamente em instantes.",
  ],
  [
    "OPENCODE_UNAVAILABLE",
    "O OpenCode está indisponível. Tente novamente em instantes.",
  ],
]);

export function localErrorMessage(error: string) {
  return errorMessages.get(error) ?? error;
}

export class RequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export function localApiPath(path: string) {
  return `/api/local${path}`;
}

export async function request(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  // biome-ignore lint/style/noRestrictedGlobals: the local backend has a separate API and origin policy.
  const response = await fetch(localApiPath(path), {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new RequestError(
      typeof body?.error === "string"
        ? localErrorMessage(body.error)
        : "O servidor local não conseguiu concluir o pedido.",
      response.status,
    );
  }
  return response;
}

export async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json();
}

export function post(body: object): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export function conversationPath(id: string) {
  return `/conversations/${encodeURIComponent(id)}`;
}

export async function readAnswer(
  response: Response,
  onDelta: (text: string) => void,
): Promise<void> {
  if (
    !response.body ||
    !response.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    throw new Error("O servidor não abriu o fluxo da resposta.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done)
        throw new Error("A resposta foi interrompida antes de terminar.");
      buffer += decoder.decode(value, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const payload = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (payload) {
          const event = JSON.parse(payload);
          if (event.type === "done") return;
          if (event.type === "error") {
            throw new Error(
              typeof event.error === "string"
                ? localErrorMessage(event.error)
                : "A resposta falhou.",
            );
          }
          if (event.type === "delta" && typeof event.text === "string")
            onDelta(event.text);
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
