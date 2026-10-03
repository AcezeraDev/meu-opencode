# Arquitetura do agente

Como as peças se encaixam hoje. O ponto de partida (o que já existia antes) está em [`ARCHITECTURE_ANALYSIS.md`](../ARCHITECTURE_ANALYSIS.md).

```
Você
 ↓
App (packages/app, desktop Electron) — compositor, conversa, painel do navegador,
     Pausar/Continuar, avaliação de cada resposta, paleta (exportar dataset)
 ↓ HTTP + eventos (SSE)
Servidor (packages/opencode, roda em Node no desktop)
 ↓
Laço do agente — session/prompt.ts
 │  1º passo: lições parecidas anexadas ao pedido (memory/lessons.ts)
 │  cada passo: limites (session/budget.ts) · pausa (session/pause.ts)
 │             · proteção contra compactação infinita
 │  modelo decide → ferramentas executam → resultado volta ao modelo
 ↓
Modelos — provider/provider.ts (AI SDK)
 │  externos (Anthropic, OpenAI, Google, OpenRouter, Roteia, OpenAI-compatível…)
 │  Ollama local (provider/ollama.ts: API nativa, contexto real, perfil enxuto)
 │  papéis: coding · fast · reasoning · vision · evaluation (provider/roles.ts)
 ↓
Ferramentas — tool/registry.ts
    arquivos (read/write/edit/glob/grep) · terminal (shell + permission/command-risk.ts)
    navegador (browser_*) · site_check (browser/qa.ts) · visual_review (evaluate/vision.ts)
    websearch (Parallel/Exa, com fontes) · webfetch · lessons · todowrite · task (subagentes)
 ↓
Dados — SQLite do app (sessões, mensagens, ferramentas, notas em session.metadata)
        ~/.local/share/opencode/: lessons/, site-checks/, browser-sites/, …
        Downloads/opencode-dataset-*.jsonl (exportação)
```

## O ciclo de trabalho

O laço do opencode já fazia: receber pedido → modelo decide → ferramenta executa → resultado volta → repetir até o modelo parar. O que foi acrescentado é **software** em volta desse laço, não só instrução no prompt:

| Etapa | Quem faz |
|---|---|
| Entender o contexto | lições anexadas automaticamente; `AGENTS.md`; busca (`grep`/`glob`) em vez de carregar o repositório inteiro |
| Planejar | `todowrite` (lista visível no app) e o agente `plan` (pode usar `models.reasoning`) |
| Pesquisar | `websearch` com fontes, orientado a consultar a documentação atual quando houver dúvida |
| Executar | ferramentas; o terminal passa pelo classificador de risco antes de rodar |
| Testar | `site_check` no navegador visível, em 3 tamanhos de tela |
| Avaliar | `visual_review` com resposta JSON; a regra "problema grave ⇒ precisa corrigir" é aplicada pelo software |
| Corrigir e testar de novo | o próprio laço, até `limits.max_fix_rounds` (3) |
| Saber parar | limites de passos, tempo, erros seguidos e uso por ferramenta: ao atingir, o passo final roda **sem poder chamar ferramentas** |
| Aprender | `lessons` (memória operacional) e, a longo prazo, o dataset dos turnos aprovados |

## Observabilidade
O app já mostra cada ferramenta como um cartão com título operacional ("Testando…", "Avaliando prints de…", "Clicou em “Enviar”"), tempos e prints. O raciocínio interno do modelo não vai para o dataset. Logs: `~/.local/share/opencode/log/`.

## Configuração (`~/.config/opencode/opencode.jsonc`)
| Chave | Para quê | Documento |
|---|---|---|
| `model`, `small_model`, `models.{coding,fast,reasoning,vision,evaluation}` | qual modelo faz o quê | MODELS.md |
| `provider.ollama.options.{host,contextWindow,maxTokens,temperature,keepAlive,think,lean}` | Ollama | MODELS.md |
| `limits.{max_steps,max_minutes,max_consecutive_errors,max_calls_per_tool,max_fix_rounds}` | quando parar | SECURITY.md |
| `permission.shell_risky` | comandos que pedem confirmação | SECURITY.md |
| `memory.enabled` | lições | MEMORY.md |
| `websearch.enabled`, `websearch.provider` | pesquisa | — |
| `browser.*` | navegador (modo extensão/processo, visível) | BROWSER.md |

## Rotas novas do servidor
- `GET /experimental/ollama/status`: Ollama, modelos instalados, hardware e sugestão.
- `POST /experimental/dataset/export?min=approved|excellent`: grava o dataset em Downloads.

## Dataset (formato)
Uma linha JSON por turno avaliado como Aprovado ou Excelente:
```json
{"messages":[{"role":"user","content":"Crie o arquivo ola.txt com funcionou"},
             {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"write","arguments":"{...}"}}]},
             {"role":"tool","tool_call_id":"call_1","content":"Wrote file"},
             {"role":"assistant","content":"Pronto, criei ola.txt."}],
 "meta":{"session":"ses_…","turn":"msg_…","rating":"excellent","model":"ollama/qwen3.5:4b","directory":"…","title":"…"}}
```
É o formato de chat com ferramentas aceito pelas bibliotecas de fine-tuning (ex.: TRL). O guia de treino fica em `training/` (próxima etapa).

## Restrições de engenharia
- No desktop o servidor roda em **Node**: nada de `Bun.*` em código de servidor (há teste e o smoke `script/browser-smoke.ts`).
- Mudanças vão primeiro para o worktree `opencode-wip`; a `dev` é compilada e publicada sozinha.
- O que muda o que o modelo vê é medido antes (ex.: perfil enxuto e cache do Ollama).
