"""
Treina a Ghost a partir de um modelo aberto, com as conversas que você aprovou no opencode.

Uso (dentro do Ubuntu/WSL, na pasta do kit, com o ambiente ativado):
    python treinar.py --dados opencode-dataset-approved-AAAA-MM-DD.jsonl
    python treinar.py --dados dataset.jsonl --teste          # teste de fumaça: poucos passos
    python treinar.py --dados dataset.jsonl --modelo Qwen/Qwen3.5-4B   # experimento maior

O que faz:
1. Lê o dataset exportado pelo opencode (uma conversa por linha) e põe a identidade
   da Ghost (identidade.md) como mensagem de sistema em cada conversa.
2. Separa 10% das conversas para conferir o aprendizado (perda de validação).
3. Treina um LoRA (só uma camada de ajuste pequena; o modelo base fica igual).
4. Junta o ajuste ao modelo e salva o modelo completo em <saida>/completo,
   pronto para o converter.sh transformar em GGUF.
5. Compara respostas do modelo original e do treinado em perguntas.txt.
"""

import argparse
import json
import math
import os
import random
import sys
import time

AQUI = os.path.dirname(os.path.abspath(__file__))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def ler_argumentos():
    p = argparse.ArgumentParser(description="Treina a Ghost com LoRA")
    p.add_argument("--dados", required=True, help="arquivo .jsonl exportado pelo opencode")
    p.add_argument("--modelo", default="Qwen/Qwen3.5-2B", help="modelo base do Hugging Face")
    p.add_argument("--saida", default=os.path.join(AQUI, "saidas", "ghost-1"))
    p.add_argument("--epocas", type=float, default=2)
    p.add_argument("--max-tokens", type=int, default=2048, help="conversas maiores são cortadas")
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--acumular", type=int, default=8, help="exemplos somados antes de cada atualização")
    p.add_argument("--teste", action="store_true", help="teste de fumaça: até 20 conversas, poucos passos")
    p.add_argument("--cpu", action="store_true", help="força CPU (só para testar o kit sem placa)")
    p.add_argument("--sem-comparar", action="store_true", help="pula a comparação no fim")
    return p.parse_args()


def identidade():
    caminho = os.path.join(AQUI, "identidade.md")
    with open(caminho, encoding="utf-8") as f:
        return f.read().strip()


def carregar(caminho, sistema, limite=None):
    conversas = []
    with open(caminho, encoding="utf-8") as f:
        for numero, linha in enumerate(f, 1):
            linha = linha.strip()
            if not linha:
                continue
            try:
                item = json.loads(linha)
            except json.JSONDecodeError:
                print(f"  linha {numero} ignorada: não é JSON")
                continue
            mensagens = item.get("messages") or []
            if not mensagens or mensagens[-1].get("role") != "assistant":
                continue
            # O modelo aprende a ser a Ghost mesmo sem o AGENTS.md do opencode.
            if mensagens[0].get("role") != "system":
                mensagens = [{"role": "system", "content": sistema}] + mensagens
            for m in mensagens:
                for chamada in m.get("tool_calls") or []:
                    # O modelo de conversa do Qwen espera os argumentos como objeto.
                    args = chamada.get("function", {}).get("arguments")
                    if isinstance(args, str):
                        try:
                            chamada["function"]["arguments"] = json.loads(args)
                        except json.JSONDecodeError:
                            chamada["function"]["arguments"] = {"input": args}
                if m.get("content") is None:
                    m["content"] = ""
            conversas.append({"messages": mensagens})
    if limite:
        conversas = conversas[:limite]
    return conversas


