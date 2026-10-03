# Navegador do agente

## O que já existia (preservado)
- Motor próprio sobre CDP (`packages/opencode/src/browser/`), sem Playwright.
- **Modo extensão** (o seu): a IA usa o seu Brave pela extensão `browser-extension/`, **sempre visível**, com cursor de mão humana na cor do projeto e borda de "IA no controle". **Modo processo**: abre um Edge/Brave próprio (`browser.headless` controla se aparece).
- Ferramentas: `browser_navigate`, `browser_act`, `browser_batch`, `browser_snapshot`, `browser_screenshot`, `browser_inspect`, `browser_script`, `browser_notes`.
- Painel ao vivo no app (botão do globo): página em tempo real, abas, barra de endereço, "Parar a IA", linha do tempo com print de cada passo, replay em vídeo ("Assistir").
- Pausa para você em login, captcha ou pagamento; recusa de cookies não essenciais; bloqueio de rastreadores; leitura de PDF e Office; memória por site.

## Testar os próprios sites — `site_check` (novo)
Código: `src/browser/qa.ts`, ferramenta `src/tool/site_check.ts`.

Abre uma aba própria (não mexe na página em que você está) e passa por cada página em **computador (1366px), tablet (768px) e celular (390px)**:
- erros de JavaScript, `console.error`, requisições com falha e HTTP 4xx/5xx (o `favicon.ico` é ignorado);
- **rolagem horizontal**, dizendo quais elementos passam da tela e até onde ("div.banner vai até 632px numa tela de 390px");
- imagens quebradas; **contraste** abaixo do mínimo, com a razão ("1,92:1, mínimo 4,5:1"); botões/links menores que 32px no celular; página sem `<title>`/`<h1>` ou quase vazia;
- **print** de cada página em cada tamanho.

Visita os links do próprio site a partir da primeira página (padrão 4, máx. 10, mais as rotas pedidas em `paths`) e **nunca** segue links de sair/excluir nem arquivos. A simulação de tamanho de tela é ligada só durante a checagem e **sempre desfeita** no fim (o painel ao vivo não muda o tamanho das páginas, por um motivo registrado no código).

Cada checagem fica em `~/.local/share/opencode/site-checks/<id>/` (`report.json` + prints). A próxima checagem do mesmo site mostra **antes × depois** ("Antes: 4 erros, 2 avisos").

Medição no Chrome em tamanho de celular: o navegador encolhe uma página larga demais para caber, então a largura da tela usada na conta é a do aparelho (390px), não `innerWidth`; senão a rolagem horizontal ficaria escondida.

## Avaliação visual — `visual_review` (novo)
Código: `src/evaluate/vision.ts`, ferramenta `src/tool/visual_review.ts`.

Manda até 6 prints da checagem (todos os tamanhos da 1ª página e o computador das outras), mais os problemas medidos, para um modelo com visão: `models.vision` se configurado, senão o modelo da conversa se ele lê imagens. Resposta em JSON:
```json
{
  "status": "needs_changes",
  "score": 6,
  "issues": [{ "severity": "high", "viewport": "mobile", "page": "/", "area": "banner",
               "problem": "O banner passa da borda direita em 390px e corta o texto",
               "fix": "max-width: 100% e padding lateral de 16px" }],
  "strengths": ["..."],
  "suggestions": ["..."],
  "requires_fix": true
}
```
Regras dadas ao modelo: cada problema cita elemento, tamanho de tela e o que se vê; nada vago; só o que aparece nos prints. Se ele listar problema `high`/`medium` e disser "aprovado", o software corrige para `needs_changes`. A avaliação fica salva em `review.json` junto da checagem.

## Autocorreção com limite
Ciclo: criar → `site_check` → `visual_review` → corrigir → `site_check` de novo → … O `visual_review` conta as rodadas do pedido atual; ao chegar em `limits.max_fix_rounds` (padrão 3) ele instrui a IA a **parar de corrigir** e mostrar o resultado e os problemas restantes. Os limites gerais do laço (`docs/SECURITY.md`) também valem.
