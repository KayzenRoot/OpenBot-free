# Plano de melhorias do OpenBot-free

O OpenBot-free é a edição local para programar, produzir ebooks e operar campanhas orgânicas. A primeira publicação parte do commit `bc424a7e691bdb905ec9c36be227e5a5bc109e7b`. Esse recorte tem executável portátil no Windows, perfil SQLite, três modelos de bots e recuperação de tarefas por etapa. A suíte local passou com 97 testes. A validação anterior do executável incluiu a retomada de um ebook após o processo ser encerrado em plena exportação e um patch real com DeepSeek testado em contêiner. [Guia de uso e compilação](openbot-local-plan.md)

A ordem abaixo prioriza a instalação e a confiabilidade do runtime. Depois vêm o aprendizado com evidência, a qualidade dos ebooks e a medição de vendas reais. Os critérios indicam como validar entregas futuras.

## P0 — Instalação e operação confiável

- [ ] **OBF-001 · CI da edição local.** Criar um workflow próprio para clone limpo no Windows x64. Fixar Bun e dependências, validar TypeScript, Biome, segredos, testes, pacote e manifesto SHA-256. Revisar os workflows herdados antes de ativar GitHub Actions. **Aceite** — a CI roda com credenciais de teste e sem autorização para publicar. O executável inicia a partir do ZIP extraído em outro caminho, carrega o frontend e exporta um arquivo pelo Edge.
- [ ] **OBF-002 · Fila e auto-healing.** Mostrar a etapa ativa, a causa da interrupção, o próximo horário de tentativa e o escopo da automação. Adicionar encerramento ordenado, recuperação de tarefas pendentes e um resumo local do estado das conexões. **Aceite** — encerrar o processo durante EPUB, PDF e análise de CSV, retomar após reiniciar e confirmar que cada artefato final é registrado uma vez. Para publicação externa, simular uma resposta perdida e comprovar que a fila consulta o estado antes de qualquer decisão.
- [ ] **OBF-003 · Perfil, credenciais e atualização.** Guiar o primeiro uso, testar a conexão do OpenCode e guardar credenciais no Windows Credential Manager ou com DPAPI. Testar migrações SQLite, backup, restauração e retorno à versão anterior em perfil separado. **Aceite** — recuperar um perfil com conversas, bots, versões, relatórios e artefatos. Segredos ficam no armazenamento de credenciais e o teste confirma sua ausência em logs, backups e arquivos públicos. Assinatura Authenticode entra quando houver certificado.

## P1 — Programação, aprendizado e ebooks

- [ ] **OBF-004 · Modo Projeto com mais contexto.** Mostrar estrutura do repositório, commit de origem, arquivos autorizados e estratégia de testes antes de gerar a proposta. Acrescentar revisão por arquivo e aplicação do patch mediante aprovação explícita. **Aceite** — resolver uma tarefa de referência com diff e testes isolados. Se a branch avançar ou a pasta tiver alterações conflitantes, exibir a divergência antes de aplicar. Depende de OBF-001 e OBF-003.
- [ ] **OBF-005 · Auto Bot Creator com etapas configuráveis.** Transformar o pedido em proposta versionada com entradas, ferramentas permitidas, etapas, limites e verificação de sucesso. Acrescentar agendamento local, simulação com dados de teste, cópia de configuração e revisão antes de ativar. **Aceite** — criar Programador, Editor e Analista a partir de descrições. Cada bot demonstra sua tarefa em simulação e pede aprovação quando a execução prevista tiver efeito externo. Depende de OBF-002.
- [ ] **OBF-006 · Aprendizado por projeto e campanha.** Associar correções a uma execução, uma versão do bot e um arquivo de resultado. Adicionar regras verificáveis além da abertura editorial, como respeitar uma estrutura de capítulos, limitar arquivos alterados ou fundamentar recomendações em pedidos confirmados. **Aceite** — comparar a skill atual com a candidata usando casos reservados, registrar regressões e repetir os testes após reverter uma promoção. Memórias de um projeto ficam no escopo daquele projeto. Depende de OBF-002 e OBF-005.
- [ ] **OBF-007 · Estúdio editorial.** Adicionar importação de texto, estilos editoriais reutilizáveis, gestão de capa, revisão por capítulo e exportação por edição. Guardar referências, idioma, metadados de acessibilidade e origem das imagens utilizadas. **Aceite** — produzir um ebook completo e uma amostra a partir de um projeto salvo. O EPUB passa no EPUBCheck e a amostra abre em leitor móvel com sumário e links operantes. Depende de OBF-001.

