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

## Avisos

- O Brave mostra a faixa **"uma extensão está depurando este navegador"** enquanto
  está anexado. É honesto e não dá para esconder.
- Uma aba só aceita um cliente de depuração: se o DevTools estiver aberto nela, o
  `attach` falha.
- A IA passa a agir **como você** em tudo que estiver logado. Trate o token como
  senha.
