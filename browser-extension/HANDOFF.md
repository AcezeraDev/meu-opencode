# Handoff — navegador da IA via extensão (metade B)

> Cole isto num chat novo do OpenCode/Claude Code, dentro do projeto
> `C:\Users\aceze\opencode`, para continuar o trabalho. A **metade A** (a
> extensão que dirige o navegador real) já está pronta. Falta a **metade B**:
> ligar essa extensão no motor do OpenCode.

## Contexto do projeto

- Fork pessoal do OpenCode em `C:\Users\aceze\opencode`, empacotado como app
  desktop **OpenCode Personal** (Electron, servidor roda em **Node**, não Bun).
- Responda em **pt-BR**.
- **Nunca compile pelo Claude** (`script/personal-desktop/update.ts` /
  `install.ts`): a armadilha do MSIX manda o build para uma cópia virtual e o app
  não vê. O vigia recompila sozinho (~10 min) quando um arquivo observado muda, ou
  o usuário clica em **Atualizar → Reiniciar**. Config (`.jsonc`) não precisa de
  build; só de sessão nova.
- Typecheck é `bun run typecheck` em cada pacote (`tsgo`). O hook de pre-push roda
  `bun turbo typecheck` no monorepo. `bun test --timeout 90000 test/browser/` em
  `packages/opencode` (timeout alto ou o afterAll estoura no Windows).

## O objetivo e a linha

A IA já tem um navegador embutido (Edge headless via CDP, `browser_*`, painel ao
vivo). Sites com WAF anti-bot (ex.: Sala do Futuro / `edusp-api.ip.tv`) barram o
headless: user agent `HeadlessChrome` e `navigator.webdriver = true`. Já se trocou
para Brave visível (config `browser` global) — isso conserta o user agent, mas o
`navigator.webdriver` continua `true`, porque o navegador é dirigido pela porta de
depuração.

A solução real, sem trapaça: dirigir o **navegador de verdade do usuário** por uma
extensão `chrome.debugger`, como faz o Claude in Chrome.

**Linha que não se cruza:** nada de forjar `navigator.webdriver`, fabricar
fingerprint, mentir user agent, nem `--disable-blink-features=AutomationControlled`
e afins. A extensão passa por ser um navegador real, não por mentir. Se mesmo
assim um site detectar `chrome.debugger`, aceita-se o bloqueio.

## O que já existe (metade A) — pasta `browser-extension/`

Extensão MV3 completa e testável sozinha:

- `manifest.json` — permissões `debugger`, `tabs`, `storage`, host `<all_urls>`.
- `background.js` — service worker: WebSocket **cliente** que conecta em
  `ws://127.0.0.1:<porta>/extension`, autentica com token, e relaia CDP via
  `chrome.debugger`. Repassa eventos CDP e o ciclo de vida das abas.
- `popup.html` / `popup.js` — pareamento (porta + token) e status.
- `test/bridge.ts` — servidor de teste que faz o papel do OpenCode. **É a
  referência da metade B.** Rode `bun browser-extension/test/bridge.ts`.
- `README.md` — como carregar e testar.

### Protocolo do fio (JSON por mensagem WebSocket)

A extensão é **cliente**; o OpenCode é o **servidor** que escuta em localhost.
`targetId` = id da aba do Chrome, como string (opaco para o motor).

    ext  → server  { type: "auth", token }
    ext  → server  { type: "ping" }                              keepalive
    ext  → server  { id, type: "result", result }
    ext  → server  { id, type: "error", error }
    ext  → server  { type: "event", targetId, method, params }   evento CDP
    ext  → server  { type: "target", event, target }             created|updated|activated|removed
    ext  → server  { type: "detached", targetId, reason }
    server → ext   { id, type: "listTargets" }
    server → ext   { id, type: "attach", targetId }
    server → ext   { id, type: "detach", targetId }
    server → ext   { id, type: "command", targetId, method, params }
    server → ext   { id, type: "createTarget", url }
    server → ext   { id, type: "activateTarget", targetId }
    server → ext   { id, type: "closeTarget", targetId }

O ponto-chave: `chrome.debugger.sendCommand` expõe **os mesmos** métodos CDP que o
motor já usa (`Input.dispatchMouseEvent`, `Runtime.evaluate`,
`Page.captureScreenshot`, `Page.navigate`, `Page.startScreencast`…). Então só o
**transporte** muda.

### Antes de codar a metade B: rode o teste da metade A

`bun browser-extension/test/bridge.ts`, pareie o popup, e leia o
`navigator.webdriver` impresso. Se vier `false`, ótimo — é o que justifica todo o
caminho. Se vier `true` mesmo sob `chrome.debugger`, avise o usuário: o ganho fica
só em ser o perfil logado dele (cookies/sessão reais), não em esconder automação.

## Progresso da metade B (já feito nesta sessão, testado)

Já está no motor, com typecheck e testes passando, e **o servidor do fonte sobe
normalmente** (`preview_start server-4097`). Tudo atrás de `browser.mode ===
"extension"`, então o caminho de processo (padrão) fica idêntico.

