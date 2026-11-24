# OpenBot-free para Windows

## Instalação

Use uma edição x64 do Windows 10 ou Windows 11 com o [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). Se o runtime estiver ausente, o instalador direciona para a página da Microsoft.

Baixe o instalador e seu arquivo `.sha256` na [release](https://github.com/KayzenRoot/OpenBot-free/releases/latest). No PowerShell, execute o comando abaixo na pasta do download e compare o valor retornado ao publicado no arquivo `.sha256`.

```powershell
Get-FileHash -Algorithm SHA256 .\OpenBot-free-Setup-0.1.0-x64.exe
```

O instalador inicial é distribuído sem assinatura Authenticode. O Windows pode apresentar um aviso de editor desconhecido. Baixe o arquivo diretamente do repositório e confira o SHA-256.

A instalação é feita em `%LOCALAPPDATA%\Programs\OpenBot-free`. Abra **OpenBot-free** pelo menu Iniciar. Para atualizar, feche o aplicativo e execute o instalador da nova versão. Para remover, use **Configurações → Aplicativos → Aplicativos instalados**. O perfil em `%LOCALAPPDATA%\OpenBotLocal` e os dados do WebView2 em `%LOCALAPPDATA%\OpenBotFree\WebView2` são preservados na atualização e na desinstalação.

## Modelo e integrações

O runtime local usa DeepSeek V4.1 Flash quando o OpenCode está configurado. Use `OPENCODE_API_KEY` no ambiente de usuário para a API Go ou configure o OpenCode CLI conforme o [guia local](openbot-local-plan.md). Fluxos de uso geral que recorrem ao modelo usam uma conexão OpenCode Console com `OPENCODE_CONSOLE_API_KEY`. Reinicie o aplicativo após alterar a configuração.

O WebView2 exibe o aplicativo. Alguns fluxos, como gravação do navegador e exportação de PDF, usam o Microsoft Edge separadamente. Consulte o [guia local](openbot-local-plan.md) para os pré-requisitos de cada fluxo.

## Compilar

Use Windows x64, Bun 1.4.3, o SDK .NET 8 para Windows e o `tar.exe` do Windows. Faça checkout do código da tag ou da branch que contém o aplicativo desktop.

```powershell
bun install --frozen-lockfile
bun run local:desktop 0.1.0
```

O comando informa o caminho do instalador em uma pasta nova sob `.openbot`. O arquivo `.sha256` fica ao lado do executável. Defina `OPENBOT_DOTNET_EXECUTABLE` com o caminho absoluto do SDK se ele estiver fora do `PATH`.
