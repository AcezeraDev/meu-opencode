#!/usr/bin/env bash
# Treina, converte para o formato do Ollama e deixa tudo numa pasta da Área de Trabalho
# do Windows, pronta para levar ao PC onde a Ghost vai rodar.
#
# Uso (no Ubuntu, na pasta do kit):
#   bash treinar-tudo.sh --dados opencode-dataset-approved-AAAA-MM-DD.jsonl --teste    # teste de fumaça
#   bash treinar-tudo.sh --dados opencode-dataset-approved-AAAA-MM-DD.jsonl            # treino de verdade
#   bash treinar-tudo.sh --dados ... --nome ghost-2                                     # próximas versões
# Outras opções do treino (--modelo, --epocas, --max-tokens...) passam direto para o treinar.py.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. .venv/bin/activate

NOME="ghost-1"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --nome) NOME="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
for arg in "${ARGS[@]}"; do [ "$arg" = "--teste" ] && NOME="$NOME-teste"; done
SAIDA="saidas/$NOME"

echo "== Treinando $NOME"
python treinar.py "${ARGS[@]}" --saida "$SAIDA"

echo "== Convertendo para o formato do Ollama (GGUF, 8 bits)"
# --no-mtp: o Qwen3.5 declara uma camada extra (MTP) que o treino não salva;
# sem esta opção o Ollama recusa o arquivo ("tensor blk.N... not found").
python llama.cpp/convert_hf_to_gguf.py "$SAIDA/completo" \
  --outfile "$SAIDA/$NOME-q8_0.gguf" --outtype q8_0 --no-mtp

echo "== Separando o que levar"
WINHOME="$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')" 2>/dev/null || true)"
DESTINO="${WINHOME:+$WINHOME/Desktop}/$NOME-para-levar"
[ -n "$WINHOME" ] || DESTINO="$SAIDA/para-levar"
mkdir -p "$DESTINO"
cp "$SAIDA/$NOME-q8_0.gguf" instalar-no-ollama.ps1 identidade.md "$DESTINO/"
[ -f "$SAIDA/comparacao.md" ] && cp "$SAIDA/comparacao.md" "$DESTINO/"
cp "$SAIDA/completo/LICENSE-base.txt" "$DESTINO/" 2>/dev/null || true

echo
echo "Pronto. Leve a pasta $DESTINO para o outro PC."
echo "Lá, no PowerShell, dentro dela:"
echo "  powershell -ExecutionPolicy Bypass -File instalar-no-ollama.ps1 -Arquivo $NOME-q8_0.gguf -Nome ${NOME/-/:}"
