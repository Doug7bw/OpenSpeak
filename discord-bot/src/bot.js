// Bot do Discord do OpenSpeak: consulta o GET /api/live do servidor e avisa quem
// está transmitindo (e qual app) no status do canal de voz, num canal de texto e
// no status do próprio bot. Cada aviso liga/desliga na config; quem transmite
// escolhe por stream ("Mostrar ao vivo no bot do Discord", configurações avançadas).
//
// Também corrige links do X/Twitter (desligado por padrão, liga por servidor com
// /openspeak links): troca por fxtwitter.com para o Discord mostrar a prévia certa.
//
// Uso: DISCORD_TOKEN=... node src/bot.js   (config em ./config.json ou OPENSPEAK_BOT_CONFIG)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActivityType, ChannelType, Client, EmbedBuilder, GatewayIntentBits, InteractionContextType, MessageFlags,
  MessageType, PermissionFlagsBits, Routes,
  SlashCommandBuilder,
} from 'discord.js';
import {
  NOTICES, appLabel, applySettings, checkConfig, diff, guildNotices, migrateMessages, migrateSettings, formatDuration, parseLive, parseStats, planVoiceUpdates,
  mediaText, presenceText, serverText, statsVars, streamKey, voiceStatusText, watchersText,
} from './live.js';
import { startWebhook } from './webhook.js';
import { LINK_SERVICES, chooseLinkAction, linkSettings, rewriteXLinks, webhookName } from './xlinks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.resolve(process.env.OPENSPEAK_BOT_CONFIG ?? path.join(ROOT, 'config.json'));
const STATE_FILE = path.resolve(process.env.OPENSPEAK_BOT_STATE ?? path.join(ROOT, 'state.json'));
/** Falhas seguidas ao consultar o servidor até considerar que ninguém está ao vivo. */
const OFFLINE_AFTER_FAILURES = 4;
/** Intervalo mínimo entre trocas do status do bot (limite do Discord). */
const PRESENCE_MIN_MS = 5000;

const log = (...args) => console.log(new Date().toISOString(), ...args);

