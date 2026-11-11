// Correção de links para a prévia funcionar no Discord: X/Twitter (fxtwitter.com por
// padrão), TikTok (tnktok.com) e reels/posts do Instagram (uuinstagram.com). Só funções
// puras aqui; o envio (resposta ou webhook) fica no bot.js.

/** Serviços aceitos (menu do painel). */
export const LINK_SERVICES = ['fxtwitter.com', 'fixupx.com', 'vxtwitter.com'];

/** Modos: "responder" tira a prévia original e responde; "substituir" apaga e reenvia como o autor. */
export const LINK_MODES = ['responder', 'substituir'];

/** Alcance: "usuarios" = só quem ativou com /links; "todos" = todo mundo, menos quem desativou. */
export const LINK_SCOPES = ['usuarios', 'todos'];

/** Redes corrigidas (cada servidor escolhe no painel; todas ligadas por padrão). */
export const LINK_NETWORKS = {
  x: { label: 'X/Twitter', emoji: '🐦', description: 'x.com e twitter.com → fxtwitter (ou o serviço escolhido)' },
  tiktok: { label: 'TikTok', emoji: '🎵', description: 'tiktok.com → tnktok.com' },
  instagram: { label: 'Instagram', emoji: '📸', description: 'reels e posts → uuinstagram.com' },
};

export const DEFAULT_LINK_SETTINGS = Object.freeze({
  enabled: false, mode: 'responder', service: 'fxtwitter.com', scope: 'usuarios',
  networks: Object.freeze({ x: true, tiktok: true, instagram: true }),
});

/**
 * Corrige os links desta pessoa neste servidor? `userChoice`: true (ativou com
 * /links), false (desativou) ou undefined (nunca escolheu = desligado, exceto no alcance "todos").
 */
export function linksApplyTo(settings, userChoice) {
  if (!settings.enabled || userChoice === false) return false;
  return userChoice === true || settings.scope === 'todos';
}

/**
 * Post do X/Twitter: https://(www.|mobile.)x.com|twitter.com/<usuario>/status/<id>[/photo/1 ...][?s=20][#...]
 * Grupos: 1 = "<" antes (link sem prévia, de propósito), 2 = usuário, 3 = id, 4 = resto do caminho.
 * A query e o fragmento (rastreio: ?s=20, ?t=...) são descartados.
 */
const X_LINK = /(<)?https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(\w{1,15}|i\/web|i)\/status(?:es)?\/(\d{1,25})((?:\/[\w.-]+)*)\/?(?:\?[^\s<>#]*)?(?:#[^\s<>]*)?/gi;

/** Junta as configurações de um servidor com o padrão (tudo desligado). */
export function linkSettings(saved) {
  const out = { ...DEFAULT_LINK_SETTINGS };
  if (typeof saved?.enabled === 'boolean') out.enabled = saved.enabled;
  if (LINK_MODES.includes(saved?.mode)) out.mode = saved.mode;
  if (LINK_SERVICES.includes(saved?.service)) out.service = saved.service;
  if (LINK_SCOPES.includes(saved?.scope)) out.scope = saved.scope;
  out.networks = { ...DEFAULT_LINK_SETTINGS.networks };
  for (const n of Object.keys(LINK_NETWORKS)) if (typeof saved?.networks?.[n] === 'boolean') out.networks[n] = saved.networks[n];
  return out;
}

/**
 * TikTok: https://(www.|m.|vm.|vt.)tiktok.com/<caminho> (vídeo, foto ou link curto) -> tnktok.com,
 * que só pede a troca do domínio (vm.tiktok.com/ABC -> vm.tnktok.com/ABC). Rastreio (?…) sai.
 * Grupos: 1 = "<", 2 = subdomínio, 3 = caminho.
 */
const TIKTOK_LINK = /(<)?https?:\/\/(?:(vm|vt)\.|www\.|m\.)?tiktok\.com\/([\w@.\/-]*[\w\/])(?:\?[^\s<>#]*)?(?:#[^\s<>]*)?/gi;

/**
 * Instagram: reels, posts e IGTV (com ou sem o perfil antes) -> uuinstagram.com, que só pede
 * "uu" antes de instagram.com. Rastreio (?igsh=…) sai. Grupos: 1 = "<", 2 = tipo, 3 = código.
 */
const INSTAGRAM_LINK = /(<)?https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:[\w.]+\/)?(reels?|p|tv)\/([\w-]+)\/?(?:\?[^\s<>#]*)?(?:#[^\s<>]*)?/gi;

/**
 * Troca os links das redes ligadas. Links entre < > ficam como estão (o autor pediu
 * para não ter prévia). Devolve o texto novo e a lista de links trocados (sem repetidos).
 */
export function rewriteLinks(content, settings = DEFAULT_LINK_SETTINGS) {
  const service = settings.service ?? DEFAULT_LINK_SETTINGS.service;
  const networks = settings.networks ?? DEFAULT_LINK_SETTINGS.networks;
  const links = [];
  const keep = (match, angle, link) => {
    if (angle) return match;
    if (!links.includes(link)) links.push(link);
    return link;
  };
  let text = String(content ?? '');
  if (networks.x) text = text.replace(X_LINK, (m, angle, user, id, rest) => keep(m, angle, `https://${service}/${user}/status/${id}${rest}`));
  if (networks.tiktok) {
    text = text.replace(TIKTOK_LINK, (m, angle, sub, path) => {
      // Só vídeo, foto ou link curto (vm./vt., /t/…): perfil e página inicial ficam como estão.
      if (!sub && !/(^|\/)(video|photo|v|t)\//i.test(path)) return m;
      return keep(m, angle, `https://${sub ? `${sub.toLowerCase()}.` : ''}tnktok.com/${path}`);
    });
  }
  if (networks.instagram) {
    text = text.replace(INSTAGRAM_LINK, (m, angle, kind, code) => keep(m, angle, `https://uuinstagram.com/${kind.toLowerCase()}/${code}/`));
  }
  return { content: text, links };
}

/** Só X/Twitter (compatibilidade). */
export function rewriteXLinks(content, service = DEFAULT_LINK_SETTINGS.service) {
  return rewriteLinks(content, { service, networks: { x: true, tiktok: false, instagram: false } });
}

/** Limite de texto de uma mensagem no Discord. */
export const MAX_CONTENT = 2000;

/**
 * Como corrigir a mensagem: 'webhook' (apaga e reenvia como o autor), 'reply'
 * (tira a prévia e responde) ou null (sem permissão para nada).
 * O modo "substituir" cai na resposta quando o webhook perderia algo: resposta a
 * outra mensagem, anexos/figurinhas/enquete, texto longo demais ou falta de permissão.
 */
export function chooseLinkAction({ mode, isReply, hasExtras, contentLength, canWebhook, canDelete, canSend }) {
  if (mode === 'substituir' && !isReply && !hasExtras && contentLength <= MAX_CONTENT && canWebhook && canDelete)
    return 'webhook';
  return canSend ? 'reply' : null;
}

/** Nome de webhook: 1 a 80 caracteres e sem "discord"/"clyde" (o Discord recusa). */
export function webhookName(name) {
  const clean = String(name ?? '').replace(/discord/gi, 'disc​ord').replace(/clyde/gi, 'cly​de').trim();
  return (clean || 'Alguém').slice(0, 80);
}
