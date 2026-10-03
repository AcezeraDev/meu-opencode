# Análise de arquitetura — opencode personal

Revisão feita em 2026-10-01 sobre o código real (worktree `opencode-wip`, branch `browser-reliability`, igual à `dev` no commit `52e7627e01`).
Objetivo: saber o que já existe antes de evoluir o opencode personal para um agente de desenvolvimento próprio, sem duplicar sistemas.

Legenda: **✅ existe e funciona** · **🟡 parcial** · **❌ falta**

---

## 1. Visão geral do que existe

O opencode personal é um fork do OpenCode (monorepo Bun + Turbo, TypeScript, Effect). Ele **já é um agente com ferramentas**, não um chat simples. O laço principal já faz: receber pedido → chamar modelo → executar ferramentas → devolver resultado ao modelo → repetir até o modelo parar.

```
Usuário
  ↓
packages/desktop (Electron)  ── packages/app (SolidJS, layout "Espaços coloridos")
  ↓ HTTP + SSE (servidor embutido, roda em NODE no desktop)
packages/opencode  (servidor: sessões, agentes, ferramentas, navegador)
  ↓
session/prompt.ts  (laço do agente)  →  provider/ (AI SDK + models.dev)
  ↓
tool/registry.ts  →  arquivos · shell · navegador · web · MCP · plugins · subagentes
  ↓
SQLite (opencode-dev.db) · snapshots git · arquivos em ~/.local/share/opencode
```

| Camada | Onde | Estado |
|---|---|---|
| Frontend desktop | `packages/desktop` (Electron, atualizador pessoal, bandeja, atalho global) | ✅ |
| Interface | `packages/app`, `packages/session-ui`, `packages/ui` (compositor V2, painel do navegador, Espaços) | ✅ |
| TUI | `packages/tui` | ✅ (não é o uso principal) |
| Servidor | `packages/opencode/src/server` (HttpApi do Effect, SSE de eventos) | ✅ |
| Núcleo compartilhado | `packages/core` (config v1, models.dev, sessão, permissão, pty, ripgrep) | ✅ |

**Restrição crítica:** no app desktop o servidor roda em **Node**, não Bun. Nenhum `Bun.*` em código de servidor (já quebrou o navegador uma vez). Há teste (`test/browser/node-runtime.test.ts`) e o smoke `script/browser-smoke.ts`.

---

## 2. Item por item do pedido

### 2.1 Agent loop — 🟡
- **Existe:** `session/prompt.ts` (~1700 linhas) faz o ciclo modelo → ferramentas → modelo; `session/processor.ts` processa o stream e as chamadas. Compactação automática (`compaction.ts`, `overflow.ts`, teto `compaction.max_context` 100k), retry com backoff (`retry.ts`), fila de mensagens, subagentes (`tool/task.ts`), detecção de *doom loop* (mesma ferramenta com a mesma entrada 3× → pede permissão).
- **Limites:** `agent.steps` existe por agente, mas o padrão é **infinito**. Não há limite de tempo, de erros consecutivos nem de uso por ferramenta.
- **Falta:** fases explícitas (planejar / executar / avaliar), critério de parada além de "o modelo parou", orçamento por execução.

### 2.2 Planejamento — 🟡
- **Existe:** ferramenta `todowrite` (lista de tarefas visível no app), agente `plan` (só leitura) e `plan_enter`/`plan_exit`. O ETA (`session/pace.ts`) já lê o progresso das tarefas.
- **Falta:** planner como lógica de software (o plano hoje é só o que o modelo escreve), replanejamento guiado por falhas.

### 2.3 Executor — 🟡
- **Existe:** a execução de ferramentas é software de verdade (registro, permissões, timeouts, truncamento de saída, estados pending/running/completed/error em cada `part`).
- **Falta:** camada que verifique "a ação funcionou?" de forma independente do modelo (ex.: build passou, página sem erro de console).

