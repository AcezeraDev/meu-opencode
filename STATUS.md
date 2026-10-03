# STATUS — opencode personal → agente de desenvolvimento próprio

Atualizado: 2026-10-01. Onde o trabalho acontece: worktree `C:\Users\aceze\opencode-wip` (branch `browser-reliability`). Nada disso está na `dev` principal ainda: a `dev` é compilada pelo vigia e publicada sozinha na Release do GitHub, então só vai para lá depois de typecheck + testes + smoke e com o seu OK.

Visão completa e mapa do que já existe: [`ARCHITECTURE_ANALYSIS.md`](ARCHITECTURE_ANALYSIS.md).

## Feito
- **Fase 1 — análise da arquitetura** (`ARCHITECTURE_ANALYSIS.md`): cada item do pedido classificado como existe / parcial / falta, com onde está no código, o que reutilizar e os riscos.
- **Fase 2 — Ollama de primeira classe** (`packages/opencode/src/provider/ollama.ts`):
  - detecta o Ollama (`/api/version`, 1,5 s) e conecta sozinho quando ele roda;
  - lista os modelos instalados com contexto máximo, ferramentas, raciocínio e visão (`/api/tags`, `/api/show` para Ollama antigo); modelos só de embedding ficam de fora;
  - conversa pela API nativa `/api/chat` com `num_ctx`, `num_predict`, `temperature`, `think`, `keep_alive` (o `/v1` do Ollama ficava preso em 4096 tokens — medido);
  - configurável sem código: `provider.ollama.options` (`host`, `contextWindow`, `maxTokens`, `temperature`, `keepAlive`, `think`) e `OLLAMA_HOST`;
  - sem o limite de 5 min do `fetch` para a primeira resposta (CPU lenta), com keepalive e cancelamento;
  - mensagens de erro em pt-BR: modelo não instalado (com o `ollama pull`), falta de memória, Ollama fechado, conexão caiu;
  - nunca vira o modelo padrão sozinho quando há outro provedor; todos os modelos locais aparecem no seletor do app.
- **Detecção de hardware + sugestão de modelos** (`provider/hardware.ts`) e rota `GET /experimental/ollama/status`. Nada é baixado.
- Documentação: [`docs/MODELS.md`](docs/MODELS.md).

### Testes desta etapa
- `test/provider/ollama.test.ts`: 20 testes (Ollama falso que repete respostas reais gravadas; SDK `ai` + `@ai-sdk/openai-compatible` de verdade passando pelo adaptador: stream com raciocínio e chamada de ferramenta, texto, sem stream, prompt lento > 3 s, cancelamento, erro no meio do stream, modelo inexistente, Ollama fechado, provider ligado/desligado, modelo padrão).
- `test/provider/hardware.test.ts`: 6 testes (GPU integrada × dedicada, laptop sem GPU, NVIDIA 12 GB, placa grande, pouca memória, detecção real).
- Suíte `test/provider/` inteira: 740 testes verdes antes da rota nova. `bun typecheck` limpo em `packages/opencode` e `packages/app`.
- **Proteção contra laço de compactação** (`session/prompt.ts`, `answersSinceSummary`): se a primeira resposta depois de um resumo já precisa de outro resumo, o prompt fixo não cabe no modelo e compactar de novo seria infinito; o laço para com uma mensagem clara. Teste novo em `test/session/prompt.test.ts` (sem a proteção: 7+ chamadas; com ela: 3 e a mensagem). Suítes `prompt` + `compaction`: 101 verdes; as 3 falhas são as antigas do Windows listadas abaixo.

