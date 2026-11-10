# Bot do Discord do OpenSpeak

Avisa no Discord quando alguém está transmitindo no OpenSpeak — **quem** está
ao vivo e **qual app** (o programa da janela transmitida, ou "Tela inteira" /
"Câmera"). Três avisos, cada um liga/desliga na config:

| Aviso | Onde aparece | Chave |
|---|---|---|
| Status do canal de voz | A "descrição" embaixo do nome da call — nas calls que têm gente, ou num canal fixo | `voiceStatus` |
| Chat | Mensagem num canal de texto específico (editada ou apagada ao terminar) | `chat` |
| Status do bot | O status personalizado do bot na lista de membros | `presence` |

Dá para configurar pelo próprio Discord com o comando **`/openspeak`** (só para
quem tem **Gerenciar servidor**; as respostas só você vê):

| Comando | O que faz |
|---|---|
| `/openspeak canal canal:#avisos` | Escolhe o canal de texto dos avisos neste servidor (e liga o chat) |
| `/openspeak avisos aviso:<Chat / Status do canal de voz / Status do bot> ligado:<sim/não>` | Liga ou desliga um aviso |
| `/openspeak voz [canal:#call]` | Liga o status de voz: num canal fixo, ou (sem canal) nas calls com gente |
| `/openspeak mencao quem:<Ninguém / @here / @everyone / cargo> [cargo:@Cargo]` | Quem o aviso no chat menciona |
| `/openspeak links ligado:<sim/não> [modo] [servico]` | Correção de links do X/Twitter (veja abaixo) |
| `/openspeak ver` | Mostra o que está ligado neste servidor (e a carga do servidor OpenSpeak) |

**Tudo é por servidor do Discord**: chat (canal e menção), status do canal de
voz (canal fixo ou automático) e links do X. Cada servidor onde o bot está
configura os seus. A exceção é o **status do bot**, que é um só e aparece em
todos: só o dono da aplicação (ou quem administra o servidor do `guildId` da
config) liga ou desliga.

E dois comandos para qualquer pessoa (também na DM com o bot):

| Comando | O que faz |
|---|---|
| `/aovivo` | Lista quem está transmitindo agora, o app, o canal, espectadores e há quanto tempo |
| `/servidor` | Usuários online, transmissões, quantos estão assistindo e o tráfego do servidor |

Os comandos são registrados como **globais** (um por vez, sem apagar outros
comandos da aplicação, como o de abrir a atividade): é isso que faz o Discord
mostrar o selo **"Supports Slash Commands"** e a lista de comandos no perfil do
bot. Comandos `/openspeak` antigos, registrados por servidor, são removidos
para não aparecerem duplicados.

Tudo vem **desligado** por padrão: ligue o que quiser com `/openspeak avisos`
(ou `"enabled": true` no `config.json`). As escolhas do `/openspeak` ficam no
`state.json` (`guilds`, por servidor; `settings`, o status do bot) e valem por
cima do `config.json`, que é o padrão de todos os servidores (um `channelId` da
config só vale no servidor daquele canal). Um `state.json` de versão antiga, com
os avisos globais, é migrado sozinho: o chat vai para o servidor do canal
escolhido e o status de voz automático continua ligado onde já estava.

Quem transmite escolhe por transmissão: **Configurações avançadas → "Mostrar ao
vivo no bot do Discord"** (ligado por padrão), no app nativo e no cliente web.
Transmissões com a opção desligada não aparecem em lugar nenhum.

## Links do X/Twitter

O Discord costuma mostrar a prévia de posts do X quebrada. Com
`/openspeak links ligado:sim`, o bot troca links de post
(`x.com`/`twitter.com`, com ou sem `www.`/`mobile.`, formato
`/usuario/status/ID`) por `fxtwitter.com` (ou `fixupx.com` / `vxtwitter.com`
com `servico:`), mantendo o caminho (`/photo/1`…) e tirando o rastreio
(`?s=20`, `?t=…`). Vale **por servidor** e vem **desligado** em todos; a escolha
fica no `state.json` (`guilds.<servidor>.links`), e não depende do `guildId` da config.

| `modo:` | O que faz |
|---|---|
| **Responder** (padrão) | Tira a prévia quebrada da mensagem original (*Gerenciar mensagens*) e responde com o(s) link(s) corrigido(s), sem mencionar o autor |
| **Substituir** | Apaga a mensagem e reenvia o texto inteiro, já corrigido, por um webhook com o nome e o avatar do autor — parece que ele mandou o link do fxtwitter direto |

No modo substituir:

- um webhook por canal, reaproveitado (o bot procura um dele antes de criar
  outro e guarda em cache; se alguém o apagar, cria de novo); em threads o
  webhook fica no canal pai e o envio vai para a thread;
- todas as menções são bloqueadas no reenvio (`@everyone`, cargos e pessoas não
  são pingados de novo);
- o original só é apagado depois que o reenvio deu certo;
- cai no modo responder quando a mensagem é **resposta** a outra (o webhook
  perderia a referência), tem **anexo**, figurinha ou enquete, ficaria com mais
  de 2000 caracteres, ou falta **Gerenciar webhooks** / **Gerenciar mensagens**.

Mensagens de bots e de webhooks são ignoradas (sem loop), e links entre `< >`
(o autor pediu sem prévia) ficam como estão. Sem permissão para responder no
canal, o bot só registra no log.

**Precisa do _Message Content Intent_**: no Developer Portal → **Bot** →
*Privileged Gateway Intents* → ative **Message Content Intent**. Sem ele, o bot
conecta assim mesmo (os avisos de transmissão seguem funcionando), avisa no log
e no `/openspeak ver`, e não corrige links. Permissões extras: **Gerenciar
mensagens** e, para o modo substituir, **Gerenciar webhooks** (além de Ver
canais, Enviar mensagens, Enviar mensagens em threads e Ler histórico).

## Como funciona

O bot consulta `GET <openspeakUrl>/api/live` a cada `pollSeconds` segundos. O
endpoint existe no servidor nativo (`openspeak-server`) e no servidor Node
(`npm start`) e só lista transmissões com `announce` ligado, com campos
públicos (título, apelido, canal, app, espectadores) — nada de uid, IP ou
miniatura —, mais a carga do servidor em `stats` (só contagens). O bot não entra no servidor OpenSpeak, então não aparece na lista
de usuários de lá.

### Webhook (instantâneo)

Com o webhook ligado, o servidor avisa o bot no mesmo instante (~0,3 s) em
vez de esperar a próxima consulta: transmissões, espectadores, troca de
apelido e gente entrando ou saindo do servidor (contador "online"). O tráfego
(Mbps, só no servidor nativo com SFU) vai no máximo a cada 15 s, e só quando o
valor arredondado muda. O bot troca o próprio status no máximo a cada 5 s
(limite do Discord), sempre com o dado mais recente.

A consulta continua como rede de segurança (POST perdido, bot reiniciando,
servidor fora do ar): com o webhook, use `"pollSeconds": 300`.

No bot (`config.json`):

```json
"webhook": { "port": 9991, "secret": "um-segredo-longo" }
```

No servidor OpenSpeak (nativo ou Node), na mesma máquina:

```bash
OPENSPEAK_LIVE_WEBHOOK=http://127.0.0.1:9991/live
OPENSPEAK_LIVE_WEBHOOK_SECRET=um-segredo-longo
```

O servidor manda um `POST` com o mesmo JSON do `/api/live` (header
`X-OpenSpeak-Secret`) quando uma transmissão anunciada começa, muda ou
termina. O bot escuta só em `127.0.0.1` (troque com `"host"` se o servidor
estiver em outra máquina, e aí use o segredo). O segredo também pode vir de
`OPENSPEAK_BOT_WEBHOOK_SECRET`.

Se o servidor OpenSpeak ficar fora do ar por ~4 consultas seguidas, o bot
considera que ninguém está ao vivo e encerra os avisos.

## Instalação

1. Em <https://discord.com/developers/applications> crie uma aplicação →
   **Bot** → copie o token. Para os avisos nenhuma *privileged intent* é
   necessária; para corrigir links do X, ative o **Message Content Intent**.
2. Convide o bot (OAuth2 → URL Generator → escopos `bot` e `applications.commands`) com as permissões
   abaixo — todas juntas dão o inteiro **`281750391712784`**:

   ```text
   https://discord.com/oauth2/authorize?client_id=1559719687493910620&scope=bot+applications.commands&permissions=281750391712784
   ```

   - **Ver canais**, **Enviar mensagens**, **Inserir links**, **Ler histórico de
     mensagens** (aviso no chat, que é editado ao terminar;
     **Mencionar @everyone** se usar `mention` com @here/@everyone/cargo);
   - **Definir status do canal de voz** e **Gerenciar canais** nos canais de voz
     (o Discord exige *Gerenciar canais* para quem não está conectado na call).
     No modo automático, dê essas permissões a um cargo do bot no servidor todo;
   - links do X: **Gerenciar mensagens**, **Gerenciar webhooks** (modo
     substituir) e **Enviar mensagens em threads**.