### 2.4 Evaluator / avaliação visual — ❌
- **Existe a matéria-prima:** prints de cada passo do navegador (`browser/trail.ts`), `browser_screenshot` com marcas, console e rede via CDP.
- **Falta:** `VisionEvaluator` com resposta estruturada (`status`, `issues`, `requires_fix`), viewports desktop/tablet/celular, comparação antes × depois, ciclo de autocorreção com limite.

### 2.5 Provedores de IA — ✅ com uma lacuna grande (Ollama)
- **Existe:** abstração completa em `provider/provider.ts` sobre o AI SDK v3: ~25 SDKs (`@ai-sdk/anthropic`, `openai`, `google`, `openai-compatible`, OpenRouter, Groq…), catálogo models.dev, provedores personalizados na config, descoberta de modelos (`discoverModels`), Roteia nativa (`provider/roteia.ts`), login por plugin (ChatGPT, Copilot). Isso **já é** o `LLMProvider` pedido — não criar outro.
- **Roteamento de modelos 🟡:** existe `model` (global), `small_model` (títulos/resumos), `model` por agente e por subagente. Não existem papéis `vision_model` / `evaluation_model` / `fast_model`.
- **Ollama ❌ (lacuna real, medida):** não há provedor `ollama` local (models.dev só tem `ollama-cloud` e `lmstudio`). Configurado à mão como OpenAI-compatível, o endpoint `/v1` do Ollama 0.35 **roda com 4096 tokens de contexto e ignora `num_ctx`** (testado nesta máquina com `options`, `num_ctx` e `extra_body`: sempre 4096). O prompt de sistema do opencode passa de 10 mil tokens, então o modelo local recebe o pedido truncado em silêncio. Não há detecção de disponibilidade nem lista automática de modelos instalados.
- **Modelo próprio futuro:** funciona naturalmente se o Ollama for de primeira classe (modelo treinado → GGUF → `ollama create` → aparece no seletor).

### 2.6 Navegador — ✅ (ponto mais forte do projeto)
- `packages/opencode/src/browser/`: CDP direto (sem Playwright), modo **processo** (Edge/Brave próprio) e modo **extensão** (Brave do usuário via `browser-extension/`, MV3). Ferramentas `browser_navigate/act/batch/snapshot/screenshot/inspect/script/notes`.
- Visível: no modo extensão (o do usuário) é sempre visível, com cursor humano na cor do projeto e borda de "IA no controle". No modo processo o padrão ainda é `headless: true`.
- Painel ao vivo no app (screencast em Worker), linha do tempo com print de cada passo, replay em vídeo, botão "Parar a IA", pausa para o usuário em login/captcha/pagamento.
- Memória por site (`browser/site.ts`: anotações, programas e rotinas salvas sozinhas), leitura de PDF/Office, bloqueio de rastreadores, recusa de cookies.
- **Falta para "testar os próprios sites":** rotina pronta de QA (subir dev server, achar a URL, varrer páginas, coletar erros de console/rede, prints em 3 viewports) e o avaliador visual.

### 2.7 Terminal — 🟡
- **Existe:** ferramenta `shell` (bash/PowerShell), PTY (`core/pty`), jobs em segundo plano (`background/job.ts`), aridade de comandos para regras de permissão (`permission/arity.ts`).
- **Risco:** a permissão padrão é `"*": "allow"` (`agent/agent.ts`). **Qualquer comando roda sem perguntar**, inclusive `rm -rf`, `format`, `Remove-Item -Recurse C:\Windows`, `git push --force`. Não há classificação SAFE / CONFIRM / BLOCKED.

### 2.8 Sistema de arquivos — ✅
- `read`, `write`, `edit`, `apply_patch`, `glob`, `grep` (ripgrep), `lsp`. Leitura de `.env` pede permissão; fora da pasta do projeto pede permissão (`external_directory`).

