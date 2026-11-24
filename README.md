# OpenBot-free

Aplicativo local para Windows com bots, ferramentas de programação, criação de ebooks e acompanhamento de campanhas orgânicas. É um fork independente do [OpenBot da CopilotKit](https://github.com/CopilotKit/OpenBot), distribuído sob a [licença MIT](LICENSE).

## Instalar no Windows

1. Baixe o arquivo `OpenBot-free-Setup-<versão>-x64.exe` na [última release](https://github.com/KayzenRoot/OpenBot-free/releases/latest).
2. Execute o instalador e abra **OpenBot-free** pelo menu Iniciar.
3. Conecte seu provedor quando quiser usar o DeepSeek V4.1 Flash. Os recursos locais, como editar e exportar ebooks, funcionam com os dados do próprio aplicativo.

O OpenBot-free abre em uma janela própria com Microsoft Edge WebView2. O instalador é por usuário e inclui o servidor local e o runtime .NET. Consulte os [requisitos e a verificação do instalador](docs/openbot-free-windows.md).

## O que você pode fazer

| Área | Fluxos da edição local |
| --- | --- |
| Programação | Conversas por projeto, análise de alterações e conexão com OpenCode |
| Ebooks | Projetos com capítulos e versões, prévia e exportação em EPUB e PDF |
| Campanhas | Planejamento de conteúdo, métricas de vendas e ações para contas conectadas |
| Bots e skills | Perfis de bots, gravação de fluxos e revisão de rascunhos de skills |

O servidor escuta no próprio computador e guarda o perfil em `%LOCALAPPDATA%\OpenBotLocal`. Chamadas ao modelo OpenCode e publicações usam os respectivos serviços externos. As integrações dependem das credenciais e permissões das contas que você conectar. Consulte os [fluxos e requisitos de cada integração](docs/openbot-local-plan.md).

## Desenvolvimento

O [guia do aplicativo Windows](docs/openbot-free-windows.md) cobre a compilação, o teste de instalação e os dados do perfil. O código correspondente a cada instalador está na tag da release.

- [Roadmap](docs/roadmap-openbot-free.md)
- [Contribuição](CONTRIBUTING.md)
- [Segurança](SECURITY.md)
- [Problemas e sugestões](https://github.com/KayzenRoot/OpenBot-free/issues)