### Teste real (servidor do worktree com dados isolados + Ollama 0.35 + `qwen3:1.7b`, CPU)
- O provedor entrou sozinho com os 3 modelos instalados, cada um com 32k de contexto; `ollama ps` confirmou `context_length` 32768 (antes: 4096).
- Prompt inteiro do opencode = **~16,6 mil tokens** chegando sem corte. Primeira leitura: **~10,5 min** na CPU (~26 tokens/s). Passos seguintes: 20–40 s, com ~16,6 mil tokens vindos do cache do Ollama.
- O modelo chamou a ferramenta `write` e ela executou. Mas o 1.7B **inventou o caminho do arquivo** (gravou fora do projeto): limitação do modelo pequeno, não do adaptador.
- Bugs achados por esse teste e corrigidos: (1) limite de 300 s do `fetch` antes do 1º token → chamada por `node:http`; (2) uso de tokens contado em dobro (o `prompt_eval_count` do Ollama já inclui o cache) → compactação a cada resposta, em laço. Isso levou também à proteção geral contra laço acima.

- `script/browser-smoke.ts` (Node, igual ao app instalado): todas as ferramentas do navegador ok nos modos processo e extensão.

- **Fase 3b — segurança do terminal** (`permission/command-risk.ts`, ligado em `tool/shell.ts`). Cada comando é classificado por software, com o parser de bash/PowerShell que o opencode já tinha:
  - **seguro** (instalar, build, testes, git status/commit, servidores, apagar dentro do projeto): segue as regras normais, sem interromper;
  - **confirmar** (git push, reset --hard, clean, rebase/amend, branch -D, stash drop, npm publish, `gh` que age no GitHub, apagar recursivo fora do projeto ou o projeto inteiro, matar programa pelo nome, registro do usuário, `Set-ExecutionPolicy`, desligar, sudo, script da internet direto no shell, `DROP` em SQL, docker prune): pede confirmação com o motivo, **inclusive no modo "Ignorar permissões"**; substitui a pergunta comum (não pergunta duas vezes); "Permitir sempre" vale para aquele comando exato;
  - **bloqueado** (formatar/particionar disco, inicialização, apagar Windows/Program Files/unidade/pasta do usuário ou Documentos/Desktop/.ssh, desligar antivírus/firewall, exceção no Defender, registro da máquina, política de scripts da máquina, apagar pontos de restauração, fork bomb): nunca roda, em nenhum modo; a IA recebe a explicação e é instruída a pedir que você rode.
  - Permissão nova `shell_risky` (padrão "ask"); no modo bypass ela continua perguntando, a menos que a config diga outra coisa explicitamente. O painel de permissão do app mostra o **Motivo**.
  - Testes: `test/permission/command-risk.test.ts` (63: comandos de uso diário, de risco e destrutivos, em Windows e Linux, e os modos) e 2 novos em `test/tool/shell.test.ts` rodando em todos os shells. Suítes de permissão + agentes: 205 verdes; `shell.test.ts`: 70/71 (a falha é a antiga do Windows).

- **Fase 3 — limites do laço e pausa.**
  - `session/budget.ts`: por pedido, conta passos (padrão 400), minutos (180, sem contar o tempo pausado), ferramentas falhando seguidas (8, incluindo chamada a ferramenta inexistente) e chamadas de uma mesma ferramenta (300). Configurável em `limits` no `opencode.jsonc` (`max_steps`, `max_minutes`, `max_consecutive_errors`, `max_calls_per_tool`; 0 = sem limite). Ao atingir um limite, o passo seguinte vai com `toolChoice: "none"` (o provedor impede ferramentas) e o modelo resume o que fez e o que falta; se ainda assim pedir ferramenta, o laço para e avisa "A IA parou: …". Antes, o limite de passos era infinito e só pedia ao modelo para parar.
  - `session/pause.ts` + botão **Pausar / Continuar** no compositor (aparece enquanto a IA trabalha ou está pausada). Guardado em `session.metadata.paused`, como o modo de permissão. Pausado: nenhum passo novo e nenhuma ferramenta nova começa (a que já está rodando termina); vale também para subagentes; continuar retoma do mesmo ponto; cancelar funciona durante a pausa.
  - Testes: `test/session/budget.test.ts` (6) e 4 novos em `prompt.test.ts` (modelo que insiste em ferramentas é parado; falhas seguidas encerram com resumo; pausa sem nenhuma chamada e retomada; cancelar pausado). Visto no app web do worktree: o botão aparece, troca para "Continuar" e o servidor grava `paused: true/false`. Smoke em Node ok.
  - Suítes `prompt` + `compaction` + `budget`: 107 verdes; 5 falhas antigas do Windows (conferido: "running task tool preserves metadata" falha igual sem as mudanças).