- `cdp.ts` — interface `CDPTransport` (o que um `Tab` precisa do transporte).
- `tab.ts` — `connection` agora é `CDPTransport`; novo `Tab.attachTransport(id,
  targetId, connection, hooks)` para um transporte já conectado.
- `bridge.ts` (novo) — `Bridge` (segura a conexão da extensão, casa
  `result`/`error` por id, roteia `event`/`target`/`detached`) e
  `BridgeConnection` (implementa `CDPTransport` por aba). Também o `Service`
  `BrowserBridge` (LayerNode, por instância, token de `browser.extensionToken`).
- `session.ts` — modo `"extension"`: sem processo, adota alvos via
  `bridge.listTargets()`, reage a `bridge.onTarget`/`onState`, e `newTab`/
  `select`/`close` vão pela ponte. Só anexa às abas que a IA dirige (não badgea
  todas as abas do usuário).
- `config.ts` (core) — `browser.mode` e `browser.extensionToken`.
- Testes: `test/browser/bridge.test.ts` (8, socket falso) — a suíte
  `test/browser/` inteira passa (50).

### A rota WebSocket — FEITA (ponte global)

O usuário escolheu a **ponte global**. Está implementada e verificada:

- `bridge.ts` — o `Bridge` virou singleton de processo (`BrowserBridge.instance()`),
  fora de `InstanceState`; token semeado de `OPENCODE_BROWSER_EXTENSION_TOKEN` e
  reforçado por `browser.extensionToken` quando uma sessão inicia. `configure()`,
  `paired`.
- `groups/browser-bridge.ts` (novo) — `BrowserBridgeApi`: GET global
  `/experimental/browser/extension`, sem roteamento por diretório, sem auth de
  credencial (o token gateia).
- `handlers/browser-bridge.ts` (novo) — faz `ctx.request.upgrade`, liga o socket
  ao singleton (`accept`/`receive`/`disconnect`), fila de saída como no PTY.
- `api.ts` e `server.ts` — registram a API (camada com
  `Socket.layerWebSocketConstructorGlobal`, sem workspace routing).

Verificado no servidor do fonte (`bun run ./src/index.ts serve`): sobe limpo;
token certo mantém o socket aberto, errado é fechado; e com um "extension" falso
+ `browser.mode:"extension"` num diretório de teste, um `control navigate` fez o
motor rodar `listTargets → attach → Page/Runtime/Network/Log.enable →
Page.navigate → Runtime.evaluate` e voltar `running:true` com a aba. Um bug foi
corrigido no caminho: `ready(s)` distinto de `live(s)` (a ponte pode estar
conectada antes de a sessão ter adotado as abas).

### O que ainda falta (precisa da extensão de verdade / do usuário)

1. **Teste ponta a ponta com o Brave real**: instalar a extensão, parear, e ver
   (a) o `navigator.webdriver` real sob `chrome.debugger`, (b) o screencast
   (`Page.startScreencast`) chegando ao painel ao vivo, (c) um site real (Sala
   do Futuro). Nada disso dá para eu testar sem a extensão instalada.
2. **Ordem do pareamento / token**: o token só chega ao singleton quando uma
   sessão usa o navegador (abrir o painel basta) ou via a env
   `OPENCODE_BROWSER_EXTENSION_TOKEN`. Se a extensão tentar parear antes disso,
   leva 403. Decidir: semear o token de forma processo-global (env no build
   pessoal) ou expor o token no painel para o usuário copiar.
3. **Painel**: em modo extensão, a entrega ao Brave / `open_external` fica sem
   sentido (o navegador já é o do usuário); e caberia um aviso "pareie a
   extensão" quando `mode:"extension"` e a ponte não está conectada.
4. **Só anexa às abas que a IA dirige** (decisão de v1, para não badgear todas as
   abas do usuário). Se quiser adotar também as abas que o usuário abre, tratar
   `onBridgeTarget` "created".

### Como o transporte encaixa (referência)

A ideia é trocar o transporte sem reescrever o `tab.ts`. O `Tab` depende da
interface `CDPTransport` (`cdp.ts`): `connect()`, `send<T>(method, params)`,
`on(method, handler) → off`, `once(method, timeout)`, `close()`, `get connected`.

### 1. `bridge.ts` (novo) — o servidor da ponte

Um serviço que:

- Escuta WebSocket em `/extension` **na porta do servidor do OpenCode que já
  existe** (ver `server/routes/instance/httpapi`), não numa porta nova.
- Valida o `token` do `auth` (gerar um por instância; expor para o popup — ver
  passo 4).
- Mantém a conexão da extensão, casa `result`/`error` por `id`, e distribui
  `event`/`target`/`detached`.
- Expõe algo como:
  - `listTargets()`, `createTarget(url)`, `activateTarget(id)`, `closeTarget(id)`
  - `connection(targetId)` → um **`BridgeConnection`** que implementa a mesma
    interface do `CDPConnection`, mas onde `send(method, params)` vira
    `{type:"command", targetId, method, params}` e os eventos CDP daquele
    `targetId` alimentam os `on(...)`.
  - um jeito de assinar o ciclo de vida das abas (para o `session.ts`).

