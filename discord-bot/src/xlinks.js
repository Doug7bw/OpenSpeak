// Correção de links do X/Twitter: troca x.com/twitter.com por um serviço que gera
// a prévia certa no Discord (fxtwitter.com por padrão). Só funções puras aqui; o
// envio (resposta ou webhook) fica no bot.js.

/** Serviços aceitos em /openspeak links servico:. */
export const LINK_SERVICES = ['fxtwitter.com', 'fixupx.com', 'vxtwitter.com'];

/** Modos: "responder" tira a prévia original e responde; "substituir" apaga e reenvia como o autor. */
export const LINK_MODES = ['responder', 'substituir'];

export const DEFAULT_LINK_SETTINGS = Object.freeze({ enabled: false, mode: 'responder', service: 'fxtwitter.com' });

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
  return out;
}

/**
 * Troca os links do X/Twitter do texto. Links entre < > ficam como estão (o autor
 * pediu para não ter prévia). Devolve o texto novo e a lista de links trocados (sem repetidos).
 */
export function rewriteXLinks(content, service = DEFAULT_LINK_SETTINGS.service) {
  const links = [];
  const text = String(content ?? '').replace(X_LINK, (match, angle, user, id, rest) => {
    if (angle) return match;
    const link = `https://${service}/${user}/status/${id}${rest}`;
    if (!links.includes(link)) links.push(link);
    return link;
  });
  return { content: text, links };
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
