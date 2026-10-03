#!/usr/bin/env bash
# Instala tudo o que o treino da Ghost precisa, dentro do Ubuntu (WSL) do PC com a placa NVIDIA.
# Uso:  bash instalar.sh
# Pode rodar de novo sem problema: o que já está instalado é aproveitado.
set -euo pipefail
cd "$(dirname "$0")"

# A versão do conversor que foi testada com o Qwen3.5 em 2026-10-01 (treino → GGUF → Ollama).
LLAMA_CPP_COMMIT="a868c3e3c56657f7e8a6231190dbbe90e7dd86c0"

echo "== 1/6 Placa de vídeo"
if ! nvidia-smi >/dev/null 2>&1; then
  echo "O Ubuntu não está vendo a placa NVIDIA."
  echo "Atualize o driver da NVIDIA no Windows (o WSL usa o driver do Windows) e reinicie o PC."
  exit 1
fi
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

echo "== 2/6 Pacotes do Ubuntu (pede a sua senha do Ubuntu)"
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip python3-dev git build-essential

echo "== 3/6 Ambiente Python separado (.venv)"
[ -d .venv ] || python3 -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate
pip install -q -U pip wheel setuptools

echo "== 4/6 PyTorch com suporte à placa (CUDA) — download grande, alguns minutos"
pip install -q torch --index-url https://download.pytorch.org/whl/cu128

echo "== 5/6 Bibliotecas de treino"
pip install -q "transformers>=5.18" "peft>=0.21" "trl>=1.14" datasets accelerate psutil
# Partes rápidas das camadas novas do Qwen3.5. Sem elas o treino funciona, só que mais devagar.
pip install -q flash-linear-attention || echo "Aviso: flash-linear-attention não instalou; o treino vai funcionar, mais devagar."
pip install -q causal-conv1d --no-build-isolation || echo "Aviso: causal-conv1d não instalou; o treino vai funcionar, mais devagar."

echo "== 6/6 Conversor para o formato do Ollama (llama.cpp)"
if [ ! -d llama.cpp/.git ]; then
  git init -q llama.cpp
  git -C llama.cpp remote add origin https://github.com/ggml-org/llama.cpp.git
fi
git -C llama.cpp fetch -q --depth 1 origin "$LLAMA_CPP_COMMIT"
git -C llama.cpp checkout -q FETCH_HEAD
pip install -q -e llama.cpp/gguf-py sentencepiece protobuf

echo
python verificar.py
echo
echo "Tudo instalado. Próximo passo: bash treinar-tudo.sh --dados <seu arquivo .jsonl> --teste"