- **Perfil enxuto para modelos locais** (`Ollama.LEAN_TOOLS`, filtro em `tool/registry.ts`, sem lista de skills em `session/prompt.ts`): 77 mil → 42 mil caracteres de instruções. Teste real com `qwen3.5:4b`: 10,4 mil tokens de entrada (antes 16,6 mil), arquivo criado na pasta certa em 2 passos, 2º passo em 7 s; a 1ª resposta ainda leva ~16 min nesta máquina (leitura a ~11 tokens/s na iGPU). Desliga com `provider.ollama.options.lean: false`. Teste novo em `test/tool/registry.test.ts`.
- **Papéis de modelo** (`provider/roles.ts`, config `models`): coding, fast, reasoning, vision, evaluation, cada um local ou externo; coding vira o padrão quando `model` não existe, fast vira o `small_model`, reasoning vai para o agente plan; evaluation cai para reasoning e depois para o principal. Testes em `test/provider/roles.test.ts`.
- **Fases 4–5 — memória e LessonsMemory** (`memory/lessons.ts`, ferramenta `lessons`, consulta automática em `session/prompt.ts`): lições problema → causa → solução → resultado em JSON, sem segredos; as 3 mais parecidas com o pedido vão ocultas na mensagem do usuário (sem quebrar o cache do provedor); `memory.enabled: false` desliga. O histórico de execuções já existia no SQLite e não foi duplicado. Testes: `test/memory/lessons.test.ts` (5) e 2 em `prompt.test.ts`. Ver `docs/MEMORY.md`.
- **Fases 6–8 — testar os próprios sites, avaliação visual e autocorreção.** `site_check` (`browser/qa.ts`): abre uma aba própria no navegador visível e passa por cada página em 1366/768/390px; acha erros de JS, `console.error`, falhas de rede e HTTP, rolagem horizontal com o elemento culpado, imagem quebrada, contraste com a razão, alvo de toque pequeno, falta de title/h1, página vazia; guarda prints e compara com a checagem anterior (antes × depois). `visual_review` (`evaluate/vision.ts`): prints + medições para o modelo de visão (`models.vision` ou o da conversa), resposta JSON {status, score, issues, strengths, suggestions, requires_fix}, cada problema com elemento, tela e correção; regra "high/medium ⇒ precisa corrigir" aplicada pelo software. Autocorreção: limite `limits.max_fix_rounds` (padrão 3). Teste real: `qwen3.5:4b` avaliou os prints de um site de laboratório e apontou o banner de 632px em tela de 390px, o link pequeno e o contraste 1,92:1. Testes: `test/browser/qa.test.ts` (Edge headless com problemas plantados), `test/evaluate/vision.test.ts` (6), smoke em Node com `site_check` nos modos processo e extensão; suítes de navegador + registro + avaliação: 207 verdes. Ver `docs/BROWSER.md`.
- **Fase 9 — pesquisa na internet** (`tool/websearch.ts`): ligada por padrão para todos os modelos, inclusive locais (`websearch.enabled: false` desliga). Sem chave do Exa usa o Parallel, que funciona sem chave (o Exa passou a responder 401 sem chave; antes metade das sessões caía nele). O resultado termina com **Fontes** (endereços dos resultados, sem os exemplos de dentro dos trechos) e o pedido de citá-las; a descrição orienta pesquisar a documentação atual quando não tiver certeza de uma API. Teste real pelo laço do opencode: pesquisa sobre Supabase + Next.js trouxe as páginas oficiais da Supabase como fontes. Testes em `test/tool/websearch.test.ts` (12).
- **Fase 10 — feedback e DatasetExporter.** Botões ★ Excelente / 👍 Aprovado / 👎 Precisa melhorar embaixo de cada resposta concluída (`scope/turn-rating.tsx`), guardados em `session.metadata.ratings` por turno; clicar de novo desfaz. `dataset/export.ts` + `POST /experimental/dataset/export?min=approved|excellent` + comando da paleta "Exportar dataset de treino": só turnos aprovados/excelentes de todos os projetos, em JSONL de chat (user, assistant com tool_calls, tool), sem raciocínio, sem segredos, saídas de ferramenta cortadas em 6 mil caracteres, com `meta` (sessão, turno, nota, modelo, projeto); arquivo em Downloads. Testado no app: clique → nota gravada → exportação com aviso "1 conversa(s) exportada(s)". Testes: `test/dataset/export.test.ts` (3).
- **Fase 12 (parte de docs):** `docs/ARCHITECTURE.md` (mapa atual, ciclo de trabalho, configuração, rotas, formato do dataset) e seção "A IA de desenvolvimento própria" no README.

