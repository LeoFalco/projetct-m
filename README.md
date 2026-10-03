# projetct-m

Entenda como você gasta tokens do Claude Code: por sessão, por assunto, por máquina e por horário.

O Claude Code grava em cada máquina uma transcrição de cada sessão (`~/.claude/projects`), com os
tokens de cada resposta. O `ptm` lê essas transcrições, guarda só as métricas e junta as de todas
as suas máquinas num repositório privado seu.

## Uso

Requer Node 22+ e, para sincronizar, `git` e [`gh`](https://cli.github.com) autenticado.

```sh
git clone https://github.com/LeoFalco/projetct-m && cd projetct-m && npm link

ptm collect     # lê as sessões desta máquina
ptm classify    # dá um assunto a cada sessão (usa o Haiku via `claude -p`)
ptm report      # relatório no terminal
ptm dashboard   # dashboard em HTML
```

`ptm report` aceita `--days N` (padrão 30), `--all`, `--top N` e `--machine NOME`.

### Várias máquinas

Na primeira máquina, crie o repositório privado de dados; nas outras, o mesmo comando o clona:

```sh
ptm sync --init          # cria/usa <seu-usuário>/projetct-m-data (privado)
ptm collect && ptm sync  # em cada máquina, sempre que quiser atualizar
```

O repositório de dados é configurável. O `ptm` usa, nesta ordem: o argumento de
`ptm sync --init dono/nome`, a variável `PTM_DATA_REPO`, o campo `dataRepo` de
`~/.projetct-m/config.json` e, por fim, `<seu-usuário>/projetct-m-data`. O `--init` grava a escolha
no `config.json` da máquina.

Toda máquina precisa do `gh` autenticado (`gh auth login` e `gh auth setup-git`): o `ptm` confere
que o repositório é privado antes de cada envio e se recusa a enviar se não for.

Cada máquina escreve só no seu próprio diretório, então não há conflito. O nome da máquina é o
hostname; para trocar, defina `PTM_MACHINE` ou `machine` em `~/.projetct-m/config.json`.

**Rode `ptm collect` com frequência** (um cron diário resolve): o Claude Code apaga transcrições
com mais de 30 dias, e o que não foi coletado até lá se perde. O que já foi coletado fica guardado.

## O que é medido

Uma linha por resposta da API: horário, modelo, tokens de entrada, saída, cache lido e cache
escrito, ferramentas usadas, skill/servidor MCP e se veio de um subagente. Por sessão: título,
projeto, branch, início e fim.

O total é dominado por **cache lido** (o contexto reenviado a cada resposta), que custa bem menos
por token que saída. Olhe os tipos separadamente antes de concluir o que "gasta mais".

## Privacidade

Este repositório é público e não contém dados. As métricas ficam em `~/.projetct-m/data` e, se
você sincronizar, num repositório **privado**. Elas incluem títulos de sessão e caminhos de
projeto, mas nunca o conteúdo das conversas. `ptm classify` envia o título e o início do primeiro
prompt de cada sessão ao modelo para escolher o assunto; esse trecho não é gravado.

## Limitações

- **Sessões na nuvem** (Claude Code na web, rotinas agendadas) não deixam transcrição em nenhuma
  máquina sua e não são medidas. Não há API de uso por conta para login por assinatura.
- Só há dados de máquinas onde o `ptm collect` roda.
- O assunto é decidido pelo título e pelo primeiro pedido da sessão. Uma sessão que começa com uma
  pergunta simples e cresce continua com o assunto inicial; `ptm classify --force` reclassifica.
