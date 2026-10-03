# Modelos no opencode personal

O "cérebro" é trocável sem mexer na arquitetura: toda chamada passa por `packages/opencode/src/provider/provider.ts`, que fala com qualquer provedor do AI SDK (Anthropic, OpenAI, Google, OpenRouter, Groq, qualquer API OpenAI-compatível, Roteia) e agora com o **Ollama local** como provedor de primeira classe.

## Ollama local

### Como funciona
- Se o Ollama estiver rodando, o provedor **Ollama (local)** aparece sozinho, com todos os modelos instalados (`ollama list`). Nada para configurar.
- Cada modelo instalado aparece no seletor de modelos (os locais não somem pela regra de "só o mais novo da família" nem pela de 6 meses).
- Um modelo local **nunca vira o padrão sozinho** se houver outro provedor conectado; só quando você escolhe (ou quando ele é o único).
- As conversas usam a API nativa `POST /api/chat`, não o endpoint `/v1` do Ollama. Motivo medido no Ollama 0.35: pelo `/v1` o modelo é sempre carregado com **4096 tokens** de contexto e o `num_ctx` é ignorado; o prompt do opencode passa disso e era cortado em silêncio. Pela API nativa o contexto configurado é respeitado (`ollama ps` mostra `context_length` 32768).
- Sem limite de 5 minutos para a primeira resposta: em CPU, ler o prompt pode passar disso. O pedido fica vivo (keepalive) e o botão de parar continua funcionando.

### Configuração (opcional) — `~/.config/opencode/opencode.jsonc`
```jsonc
{
  "provider": {
    "ollama": {
      "options": {
        "host": "http://127.0.0.1:11434",  // ou OLLAMA_HOST; aceita "0.0.0.0:11434"
        "contextWindow": 32768,            // num_ctx de todos os modelos (limitado ao máximo de cada um)
        "maxTokens": 8192,                 // teto de cada resposta (num_predict)
        "temperature": 0.6,                // usada quando o agente não define outra
        "keepAlive": "30m",                // quanto tempo o modelo fica na memória
        "think": false                     // liga/desliga o raciocínio de modelos como qwen3
      },
      // Ajuste por modelo (vai direto para o Ollama):
      "models": {
        "qwen3:8b": { "options": { "num_ctx": 16384 }, "limit": { "context": 16384, "output": 4096 } }
      }
    }
  },
  // Usar um modelo local:
  "model": "ollama/qwen3:4b"
}
```
### Perfil enxuto (padrão para o Ollama)
Medido em 2026-10-01: o opencode mandava ~77 mil caracteres de instruções antes do pedido, e 3/4 disso eram descrições de ferramentas. Para modelos do Ollama, o padrão agora é um perfil enxuto: ler, escrever, editar, buscar arquivos, terminal, lista de tarefas, `webfetch`/`websearch` e o navegador essencial (`browser_navigate`, `browser_act`, `browser_snapshot`, `browser_screenshot`), sem a lista de skills. Ficam de fora: vídeo, programas e anotações do navegador, inspeção, subagentes e perguntas. Resultado: 42 mil caracteres; no teste real o `qwen3.5:4b` recebeu 10,4 mil tokens (antes 16,6 mil), criou o arquivo pedido na pasta certa em 2 passos, e o 2º passo levou 7 s (cache). Para voltar ao conjunto completo: `"provider": { "ollama": { "options": { "lean": false } } }`. Outros provedores não mudam.

`limit.context` e `num_ctx` precisam ser o mesmo número: o primeiro é o que a compactação usa para planejar, o segundo é o que o Ollama carrega.

Para desligar o Ollama no opencode: `"disabled_providers": ["ollama"]`.

### Hardware e sugestão de modelos
`GET /experimental/ollama/status` devolve se o Ollama está rodando, os modelos instalados, CPU/RAM/GPU/VRAM/disco detectados (sem supor NVIDIA: lê `nvidia-smi` quando existe e a lista de placas do Windows) e uma sugestão por papel (`coding`, `fast`, `vision`) com o contexto que cabe. **Nada é baixado automaticamente.**

Regras da sugestão (`provider/hardware.ts`):
- Com GPU dedicada, o orçamento é 90% da VRAM; sem GPU, metade da RAM (o resto fica para Windows, app, navegador e o servidor do projeto).
- Memória necessária ≈ tamanho do modelo + contexto (KV cache por arquitetura) + 0,5 GB.
- Para agente, preferir modelo que caiba com ≥ 32k de contexto, depois o que já está instalado, depois o maior.
- Só modelos que chamam ferramentas de forma confiável entram como `coding` (família qwen3).

Nesta máquina (i5-1335U, 16 GB, Iris Xe sem GPU dedicada, Ollama com `OLLAMA_IGPU_ENABLE=1`): **`qwen3.5:4b` com 64k** para programar e avaliar prints, **`qwen3.5:2b`** como rápido. Medido em 2026-10-01: `qwen3.5:4b` ocupa 3,1 GB com 8k, 3,9 GB com 32k e 4,8 GB com 64k (arquitetura híbrida: só 1 camada em 4 guarda cache completo); o antigo `qwen3:4b` **nem carrega com 32k** nesta placa integrada (falta de memória). A primeira resposta de uma sessão demora vários minutos; as seguintes reaproveitam o início do prompt.

## Treinar na CPU (medido nesta máquina)
LoRA (r=16, todas as camadas lineares), fp32, sequências de 512 tokens, PyTorch 2.14 CPU + transformers 5.18 + peft 0.21. Script: `Downloads\minha ia\treino\medir_treino.py`.

| Modelo | Tokens/s de treino | RAM de pico | 300 conversas de ~1500 tokens (1 época) |
|---|---|---|---|
| Qwen3-0.6B | 16 | 3,3 GB | ~8 h |
| Qwen3.5-0.8B (sem gradient checkpointing) | 13 | 3,8 GB | ~9,6 h |
| LFM2.5-1.2B | 11 | 5,1 GB | ~12 h |
| Qwen3.5-0.8B (com checkpointing) | 10 | 4,0 GB | ~13 h |

O treino funciona (a perda cai), cabe com folga na RAM, mas é lento: o Qwen3.5 usa na CPU a implementação de referência das camadas híbridas (`flash-linear-attention` e `causal-conv1d` são só para GPU). Modelos de 2B ou mais levariam dias por época aqui; para eles, alugar GPU por algumas horas.

## Modelo próprio (futuro)
Modelo aberto → fine-tuning (ver `training/`) → exportar GGUF → `ollama create meu-modelo -f Modelfile` → aparece sozinho no seletor como `ollama/meu-modelo`. Nenhuma mudança de código é necessária.

## Papéis de modelo
Cada papel pode ser um modelo local ou externo (`provider/modelo`), em `opencode.jsonc`:
```jsonc
"models": {
  "coding": "ollama/qwen3.5:4b",          // principal, quando "model" não está definido
  "fast": "ollama/qwen3.5:2b",            // títulos e resumos, quando "small_model" não está definido
  "reasoning": "anthropic/claude-sonnet-4", // agente plan (se ele não tiver modelo próprio)
  "vision": "ollama/qwen3.5:4b",          // lê prints na avaliação visual
  "evaluation": "openai/gpt-5"             // confere o resultado; reserva: reasoning, depois o principal
}
```
`model` e `small_model` continuam valendo e têm prioridade. Código: `packages/opencode/src/provider/roles.ts`.