Copie a mecânica de id/pending/handlers do `Bridge` em `test/bridge.ts`.

### 2. `session.ts` — um modo "extensão"

Hoje `launch()` sobe um processo e liga o `CDPConnection` por aba. No modo
extensão:

- **Não** subir processo nem `waitForPort`. Em vez de `/json/list`, usar
  `bridge.listTargets()`; em vez de `Target.setDiscoverTargets`, usar os eventos
  `target` da extensão para `adopt`/remover abas.
- `adopt(targetId)` cria um `Tab` com um `BridgeConnection` no lugar do
  `CDPConnection` (ver passo 3).
- `newTab` → `bridge.createTarget`; `select` → `activateTarget`; `close` →
  `closeTarget`.
- `status.running` = extensão conectada. Se a extensão cair, refletir como parado.
- Decidir o disparo: config `browser.mode: "extension"` (ou `browser.extension:
  true`). Sem extensão conectada, ou cai no comportamento atual (lança navegador),
  ou reporta "abra o Brave com a extensão".

### 3. `tab.ts` — deixar o transporte injetável

`Tab.attach(id, targetId, wsUrl, hooks)` hoje cria um `CDPConnection(wsUrl)`.
Generalizar para receber uma conexão pronta (um `CDPConnection` **ou** um
`BridgeConnection`), já que ambos têm a mesma interface. Fora isso o `tab.ts` não
muda: os comandos CDP são idênticos.
Atenção: no modo extensão o `Page.enable`/`Runtime.enable`/`Network.enable` do
`prepare()` continuam necessários, chamados via `sendCommand`. O screencast
(`Page.startScreencast` + evento `Page.screencastFrame`) funciona pela extensão —
confirmar que os frames chegam pelo relay para o painel ao vivo.

### 4. Pareamento (token + porta) para o usuário

- Gerar o token no servidor e mostrá-lo (config, log, ou um cantinho do painel do
  navegador). O usuário cola no popup da extensão junto com a porta do servidor
  (a mesma do app; ver `.claude/launch.json` "server-4097" nos testes locais).
- Endpoint só em `127.0.0.1`. Sem token válido, recusar o socket.

### 5. Ferramentas e painel

Não devem precisar mudar: `browser_*` e o painel falam com o `Browser.Service`,
que passa a usar o transporte da extensão por baixo. Verificar
`open_external`/handoff (entrega ao Brave) — no modo extensão o "navegador do
usuário" já é o próprio, então a entrega provavelmente vira sem sentido ou some.

## Verificação da metade B

1. `bun run typecheck` em `opencode` (e nos pacotes tocados). Pre-push:
   `bun turbo typecheck`.
2. `bun test --timeout 90000 test/browser/` — adaptar/So os testes que assumem
   processo lançado; adicionar teste do `BridgeConnection` com um WebSocket falso
   (mesma ideia do navegador falso `where.exe` em `test/browser/session.test.ts`).
3. Ponta a ponta: `bun browser-extension/test/bridge.ts` prova a extensão;
   depois, com a metade B, criar sessão vazia (`POST /session?directory=…` na
   porta 4097, receita na memória `opencode-scope-redesign`) e dirigir o Brave
   real pelo painel.
4. **Confirmar `Get-Process brave` aberto antes** (armadilha do MSIX). Só testar
   login em site do próprio usuário, e o **login com a senha é o usuário quem
   faz** — não automatizar credenciais tiradas do banco de sessões.
5. Avisar: vigia recompila sozinho (~10 min) ou Atualizar → Reiniciar. Não rodar
   `update.ts`/`install.ts` pelo Claude.

## Memórias relevantes (já salvas)

- `opencode-browser` — motor `browser_*`, painel, entrega ao Brave, sites de
  teste, navegador falso dos testes.
- `opencode-personal-desktop` — build/vigia, servidor em Node (sem `Bun.*`),
  armadilha do MSIX.
- `opencode-git-push` — como enviar ao GitHub pessoal (foto na branch, hook de
  typecheck, symlinks).

## Estado atual do repositório (não commitado)

Metade B (esta sessão): `bridge.ts` (novo), `cdp.ts`, `tab.ts`, `session.ts`,
`config.ts` (core), `test/browser/bridge.test.ts` (novo). Falta só a rota WS.

Entrega ao Brave (sessão anterior): `blocked.ts` (novo), mudanças em
`session.ts`/`tab.ts`/`page.ts`/`install.ts`/`browser_navigate.ts`/
`browser_act.ts`, schemas da API, config `browser.external`, botão "Abrir no
Brave" no painel, i18n e testes (`test/browser/blocked.test.ts`, ampliação de
`session.test.ts`).

Config global `~/.config/opencode/opencode.jsonc` aponta o navegador da IA para o
Brave visível (`executablePath` + `headless:false` + `profile:"brave"`).

Nada commitado. `browser-extension/` está fora dos workspaces (não entra no
typecheck do turbo).
