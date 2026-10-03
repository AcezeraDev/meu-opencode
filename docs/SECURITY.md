# Segurança e autonomia do agente

O agente pode trabalhar sozinho por muito tempo, mas há limites que são decididos por **software**, não por pedir ao modelo que se comporte.

## Terminal: seguro, confirmar, bloqueado
Código: `packages/opencode/src/permission/command-risk.ts`, chamado pela ferramenta `shell` depois de separar cada comando com o parser de bash/PowerShell.

| Nível | Exemplos | O que acontece |
|---|---|---|
| **Seguro** | `npm install`, `npm run dev/build/test`, `pnpm`, `yarn`, `bun`, `pip`, `python`, `git status/diff/add/commit/log`, `git checkout -b`, apagar dentro do projeto (`rm -rf node_modules`) | Segue as regras normais de permissão |
| **Confirmar** | `git push`, `git reset --hard`, `git clean -f`, `git rebase`, `commit --amend`, `branch -D`, `stash drop`, `npm publish`, `gh` agindo no GitHub, apagar recursivo fora do projeto ou o projeto inteiro, `taskkill /IM`, `Stop-Process -Name`, registro do usuário (HKCU), `Set-ExecutionPolicy`, desligar/reiniciar, `sudo`, `curl … \| sh`, `iex (irm …)`, `DROP TABLE`, `docker system prune` | Pergunta com o **motivo**, inclusive no modo "Ignorar permissões" (permissão `shell_risky`). "Permitir sempre" vale só para aquele comando exato |
| **Bloqueado** | formatar/particionar disco (`format`, `diskpart`, `Format-Volume`, `mkfs`, `dd of=/dev/…`), `bcdedit`, apagar Windows/Program Files/unidade/pasta do usuário/Documentos/Desktop/.ssh, desligar Defender/firewall, exceção no antivírus, registro da máquina (HKLM), política de scripts da máquina, apagar pontos de restauração, fork bomb | Nunca roda, em nenhum modo. A IA recebe a explicação e é instruída a pedir que você rode |

Para mudar: em `opencode.jsonc`, `"permission": { "shell_risky": "allow" }` libera os comandos de "confirmar" (não recomendado). Os bloqueados não têm chave para liberar.

## Limites de cada pedido
Código: `packages/opencode/src/session/budget.ts`. Em `opencode.jsonc`:
```jsonc
"limits": {
  "max_steps": 400,              // passos do modelo
  "max_minutes": 180,            // tempo (a pausa não conta)
  "max_consecutive_errors": 8,   // ferramentas falhando seguidas
  "max_calls_per_tool": 300      // chamadas de uma mesma ferramenta
}
```
`0` = sem limite. Ao atingir um limite, o próximo passo roda **sem poder chamar ferramentas** e o modelo resume o que fez e o que falta. Se o provedor ignorar isso, o laço para.

Também há uma proteção contra compactação infinita: se a primeira resposta depois de resumir a conversa já estoura o contexto, o laço para com uma mensagem clara.

## Pausar, continuar, cancelar
Botão **Pausar / Continuar** no compositor. Pausado, nada novo começa (nem passo do modelo, nem ferramenta, nem subagente); continuar retoma do mesmo ponto; o botão de parar cancela normalmente.

## Modos de permissão (já existiam)
Manual (pergunta antes de editar e de rodar comandos), Automático (padrão), Aceitar edições, Plano (só lê) e Ignorar permissões. Os comandos "confirmar" e "bloqueado" valem em todos eles.

## Arquivos
Fora da pasta do projeto, ler ou alterar pede permissão (`external_directory`); ler `.env` pede permissão.
