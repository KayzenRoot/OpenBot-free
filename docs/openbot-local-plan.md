# Plano do OpenBot local

Objetivo de uso pessoal no Windows. Preservar a interface e os fluxos do OpenBot, executar o aplicativo e armazenar os dados no computador, e substituir as dependências do CopilotKit por código local. O modelo escolhido é o DeepSeek V4.1 Flash (`deepseek-v4.1-flash`) via OpenCode. Nesse modo, a inferência usa a API remota do OpenCode. Conversas, skills, evidências e arquivos ficam sob controle do backend local. Somente o contexto necessário a cada inferência segue para o provedor.

## Inventário técnico

| Área | Base disponível no clone | Substituição planejada |
| --- | --- | --- |
| Web, Desktop, Mobile e Recorder | React/Vite, Tauri, Expo e extensão Chrome. Os clientes chamam a API gerada e partes do web/Recorder usam SDKs do CopilotKit. | Preservar telas, identidade visual e animações. Substituir os hooks, transporte e configuração de serviços, por fluxo, com testes de paridade. |
| Servidor, banco e computador do Bot | OpenAPI, AsyncAPI, Docker Compose e documentação. O servidor Hono, as migrações e o computador são distribuídos por imagem. | Implementar um servidor e esquema próprios. Começar com Bun e SQLite para um único usuário. Usar Docker para o ambiente isolado do navegador quando necessário. |
| Chat, streaming e agentes | Contrato AG-UI e 14 adaptadores locais. CopilotKit Runtime e Intelligence participam do streaming, do histórico e da memória. | Implementar protocolo, retomada e armazenamento local. Reutilizar adaptadores compatíveis com o contrato e substituir imports do fornecedor. |
| Aprendizado | Recorder, páginas de configuração/revisão e contratos de evidência e propostas. Intelligence gera e publica skills. | Guardar demonstrações e conversas localmente, gerar propostas com o modelo, validar e versionar `SKILL.md`, revisar e publicar no catálogo local. |
| Ferramentas e rotinas | Contratos para MCP, aprovações, auditoria, agenda, canais e controle do computador. | Reimplementar verificação de permissões e registro de ações no servidor. Usar integrações diretas configuradas pelo usuário para os serviços externos que precisar. |

A arquitetura, o aprendizado e os contratos do repositório orientam a migração. [Arquitetura](architecture.md) · [Desenvolvimento](development.md) · [Aprendizado](automatic-learning.md) · [REST](../api/openapi.yaml) · [WebSockets](../api/asyncapi.yaml) · [Compose](../docker-compose.yml)

