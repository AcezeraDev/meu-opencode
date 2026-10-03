"""Confere se o ambiente de treino está pronto: placa, memória, bibliotecas e conversor."""
import importlib
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ok = True


def item(nome, certo, detalhe=""):
    global ok
    ok = ok and certo
    print(f"{'OK ' if certo else 'FALTA'}  {nome}{f' — {detalhe}' if detalhe else ''}")


try:
    import torch

    gpu = torch.cuda.is_available()
    item("PyTorch", True, torch.__version__)
    item("Placa NVIDIA visível", gpu, torch.cuda.get_device_name(0) if gpu else "instale o driver da NVIDIA no Windows e reinicie")
    if gpu:
        memoria = torch.cuda.get_device_properties(0).total_memory / 1024**3
        item("Memória da placa", memoria >= 8, f"{memoria:.1f} GB")
        item("Precisão bf16", torch.cuda.is_bf16_supported())
        a = torch.randn(512, 512, device="cuda")
        item("Conta de teste na placa", bool(torch.isfinite(a @ a).all()))
except ImportError:
    item("PyTorch", False, "rode bash instalar.sh")

for nome in ("transformers", "peft", "trl", "datasets", "accelerate"):
    try:
        modulo = importlib.import_module(nome)
        item(nome, True, getattr(modulo, "__version__", ""))
    except ImportError:
        item(nome, False, "rode bash instalar.sh")

for nome, pacote in (("fla", "flash-linear-attention"), ("causal_conv1d", "causal-conv1d")):
    try:
        importlib.import_module(nome)
        print(f"OK     {pacote} (treino mais rápido)")
    except ImportError:
        print(f"aviso  {pacote} ausente: o treino funciona, mais devagar")

aqui = os.path.dirname(os.path.abspath(__file__))
item("Conversor llama.cpp", os.path.exists(os.path.join(aqui, "llama.cpp", "convert_hf_to_gguf.py")))

print()
print("Tudo pronto para treinar." if ok else "Falta algo acima. Rode bash instalar.sh e veja as mensagens.")
sys.exit(0 if ok else 1)