3. IDs de canal são opcionais: o canal do chat se escolhe com `/openspeak canal`
   e o status de voz vai sozinho para as calls com gente. Para fixar um canal na
   config, ative o Modo Desenvolvedor (Configurações → Avançado) e use o botão
   direito no canal → **Copiar ID**.
4. Configure e rode (Node 18.17+):

```bash
cd discord-bot
npm install
cp config.example.json config.json
DISCORD_TOKEN=seu-token npm start
```

`DISCORD_TOKEN` também pode ir em `"token"` no `config.json` (que fica fora
do git). Outros caminhos: `OPENSPEAK_BOT_CONFIG` (config) e
`OPENSPEAK_BOT_STATE` (arquivo onde o bot lembra as mensagens publicadas, para
editá-las mesmo depois de reiniciar).

## Configuração

```jsonc
{
  "openspeakUrl": "https://openspeak.duckdns.org", // servidor OpenSpeak (http/https, sem /ws)
  "pollSeconds": 15,                                // 5 a 300
  "guildId": "",                                    // opcional: avisos de transmissão só neste servidor do Discord (links valem em todos)

  "voiceStatus": {
    "enabled": false,
    "channelId": "",                                // vazio: calls com alguém conectado; ou o ID de um canal fixo
    "live": "🔴 Ao vivo no OpenSpeak: {lista}",
    "item": "{quem} ({app})",                       // cada item de {lista}
    "idle": ""                                      // sem ninguém ao vivo ("" limpa)
  },
  "chat": {
    "enabled": false,
    "channelId": "",                                // canal de texto; vazio = escolher com /openspeak canal
    "mention": "",                                  // ex.: "@here" ou "<@&ID_DO_CARGO>"
    "onEnd": "edit"                                 // edit (marca como encerrada, com a duração, quem assistiu e, no SFU, os dados), delete ou keep
  },
  "presence": {
    "enabled": false,
    "live": "{quem} transmitindo {app}",
    "liveMany": "{qtd} transmissões ao vivo no OpenSpeak", // mais de uma ao mesmo tempo
    "idle": "Ninguém ao vivo no OpenSpeak",
    "server": "👥 {usuarios} online · 👀 {assistindo} assistindo{trafego}", // "" desliga
    "rotateSeconds": 20,                            // 15 a 600: alterna entre o texto acima e "server"
    "type": "custom"                                // custom, playing, watching, listening ou competing
  }
}
```

Com `voiceStatus.channelId` vazio, o bot põe o status em toda call que tem
alguém (que não seja bot) e limpa assim que ela esvazia ou a transmissão acaba.
Quem entra numa call durante uma transmissão vê o status na hora.

Marcadores nos textos: `{quem}` (apelido), `{app}`, `{titulo}`, `{canal}`
(canal do OpenSpeak), `{espectadores}`, `{qtd}` (transmissões ao vivo) e
`{lista}` (só no status do canal de voz).

Carga do servidor (valem em todos os textos): `{usuarios}` (conectados),
`{transmissoes}` (todas, inclusive as que não aparecem no bot — só a
contagem), `{assistindo}` (espectadores somados), `{mbps}` (tráfego de mídia
do servidor, entrada + saída) e `{trafego}` (" · 12 Mbps", ou vazio quando o
servidor não mede). O tráfego só existe no servidor nativo com SFU: no P2P a
mídia vai direto entre as pessoas e o servidor não a vê (`{mbps}` mostra "—").
Os números vêm do campo `stats` do `/api/live`, só contagens agregadas.

**Status do bot**: o texto de quem está ao vivo e o da carga do servidor
(`server`) se alternam a cada `rotateSeconds`; quando alguém começa a
transmitir, aparece na hora. Sem ninguém ao vivo o status fica parado: mostra
a carga do servidor se há gente conectada, senão o texto `idle`. Com `type: "custom"` o Discord mostra só o texto;
com `playing`/`watching`/`listening`/`competing` aparece como
"Jogando …", "Assistindo …", "Ouvindo …" ou "Competindo em …".

## Rodando na VM junto do servidor

Exemplo de serviço systemd (`/etc/systemd/system/openspeak-bot.service`):

```ini
[Unit]
Description=Bot do Discord do OpenSpeak
After=network-online.target

[Service]
WorkingDirectory=/opt/openspeak/discord-bot
Environment=DISCORD_TOKEN=seu-token
ExecStart=/usr/bin/node src/bot.js
Restart=always
User=openspeak

[Install]
WantedBy=multi-user.target
```

## Testes

```bash
cd discord-bot
npm test
```