function loadConfig() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error(`Não foi possível ler ${CONFIG_FILE}: ${err.message}\nCopie config.example.json para config.json e preencha.`);
    process.exit(1);
  }
  const problems = checkConfig(config);
  const token = process.env.DISCORD_TOKEN || config.token;
  if (!token) problems.push('defina DISCORD_TOKEN (variável de ambiente) ou "token" na config');
  if (problems.length) {
    console.error(`Config inválida (${CONFIG_FILE}):\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  return { config, token };
}

/** Mensagens publicadas no chat, por stream: sobrevivem a reinícios do bot. */
function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      messages: state.messages && typeof state.messages === 'object' ? state.messages : {},
      voice: state.voice && typeof state.voice === 'object' ? state.voice : {}, // canal -> status escrito
      settings: state.settings && typeof state.settings === 'object' ? state.settings : {}, // escolhas do /openspeak
      // Por servidor do Discord: { chat, voiceStatus, links } (escolhas do /openspeak naquele servidor).
      guilds: state.guilds && typeof state.guilds === 'object' ? state.guilds : {},
      links: state.links, // formato antigo (só migração)
    };
  } catch {
    return { messages: {}, voice: {}, settings: {}, guilds: {} };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log('aviso: não foi possível salvar o estado:', err.message);
  }
}

function explain(err) {
  // 50013 = Missing Permissions, 50001 = Missing Access, 10003 = Unknown Channel
  if (err?.code === 50013) return 'sem permissão (veja as permissões no README)';
  if (err?.code === 50001) return 'o bot não tem acesso ao canal';
  if (err?.code === 10003) return 'canal não encontrado (confira o ID)';
  if (err?.code === 30007) return 'o canal já tem webhooks demais (limite do Discord)';
  return err?.message ?? String(err);
}

/** /openspeak: avisos e links deste servidor (o status do bot é global). */
const ADMIN_COMMAND = new SlashCommandBuilder()
  .setName('openspeak')
  .setDescription('Avisos de transmissões do OpenSpeak')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(sub => sub
    .setName('canal')
    .setDescription('Canal de texto deste servidor onde o bot avisa quem está ao vivo')
    .addChannelOption(opt => opt
      .setName('canal').setDescription('Canal de texto').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand(sub => sub
    .setName('avisos')
    .setDescription('Liga ou desliga um dos avisos')
    .addStringOption(opt => opt
      .setName('aviso').setDescription('Qual aviso').setRequired(true)
      .addChoices(
        { name: 'Chat (mensagem no canal de texto)', value: 'chat' },
        { name: 'Status do canal de voz', value: 'voz' },
        { name: 'Status do bot', value: 'status' },
      ))
    .addBooleanOption(opt => opt.setName('ligado').setDescription('Ligar ou desligar').setRequired(true)))
  .addSubcommand(sub => sub
    .setName('voz')
    .setDescription('Canal de voz do status (sem canal: as calls com alguém conectado)')
    .addChannelOption(opt => opt
      .setName('canal').setDescription('Canal de voz fixo (deixe vazio para as calls com gente)')
      .addChannelTypes(ChannelType.GuildVoice)))
  .addSubcommand(sub => sub
    .setName('mencao')
    .setDescription('Quem o aviso no chat menciona')
    .addStringOption(opt => opt
      .setName('quem').setDescription('Quem mencionar').setRequired(true)
      .addChoices(
        { name: 'Ninguém', value: 'ninguem' },
        { name: '@here', value: '@here' },
        { name: '@everyone', value: '@everyone' },
        { name: 'Um cargo (escolha em "cargo")', value: 'cargo' },
      ))
    .addRoleOption(opt => opt.setName('cargo').setDescription('Cargo a mencionar')))
  .addSubcommand(sub => sub
    .setName('links')
    .setDescription('Corrige links do X/Twitter neste servidor (troca por fxtwitter para a prévia funcionar)')
    .addBooleanOption(opt => opt.setName('ligado').setDescription('Ligar ou desligar').setRequired(true))
    .addStringOption(opt => opt
      .setName('modo').setDescription('Como corrigir (padrão: responder)')
      .addChoices(
        { name: 'Responder: tira a prévia original e responde com o link corrigido', value: 'responder' },
        { name: 'Substituir: apaga a mensagem e reenvia como o autor', value: 'substituir' },
      ))
    .addStringOption(opt => opt
      .setName('servico').setDescription('Serviço da prévia (padrão: fxtwitter.com)')
      .addChoices(...LINK_SERVICES.map(s => ({ name: s, value: s })))))
  .addSubcommand(sub => sub.setName('ver').setDescription('Mostra a configuração deste servidor'));

/** Comandos para qualquer pessoa (também na DM com o bot). */
const PUBLIC_CONTEXTS = [InteractionContextType.Guild, InteractionContextType.BotDM];
const COMMANDS = [
  ADMIN_COMMAND,
  new SlashCommandBuilder().setName('aovivo').setDescription('Quem está transmitindo no OpenSpeak agora')
    .setContexts(...PUBLIC_CONTEXTS),
  new SlashCommandBuilder().setName('servidor').setDescription('Usuários online, transmissões e tráfego do servidor OpenSpeak')
    .setContexts(...PUBLIC_CONTEXTS),
];
const COMMAND_NAMES = new Set(COMMANDS.map(c => c.name));

/** Tipo da atividade no status do bot (config presence.type). */
const ACTIVITY_TYPE = {
  playing: ActivityType.Playing, watching: ActivityType.Watching,
  listening: ActivityType.Listening, competing: ActivityType.Competing,
};

const LINK_MODE_NAME = {
  responder: 'responde com o link corrigido (tira a prévia original)',
  substituir: 'apaga e reenvia como o autor',
};

const NOTICE_NAME = { chat: 'Chat', voiceStatus: 'Status do canal de voz', presence: 'Status do bot' };

class LiveBot {
  constructor(baseConfig, client) {
    this.baseConfig = baseConfig;
    this.client = client;
    this.state = loadState();
    this.migrateState();
    // Global: status do bot, textos e servidor OpenSpeak. Chat e status de voz: por servidor (notices()).
    const config = (this.config = applySettings(baseConfig, this.state.settings));
    this.known = new Map(); // chave -> stream (último visto)
    this.watched = new Map(); // chave -> apelidos de quem assistiu em algum momento
    this.chatFailed = new Set(); // "stream|servidor|canal" que falhou: não insiste a cada consulta
    this.failures = 0;
    this.voiceText = '';
    // Status já escrito por canal de voz (limpa o que ficou de antes de um reinício).
    // Num canal fixo a primeira escrita é forçada ('\0'), para limpar um status antigo.
    this.voiceCurrent = new Map(Object.entries(this.state.voice));
    for (const guild of this.client.guilds.cache.values()) {
      const v = this.notices(guild.id).voiceStatus;
      if (v.enabled && v.channelId && !this.voiceCurrent.has(v.channelId)) this.voiceCurrent.set(v.channelId, '\0');
    }
    this.voiceQueue = Promise.resolve();
    this.owner = null; // dono da aplicação (User ou Team), para o status do bot
    this.lastPresence = null;
    // Status do bot: alterna entre quem está ao vivo e a carga do servidor.
    this.presenceTexts = [];
    this.presenceIndex = 0;
    this.presenceMain = null;
    this.presenceLive = false;
    this.lastPresenceLive = null;
    this.pendingPresence = null;
    this.presenceAt = 0;
    this.presenceTimer = null;
    this.streams = [];
    this.stats = parseStats(null); // carga do servidor (desconhecida até a primeira resposta)
    this.queue = Promise.resolve(); // consultas e webhooks, um de cada vez
    this.liveUrl = new URL('/api/live', config.openspeakUrl).toString();
    this.webhooks = new Map(); // canal -> Promise<Webhook> (um webhook do bot por canal)
    this.messageIntent = true; // false se o Message Content Intent não está ativo no portal
  }

  /** state.json de versões antigas (avisos globais, um servidor só) -> por servidor. */
  migrateState() {
    const s = this.state;
    const guildOf = channelId => this.client.channels.cache.get(channelId)?.guildId;
    s.messages = migrateMessages(s.messages, guildOf);
    if (s.settings.chat || s.settings.voiceStatus) {
      ({ settings: s.settings, guilds: s.guilds } = migrateSettings(s.settings, s.guilds, {
        chatGuild: s.settings.chat?.channelId ? guildOf(s.settings.chat.channelId) : '',
        guildIds: [...this.client.guilds.cache.keys()],
        homeGuild: this.baseConfig.guildId,
      }));
      log('state.json: avisos do /openspeak agora são por servidor (escolhas antigas migradas)');
    }
    for (const [guildId, links] of Object.entries(s.links ?? {})) s.guilds[guildId] = { links, ...s.guilds[guildId] };
    delete s.links;
    saveState(s);
  }

  /** Chat e status de voz deste servidor do Discord. */
  notices(guildId) {
    return guildNotices(this.config, this.state.guilds[guildId], guildId);
  }

  saveGuild(guildId, section, values) {
    const guild = (this.state.guilds[guildId] ??= {});
    guild[section] = { ...guild[section], ...values };
    saveState(this.state);
    // Mexeu no chat (ex.: deu a permissão e escolheu o canal de novo): tenta avisar outra vez.
    if (section === 'chat') for (const failed of this.chatFailed) if (failed.includes(`|${guildId}|`)) this.chatFailed.delete(failed);
  }

  /** IDs de canal da config valem em todos os servidores: só usa no servidor do canal. */
  inGuild(channelId, guildId) {
    return this.client.channels.cache.get(channelId)?.guildId === guildId;
  }

  isBotOwner(user) {
    const owner = this.owner;
    return Boolean(owner && (owner.members ? owner.members.has(user.id) : owner.id === user.id));
  }

  async fetchStreams() {
    const res = await fetch(this.liveUrl, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${this.liveUrl}`);
    const body = await res.json();
    return { streams: parseLive(body), stats: parseStats(body) };
  }

  enqueue(job) {
    this.queue = this.queue.then(job).catch(err => log('erro:', err));
    return this.queue;
  }

  /** Consulta periódica ao /api/live (com o webhook, só uma rede de segurança). */
  tick() {
    return this.enqueue(async () => {
      let streams, stats;
      try {
        ({ streams, stats } = await this.fetchStreams());
        this.online();
      } catch (err) {
        this.failures++;
        if (this.failures === 1) log('falha ao consultar o OpenSpeak:', err.message);
        if (this.failures < OFFLINE_AFTER_FAILURES) return; // mantém o último estado
        if (this.failures === OFFLINE_AFTER_FAILURES) log('servidor fora do ar: considerando que ninguém está ao vivo');
        streams = [];
        stats = parseStats(null);
      }
      await this.apply(streams, stats);
    });
  }

  /** O servidor avisou pelo webhook: atualiza na hora. */
  push(streams, stats) {
    return this.enqueue(async () => {
      this.online();
      await this.apply(streams, stats);
    });
  }

  online() {
    if (this.failures >= OFFLINE_AFTER_FAILURES) log('servidor OpenSpeak respondeu de novo');
    this.failures = 0;
  }

  async apply(streams, stats = this.stats) {
    // Mensagens de streams que já existiam antes de um reinício do bot também contam.
    const previous = new Set([...this.known.keys(), ...Object.keys(this.state.messages)]);
    const { started, stopped } = diff(previous, streams);
    const current = new Map(streams.map(s => [streamKey(s), s]));

    for (const s of started) log(`ao vivo: ${s.owner} — ${appLabel(s)} (${s.name})`);
    this.trackWatchers(current);
    // Avisos já publicados terminam mesmo com o chat desligado ou em outro canal.
    for (const key of stopped) {
      await this.finish(key, this.known.get(key));
      this.watched.delete(key);
    }
    for (const [key, s] of current) {
      const before = this.known.get(key);
      if (before && (before.app !== s.app || before.name !== s.name || before.paused !== s.paused)) await this.refresh(key, s);
    }
    // Também avisa as transmissões em andamento num servidor que acabou de ligar o chat.
    await this.announceAll(current);
    this.known = current;
    this.streams = streams;
    this.stats = stats;

    // Sempre: os servidores com o status de voz desligado simplesmente não têm canais na lista.
    this.voiceText = voiceStatusText(this.config.voiceStatus, streams, stats);
    await this.syncVoice();
    if (this.config.presence.enabled) this.updatePresence(streams, stats);
  }

  /**
   * Acumula quem assistiu: quem saiu antes do fim também entra na lista. Guardado
   * junto do aviso publicado para sobreviver a um reinício do bot.
   */
  trackWatchers(current) {
    let changed = false;
    for (const [key, s] of current) {
      const saved = this.state.messages[key];
      const names = this.watched.get(key) ?? new Set(saved?.watchers);
      for (const name of s.viewerNames) names.add(name);
      this.watched.set(key, names);
      if (saved && names.size !== (saved.watchers?.length ?? 0)) {
        saved.watchers = [...names];
        changed = true;
      }
    }
    if (changed) saveState(this.state);
  }

  // ----------------------------------------------------------------- chat

  embedFor(s, ended = false, watchers = []) {
    const embed = new EmbedBuilder()
      .setColor(ended ? 0x5c6370 : s.paused ? 0xe5a50a : 0xe5484d)
      .setTitle(ended ? `⚫ ${s.owner || 'Alguém'} encerrou a transmissão` : `🔴 ${s.owner || 'Alguém'} está ao vivo no OpenSpeak`)
      .addFields({ name: 'Transmitindo', value: appLabel(s), inline: true });
    if (s.name) embed.setDescription(s.name);
    if (ended) {
      embed.addFields({ name: 'Duração', value: formatDuration(Date.now() - s.started), inline: true });
      // Só no SFU: no P2P a mídia não passa pelo servidor, que não sabe quanto foi.
      const media = mediaText(s.media);
      if (media) embed.addFields({ name: 'Dados', value: media, inline: true });
      embed.addFields({ name: 'Assistiram', value: watchersText(watchers) });
    }
    else if (s.paused) embed.addFields({ name: 'Situação', value: 'Pausada', inline: true });
    if (!ended) embed.setURL(this.config.openspeakUrl);
    if (s.started) embed.setTimestamp(new Date(s.started));
    return embed;
  }

  /** Publica cada transmissão nos servidores com o chat ligado que ainda não a avisaram. */
  async announceAll(current) {
    if (!current.size) return;
    for (const guild of this.client.guilds.cache.values()) {
      const chat = this.notices(guild.id).chat;
      if (!chat.enabled || !chat.channelId || !this.inGuild(chat.channelId, guild.id)) continue;
      for (const [key, s] of current) {
        const failKey = `${key}|${guild.id}|${chat.channelId}`;
        if (this.state.messages[key]?.posts[guild.id] || this.chatFailed.has(failKey)) continue;
        if (!(await this.announce(key, s, guild, chat))) this.chatFailed.add(failKey);
      }
    }
  }

  async announce(key, s, guild, chat) {
    try {
      const channel = await this.client.channels.fetch(chat.channelId);
      if (!channel?.isTextBased?.()) throw new Error('o canal do chat não é um canal de texto');
      const mention = chat.mention.trim();
      const message = await channel.send({
        content: mention || undefined,
        embeds: [this.embedFor(s)],
        allowedMentions: mention ? { parse: ['everyone', 'roles', 'users'] } : { parse: [] },
      });
      const entry = (this.state.messages[key] ??= { stream: s, watchers: [...(this.watched.get(key) ?? [])], posts: {} });
      entry.stream = s;
      entry.posts[guild.id] = { channelId: channel.id, messageId: message.id };
      saveState(this.state);
      return true;
    } catch (err) {
      log(`chat em "${guild.name}": falha ao avisar:`, explain(err));
      return false;
    }
  }

  /** Mensagens publicadas da transmissão, em todos os servidores. */
  async *posts(key) {
    for (const post of Object.values(this.state.messages[key]?.posts ?? {})) {
      try {
        const channel = await this.client.channels.fetch(post.channelId);
        yield await channel.messages.fetch(post.messageId);
      } catch (err) {
        if (err?.code !== 10008 && err?.code !== 10003) log('chat: aviso publicado não encontrado:', explain(err));
      }
    }
  }

  async refresh(key, s) {
    if (!this.state.messages[key]) return;
    for await (const msg of this.posts(key)) {
      await msg.edit({ embeds: [this.embedFor(s)] }).catch(err => log('chat: falha ao atualizar aviso:', explain(err)));
    }
    this.state.messages[key].stream = s;
    saveState(this.state);
  }

  async finish(key, last) {
    const saved = this.state.messages[key];
    if (!saved) return;
    const s = last ?? saved.stream;
    if (s) log(`encerrou: ${s.owner} — ${appLabel(s)}`);
    const watchers = [...(saved.watchers ?? []), ...(this.watched.get(key) ?? [])];
    for await (const msg of this.posts(key)) {
      try {
        if (this.config.chat.onEnd === 'delete') await msg.delete();
        else if (this.config.chat.onEnd === 'edit' && s) await msg.edit({ content: null, embeds: [this.embedFor(s, true, watchers)] });
      } catch (err) {
        if (err?.code !== 10008) log('chat: falha ao encerrar aviso:', explain(err)); // 10008 = mensagem já apagada
      }
    }
    delete this.state.messages[key];
    for (const failed of this.chatFailed) if (failed.startsWith(`${key}|`)) this.chatFailed.delete(failed);
    saveState(this.state);
  }

  // --------------------------------------------- status do canal de voz

  /** Por servidor com o status de voz ligado: o canal fixo, ou as calls com alguém (que não seja bot). */
  voiceTargets() {
    const targets = [];
    for (const guild of this.client.guilds.cache.values()) {
      const voice = this.notices(guild.id).voiceStatus;
      if (!voice.enabled) continue;
      if (voice.channelId) {
        if (this.inGuild(voice.channelId, guild.id)) targets.push(voice.channelId);
        continue;
      }
      for (const channel of guild.channels.cache.values()) {
        if (channel.type === ChannelType.GuildVoice && channel.members.some(m => !m.user.bot)) targets.push(channel.id);
      }
    }
    return targets;
  }

  /** Enfileirado: roda a cada consulta e quando alguém entra/sai de uma call. */
  syncVoice() {
    this.voiceQueue = this.voiceQueue.then(async () => {
      for (const { channelId, status } of planVoiceUpdates(this.voiceCurrent, this.voiceTargets(), this.voiceText)) {
        try {
          // Não há método no discord.js: PUT /channels/{id}/voice-status { status }.
          await this.client.rest.put(`${Routes.channel(channelId)}/voice-status`, { body: { status } });
        } catch (err) {
          const name = this.client.channels.cache.get(channelId)?.name ?? channelId;
          log(`status do canal de voz "${name}":`, explain(err));
        }
        // Mesmo com erro: não insiste a cada consulta, tenta de novo na próxima mudança.
        if (status) this.voiceCurrent.set(channelId, status);
        else this.voiceCurrent.delete(channelId);
        this.state.voice = Object.fromEntries([...this.voiceCurrent].filter(([, text]) => text !== '\0'));
        saveState(this.state);
      }
    }).catch(err => log('status do canal de voz:', explain(err)));
    return this.voiceQueue;
  }

  // ------------------------------------------------------ status do bot

  updatePresence(streams, stats) {
    const main = presenceText(this.config.presence, streams, stats);
    if (main !== this.presenceMain) this.presenceIndex = 0; // mudou quem está ao vivo: mostra na hora
    this.presenceMain = main;
    const server = serverText(this.config.presence, stats);
    // Só alterna com alguém ao vivo. Sem transmissão, um texto fixo: a carga do
    // servidor se tem gente conectada, senão o "idle".
    this.presenceTexts = (streams.length ? [main, server] : [stats?.clients > 0 && server ? server : main]).filter(Boolean);
    this.presenceLive = streams.length > 0;
    this.showPresence();
  }

  /** Chamado a cada presence.rotateSeconds. */
  rotatePresence() {
    if (!this.config.presence.enabled || this.presenceTexts.length < 2) return;
    this.presenceIndex = (this.presenceIndex + 1) % this.presenceTexts.length;
    this.showPresence();
  }

  showPresence() {
    const texts = this.presenceTexts;
    this.setPresence(texts.length ? texts[this.presenceIndex % texts.length] : '', this.presenceLive);
  }

  /**
   * Com o webhook, entradas e saídas chegam em rajadas: o Discord limita trocas de
   * status, então aplica no máximo uma a cada PRESENCE_MIN_MS (sempre a mais recente).
   */
  setPresence(text, live) {
    this.pendingPresence = { text, live };
    const wait = this.presenceAt + PRESENCE_MIN_MS - Date.now();
    if (wait <= 0) return this.flushPresence();
    this.presenceTimer ??= setTimeout(() => {
      this.presenceTimer = null;
      this.flushPresence();
    }, wait);
  }

  flushPresence() {
    const { text, live } = this.pendingPresence;
    if (!this.config.presence.enabled || (text === this.lastPresence && live === this.lastPresenceLive)) return;
    this.lastPresence = text;
    this.lastPresenceLive = live;
    this.presenceAt = Date.now();
    const type = ACTIVITY_TYPE[this.config.presence.type];
    // "custom" mostra só o texto; os outros tipos aparecem como "Jogando <texto>" etc.
    const activity = type === undefined ? { type: ActivityType.Custom, name: 'OpenSpeak', state: text } : { type, name: text };
    this.client.user.setPresence({ status: live ? 'online' : 'idle', activities: text ? [activity] : [] });
  }

  // ---------------------------------------------- links do X/Twitter

  links(guildId) {
    return linkSettings(this.state.guilds[guildId]?.links);
  }

  /** Mensagem nova em algum servidor: corrige os links do X se o servidor ligou. */
  async onMessage(message) {
    // Bots e webhooks (inclusive os nossos reenvios) nunca: evita loop.
    if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;
    const settings = this.links(message.guildId);
    if (!settings.enabled) return;
    const { content, links } = rewriteXLinks(message.content, settings.service);
    if (!links.length) return;

    const channel = message.channel;
    const thread = channel.isThread();
    const target = thread ? channel.parent : channel; // o webhook fica no canal pai da thread
    const me = message.guild.members.me ?? this.client.user;
    const perms = channel.permissionsFor(me);
    const has = flag => Boolean(perms?.has(flag));
    const action = chooseLinkAction({
      mode: settings.mode,
      isReply: message.type === MessageType.Reply,
      hasExtras: message.attachments.size > 0 || message.stickers.size > 0 || Boolean(message.poll),
      contentLength: content.length,
      canWebhook: Boolean(target?.fetchWebhooks && target.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)),
      canDelete: has(PermissionFlagsBits.ManageMessages),
      canSend: has(thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages)
        && has(PermissionFlagsBits.ReadMessageHistory),
    });
    if (action === 'webhook' && await this.resend(message, content, target, thread)) return;
    if (action) await this.replyLinks(message, links, has(PermissionFlagsBits.ManageMessages));
  }

  /** Modo responder (e plano B do substituir): tira a prévia quebrada e responde, sem mencionar o autor. */
  async replyLinks(message, links, canSuppress) {
    if (canSuppress) {
      try {
        await message.suppressEmbeds(true);
      } catch (err) {
        if (err?.code !== 10008) log('links: falha ao tirar a prévia:', explain(err));
      }
    }
    try {
      await message.reply({
        content: links.join('\n'),
        allowedMentions: { parse: [], repliedUser: false },
        failIfNotExists: false,
      });
    } catch (err) {
      log('links: falha ao responder:', explain(err));
    }
  }

  /** Webhook do bot no canal: reaproveita um que já exista, senão cria um (guardado em cache). */
  webhookFor(channel) {
    let pending = this.webhooks.get(channel.id);
    if (!pending) {
      pending = (async () => {
        const existing = (await channel.fetchWebhooks()).find(w => w.owner?.id === this.client.user.id && w.token);
        return existing ?? channel.createWebhook({ name: 'OpenSpeak links', reason: 'Correção de links do X/Twitter' });
      })();
      pending.catch(() => this.webhooks.delete(channel.id)); // tenta de novo na próxima
      this.webhooks.set(channel.id, pending);
    }
    return pending;
  }

  /**
   * Modo substituir: reenvia o texto como o autor (nome e avatar dele) e só então
   * apaga o original, para não perder a mensagem se o envio falhar. false = usar o plano B.
   */
  async resend(message, content, target, thread) {
    const payload = {
      content,
      username: webhookName(message.member?.displayName ?? message.author.displayName),
      avatarURL: (message.member ?? message.author).displayAvatarURL({ size: 256 }),
      allowedMentions: { parse: [] }, // não pinga @everyone nem ninguém de novo
      ...(thread ? { threadId: message.channel.id } : {}),
    };
    let webhook, sent;
    for (let attempt = 0; attempt < 2 && !sent; attempt++) {
      try {
        webhook = await this.webhookFor(target);
        sent = await webhook.send(payload);
      } catch (err) {
        this.webhooks.delete(target.id);
        if (err?.code === 10015 && attempt === 0) continue; // webhook apagado por alguém: cria outro
        log('links: webhook falhou, respondendo em vez disso:', explain(err));
        return false;
      }
    }
    try {
      await message.delete();
      return true;
    } catch (err) {
      if (err?.code === 10008) return true; // o autor já apagou
      log('links: não consegui apagar o original:', explain(err));
      await webhook.deleteMessage(sent).catch(() => {}); // evita a mensagem duplicada
      return false;
    }
  }

  saveLinks(guildId, change) {
    this.saveGuild(guildId, 'links', { ...this.links(guildId), ...change });
  }

  linksText(guildId) {
    const l = this.links(guildId);
    const status = !l.enabled ? 'desligado — ligue com `/openspeak links`' : `${LINK_MODE_NAME[l.mode]}, via ${l.service}`;
    const warn = l.enabled && !this.messageIntent
      ? '\n⚠️ Sem o **Message Content Intent** no Developer Portal o bot não lê as mensagens: ative e reinicie o bot.' : '';
    return `${l.enabled ? '🟢' : '⚪'} **Links do X/Twitter**: ${status}${warn}`;
  }

  async onLinksCommand(interaction, reply) {
    const change = { enabled: interaction.options.getBoolean('ligado', true) };
    const mode = interaction.options.getString('modo');
    const service = interaction.options.getString('servico');
    if (mode) change.mode = mode;
    if (service) change.service = service;
    this.saveLinks(interaction.guildId, change);
    log(`/openspeak links: ${change.enabled ? 'ligado' : 'desligado'} em "${interaction.guild?.name}" (por ${interaction.user.tag})`);

    const l = this.links(interaction.guildId);
    const perms = interaction.channel?.permissionsFor?.(this.client.user);
    const missing = [];
    if (l.enabled && perms && !perms.has(PermissionFlagsBits.ManageMessages))
      missing.push('**Gerenciar mensagens** (tirar a prévia / apagar)');
    if (l.enabled && perms && l.mode === 'substituir' && !perms.has(PermissionFlagsBits.ManageWebhooks))
      missing.push('**Gerenciar webhooks** (sem isso, respondo em vez de substituir)');
    const hint = missing.length ? `\nNeste canal falta: ${missing.join(', ')}.` : '';
    await reply(`${this.linksText(interaction.guildId)}${hint}`);
  }

  // ------------------------------------------------------- /openspeak

  /**
   * Comandos globais: é o que faz o Discord mostrar "Supports Slash Commands" no
   * perfil do bot. Um create por comando (sobrescreve pelo nome) em vez de set(),
   * para não apagar os outros comandos da aplicação, como o de abrir a atividade.
   */
  async registerCommands() {
    const existing = await this.client.application.commands.fetch();
    for (const command of COMMANDS) {
      const json = command.toJSON();
      const current = existing.find(c => c.name === json.name);
      if (current?.equals(json)) continue;
      await this.client.application.commands.create(json);
      log(`comando /${json.name} registrado`);
    }
  }

  /** Versões antigas registravam o /openspeak por servidor: com o global, ficaria duplicado. */
  async removeGuildCommands(guild) {
    try {
      for (const command of (await guild.commands.fetch()).values())
        if (COMMAND_NAMES.has(command.name)) await command.delete();
    } catch (err) {
      if (err?.code !== 50001) log(`comandos antigos em "${guild.name}":`, explain(err));
    }
  }

  /** Status do bot (global): só no state.settings, valendo para todos os servidores. */
  savePresence(enabled) {
    this.state.settings.presence = { ...this.state.settings.presence, enabled };
    saveState(this.state);
    this.config = applySettings(this.baseConfig, this.state.settings);
  }

  /** Quem pode mexer no status do bot, que aparece em todos os servidores. */
  canChangePresence(interaction) {
    return this.isBotOwner(interaction.user) || Boolean(this.config.guildId && interaction.guildId === this.config.guildId);
  }

  describe(guildId) {
    const n = this.notices(guildId);
    const dot = on => (on ? '🟢' : '⚪');
    const inHere = id => id && this.inGuild(id, guildId);
    const chat = inHere(n.chat.channelId) ? `<#${n.chat.channelId}>` : 'nenhum canal escolhido — use `/openspeak canal`';
    const mention = n.chat.mention ? `, mencionando ${n.chat.mention}` : '';
    const voice = inHere(n.voiceStatus.channelId) ? `<#${n.voiceStatus.channelId}>` : 'calls com alguém conectado';
    const v = statsVars(this.stats);
    return ['**Neste servidor**',
      `${dot(n.chat.enabled)} **${NOTICE_NAME.chat}**: ${chat}${mention}`,
      `${dot(n.voiceStatus.enabled)} **${NOTICE_NAME.voiceStatus}**: ${voice}`,
      this.linksText(guildId),
      '**Em todos os servidores**',
      `${dot(this.config.presence.enabled)} **${NOTICE_NAME.presence}** (só o dono do bot muda)`,
      `Transmissões ao vivo agora: **${this.streams.length}**`,
      `Servidor: **${v.usuarios}** online, **${v.transmissoes}** transmissões, **${v.assistindo}** assistindo, **${v.mbps}** Mbps`,
    ].join('\n');
  }

  async onCommand(interaction) {
    if (interaction.commandName === 'aovivo') return this.onLiveCommand(interaction);
    if (interaction.commandName === 'servidor') return this.onServerCommand(interaction);
    const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
      return reply('Só quem pode **Gerenciar servidor** configura os avisos.');
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (sub === 'links') return this.onLinksCommand(interaction, reply);
    if (sub === 'ver') return reply(this.describe(guildId));
    // Com guildId na config, os avisos de transmissão ficam só naquele servidor (links valem em todos).
    const otherGuild = !this.notices(guildId).allowed;
    const avisoStatus = sub === 'avisos' && interaction.options.getString('aviso') === 'status';
    if (otherGuild && !avisoStatus) return reply('Os avisos do OpenSpeak estão configurados para outro servidor.');

    if (sub === 'canal') {
      const channel = interaction.options.getChannel('canal', true);
      const perms = channel.permissionsFor?.(this.client.user);
      const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
      if (perms && !perms.has(needed))
        return reply(`Não consigo escrever em <#${channel.id}>: preciso de **Ver canal**, **Enviar mensagens** e **Inserir links** lá.`);
      this.saveGuild(guildId, 'chat', { channelId: channel.id, enabled: true });
      log(`/openspeak: chat em #${channel.name} de "${interaction.guild?.name}" (por ${interaction.user.tag})`);
      this.enqueue(() => this.apply(this.streams));
      await reply(`Pronto: vou avisar em <#${channel.id}> quando alguém começar a transmitir.`);
      return;
    }

    if (sub === 'voz') {
      const channel = interaction.options.getChannel('canal');
      this.saveGuild(guildId, 'voiceStatus', { channelId: channel?.id ?? '', enabled: true });
      if (channel && !this.voiceCurrent.has(channel.id)) this.voiceCurrent.set(channel.id, '\0'); // limpa status antigo
      log(`/openspeak: status de voz em ${channel ? `#${channel.name}` : 'calls com gente'} de "${interaction.guild?.name}"`);
      this.enqueue(() => this.apply(this.streams));
      await reply(channel ? `Status de voz ligado em <#${channel.id}>.` : 'Status de voz ligado nas calls com alguém conectado.');
      return;
    }

    if (sub === 'mencao') {
      const who = interaction.options.getString('quem', true);
      const role = interaction.options.getRole('cargo');
      if (who === 'cargo' && !role) return reply('Escolha o cargo na opção **cargo**.');
      const mention = who === 'ninguem' ? '' : who === 'cargo' ? `<@&${role.id}>` : who;
      this.saveGuild(guildId, 'chat', { mention });
      await reply(mention ? `Os avisos no chat vão mencionar ${mention}.` : 'Os avisos no chat não mencionam ninguém.');
      return;
    }

    if (sub === 'avisos') {
      const section = NOTICES[interaction.options.getString('aviso', true)];
      const enabled = interaction.options.getBoolean('ligado', true);
      if (section === 'presence') {
        if (!this.canChangePresence(interaction))
          return reply('O status do bot aparece em todos os servidores: só o dono do bot liga ou desliga.');
        this.savePresence(enabled);
      } else this.saveGuild(guildId, section, { enabled });
      log(`/openspeak: ${NOTICE_NAME[section]} ${enabled ? 'ligado' : 'desligado'} em "${interaction.guild?.name}" (por ${interaction.user.tag})`);
      if (section === 'voiceStatus' && !enabled) this.syncVoice(); // tira os canais deste servidor da lista: limpa
      if (section === 'presence' && !enabled) {
        this.lastPresence = this.presenceMain = null;
        this.presenceTexts = [];
        this.client.user.setPresence({ status: 'online', activities: [] });
      }
      if (enabled) this.enqueue(() => this.apply(this.streams));
      const chatId = this.notices(guildId).chat.channelId;
      const hint = section === 'chat' && enabled && !(chatId && this.inGuild(chatId, guildId)) ? '\nFalta escolher o canal: `/openspeak canal`.' : '';
      await reply(`${NOTICE_NAME[section]} ${enabled ? 'ligado' : 'desligado'}.${hint}`);
      return;
    }

  }

  /** /aovivo: quem está transmitindo (só streams com "Mostrar ao vivo no bot do Discord"). */
  async onLiveCommand(interaction) {
    const streams = this.streams;
    const embed = new EmbedBuilder().setColor(streams.length ? 0xe5484d : 0x5c6370).setURL(this.config.openspeakUrl)
      .setTitle(streams.length ? `🔴 ${streams.length} ao vivo no OpenSpeak` : 'Ninguém ao vivo no OpenSpeak agora');
    if (streams.length) {
      const now = Date.now();
      const lines = streams.slice(0, 15).map(s => {
        const parts = [`**${s.owner || 'Alguém'}** — ${appLabel(s)}`];
        if (s.channel) parts.push(s.channel);
        parts.push(`👀 ${s.viewers}`);
        if (s.started) parts.push(formatDuration(now - s.started));
        return `${s.paused ? '⏸️' : '🔴'} ${parts.join(' · ')}`;
      });
      if (streams.length > 15) lines.push(`… e mais ${streams.length - 15}`);
      embed.setDescription(lines.join('\n'));
    }
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  /** /servidor: carga do servidor (contagens agregadas do /api/live). */
  async onServerCommand(interaction) {
    const v = statsVars(this.stats);
    const offline = this.failures >= OFFLINE_AFTER_FAILURES;
    const embed = new EmbedBuilder().setColor(offline ? 0x5c6370 : 0x3ba55d).setURL(this.config.openspeakUrl)
      .setTitle(offline ? '⚫ Servidor OpenSpeak fora do ar' : '🟢 Servidor OpenSpeak')
      .addFields(
        { name: 'Online', value: v.usuarios, inline: true },
        { name: 'Transmissões', value: v.transmissoes, inline: true },
        { name: 'Assistindo', value: v.assistindo, inline: true },
        { name: 'Tráfego', value: this.stats.mbps == null ? '— (P2P: a mídia não passa pelo servidor)' : `${v.mbps} Mbps`, inline: true },
      );
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  async shutdown() {
    this.voiceText = '';
    await this.syncVoice().catch(() => {});
  }
}

const { config, token } = loadConfig();
let client;
let bot;

/**
 * GuildVoiceStates (não é privilegiada): saber quais calls têm gente.
 * GuildMessages + MessageContent (privilegiada, ativar no Developer Portal): ler
 * as mensagens para corrigir links do X. Sem ela no portal, o login falha com
 * "disallowed intents" e o bot conecta de novo sem ler mensagens (os avisos seguem).
 */
function createClient(readMessages) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
  if (readMessages) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  const c = new Client({ intents });
  c.once('clientReady', () => onReady(c, readMessages).catch(err => log('erro ao iniciar:', err)));
  c.on('interactionCreate', interaction => {
    if (!bot || !interaction.isChatInputCommand() || !COMMAND_NAMES.has(interaction.commandName)) return;
    bot.onCommand(interaction).catch(err => log(`/${interaction.commandName}:`, explain(err)));
  });
  c.on('voiceStateUpdate', (before, after) => {
    if (!bot || before.channelId === after.channelId) return;
    const voice = bot.notices(after.guild.id).voiceStatus;
    if (voice.enabled && !voice.channelId) bot.syncVoice().catch(err => log('erro:', err));
  });
  // 4014 = Disallowed Intents: o discord.js não reconecta nem sempre rejeita o login.
  c.on('shardDisconnect', event => {
    if (readMessages && event?.code === 4014) withoutMessages(c);
  });
  c.on('messageCreate', message => {
    bot?.onMessage(message).catch(err => log('links:', explain(err)));
  });
  return c;
}

async function onReady(client, readMessages) {
  bot = new LiveBot(config, client);
  bot.messageIntent = readMessages;
  const c = bot.config;
  log(`conectado como ${client.user.tag}; consultando ${new URL('/api/live', c.openspeakUrl)} a cada ${c.pollSeconds} s`);
  try {
    bot.owner = (await client.application.fetch()).owner;
  } catch (err) {
    log('não consegui ver o dono da aplicação:', explain(err));
  }
  for (const guild of client.guilds.cache.values()) {
    const n = bot.notices(guild.id);
    if (!n.chat.enabled && !n.voiceStatus.enabled) continue;
    const voice = !n.voiceStatus.enabled ? 'desligado' : n.voiceStatus.channelId ? 'canal fixo' : 'calls com gente';
    const chat = !n.chat.enabled ? 'desligado' : n.chat.channelId ? 'ligado' : 'sem canal (use /openspeak canal)';
    log(`avisos em "${guild.name}": chat ${chat}, status de voz ${voice}`);
  }
  log(`status do bot ${c.presence.enabled ? 'ligado' : 'desligado'}; ${client.guilds.cache.size} servidor(es)`);
  try {
    await bot.registerCommands();
  } catch (err) {
    log('comandos:', explain(err), '(convide o bot com o escopo applications.commands)');
  }
  for (const guild of client.guilds.cache.values()) await bot.removeGuildCommands(guild);
  if (c.webhook.port) {
    try {
      await startWebhook({ ...c.webhook, onLive: (streams, stats) => bot.push(streams, stats) });
      log(`webhook: escutando em http://${c.webhook.host}:${c.webhook.port}/live` +
        (c.webhook.secret ? ' (com segredo)' : ' (sem segredo)'));
    } catch (err) {
      log(`webhook: não foi possível escutar na porta ${c.webhook.port}: ${err.message} (seguindo só com a consulta)`);
    }
  }
  await bot.tick();
  setInterval(() => bot.tick(), c.pollSeconds * 1000);
  setInterval(() => bot.rotatePresence(), c.presence.rotateSeconds * 1000);
  const linkGuilds = Object.values(bot.state.guilds).filter(g => g?.links?.enabled).length;
  if (!readMessages && linkGuilds)
    log(`links do X: ligado em ${linkGuilds} servidor(es), mas sem o Message Content Intent não funciona`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log('encerrando');
    await bot?.shutdown();
    await client?.destroy();
    process.exit(0);
  });
}

/** Sem o Message Content Intent no portal: troca o cliente por um que não lê mensagens. */
async function withoutMessages(failed) {
  if (client !== failed) return; // já trocado
  client = null;
  log('Message Content Intent desligado no Developer Portal: conectando sem ler mensagens (links do X não funcionam)');
  await failed.destroy();
  return login(false);
}

async function login(readMessages) {
  const c = (client = createClient(readMessages));
  try {
    await c.login(token);
  } catch (err) {
    if (readMessages && /disallowed intents/i.test(err.message)) return withoutMessages(c);
    console.error('Login no Discord falhou:', err.message);
    await c.destroy();
    process.exitCode = 1;
  }
}

login(true);
