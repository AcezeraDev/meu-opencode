<h1 align="center">Meu OpenCode</h1>

<p align="center">Minha versão do <a href="https://github.com/anomalyco/opencode">OpenCode</a>: visual de osciloscópio, medições ao vivo enquanto a IA responde e um app de desktop que se atualiza sozinho a partir deste código.</p>

![O chat com a tela do osciloscópio, a faixa de medição ao vivo e o resumo de cada resposta](packages/app/.impeccable/review/desktop.png)

> [!NOTE]
> Projeto pessoal, para meu próprio uso. **Não é feito pela equipe do OpenCode e não tem ligação com ela.** O OpenCode original está em [anomalyco/opencode](https://github.com/anomalyco/opencode).

## O que mudei

### O visual: osciloscópio de bancada

Cada resposta da IA é tratada como um sinal ao vivo, medido numa tela de instrumento. O chat fica sobre um fundo escuro com uma grade fina, e a moldura ao redor é opaca. As regras completas do visual estão em [packages/app/DESIGN.md](packages/app/DESIGN.md), e a ideia do produto em [packages/app/PRODUCT.md](packages/app/PRODUCT.md).

- **Cor RGB sempre mudando**, mas só no que está ao vivo: a luz em volta do chat enquanto a IA responde, o botão de enviar/parar, a aba ativa. Erros, avisos e edições têm cores fixas.
- **Enquanto a IA responde:** uma luz corre em volta do painel do chat e, quando ela está pensando, aparece uma onda correndo.
- A velocidade da troca de cor, o brilho da resposta e o limite de gasto ficam em **Configurações → Geral**. Com as animações reduzidas no sistema, tudo isso para.

### Funções que adicionei

- **Faixa de medição ao vivo**, acima da caixa de mensagem: tempo, velocidade em tokens/s, etapa atual, número de passos e custo.
- **Resumo de cada resposta**, no fim do turno: duração, ferramentas, arquivos, tokens, velocidade e custo.
- **Minimapa da conversa**, na borda direita: marcas das minhas mensagens, das edições e dos erros; clicar pula para o trecho.
- **Anel de contexto**, na caixa de mensagem: quanto da memória do modelo a conversa já usa, com "Compactar agora" a um clique.
- **Gasto do dia** na barra de título, somando todas as sessões, com limite diário e aviso.
- **Cola de atalhos:** segurar `Ctrl` mostra todos os atalhos disponíveis.
- **Gerador de vídeos na web:** uma ferramenta que a IA pode usar para gerar vídeos, com painel próprio nas configurações.

### App de desktop pessoal

O **OpenCode Personal** é um app instalado ao lado do OpenCode oficial, compilado a partir desta pasta. Um vigia observa o código, recompila sozinho depois que eu paro de editar e instala quando o app fecha; também dá para clicar em **Atualizar** e depois em **Reiniciar** na barra de título.

```bash
bun script/personal-desktop/update.ts    # compila agora
bun script/personal-desktop/watch.ts     # vigia o código e recompila
bun script/personal-desktop/startup.ts   # liga o vigia junto com o Windows
```

O app pessoal nunca divide pasta, nome de pacote ou cache com o oficial.

## Como rodar

```bash
bun install
bun dev            # o agente no terminal
bun dev:web        # o app no navegador
bun dev:desktop    # o app de desktop
```

## Acompanhando o OpenCode oficial

A branch `dev` aqui do meu computador guarda o histórico completo do projeto original e é por ela que eu puxo as novidades:

```bash
git pull origin dev
```

Este repositório recebe só uma foto do código, sem os commits do projeto original:

```bash
git branch -f pessoal $(git commit-tree "dev^{tree}" -p pessoal -m "o que mudou")
git push meu pessoal:dev
```

## Licença

MIT, igual ao projeto original — veja [LICENSE](LICENSE). O OpenCode é feito pela [Anomaly](https://github.com/anomalyco); o que está aqui são as minhas mudanças em cima dele.
