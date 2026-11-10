// Lógica pura do bot (sem Discord): lê o GET /api/live do servidor OpenSpeak,
// descobre o que começou/terminou e monta os textos a partir dos modelos da config.

/** Rótulo quando o cliente não informa o programa (navegador, tela, câmera). */
const TYPE_LABEL = { 1: 'Câmera', 2: 'Tela inteira', 3: 'Janela', 4: 'Transmissão' };

export const VOICE_STATUS_MAX = 500; // limite do Discord
export const PRESENCE_MAX = 128;
export const ON_END = ['edit', 'delete', 'keep'];

export function appLabel(stream) {
  return (typeof stream.app === 'string' && stream.app.trim()) || TYPE_LABEL[stream.type] || 'Transmissão';
}

/** Ids de stream recomeçam ("s1") quando o servidor reinicia; o início desempata. */
export const streamKey = stream => `${stream.id}@${stream.started}`;

export function fill(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

export function streamVars(stream, total = 1) {
  return {
    quem: stream.owner || 'Alguém',
    app: appLabel(stream),
    titulo: stream.name || '',
    canal: stream.channel || '',
    espectadores: stream.viewers ?? 0,
    qtd: total,
  };
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Valida a resposta do servidor; lança se não for o formato esperado. */
export function parseLive(body) {
  if (!body || !Array.isArray(body.streams)) throw new Error('resposta inesperada de /api/live');
  return body.streams
    .filter(s => s && typeof s.id === 'string')
    .map(s => ({
      id: s.id,
      name: String(s.name ?? ''),
      owner: String(s.owner ?? ''),
      channel: String(s.channel ?? ''),
      app: String(s.app ?? ''),
      type: Number(s.type) || 0,
      paused: !!s.paused,
      viewers: Number(s.viewers) || 0,
      // Servidor antigo não manda: ninguém listado.
      viewerNames: Array.isArray(s.viewerNames) ? s.viewerNames.map(String).filter(n => n.trim()) : [],
      media: parseMedia(s.media),
      started: Number(s.started) || 0,
    }))
    .sort((a, b) => a.started - b.started);
}

/**
 * Dados da transmissão, só quando ela passa pelo relay (SFU) do servidor nativo:
 * `sent` = o que o transmissor enviou, `received` = o que os espectadores receberam.
 * `null` no P2P (a mídia não passa pelo servidor) ou em servidor antigo.
 */
function parseMedia(media) {
  const sent = Number(media?.sentBytes), received = Number(media?.receivedBytes);
  return Number.isFinite(sent) && Number.isFinite(received) ? { sent, received } : null;
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: digits })} ${units[unit]}`;
}

/** Campo "Dados" da mensagem de fim (vazio = não mostrar: transmissão P2P). */
export function mediaText(media) {
  if (!media) return '';
  return `↑ ${formatBytes(media.sent)} enviados · ↓ ${formatBytes(media.received)} recebidos`;
}

export const EMBED_FIELD_MAX = 1024; // limite do Discord

/** Quem assistiu (acumulado ao longo da transmissão), para a mensagem de fim. */
export function watchersText(names) {
  const list = [...new Set(names)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return list.length ? clip(list.join(', '), EMBED_FIELD_MAX) : 'Ninguém';
}

/**
 * Carga do servidor (campo `stats` do /api/live): só contagens agregadas.
 * `null` = servidor antigo, fora do ar, ou sem medição (Mbps no modo P2P).
 */
export function parseStats(body) {
  const stats = body?.stats;
  const count = v => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
  return {
    clients: count(stats?.clients),
    streams: count(stats?.streams),
    viewers: count(stats?.viewers),
    mbps: count(stats?.mbps),
  };
}

const UNKNOWN = '—';

/** Marcadores da carga do servidor, valem em todos os textos. */
export function statsVars(stats = {}) {
  const n = v => (v == null ? UNKNOWN : String(v));
  const mbps = stats.mbps == null ? UNKNOWN : stats.mbps.toLocaleString('pt-BR', { maximumFractionDigits: stats.mbps < 10 ? 1 : 0 });
  return {
    usuarios: n(stats.clients),
    transmissoes: n(stats.streams),
    assistindo: n(stats.viewers),
    mbps,
    // " · 12 Mbps" só quando o servidor mede (SFU); no P2P a mídia não passa por ele.
    trafego: stats.mbps == null ? '' : ` · ${mbps} Mbps`,
  };
}

/** @param {Set<string>|string[]} previous chaves já anunciadas */
export function diff(previous, streams) {
  const before = new Set(previous);
  const now = new Set(streams.map(streamKey));
  return {
    started: streams.filter(s => !before.has(streamKey(s))),
    stopped: [...before].filter(key => !now.has(key)),
  };
}

export function voiceStatusText(cfg, streams, stats) {
  const server = statsVars(stats);
  if (!streams.length) return clip(fill(cfg.idle, { ...server, qtd: 0, lista: '' }), VOICE_STATUS_MAX);
  const lista = streams.map(s => fill(cfg.item, streamVars(s, streams.length))).join(', ');
  const first = streamVars(streams[0], streams.length);
  return clip(fill(cfg.live, { ...server, ...first, lista }), VOICE_STATUS_MAX);
}

export function presenceText(cfg, streams, stats) {
  const server = statsVars(stats);
  if (!streams.length) return clip(fill(cfg.idle, { ...server, qtd: 0 }), PRESENCE_MAX);
  const template = streams.length > 1 && cfg.liveMany ? cfg.liveMany : cfg.live;
  return clip(fill(template, { ...server, ...streamVars(streams[0], streams.length) }), PRESENCE_MAX);
}

/** Texto da carga do servidor no status do bot (vazio se o servidor não informa). */
export function serverText(cfg, stats) {
  if (!cfg.server || stats?.clients == null) return '';
  return clip(fill(cfg.server, statsVars(stats)), PRESENCE_MAX);
}

/** Tipos de atividade do status do bot ("custom" mostra só o texto). */
export const PRESENCE_TYPES = ['custom', 'playing', 'watching', 'listening', 'competing'];

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * O que escrever em cada canal de voz. `current`: status já escrito por canal;
 * `targets`: canais que devem mostrar `text`. Os que saíram da lista são limpos.
 */
export function planVoiceUpdates(current, targets, text) {
  const updates = [];
  const wanted = new Set(text ? targets : []);
  for (const channelId of wanted) if (current.get(channelId) !== text) updates.push({ channelId, status: text });
  for (const [channelId, status] of current) if (!wanted.has(channelId) && status) updates.push({ channelId, status: '' });
  return updates;
}

/** Opção de /openspeak avisos -> seção da config. */
export const NOTICES = { chat: 'chat', voz: 'voiceStatus', status: 'presence' };

/**
 * Config efetiva: o config.json com as escolhas feitas pelo /openspeak por cima
 * (guardadas no state.json). Só o canal do chat e o liga/desliga de cada aviso.
 */
export function applySettings(config, settings = {}) {
  const out = { ...config };
  for (const section of Object.values(NOTICES)) {
    out[section] = { ...config[section] };
    const enabled = settings[section]?.enabled;
    if (typeof enabled === 'boolean') out[section].enabled = enabled;
  }
  if (typeof settings.chat?.channelId === 'string') out.chat.channelId = settings.chat.channelId;
  return out;
}

/** Avisos configuráveis por servidor do Discord (o status do bot é um só, global). */
export const GUILD_NOTICES = ['chat', 'voiceStatus'];

/**
 * Avisos de um servidor do Discord: o config.json é o padrão (só nos servidores
 * permitidos por `guildId`; IDs de canal da config só valem no servidor do canal,
 * o que o bot confere ao usar) e as escolhas do /openspeak naquele servidor vão por cima.
 */
export function guildNotices(config, saved = {}, guildId) {
  const allowed = !config.guildId || config.guildId === guildId;
  const chat = { enabled: !!config.chat.enabled, channelId: config.chat.channelId || '', mention: config.chat.mention || '' };
  const voiceStatus = { enabled: !!config.voiceStatus.enabled, channelId: config.voiceStatus.channelId || '' };
  const c = saved?.chat ?? {}, v = saved?.voiceStatus ?? {};
  if (typeof c.enabled === 'boolean') chat.enabled = c.enabled;
  if (typeof c.channelId === 'string') chat.channelId = c.channelId;
  if (typeof c.mention === 'string') chat.mention = c.mention;
  if (typeof v.enabled === 'boolean') voiceStatus.enabled = v.enabled;
  if (typeof v.channelId === 'string') voiceStatus.channelId = v.channelId;
  if (!allowed) chat.enabled = voiceStatus.enabled = false;
  return { allowed, chat, voiceStatus };
}

/**
 * Formato antigo das mensagens publicadas ({channelId, messageId} por stream,
 * um servidor só) -> novo ({stream, watchers, posts: {servidor: {channelId, messageId}}}).
 * `guildOf(canal)` diz o servidor; sem ele a chave vira o canal (só serve para editar no fim).
 */
export function migrateMessages(messages = {}, guildOf = () => undefined) {
  const out = {};
  for (const [key, m] of Object.entries(messages)) {
    if (!m || typeof m !== 'object') continue;
    if (m.posts && typeof m.posts === 'object') out[key] = m;
    else if (m.channelId && m.messageId)
      out[key] = { stream: m.stream, watchers: m.watchers ?? [],
        posts: { [guildOf(m.channelId) ?? m.channelId]: { channelId: m.channelId, messageId: m.messageId } } };
  }
  return out;
}

/**
 * Escolhas antigas do /openspeak (globais: state.settings.chat/voiceStatus) ->
 * por servidor. `chatGuild`: servidor do canal do chat antigo (ou null);
 * `guildIds`: servidores onde o bot está. O status de voz automático valia em
 * todos, então continua ligado em todos. Devolve {settings, guilds} novos.
 */
export function migrateSettings(settings = {}, guilds = {}, { chatGuild, guildIds = [], homeGuild = '' } = {}) {
  const out = structuredClone(guilds);
  const rest = { ...settings };
  const put = (guildId, section, values) => {
    out[guildId] = { ...out[guildId] };
    out[guildId][section] = { ...values, ...out[guildId][section] }; // não sobrescreve o que já é por servidor
  };
  if (settings.chat) {
    const target = chatGuild || homeGuild || (guildIds.length === 1 ? guildIds[0] : '');
    if (target) put(target, 'chat', settings.chat);
    delete rest.chat;
  }
  if (typeof settings.voiceStatus?.enabled === 'boolean') {
    for (const guildId of homeGuild ? [homeGuild] : guildIds) put(guildId, 'voiceStatus', { enabled: settings.voiceStatus.enabled });
  }
  delete rest.voiceStatus;
  return { settings: rest, guilds: out };
}

/** Normaliza a config e devolve a lista de problemas (vazia = ok). */
export function checkConfig(config) {
  const problems = [];
  const id = v => typeof v === 'string' && /^\d{15,25}$/.test(v);
  try {
    const url = new URL(config.openspeakUrl);
    if (!/^https?:$/.test(url.protocol)) problems.push('openspeakUrl deve começar com http:// ou https://');
  } catch {
    problems.push('openspeakUrl inválido');
  }
  config.pollSeconds = Math.min(300, Math.max(5, Number(config.pollSeconds) || 15));
  // Webhook do servidor (OPENSPEAK_LIVE_WEBHOOK): porta 0 = desligado, só a consulta.
  config.webhook = { port: 0, host: '127.0.0.1', secret: '', ...config.webhook };
  config.webhook.port = Number(config.webhook.port) || 0;
  if (process.env.OPENSPEAK_BOT_WEBHOOK_SECRET) config.webhook.secret = process.env.OPENSPEAK_BOT_WEBHOOK_SECRET;
  if (config.webhook.port < 0 || config.webhook.port > 65535) problems.push('webhook.port deve ser de 1 a 65535 (ou 0 para desligar)');
  config.voiceStatus = { enabled: false, live: '🔴 Ao vivo no OpenSpeak: {lista}', item: '{quem} ({app})', idle: '', ...config.voiceStatus };
  config.chat = { enabled: false, mention: '', onEnd: 'edit', ...config.chat };
  config.presence = {
    enabled: false, type: 'custom', live: '{quem} transmitindo {app}', liveMany: '', idle: '',
    server: '👥 {usuarios} online · 👀 {assistindo} assistindo{trafego}', rotateSeconds: 20, ...config.presence,
  };
  // O Discord limita trocas de status; abaixo de 15 s não vale a pena.
  config.presence.rotateSeconds = Math.min(600, Math.max(15, Number(config.presence.rotateSeconds) || 20));
  if (!PRESENCE_TYPES.includes(config.presence.type)) problems.push(`presence.type deve ser ${PRESENCE_TYPES.join(', ')}`);
  // Sem channelId: o status vai para os canais de voz que têm alguém conectado.
  if (config.voiceStatus.enabled && config.voiceStatus.channelId && !id(config.voiceStatus.channelId))
    problems.push('voiceStatus.channelId precisa ser o ID do canal de voz (ou vazio para os canais com gente)');
  if (config.guildId && !id(config.guildId)) problems.push('guildId precisa ser o ID do servidor do Discord (ou vazio)');
  // Sem channelId o chat espera o /openspeak canal.
  if (config.chat.channelId && !id(config.chat.channelId)) problems.push('chat.channelId precisa ser o ID do canal de texto (ou vazio para escolher com /openspeak canal)');
  if (!ON_END.includes(config.chat.onEnd)) problems.push(`chat.onEnd deve ser ${ON_END.join(', ')}`);
  return problems;
}