## P1 — Vendas orgânicas com dados reais

- [ ] **OBF-008 · Checkout e pedidos.** Integrar primeiro a plataforma em que o ebook será vendido. Sincronizar pedidos e reembolsos com IDs estáveis, validar a origem dos eventos e reconciliar o relatório local com o da plataforma. **Aceite** — em sandbox, reprocessar o mesmo evento sem duplicar pedidos e demonstrar compra aprovada, cancelamento e reembolso parcial ou integral conforme suporte da plataforma. O fluxo de teste usa pedidos e contas de simulação. Depende de OBF-003.
- [ ] **OBF-009 · Campanhas e atribuição.** Vincular ebook, edição, amostra, oferta, conteúdo e origem em cada campanha. Criar variantes de página, preparar um calendário orgânico e importar as métricas de uma fonte configurada. **Aceite** — rastrear em ambiente de teste o caminho de um conteúdo até uma compra confirmada, registrar origem desconhecida quando o checkout não a fornecer e comparar canais por compras e reembolsos. Depende de OBF-007 e OBF-008.
- [ ] **OBF-010 · Publicações e revisão.** Melhorar prévia, fuso horário, confirmação da conta, conferência do resultado e trilha de aprovação. Conectar primeiro a conta profissional do Instagram e validar com conteúdo aprovado. Manter a preparação manual para grupos do Facebook. **Aceite** — uma publicação aprovada recebe confirmação externa, consultas de recuperação não repetem a ação e o histórico registra conta, revisão, horário e resultado. Depende de OBF-002 e OBF-003.

## P2 — Uso diário e expansão

- [ ] **OBF-011 · Central de operação.** Reunir bots, tarefas, aprovações, arquivos, filas e erros em uma visão diária. Adicionar favoritos, busca, atalhos acessíveis e visão de atividade por projeto. **Aceite** — do painel inicial, abrir a etapa que falhou, baixar o resultado e encontrar a aprovação correspondente. Validar o fluxo somente com teclado e em tela estreita. Depende de OBF-002.
- [ ] **OBF-012 · Extensões e plataformas.** Documentar um contrato para ferramentas registradas, compatibilidade de skills e permissões de conectores. Avaliar o mesmo pacote local em outros sistemas depois da validação no Windows. **Aceite** — adicionar um conector de referência com simulação, escopo visível, revogação e testes por plataforma suportada. Depende de OBF-001, OBF-003 e OBF-005.

## Ordem da primeira entrega

1. Fazer **OBF-001** e **OBF-002** para que cada alteração tenha build e recuperação reproduzíveis.
2. Avançar **OBF-003** e **OBF-007** para estabilizar a instalação e lançar um ebook piloto.
3. Conectar **OBF-008** e **OBF-009** quando houver uma plataforma de venda escolhida. Usar o piloto para medir cliques, compras confirmadas e reembolsos por canal.
4. Evoluir **OBF-004**, **OBF-005** e **OBF-006** com tarefas de referência e correções reais revisadas.

Para fechar uma entrega, registrar o commit, os comandos que rodaram, o resultado reproduzível e as dependências que ainda exigem conta, certificado ou autorização. A primeira meta operacional é concluir uma correção de código revisada e um ebook com amostra, página, compra de teste e atribuição demonstrada.
