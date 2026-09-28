# Eterna Discord Bot — JavaScript

Bot Discord em **JavaScript/Node.js**, preparado para rodar no **Render** e entregar EternaCoins no Minecraft Bedrock via RCON.

## Fluxo

1. No Minecraft, o jogador executa `/eterna:autenticar`.
2. O addon mostra um código e o comando `/vincular CODIGO NOME_DO_JOGADOR`.
3. O jogador executa esse comando no Discord.
4. O bot confere o scoreboard `eterna_auth_code` por RCON.
5. O bot marca `eterna_linked 1`, limpa o código e salva o vínculo.
6. A cada limite de palavras, executa `scoreboard players add NOME eternacoins QUANTIDADE`.

## Comandos Discord

- `/vincular codigo jogador`
- `/progresso`
- `/config palavras quantidade`
- `/config moedas quantidade`
- `/config status`
- `/config canal-adicionar`
- `/config canal-remover`
- `/config canal-listar`
- `/desvincular usuario` — administrador

## Deploy no Render

Use um **Background Worker**, não um Web Service: o bot mantém uma conexão com o Gateway do Discord e não precisa abrir uma porta HTTP.

1. Suba esta pasta em um repositório Git.
2. No Render, crie `New > Background Worker` e selecione o repositório.
3. Escolha o runtime **Node**.
4. Build Command: `npm install --omit=dev`.
5. Start Command: `npm start`.
6. Configure as variáveis secretas:

```text
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
RCON_HOST=...
RCON_PORT=19132
RCON_PASSWORD=...
```

Variáveis opcionais:

```text
DISCORD_GUILD_ID=id_do_servidor_para_registro_imediato
WORDS_PER_REWARD=10
COINS_PER_REWARD=5
STATE_FILE=/var/lib/eterna/state.json
```

O arquivo `render.yaml` já contém essa configuração. Para não perder os contadores durante um redeploy, use um Persistent Disk no caminho `/var/lib/eterna`, ou depois migre o estado para um banco persistente.

## Discord Developer Portal

Ative **Message Content Intent** na página do bot. O código também solicita esse intent; os dois lados são necessários para receber o texto das mensagens.

Convide o bot com os escopos `bot` e `applications.commands`, com permissões para ler mensagens, ver canais, enviar mensagens e adicionar reações.

## Teste local

```bash
npm install
cp .env.example .env
# preencha .env sem enviar o arquivo a ninguém
npm run check
npm start
```

Nunca coloque token do Discord ou senha RCON no Git, no ZIP ou nas mensagens.