## Em andamento
- Commitado no worktree (local); **fora da `dev`** até o seu OK. Próximo: training/ (Fase 11, adiada a pedido do usuário); ideia em discussão: agente "amigo" conversacional com memória pessoal.

## Pendente (próximas fases, na ordem)
1. **2b — papéis de modelo**: `vision`, `evaluation`, `fast`, `reasoning` na config, reaproveitando `model`/`small_model`/modelo por agente; cartão do Ollama nas Configurações (status, modelos, sugestão de hardware).
2. **3 — limites do laço e pausa**: passos, tempo, erros seguidos e chamadas por ferramenta configuráveis (hoje `steps` é infinito por padrão); pausar/continuar.
3. **3c — níveis SAFE / NORMAL / AUTONOMOUS** como nomes amigáveis sobre os modos de permissão que já existem (Manual / Automático / Ignorar permissões).
4. **4–5 — execuções e LessonsMemory** em SQLite.
5. **6–8 — QA de site, VisionEvaluator estruturado, ciclo de correção com limite**, reaproveitando o navegador e os prints que já existem.
6. **9 — pesquisa web** ligada por padrão, com fontes.
7. **10 — feedback por execução + DatasetExporter JSONL**.
8. **11 — `training/`** (HF Transformers, PEFT, LoRA/QLoRA, TRL → GGUF → Ollama).
9. **12 — testes, docs (`ARCHITECTURE`, `MEMORY`, `BROWSER`, `TRAINING`, `SECURITY`), README.**

## Problemas conhecidos
- Nesta máquina (sem GPU dedicada) modelos locais são lentos: a 1ª resposta de uma sessão leva ~10 min porque o prompt do opencode (sistema + ferramentas) tem ~16,6 mil tokens. Os passos seguintes reaproveitam o cache do Ollama (20–40 s). Para ficar prático, a Fase 3 deve ter um **perfil enxuto para modelos locais** (menos ferramentas e skills no prompt).
- Modelos de 1–2B erram em tarefas de agente (caminho de arquivo inventado). Para programar localmente aqui, use no mínimo o `qwen3:4b`.
- O Ollama é detectado quando o projeto é aberto; se ele for aberto depois, os modelos só aparecem ao recarregar o projeto/app.
- A rota `/experimental/ollama/status` ainda não está no SDK gerado (`packages/client`), como a da Roteia; o app ainda não tem cartão para ela.
- Falhas antigas do Windows, sem relação com esta etapa (registradas antes): `prompt "loop waits while shell runs"`, `compaction "stops quickly when aborted during retry backoff"`, flake `streams status, frames…`.

## Próximo passo
Terminar a validação real com o modelo local, rodar a checagem completa (typecheck do monorepo, testes do navegador, `script/browser-smoke.ts`) e pedir seu OK para trazer a Fase 2 para a `dev`. Depois, Fase 3b (segurança do terminal) antes de dar mais autonomia ao agente.