def main():
    args = ler_argumentos()
    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    gpu = torch.cuda.is_available() and not args.cpu
    print(f"Placa de vídeo: {torch.cuda.get_device_name(0) if gpu else 'nenhuma (CPU)'}")
    if not gpu and not args.cpu:
        print("Nenhuma placa NVIDIA visível. Rode verificar.py. Para testar mesmo assim, use --cpu.")
        sys.exit(1)

    conversas = carregar(args.dados, identidade(), 20 if args.teste else None)
    print(f"Conversas no dataset: {len(conversas)}")
    if len(conversas) < 2:
        print("Poucas conversas. Avalie mais respostas como Aprovado/Excelente e exporte de novo.")
        sys.exit(1)
    if not args.teste and len(conversas) < 100:
        print("Aviso: com menos de 100 conversas o modelo muda pouco. Funciona, mas o ganho é pequeno.")

    random.seed(42)
    random.shuffle(conversas)
    validacao = max(1, len(conversas) // 10)
    treino_ds = Dataset.from_list(conversas[validacao:])
    valid_ds = Dataset.from_list(conversas[:validacao])

    tokenizer = AutoTokenizer.from_pretrained(args.modelo)
    dtype = torch.bfloat16 if gpu else torch.float32
    modelo = AutoModelForCausalLM.from_pretrained(args.modelo, dtype=dtype)

    passos_teste = 4 if args.cpu else 30
    config = SFTConfig(
        output_dir=os.path.join(args.saida, "progresso"),
        num_train_epochs=args.epocas,
        max_steps=passos_teste if args.teste else -1,
        per_device_train_batch_size=1,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=1 if args.teste else args.acumular,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=0.05,  # fração dos passos (transformers 5)
        max_length=args.max_tokens,
        gradient_checkpointing=True,
        bf16=gpu,
        logging_steps=1 if args.teste else 5,
        eval_strategy="no" if args.teste else "steps",
        eval_steps=50,
        save_strategy="no" if args.teste else "steps",
        save_steps=100,
        save_total_limit=2,
        report_to="none",
        use_cpu=not gpu,
    )
    lora = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.05,
        target_modules="all-linear",
        task_type="CAUSAL_LM",
    )
    treinador = SFTTrainer(
        model=modelo,
        args=config,
        train_dataset=treino_ds,
        eval_dataset=None if args.teste else valid_ds,
        processing_class=tokenizer,
        peft_config=lora,
    )

    inicio = time.time()
    retomar = not args.teste and any(n.startswith("checkpoint") for n in os.listdir(config.output_dir)) if os.path.isdir(config.output_dir) else False
    treinador.train(resume_from_checkpoint=retomar or None)
    print(f"Treino terminou em {(time.time() - inicio) / 60:.1f} min")
    if not args.teste:
        resultado = treinador.evaluate()
        perda = resultado.get("eval_loss")
        if perda is not None:
            print(f"Perda de validação: {perda:.3f} (perplexidade {math.exp(perda):.1f})")

    ajuste = os.path.join(args.saida, "ajuste-lora")
    treinador.model.save_pretrained(ajuste)
    print(f"Ajuste salvo em {ajuste}")

    completo = os.path.join(args.saida, "completo")
    juntado = treinador.model.merge_and_unload()
    juntado.save_pretrained(completo, safe_serialization=True)
    tokenizer.save_pretrained(completo)
    with open(os.path.join(completo, "LICENSE-base.txt"), "w", encoding="utf-8") as f:
        f.write(
            f"Este modelo é um ajuste fino de {args.modelo}, distribuído sob a licença Apache 2.0.\n"
            "O aviso da licença original deve acompanhar cópias deste modelo.\n"
        )
    print(f"Modelo completo salvo em {completo}")

    if not args.sem_comparar:
        comparar(args, completo, tokenizer, dtype, gpu)


def comparar(args, completo, tokenizer, dtype, gpu):
    import torch
    from transformers import AutoModelForCausalLM

    caminho = os.path.join(AQUI, "perguntas.txt")
    with open(caminho, encoding="utf-8") as f:
        perguntas = [linha.strip() for linha in f if linha.strip() and not linha.startswith("#")]
    if args.teste:
        perguntas = perguntas[:2]
    sistema = identidade()
    dispositivo = "cuda" if gpu else "cpu"

    def responder(modelo, pergunta):
        mensagens = [{"role": "system", "content": sistema}, {"role": "user", "content": pergunta}]
        texto = tokenizer.apply_chat_template(mensagens, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        entrada = tokenizer(texto, return_tensors="pt").to(dispositivo)
        with torch.no_grad():
            saida = modelo.generate(**entrada, max_new_tokens=60 if args.teste else 300, do_sample=False)
        return tokenizer.decode(saida[0][entrada["input_ids"].shape[1]:], skip_special_tokens=True).strip()

    respostas = {}
    # Um modelo de cada vez na placa: os dois juntos não cabem com folga.
    for nome, origem in (("Original", args.modelo), ("Ghost", completo)):
        modelo = AutoModelForCausalLM.from_pretrained(origem, dtype=dtype).to(dispositivo)
        respostas[nome] = [responder(modelo, pergunta) for pergunta in perguntas]
        del modelo
        if gpu:
            torch.cuda.empty_cache()
    linhas = ["# Comparação: modelo original × Ghost treinada", ""]
    for numero, pergunta in enumerate(perguntas):
        linhas.append(f"## {numero + 1}. {pergunta}\n")
        linhas.append(f"**Original:** {respostas['Original'][numero]}\n")
        linhas.append(f"**Ghost:** {respostas['Ghost'][numero]}\n")
    destino = os.path.join(args.saida, "comparacao.md")
    with open(destino, "w", encoding="utf-8") as f:
        f.write("\n".join(linhas))
    print(f"Comparação salva em {destino}")


if __name__ == "__main__":
    main()
