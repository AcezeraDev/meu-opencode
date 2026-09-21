# OpenCode Browser Bridge (extensão)

Deixa o agente do OpenCode dirigir o **seu** navegador de verdade (Brave/Chrome,
com o seu perfil e os seus logins) pelo protocolo DevTools, via `chrome.debugger`
— sem porta de depuração no navegador e **sem forjar nada**. Ele passa por sites
com proteção anti-bot pelo mesmo motivo que você passa: é o seu navegador real.

Este é o **lado do navegador** (metade A). Ligar isto no motor do OpenCode é a
metade B — veja `HANDOFF.md`.

## Instalar no Brave

1. `brave://extensions`
2. Ligue **Modo de desenvolvedor** (canto superior direito).
3. **Carregar sem compactação** → escolha esta pasta (`browser-extension`).
4. Fixe a extensão se quiser ver o status pelo popup.

## Testar sozinho (a ponte de teste)

```bash
bun browser-extension/test/bridge.ts
```

Ele imprime uma **porta** e um **token**. Abra o popup da extensão, preencha os
dois, clique em **Salvar e conectar**. A ponte então lista as abas, anexa à ativa,
lê `navigator.userAgent` / `navigator.webdriver` e abre o `example.com`, salvando
`browser-extension/test/bridge-shot.png`.

O `navigator.webdriver` impresso aí responde a pergunta que ficou em aberto: se
sob `chrome.debugger` ele vem `false`, este caminho resolve o bloqueio da Sala do
Futuro sem mentira nenhuma.

## Usar com o OpenCode de verdade

O motor já fala com a extensão (ponte global, rota
`/experimental/browser/extension`). Para ligar:

1. Na config (`~/.config/opencode/opencode.jsonc`): `"browser": { "mode":
   "extension", "extensionToken": "<um-segredo>" }`.
2. No popup da extensão: a **porta do servidor do OpenCode** e o **mesmo token**.
3. Abra o painel do navegador uma vez (ou defina a env
   `OPENCODE_BROWSER_EXTENSION_TOKEN`) para o token entrar em vigor, então pareie.

Detalhe de v1: o token só chega à ponte quando uma sessão usa o navegador ou pela
env; parear antes disso dá 403. Veja `HANDOFF.md`.

## Depois de atualizar esta pasta

O Brave não relê a extensão sozinho: em `brave://extensions`, clique no ↻ do
cartão "OpenCode Browser Bridge" (a versão aparece ali). Desde a 0.2.0 o `attach`
leva a lista de eventos CDP que o OpenCode lê, e a extensão só repassa esses.
Uma extensão antiga continua funcionando, só repassa tudo.

Desde a 0.5.0 o `attach` também leva, por evento, quais campos o OpenCode lê, e
a extensão poda o resto antes de mandar. Um `Network.responseReceived` inteiro
traz todos os cabeçalhos, os tempos e a cadeia de certificados: abrir um site de
notícias comum empurrava 1,1 MB de eventos em 12 s pelo mesmo socket em que o
clique e a resposta dele passam; podado dá 292 KB. Uma extensão antiga continua
funcionando, só manda tudo.

Desde a 0.3.0 existe o pedido `goBack` (`chrome.tabs.goBack`, sem debugger).
Quando a IA clica num link de PDF, o Brave abre o visualizador de PDF dele e
expulsa o debugger da aba; o OpenCode lê o PDF baixando o arquivo e usa o
`goBack` para devolver a aba à página anterior e retomar o controle. Sem ele, a
IA continua numa aba nova.

## Avisos

- O Brave mostra a faixa **"uma extensão está depurando este navegador"** enquanto
  está anexado. É honesto e não dá para esconder.
- Uma aba só aceita um cliente de depuração: se o DevTools estiver aberto nela, o
  `attach` falha.
- A IA passa a agir **como você** em tudo que estiver logado. Trate o token como
  senha.
