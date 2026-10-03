# Memória do agente

## O que já fica guardado (sem nada novo)
- **Histórico de execuções:** cada conversa, pedido, passo, chamada de ferramenta (entrada, saída, erro, tempo), tokens e custo ficam no SQLite do app (`~/.local/share/opencode/opencode-dev.db`, tabelas `session`, `message`, `part`). É a base do histórico e do futuro dataset; não foi duplicado.
- **Preferências e regras permanentes:** `~/.config/opencode/AGENTS.md` (global) e `AGENTS.md` do projeto. Vão para o prompt de toda conversa.
- **Memória por site do navegador:** anotações e programas por site (`browser-sites/`).
- **Resumo da conversa** quando o contexto enche (compactação).

## Lições (LessonsMemory) — novo
Memória operacional: **problema → causa → solução → resultado**, consultada antes de trabalhos parecidos. Não é treino do modelo; são anotações devolvidas ao prompt quando combinam.

- Onde: um JSON por lição em `~/.local/share/opencode/lessons/`. Código: `packages/opencode/src/memory/lessons.ts`.
- **Guardar:** a ferramenta `lessons` (`add`) — o agente guarda depois de resolver um problema que deu trabalho e confirmar a correção (build, teste ou navegador passando). Chaves de API, tokens e senhas são removidos antes de gravar.
- **Consultar:**
  - automático: no 1º passo de cada pedido, o software busca lições parecidas com o que você escreveu e anexa as até 3 melhores à sua mensagem, como parte oculta (você não vê; o modelo vê). Fica no fim do histórico, não no prompt de sistema, para não estragar o cache do provedor (importante no Ollama);
  - sob demanda: `lessons` (`search`) com o texto de um erro.
- **Busca:** palavras sem acento, sem palavras comuns; palavras raras valem mais; problema e etiquetas pesam 3×; lições do mesmo projeto ganham um bônus, mas lições de outros projetos também valem (ex.: um erro de React serve em qualquer projeto).
- Cada lição conta quantas vezes foi mostrada (`uses`), para separar no futuro as que ajudam.
- Desligar: `"memory": { "enabled": false }` no `opencode.jsonc` (some a consulta automática e a ferramenta).

Exemplo de lição:
```json
{
  "problem": "React hydration mismatch: Text content does not match server-rendered HTML",
  "cause": "Date.now() renderizado no servidor e de novo no cliente",
  "solution": "Renderizar a data só depois de montar (useEffect)",
  "result": "Erro sumiu do console; página conferida no navegador",
  "tags": ["react", "nextjs", "hydration"]
}
```

## Próximos passos
- Tela no app para ver, editar e apagar lições.
- Avaliação (Aprovado / Precisa melhorar) por execução, ligada ao exportador de dataset (Fase 10).