O inventário partiu dos 5.292 arquivos versionados em `main` no commit `6b76bba429c85e8dcfed40076677c7c343b68d13`. O clone inclui o código MIT do template e os contratos. O backend do servidor, o computador isolado e o supervisor vêm de imagens publicadas. O Intelligence tem licença própria. A revisão estática desses serviços fica limitada aos contratos, configuração e testes públicos. Em `main`, a tag do backend é móvel, portanto reproduzir o aplicativo original exigiria registrar também os digests executados. [Licenciamento](../README.md#open-source-local-operation-and-licensing) · [Imagens](../backend-images.env)

- O Compose separa PostgreSQL da rede dos Bots e dá acesso ao socket do engine apenas ao supervisor. Dois healthchecks do Compose testam a conexão HTTP sem verificar o status. Na versão local, a saúde dos serviços e o isolamento do navegador precisam de testes distintos. [Compose](../docker-compose.yml)
- O Recorder tem permissões amplas de navegador e dispõe de mascaramento e fila de retransmissão. O aceite local deve demonstrar o tratamento de conteúdo sensível e a recuperação após desligar o backend. [Manifesto](../extension/src/manifest.ts) · [Mascaramento](../shared/recorder-masking.ts)
- O Mobile faz polling a cada dez segundos em primeiro plano e a tela de conversa carrega até 200 mensagens. A troca de organização pode receber uma resposta atrasada do contexto anterior, pois o hook aplica todas as respostas. [Carregamento](../mobile/src/use-load.ts) · [Histórico](../mobile/app/conversation.tsx)
- O agente Kubernetes verifica assinaturas Ed25519, mas a deduplicação de comandos usa um snapshot inicial do lote. Um mesmo comando válido repetido no lote pode ser executado duas vezes. Os adaptadores Python também resolvem dependências durante o build. Esses itens precisam de verificação própria caso sejam incluídos na instalação pessoal. [Comandos](../management-agent/src/agent.ts) · [Contratos](../shared/management-contract.ts) · [Deps Python](../agent-crewai/requirements.txt)

## Lista de implementação e aceite

- [x] **01. Backend inicial e provedor.** Criar processo local independente, usando Bun no Windows, com endpoint de saúde e uma rota de chat protegida. Enviar a identidade do cliente e o ID estável da conversa ao OpenCode. Validar streaming, ferramentas declaradas e erros com provedor simulado. Confirmei também um turno de programação na conta ativa do OpenCode Go via CLI, do backend até a gravação no SQLite.
- [ ] **02. Núcleo persistente e primeiro chat na interface.** Executar 02A (SQLite e turnos), 02B (chat na interface existente) e 02C (recuperação de dados e anexos). Os critérios de cada entrega estão nas ordens de trabalho abaixo.
- [ ] **03. Skills e Automatic Learning.** Conectar a extensão ao backend local e receber evidências de demonstrações e conversas. Mascarar credenciais antes de armazenar ou enviar contexto ao modelo. Criar fila persistente com deduplicação, geração de propostas, evidências vinculadas, publicação, rejeição, versões e opção de aprovação automática. Verificar a jornada completa de uma gravação até o uso da skill publicada por um Bot. Preservar o escopo original de cada grant ao aplicar uma skill.
- [ ] **04. Computador e ações.** Entregar navegador isolado, arquivos, captura de tela, controle humano e permissões de acesso ao host. Recuperar estado do navegador após reiniciar. Implementar confirmação e trilha de auditoria no gateway antes da execução de ações com efeitos externos. Testar políticas, negativas, timeouts e interrupções com serviços de teste.
- [ ] **05. Demais superfícies e fluxos.** Mapear cada operação do OpenAPI, canal WebSocket e fluxo visível em uma matriz de paridade por cliente.
  - [x] Memória com inspeção, edição e exclusão. Validar recuperação de uma memória após reinício.
  - [ ] Pesquisa web, anexos e interfaces interativas. Verificar a renderização e o isolamento do conteúdo gerado.
  - [ ] Rotinas e delegação entre Bots. Validar agenda, retomada, deduplicação e trilha de execução.
  - [ ] MCP e integrações de aplicativos. Validar conexão, revogação, consentimento e auditoria de ações.
  - [ ] Canais, compartilhamento e administração. Validar fluxos locais de cada cliente e identificar as operações que exigem credenciais ou endpoints de terceiros, incluindo Slack, Teams e notificações mobile.
  - [x] Entregar o painel Trabalho com análise e atualização automática de CSV, geração de EPUB, fila de publicações e catálogo de skills de texto.
  - [ ] Validar publicações reais no Instagram com uma conta profissional conectada e um rascunho aprovado.
  - [ ] Validar inferência geral no OpenCode Console para gerar rascunhos de legendas e ebooks com DeepSeek.
  - [ ] Conectar a loja usada pelo usuário e validar leitura de pedidos e operações autorizadas em ambiente de teste.
- [ ] **06. Instalação e remoção de dependências.** Ligar o Desktop ao novo backend, fornecer inicialização e backup no Windows, e empacotar somente os componentes locais necessários. Remover imports, SDKs, imagens, login, configuração, telemetria e chamadas de rede do CopilotKit do caminho distribuído. Preservar créditos e licenças exigidos pelo código MIT. Verificar que o workspace inicia com ambiente limpo sem conta CopilotKit.
- [ ] **07. Aceite de paridade.** Completar a matriz de recursos com evidência por jornada. Rodar instalação do zero, restauração, testes de contrato/UI/reinício e auditoria das conexões externas. Confirmar o DeepSeek V4.1 Flash com a conta do usuário e executar o teste final no Windows.

## Ordem de trabalho OPENBOT-LOCAL-001

**Risco padrão.** O primeiro incremento implementa o transporte oficial OpenAI Chat Completions do OpenCode Go e disponibiliza a rota de chat inicial apenas em `127.0.0.1`. O token da API local fica separado da chave do provedor. A rota aceita mensagens de texto com ID de sessão definido pelo cliente e repassa SSE. O transporte pode encaminhar descrições de ferramentas, e a implementação atual só testa esse tráfego com respostas simuladas. UI, armazenamento, execução de ferramentas, gravação e aprendizado entram nos incrementos seguintes.

**Critério de aceite.** O teste inicia o servidor em uma porta loopback livre, verifica saúde, autenticação, entrada inválida, streaming, ID de sessão, modelo e tratamento de erro do provedor. A verificação inclui typecheck e Biome, com todas as chamadas ao modelo substituídas por fixtures.

```powershell
bun test local-backend/server.test.ts
bun x --no-install tsc --project local-backend/tsconfig.json
bun x --no-install biome check local-backend
```

Para iniciar o incremento no Windows, configure `OPENCODE_API_KEY` no ambiente e gere `OPENBOT_LOCAL_TOKEN` com pelo menos 32 caracteres aleatórios. Execute `bun local-backend/server.ts` com Bun 1.4.3 e consulte `http://127.0.0.1:3011/health`. O POST em `/api/local/chat` recebe JSON com `sessionId` e `messages`, e usa `Authorization: Bearer` com o token local. A chave do OpenCode fica no processo do servidor.

O catálogo do OpenCode Go inclui DeepSeek V4.1 Flash. O provedor documenta que o modelo pode exigir a região Global na configuração de privacidade, e exige que clientes externos se identifiquem, enviem o ID estável da sessão e gerem tráfego típico de agentes de programação. A elegibilidade para o tráfego geral do OpenBot deve ser confirmada antes de ligar o modo de aprendizado e as rotinas à sua assinatura. [OpenCode Go](https://opencode.ai/docs/console/go/) · [Integração de clientes](https://opencode.ai/docs/console/harnesses)

## Ordem de trabalho OPENBOT-LOCAL-002A — SQLite e turnos

**Risco elevado.** A primeira fatia precisa manter o histórico após o restart, evitar envios duplicados ao provedor e preservar a conversa se o processo cair durante o streaming. A API atual em `127.0.0.1:3011` serve de entrada para esta fatia. O backend local se torna a fonte do histórico que será enviado ao modelo. [Servidor atual](../local-backend/server.ts) · [Contrato das conversas](../api/openapi/conversations.yaml)

- [x] Criar a primeira migração para conversas, mensagens e execuções, com chaves estrangeiras e ordem estável das mensagens. Abrir o SQLite em WAL em uma pasta própria sob `%LOCALAPPDATA%\OpenBotLocal`, com um caminho configurável para testes e restauração. O processo Bun opera sem Docker.
- [x] Implementar criação, listagem, leitura do histórico e envio autenticado. Correlacionar a sessão no provedor com a conversa local. Validar o ID de envio por conversa e exigir que uma repetição com o mesmo ID corresponda à mesma mensagem.
- [x] Registrar a mensagem do usuário e a execução em uma transação antes de chamar o provedor. Persistir a resposta e o estado final em conjunto. Exibir estados de execução, falha, cancelamento e interrupção. Após uma queda, recuperar mensagens já gravadas e marcar execuções interrompidas para uma tentativa explícita.
- [x] Ler eventos SSE divididos em blocos e só confirmar a resposta após o encerramento válido do turno. Emitir erro visível para respostas truncadas ou falhas do provedor. O transporte HTTP envia deltas e o CLI emite partes de texto completas.

**Aceite.** Com OpenCode simulado, criar e concluir um turno, encerrar o processo, iniciar de novo e recuperar exatamente a conversa. Exercitar envios duplicados e simultâneos, compartilhamento de IDs entre conversas, falha HTTP, stream truncado, cancelamento e restart no meio do turno. Verificar que o cancelamento interrompe o fluxo do provedor e preserva o histórico anterior. Usar os testes do backend, o typecheck e o Biome para validar a entrega.

**Pré-voo no Windows.** Bun 1.4.3 abriu um SQLite temporário, gravou uma mensagem numa transação em modo WAL, reabriu o banco e leu a mesma mensagem e a versão do esquema. Uma cópia criada com `VACUUM INTO` também abriu com os mesmos dados. Esta verificação valida o mecanismo de armazenamento e cópia.

## Modo pessoal em validação

O [launcher de desenvolvimento no Windows](../OpenBot-Local.cmd) instala as dependências fixadas, monta a entrada local e inicia o servidor em `http://127.0.0.1:3011`. O [empacotador](../scripts/package-openbot-local.ts) cria `.openbot/local-windows` com outro `OpenBot-Local.cmd`, o runtime Bun, a interface compilada e o Playwright. O pacote roda sem instalação do npm e usa o Edge e o OpenCode da máquina. O acesso usa o token mostrado no terminal. Esta entrada reutiliza partes visuais do template e tem seu próprio transporte. O build local verifica a ausência do SDK CopilotKit no bundle do navegador.

- O chat guarda conversas em SQLite. Com `OPENCODE_API_KEY`, o backend chama a API Go diretamente. Com o OpenCode CLI instalado e autorizado, o launcher pode usar a conexão existente do CLI para programação, com ferramentas bloqueadas. O aplicativo não copia a chave do CLI. [Servidor](../local-backend/server.ts) · [CLI OpenCode](../local-backend/opencode-cli.ts)
- O modo local importa lotes JSON do Recorder e pode abrir um Edge separado para gravar tipos de ações. A captura descarta URLs, valores digitados e conteúdo da página. Ao parar, gera um rascunho para revisão. Sem `OPENCODE_CONSOLE_API_KEY`, o rascunho é extraído localmente das evidências. Uma conexão Console explicitamente configurada usa DeepSeek V4.1 Flash para gerar a proposta. [Recorder](../local-backend/browser-recorder.ts) · [Propostas](../local-backend/learning-proposer.ts)
- O painel de memórias salva, edita, busca e remove notas. O chat inclui apenas as notas que correspondem aos termos da mensagem. O painel de rotinas salva e ativa solicitações de texto recorrentes e mostra seu histórico. Rotinas executam enquanto o processo local está aberto. Com OpenCode Go, o uso previsto é para tarefas de programação. [Memória](../local-backend/memory.ts) · [Rotinas](../local-backend/local-routines.ts)
- A entrada local inclui o painel Navegador. Ele abre um Edge separado com perfil próprio, mostra as abas, permite focar e fechar abas e oferece captura de tela sob demanda ou acompanhamento periódico. O usuário pode revisar um trecho visível da página e inseri-lo no rascunho do chat. O perfil do Edge permanece no computador, fora do backup SQLite. [Navegador](../local-backend/personal-browser.ts) · [Painel](../app/src/local/browser-panel.tsx)
- O backup por linha de comando salva conversas, evidências, skills, anexos, memórias e rotinas. Para capturar os bancos no mesmo instante lógico, mantenha o OpenBot fechado durante a cópia. A restauração verifica o manifesto e cria um novo perfil. [Backup](../local-backend/profile-backup.ts)

**Validação no Windows.** O navegador Edge abriu o pacote portátil e passou pelos fluxos de sessão, recuperação do chat durante uma resposta, anexos, memórias, ativação de rotinas e revisão de skills. O utilitário empacotado de backup restaurou o perfil de teste. A captura do Recorder foi testada com uma página de teste, e um turno de programação com o DeepSeek V4.1 Flash real foi persistido via conexão OpenCode Go. Ainda falta a migração integral do runtime principal, dos computadores dos Bots e das integrações originais.

## Ordem de trabalho OPENBOT-LOCAL-002B — Chat na interface existente

**Dependência.** 002A aceita. Servir o app e sua API na mesma origem loopback. O bootstrap pessoal troca uma credencial de uso único por sessão local em cookie `HttpOnly` com `SameSite=Strict`. A chave do OpenCode permanece no servidor. O modo local precisa ter identidade e Bot inicial próprios para abrir a rota autenticada. [Rota autenticada](../app/src/routes/_authed.tsx) · [Configuração de proxy](../app/vite.config.ts)

- [ ] Implementar as operações de conversa usadas na primeira jornada no contrato público de `/api/v2`. Usar os clientes gerados quando a operação já estiver descrita. Adaptar carregamento inicial, envio, stop e reconexão em um transporte local de chat.
- [ ] Trocar a dependência de `useAgent` e `useCopilotKit` nos caminhos necessários a essa jornada. Reusar o compositor, a transcrição, os estados de carregamento e as ações atuais. Mapear separadamente renderizadores de ferramentas, interfaces generativas, voz e outros consumidores do SDK para a fase de paridade. [Chat](../app/src/components/channels/channel-chat.tsx) · [Compositor](../app/src/components/channels/composer/composer.tsx) · [Histórico legado](../app/src/lib/copilot/thread-messages.ts)
- [ ] Preparar a entrada do Desktop para a mesma origem local. A troca de runtime deve acontecer antes de remover os pacotes e estilos que sustentam as telas ainda em migração.

**Aceite.** Abrir a interface no Windows, iniciar uma conversa, ver a resposta em streaming, parar uma geração, recarregar e reabrir a conversa após reiniciar o servidor. Validar teclado e foco do compositor, estados de erro e comparação visual das telas. Na jornada exercitada, observar somente o backend loopback e o provedor configurado na saída do servidor.

## Ordem de trabalho OPENBOT-LOCAL-002C — Anexos, exportação e restauração

- [ ] Armazenar anexos e seus metadados no perfil local, com limite de tamanho, checagem por conversa e limpeza consistente em caso de falha ou exclusão. Manter fotos, OCR e outros formatos vinculados às capacidades verificadas do provedor.
- [ ] Criar backup consistente do SQLite e dos arquivos do perfil. Restaurar primeiro em pasta separada, checar versão e integridade, e abrir o backup restaurado antes de trocar qualquer perfil ativo. Registrar o caminho e a versão do backup na interface ou no launcher.
- [ ] Validar exportação, restauração, histórico e anexos em um segundo perfil no Windows. Confirmar que chaves e tokens ficam fora do backup de conteúdo.

## Ordem de trabalho OPENBOT-LOCAL-003 — Automatic Learning local

**Dependência.** Identidade, armazenamento e contrato de anexos da etapa 02 disponíveis. O Recorder já tem pareamento, mascaramento e fila de retransmissão. O gateway atual recebe lotes e confirma quais eventos foram aceitos. O caminho local precisa oferecer essa confirmação e vincular evidências a uma pessoa, conversa e gravação. [Contrato do Recorder](../shared/recorder-api.ts) · [Transmissão de gravações](../extension/src/offscreen/streamer.ts) · [Contratos de aprendizado](../api/openapi/learning.yaml)

- [ ] Receber e deduplicar eventos por gravação e sequência. Aplicar o mascaramento antes de persistir ou montar contexto para o modelo. Encerrar, interromper e retomar sessões recuperáveis da fila do Recorder.
- [ ] Implementar o trabalho de análise com estados persistentes, acionamento manual e opção de agenda. Modelar saídas como propostas estruturadas. Validar título, conteúdo de `SKILL.md`, evidências e caminhos de arquivos auxiliares antes de abrir a revisão.
- [ ] Ligar as telas existentes de propostas e revisão. Permitir rejeitar, editar e aprovar. Publicar uma revisão identificável e fazer o Bot consumir a versão publicada no turno seguinte. A aplicação da skill respeita permissões e aprovações já vigentes. [Revisão](../app/src/components/settings/learning-review.tsx) · [Publicação documentada](automatic-learning.md#reviewing-learned-skills)
- [ ] Verificar as condições da conta antes de ativar inferência para aprendizado e rotinas. O planejamento usa o DeepSeek V4.1 Flash do OpenCode para os usos elegíveis. Se a modalidade da conta cobrir apenas programação, o mesmo contrato de provedor permite configurar explicitamente uma modalidade elegível para as demais chamadas. O fluxo inteiro pode ser desenvolvido e testado com um provedor simulado.

**Aceite.** Da gravação à skill publicada em um perfil limpo no Windows. Simular repetição de lote, perda de conexão, evidência sensível, proposta inválida e falha do modelo. Confirmar que a skill aprovada é recuperada após reiniciar e influencia um turno do Bot sem alterar seus grants.

## Ordem de trabalho OPENBOT-LOCAL-004A — Navegador pessoal

- [x] Manter o perfil do Edge separado dos perfis pessoais já instalados. Validar reabertura com dados do perfil de teste.
- [x] Abrir, listar, focar e fechar abas. Vincular captura e leitura ao ID da aba, com rejeição de páginas internas e URLs com credenciais nas chamadas de abertura.
- [x] Mostrar capturas na interface local. Preparar texto visível para revisão no rascunho, preservando a decisão explícita de enviar a conversa.
- [ ] Integrar ferramentas dos Bots com isolamento, permissões por ação, aprovações, retomada e auditoria.

O pacote com o navegador ficou em `.openbot/local-windows-browser`. A validação usou o Edge no Windows e uma página loopback. Cobriu abas, captura PNG, controles de acompanhamento, leitura de texto e preenchimento do rascunho. O chat também permite renomear e excluir conversas. A exclusão confirmada remove turnos e anexos do perfil local. Na inicialização, o serviço remove anexos sem conversa associada.

## Uso diário no Windows

Abra `.openbot/local-windows-business/OpenBot-Local.cmd` e acesse [OpenBot no computador](http://127.0.0.1:3011/). Use o token da janela do servidor para entrar. Mantenha a janela aberta para executar os agendamentos. O pacote usa Bun e Edge no Windows, sem Docker. O perfil padrão fica em `%LOCALAPPDATA%\OpenBotLocal`.

### Publicações

- Instagram. Configure `OPENBOT_INSTAGRAM_ACCOUNT_ID` e `OPENBOT_INSTAGRAM_ACCESS_TOKEN` no ambiente do processo. Use uma conta profissional com Instagram Login e as permissões `instagram_business_basic` e `instagram_business_content_publishing`. Informe a URL HTTPS pública de um JPEG, salve o rascunho, revise a conta, a imagem e o horário e aprove a versão. O OpenBot usa a Graph API v26.0 por padrão. Se o resultado ficar indeterminado, confira a conta antes de registrar o resultado. [Publicações no Instagram](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
- Grupos do Facebook. Acrescente o endereço do grupo, aprove o rascunho e use **Copiar legenda** e **Abrir grupo**. Registre o resultado no painel. A Meta encerrou a API de Grupos em 22 de abril de 2024. [Alteração da API](https://developers.facebook.com/documentation/development/graph-api/changelog/version19.0)
- A fila registra estados e resultados no SQLite. No backup, agendamentos de Instagram podem ter sido executados no perfil original depois da cópia. O arquivo arquivado marca esses itens para conferência e desativa sua execução automática.

### Dados, vendas e ebooks

- Em **Trabalho → Dados e vendas**, importe um CSV UTF-8. Para atualizar o relatório automaticamente, coloque o arquivo em `%LOCALAPPDATA%\OpenBotLocal\sales-inbox\vendas.csv`. O OpenBot lê o arquivo a cada 30 segundos enquanto está aberto. O total acompanha a moeda usada no arquivo. O relatório inclui unidades, totais e agrupamentos por data e produto. A entrada cabe em 128 KiB. A operação de pedidos e pagamentos depende da conexão da loja.
- Em **Trabalho → Ebooks**, adicione título, autor e capítulos ou gere o rascunho com o DeepSeek. Revise e baixe o EPUB. A exportação e a análise de vendas são locais. Para rascunhos por IA, use `OPENCODE_CONSOLE_API_KEY` de uma conta elegível para inferência de uso geral. O modelo recebe a orientação do campo de rascunho. [OpenCode Console](https://opencode.ai/docs/console/)

```csv
data;produto;quantidade;valor_total
2026-11-23;Produto de exemplo;2;39,90
```

### Skills e plugins

O OpenBot revisa a fila de gravações a cada 30 segundos e gera um rascunho local para a próxima evidência ainda sem proposta. Abra **Aprendizado → Propostas**, atualize a lista e revise o rascunho antes de publicar a skill. Essa análise agendada usa as evidências já minimizadas pelo Recorder e funciona sem conexão a um modelo.

O perfil local contém um checkout esparso do [repositório OpenAI Plugins](https://github.com/openai/plugins), no commit `981b02c0c44058b595f3b4180002c3ae3c806d40`, com 22 plugins selecionados e 156 skills de texto disponíveis. O catálogo usa `%LOCALAPPDATA%\OpenBotLocal\openai-plugins` ou `OPENBOT_LOCAL_PLUGINS_DIR`. Consulte e copie a referência na aba **Plugins**. Coloque a referência na primeira linha da mensagem e o pedido nas linhas seguintes.

```text
/plugin data-analytics/<identificador-da-skill>
Analise estes campos e sugira um relatório.
```

As instruções carregadas orientam o turno de chat. Recursos que exigem apps, MCP, comandos, hooks ou o runtime do Codex dependem de integrações próprias. Os conectores para operar uma loja e os clientes originais de desktop e mobile continuam na lista de migração.

## Pilotos de programação e ebooks

Abra `.openbot/local-windows-pilot/OpenBot-Local.cmd` e entre em [OpenBot local](http://127.0.0.1:3011/). Use o token mostrado no terminal.

- Em **Projeto**, informe a pasta raiz de um Git local, uma tarefa e os arquivos versionados que a tarefa pode alterar. O DeepSeek V4.1 Flash recebe a tarefa e o conteúdo desses arquivos no commit atual. Abra o diff e baixe o patch para revisão. A edição ocorre em uma worktree separada. Para executar testes Bun, selecione arquivos de teste versionados e confirme a execução. O executor usa um contêiner Linux local, sem rede e com o código montado em leitura, usando a imagem `docker.io/oven/bun:1.4.3`. O histórico de tarefas, as worktrees e os patches ficam na pasta `project-pilots` do perfil. Mantenha os patches importantes em uma cópia separada.
- Em **Trabalho → Ebooks**, abra **Criar projeto piloto** para carregar o guia *Git com IA — revise antes de aplicar*. Altere autor, capa, fontes, sumário e capítulos, salve cada versão e use a prévia para celular. O OpenBot exporta o ebook em EPUB, PDF e uma amostra em PDF do primeiro capítulo. O Edge renderiza o PDF e a capa. A geração de rascunhos por capítulo exige `OPENCODE_CONSOLE_API_KEY` configurada para uso geral.
- Em **Trabalho → Campanha**, salve a página e as três pautas. Informe a URL HTTPS de publicação para gerar UTMs e o link real do checkout para habilitar a compra. **Baixar kit público com amostra e capa** gera um ZIP com `index.html`, `amostra.pdf` e `capa.png`. O EPUB e PDF completos saem pelo Estúdio. Publique os três arquivos do kit juntos no seu site. Mantenha os arquivos completos na plataforma que entrega o produto comprado.
- Importe CSVs de cliques e pedidos pelo painel da campanha. Use apenas eventos deste ebook e preserve os parâmetros UTM no checkout. Compras sem origem registrada ficam separadas no relatório. O total monetário desconta reembolsos inteiros informados no CSV. O backup do perfil inclui o Estúdio e a campanha.

## Bots e executável Windows

Abra `.openbot/openbot-windows-x64/OpenBotLocal.exe` e entre no [OpenBot local](http://127.0.0.1:3011/) com o token exibido no terminal. Mantenha o executável aberto para a fila avançar. O painel web pode ser fechado entre execuções. A pasta `resources` acompanha o executável no pacote.

- Em **Bots**, descreva o trabalho. O criador escolhe ou aceita um dos três modelos: **Programador**, **Editor de ebooks** ou **Analista de vendas**. A simulação verifica o fluxo e as ferramentas permitidas antes de ativar uma versão. A versão ativa permanece disponível enquanto um novo rascunho passa pela simulação.
- Em **Executar**, escolha os dados da tarefa. O Programador envia ao OpenCode Go os arquivos versionados selecionados, salva o patch em uma worktree e roda os testes Bun explicitamente aprovados no contêiner local. O Editor usa uma revisão fixa do ebook para gerar arquivos ou um rascunho de capítulo. O Analista gera um relatório local a partir dos dados importados da campanha e sugere uma próxima peça com base em compras atribuídas.
- A fila salva um checkpoint por etapa. Em uma falha temporária, repete somente a etapa segura dentro do limite de tentativas. Em uma interrupção durante uma ação ambígua, abre revisão. Pausa e cancelamento solicitados durante uma etapa valem depois do próximo checkpoint. Use o histórico de execução e baixe os arquivos no próprio painel Bots.
- O painel mostra a causa da última tentativa, o próximo horário de repetição e as conexões configuradas. Detectar o CLI do OpenCode indica que o executável foi encontrado. As chamadas que usam esse CLI ainda dependem da sessão do provedor.
- Para fazer backup ou atualizar, use o encerramento ordenado em **Bots** ou pressione **Ctrl+C** na janela do servidor. O OpenBot para de aceitar novas tarefas e deixa as etapas em curso registrarem o seu estado. Ao reabrir, a fila retoma as etapas recuperáveis. Se o tempo de encerramento for excedido, a recuperação usa o último checkpoint persistido.
- Use **Ensinar a partir desta execução** para registrar seu antes e depois. O piloto editorial aprende uma regra específica: abrir o capítulo com um exemplo prático fornecido. Ele usa duas correções distintas e uma terceira reservada para comparar o resultado antes da aprovação. É possível voltar à configuração inicial. Os outros modelos registram as correções para revisão. O rascunho de capítulo usa o OpenCode Console habilitado para uso geral.
- Na fila de publicações, **Conferir no Instagram** consulta o status de um contêiner já criado. Se a Meta confirmar a publicação, o status local é atualizado. Resultados inconclusivos seguem para revisão. [Reconciliação pela API da Meta](https://developers.facebook.com/documentation/instagram-platform/content-publishing#container-publishing-status)
- Feche o OpenBot antes de fazer backup. Use `OpenBot-Profile.cmd backup <perfil> <nova-pasta>` e `OpenBot-Profile.cmd restore <backup> <nova-pasta>`. O manifesto v6 cobre filas, bots, skills e seus arquivos. Worktrees de programação ficam na pasta `project-pilots`; uma proposta pendente restaurada vai para revisão.

Compile em Windows x64 com Bun 1.4.3 e as dependências do lockfile instaladas. O pacote embute o frontend e inclui o runtime, o Playwright e um manifesto SHA-256. Use `bun run local:exe` para criar a pasta de distribuição padrão, ou execute o compilador diretamente com uma pasta nova depois do build do frontend.

```powershell
bun run local:build
bun --no-env-file scripts/build-openbot-exe.ts .openbot/openbot-windows-x64
```
