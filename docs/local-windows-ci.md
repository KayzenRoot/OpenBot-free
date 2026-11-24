# Validação Windows do OpenBot-free

A validação da edição local usa Windows x64, Edge e Bun 1.4.3. Ela instala as dependências do lockfile, gera a configuração de build e roda os testes do backend local e dos limites do cliente. A checagem de segredos examina a mudança em revisão. O pacote gerado usa dados sintéticos no teste de execução. [Workflow](../.github/workflows/openbot-free-windows.yml)

## Rodar no computador

Em um clone de trabalho novo, a partir da raiz do repositório:

```powershell
bun install --frozen-lockfile
bun --no-env-file scripts/generate-app-config.ts
bun x --no-install biome check --error-on-warnings local-backend app/src/local scripts/build-openbot-exe.ts scripts/test-openbot-exe.ts package.json
bun x --no-install tsc --project local-backend/tsconfig.json
bun x --no-install tsc --project app/tsconfig.json
$env:OPENBOT_TEST_EDGE = '1'
bun test --dots ./local-backend ./api/client-boundary.test.ts
bun run local:exe
bun --no-env-file scripts/test-openbot-exe.ts .openbot/openbot-windows-x64
```

O teste portátil confere o manifesto SHA-256, extrai o pacote em outro caminho, inicia o executável com um perfil temporário e verifica os arquivos da interface e uma exportação pelo Edge. O compilador exige uma pasta de destino nova para que cada manifesto corresponda a uma compilação.

## Workflows herdados

O repositório público preserva os workflows do template. A CI original usa pressupostos sobre o upstream, incluindo a publicação de imagens e o histórico de versões distribuídas. A árvore também inclui trabalhos de assinatura, publicação e agendamentos. A automação do repositório permanece desativada no GitHub. Antes da ativação, desabilite os workflows herdados que podem executar nesse repositório e confirme que o workflow local pode rodar com acesso de leitura e sem credenciais de produção.

| Finalidade | Workflows herdados |
| --- | --- |
| CI, contribuições e compatibilidade | `ci.yml`, `contributor-ci.yml`, `model-compat.yml`, `model-lock.yml` |
| Segurança e sincronização upstream | `security-floor.yml`, `security_zizmor.yml`, `upstream-upgrade.yml` |
| Desktop, assinatura e atualização | `desktop.yml`, `desktop-build.yml`, `desktop-signing.yml`, `desktop-macos-signing.yml`, `desktop-shell-updates.yml`, `desktop-upgrade.yml`, `downloads-sync.yml` |
| Distribuição e imagens | `images.yml`, `internal-build.yml`, `publish-release.yml`, `release.yml` |

O workflow dedicado valida o pacote em perfil temporário. Distribuição, assinatura e configuração de credenciais são etapas separadas do build de CI.
