# Kit de treino da Ghost

Treina a **Ghost** (o seu modelo) no PC com a placa NVIDIA e instala no Ollama do PC onde você usa o opencode.

Caminho testado de ponta a ponta em 2026-10-01: treino → conversão para GGUF → Ollama → resposta e chamada de ferramenta funcionando.

```
PC do dia a dia                      PC com a RTX 3060 (12 GB)
───────────────                      ─────────────────────────
avaliar respostas (★ 👍 👎)
Ctrl+K → Exportar dataset  ──.jsonl──▶  bash treinar-tudo.sh
                                          (treina + converte)
instalar-no-ollama.ps1     ◀──.gguf────  pasta "ghost-1-para-levar"
ollama/ghost:1 no opencode               na Área de Trabalho
```

---

## Parte A — Preparar o PC da placa (uma vez só, ~1 hora)

**A1. Driver da NVIDIA atualizado.** Pelo GeForce Experience / NVIDIA App ou pelo site da NVIDIA. Reinicie depois.

**A2. Instalar o Ubuntu dentro do Windows (WSL).** Abra o **PowerShell como administrador** e rode:
```powershell
wsl --install -d Ubuntu-24.04
```
Reinicie o PC. Na volta, o Ubuntu abre sozinho e pede um **nome de usuário e uma senha** (anote a senha; ela é pedida na instalação).

**A3. Copiar o kit para dentro do Ubuntu.** Copie a pasta `kit-treino-ghost` para `C:\ghost` no PC da placa. Depois, no Ubuntu (menu Iniciar → Ubuntu):
```bash
cp -r /mnt/c/ghost ~/ghost
cd ~/ghost
```
(Trabalhar dentro do Ubuntu, e não direto em `/mnt/c`, deixa tudo bem mais rápido.)

**A4. Instalar tudo:**
```bash
bash instalar.sh
```
Baixa e instala PyTorch para a placa, as bibliotecas de treino e o conversor. Leva de 10 a 30 minutos. No fim aparece a conferência: todas as linhas devem dizer **OK** (os avisos de "treino mais rápido" são opcionais).

Precisa de uns **40 GB livres no disco C:**.

---

## Parte B — Juntar as conversas (no PC do dia a dia)

**B1.** Use a Ghost normalmente e **avalie as respostas** com ★ Excelente, 👍 Aprovado ou 👎 Precisa melhorar (botões embaixo de cada resposta).

**B2.** Quando tiver conversas suficientes: **Ctrl+K → "Exportar dataset de treino"**. O arquivo `opencode-dataset-approved-AAAA-MM-DD.jsonl` vai para Downloads.
- Para o **teste de fumaça**: qualquer quantidade (até o `exemplo-dataset.jsonl` deste kit serve).
- Para um treino que **muda de verdade**: 300 conversas ou mais. Com menos de 100 o modelo muda pouco.

**B3.** Leve o `.jsonl` para o PC da placa e coloque em `C:\ghost`. No Ubuntu:
```bash
cp /mnt/c/ghost/opencode-dataset-*.jsonl ~/ghost/
```

---

## Parte C — Treinar (no PC da placa)

**C1. Teste de fumaça primeiro (~10 minutos)** — prova que tudo funciona antes do treino longo:
```bash
cd ~/ghost
bash treinar-tudo.sh --dados exemplo-dataset.jsonl --teste
```
No fim aparece uma pasta **`ghost-1-teste-para-levar`** na Área de Trabalho do Windows.

**C2. Treino de verdade:**
```bash
bash treinar-tudo.sh --dados opencode-dataset-approved-AAAA-MM-DD.jsonl
```
- Modelo base: **Qwen3.5-2B** (cabe com folga em 12 GB).
- Mostra a **perda** caindo. Ela deve baixar; a de validação, ao fim, diz se aprendeu sem só decorar.
- Salva o progresso a cada 100 passos: se cair a luz, rodar o mesmo comando de novo continua de onde parou.
- Tempo: de dezenas de minutos a poucas horas, conforme o número de conversas.
- No fim aparece a pasta **`ghost-1-para-levar`** na Área de Trabalho, com o modelo (`ghost-1-q8_0.gguf`, ~2,5 GB), o instalador e o `comparacao.md` (respostas do modelo original × da Ghost, lado a lado).

**Experimento maior (opcional):** `--modelo Qwen/Qwen3.5-4B` — mais inteligente, usa quase toda a memória da placa. Se der "out of memory", use `--max-tokens 1024`.

---

## Parte D — Instalar e usar (no PC do dia a dia)

**D1.** Copie a pasta `ghost-1-para-levar` para este PC (pen drive, Drive ou rede).

**D2.** Dentro dela, no PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File instalar-no-ollama.ps1 -Arquivo ghost-1-q8_0.gguf -Nome ghost:1
```
O instalador copia do `qwen3.5:2b` o jeito de conversar e de chamar ferramentas, registra **`ghost:1`** no Ollama e faz uma pergunta de teste.

**D3.** No opencode: recarregue o projeto (ou reinicie o app) e escolha **`ollama/ghost:1`** no seletor de modelos. Para ela fazer as tarefas simples e títulos, em `opencode.jsonc`: `"models": { "fast": "ollama/ghost:1" }`.

---

## Próximas versões

Junte mais conversas avaliadas, exporte de novo e treine com outro nome:
```bash
bash treinar-tudo.sh --dados <novo .jsonl> --nome ghost-2
```
```powershell
powershell -ExecutionPolicy Bypass -File instalar-no-ollama.ps1 -Arquivo ghost-2-q8_0.gguf -Nome ghost:2
```
A `ghost:1` continua no Ollama: dá para comparar e voltar se a nova não ficar melhor.

---

## Problemas comuns

| Mensagem | O que fazer |
|---|---|
| "O Ubuntu não está vendo a placa NVIDIA" | Atualize o driver no Windows e reinicie. No Ubuntu, `nvidia-smi` tem que mostrar a placa. |
| `CUDA out of memory` | `--max-tokens 1024` ou, se estiver no 4B, volte para o 2B. |
| O Ollama diz `tensor 'blk.N...' not found` | O `.gguf` foi convertido sem `--no-mtp`. Use o `treinar-tudo.sh`, que já passa essa opção. |
| A Ghost não chama ferramentas no opencode | Instale sempre pelo `instalar-no-ollama.ps1` (ele copia o formato de ferramentas do `qwen3.5:2b`). |
| Treino lento, avisos de `flash-linear-attention` | Funciona mesmo assim; essas bibliotecas só aceleram. |

## O que cada arquivo faz
- `instalar.sh` — instala tudo no Ubuntu (versão do conversor fixada na que foi testada).
- `verificar.py` — confere placa, memória e bibliotecas.
- `treinar-tudo.sh` — treino + conversão + pasta para levar.
- `treinar.py` — o treino (LoRA): identidade da Ghost em cada conversa, 10% para validação, ajuste juntado ao modelo, comparação.
- `identidade.md` — quem a Ghost é (vai como mensagem de sistema no treino). Mude aqui se quiser mudar o jeito dela.
- `perguntas.txt` — perguntas da comparação original × Ghost.
- `exemplo-dataset.jsonl` — formato do dataset e conversas para o teste de fumaça.
- `instalar-no-ollama.ps1` — registra o modelo no Ollama do Windows.

## Licença
A Ghost é um ajuste fino do Qwen3.5 (Apache 2.0). Você pode usar, renomear e até usar comercialmente; mantenha o `LICENSE-base.txt` junto do modelo.