### 2.9 Git — 🟡
- **Existe:** snapshots automáticos num repositório git sombra por projeto (`snapshot/`) com reverter/desfazer por mensagem (`session/revert.ts`) — isso **já é** o checkpoint pedido. `project/vcs.ts` lê branch/diff para o app. Git normal via shell.
- **Falta:** regra de software contra `git push` automático (hoje depende só da permissão, que é allow).

### 2.10 Pesquisa web — 🟡
- `websearch` (Exa ou Parallel via MCP) existe mas só liga com `websearch.enabled` ou flag; `webfetch` funciona. Sem camada que exija fontes e sem cache de pesquisas.

### 2.11 Memória — 🟡
- **Existe:** histórico completo de sessões em SQLite (`opencode-dev.db`: sessões, mensagens, partes com entrada/saída/tempo de cada ferramenta); instruções persistentes `AGENTS.md` (global em `~/.config/opencode/AGENTS.md` e por projeto); memória por site do navegador; resumos de compactação.
- **Falta:** memória operacional entre sessões (`LessonsMemory`: problema → causa → solução → resultado), busca de lições antes de agir, preferências do usuário estruturadas.

### 2.12 Histórico de execuções — 🟡
- Cada sessão/mensagem/ferramenta já tem ID, tempos, entradas, saídas e erros no SQLite. Falta o conceito de **execução** (pedido → plano → passos → resultado final) com status e avaliação.

### 2.13 Feedback e dataset — ❌
- Não há "Aprovado / Precisa melhorar" por execução nem exportador JSONL. Há `opencode export` (sessão em JSON) e `opencode stats` como base.

### 2.14 Segurança e autonomia — 🟡
- **Existe:** sistema de regras allow/ask/deny com curingas, modos de permissão no compositor (Manual, Automático, Aceitar edições, Plano, Ignorar permissões) em `session.metadata.permissionMode`, herdados por subagentes.
- **Falta:** níveis SAFE / NORMAL / AUTONOMOUS mapeados nesses modos, lista de comandos bloqueados que nenhum modo libera.

### 2.15 Interrupção — 🟡
- Cancelar ✅ (abort da sessão, botão no app e no painel do navegador). Continuar ✅ (mandar nova mensagem; "Continuar de onde parou"). **Pausar ❌** (não existe "não execute novas ferramentas até eu mandar").

### 2.16 Observabilidade e logs — 🟡
- Cada ferramenta aparece como cartão com título operacional ("Clicou em “Enviar”"), tempos, print; eventos por SSE; gasto do dia em R$, ETA, resumo semanal. Raciocínio do modelo aparece só quando o provedor manda (pode ser escondido).
- Logs: `~/.local/share/opencode/log/opencode.log` (texto), `browser-bridge.log`, `main.log` do desktop. **Falta log estruturado por execução** (run_id, step, tool, status, duração) com remoção de segredos.

### 2.17 Configuração — ✅
- `opencode.jsonc` global e por projeto, esquema em `packages/core/src/v1/config/config.ts`, tela de Configurações com busca. Novas opções devem entrar nesse esquema (não criar outro arquivo de configuração).

### 2.18 Hardware — ❌
- Nada detecta CPU/RAM/GPU. Nesta máquina: i5-1335U (10 núcleos), 15,7 GB RAM, Intel Iris Xe (sem GPU dedicada, sem CUDA), 43 GB livres, Ollama 0.35 com `qwen3:1.7b`, `qwen3:4b`, `qwen3:8b`.

### 2.19 Contexto e projetos grandes — ✅
- Ferramentas de busca (`grep`/`glob`/`lsp`), leitura paginada, truncamento de saída em arquivo, compactação, poda (`prune`), lista curta de skills, leituras antigas de página removidas do contexto. Não carrega o repositório inteiro.

---

## 3. O que reutilizar (não duplicar)

