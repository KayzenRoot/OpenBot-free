# Contribuir com o OpenBot-free

Abra uma [issue](https://github.com/KayzenRoot/OpenBot-free/issues) para relatar um problema ou discutir uma melhoria. Para erros no aplicativo Windows, informe a versão do instalador, a versão do Windows e os passos para reproduzir. Remova credenciais e dados de clientes dos exemplos.

Envie a alteração em uma pull request. Explique o comportamento esperado e registre as verificações feitas. Consulte o [roadmap](docs/roadmap-openbot-free.md) para identificar o escopo em andamento.

## Validação local

Na raiz do código, use Bun 1.4.3.

```powershell
bun install --frozen-lockfile
bun --no-env-file scripts/generate-app-config.ts
bun test local-backend
bun run local:build
```

Para alterações no aplicativo instalável, siga o [guia do Windows](docs/openbot-free-windows.md) e inclua o resultado do teste de instalação e abertura.