| Pedido | Reutilizar |
|---|---|
| `LLMProvider` / providers | `provider/provider.ts` + `custom()` loaders + `discoverModels` (padrão da Roteia) |
| Navegador visível / ao vivo | `browser/*`, painel `app/src/pages/session/browser/`, `trail.ts` |
| Checkpoints / reverter | `snapshot/` + `session/revert.ts` |
| Plano visível | `todowrite` + cartão de tarefas do app |
| Banco de dados | SQLite já usado (`opencode-dev.db`, drizzle) |
| Permissões / autonomia | `permission/` + modos do compositor |
| Configuração | esquema v1 de `opencode.jsonc` |
| Subagentes (avaliador, pesquisador) | `tool/task.ts` + agentes configuráveis |

## 4. Riscos de arquitetura

1. **Vigia + release automática:** editar a `dev` principal dispara build e publica no GitHub (o outro PC se atualiza). Todo trabalho fica no worktree `opencode-wip` até passar em typecheck, testes e smoke.
2. **Node no desktop:** `Bun.*` no servidor passa nos testes e quebra no app.
3. **Mudar o que o modelo vê** (descrições de ferramentas, prompt) já piorou o comportamento antes e foi revertido. Mudanças de prompt devem ser opcionais e medidas.
4. **Shell sem classificação** com permissão padrão `allow`: o risco mais sério para um agente mais autônomo.
5. **Modelos locais nesta máquina** rodam na CPU: com prompts de 15–20 mil tokens a primeira resposta pode levar minutos. O cache de prefixo do Ollama ajuda nos passos seguintes.
6. **Fork do upstream:** arquivos grandes como `prompt.ts` e `provider.ts` divergem do oficial; preferir módulos novos ligados por pontos pequenos.

## 5. Dependências importantes
Bun (dev/testes), Node 24 (servidor no desktop), Electron, Effect 4, AI SDK v3 (`@ai-sdk/*`), SolidJS, drizzle + SQLite, ripgrep, CDP via WebSocket nativo, Ollama 0.35 local (opcional).

---

## 6. Plano de implementação (sobre o projeto real)

| Fase | Entrega concreta | Onde |
|---|---|---|
| 1 | Esta análise + `STATUS.md` | raiz |
| 2 | **Provedor Ollama nativo**: detecção, lista de modelos instalados no seletor, contexto/temperatura/máx. tokens configuráveis, chamada pela API nativa `/api/chat` (corrige o contexto de 4096); detecção de hardware + sugestão de modelos | `provider/ollama.ts`, `provider/hardware.ts`, config `provider.ollama.options` |
| 2b | Papéis de modelo (`models.vision`, `models.evaluation`, `models.fast`) reaproveitando `small_model` | config v1 |
| 3 | Limites do laço (passos, tempo, erros seguidos, chamadas por ferramenta) com padrão seguro; pausa/continuar | `session/prompt.ts` (ponto pequeno) + módulo `session/budget.ts` |
| 3b | Classificador de comandos SAFE/CONFIRM/BLOCKED ligado à permissão do `shell`; níveis SAFE/NORMAL/AUTONOMOUS mapeados nos modos existentes | `permission/command-risk.ts` |
| 4–5 | Execuções (run) + `LessonsMemory` em SQLite próprio, com busca antes de agir (ferramenta `lessons`) | `memory/` |
| 6–8 | QA de site: subir projeto, varrer páginas, console/rede, 3 viewports, prints guardados; `VisionEvaluator` com JSON estruturado; ciclo de correção com limite | `browser/qa.ts`, `evaluate/vision.ts` |
| 9 | Pesquisa web ligada por padrão com fontes | `websearch` existente |
| 10 | Feedback por execução no app + `DatasetExporter` JSONL (só aprovadas/excelentes) | `memory/dataset.ts`, app |
| 11 | `training/` com guia de HF Transformers, PEFT, LoRA/QLoRA, TRL → GGUF → Ollama | docs |
| 12 | Testes, documentação em `docs/`, README | — |
