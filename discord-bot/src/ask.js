// Pergunta livre sobre Deadlock: "@Frisquila melhor build pra seven", "quem countera o billy?",
// "que herói é esse?", "itens pra counterar o haze", "melhores heróis agora", "o que faz o
// toxic bullets", e qualquer outra coisa do jogo (lore, mecânicas…).
//
// 1. Tenta entender sozinho (herói/item + palavras-chave) e responde com a tela do comando.
// 2. Se não der, o ia-gateway (tarefa "frisquila") classifica a pergunta.
// 3. Pergunta aberta (lore, mecânica): o ia-gateway (tarefa "frisquila_resposta") responde em
//    texto, com os textos oficiais do jogo (lore, habilidades, itens) como base. Números nunca
//    vêm da IA: para isso há as telas com dados da deadlock-api.

import { normalize } from './deadlock.js';

/** Palavras que indicam o tipo de pergunta (já normalizadas: minúsculas e sem acento). */
const KEYWORDS = {
  counter: ['counter', 'counters', 'countera', 'counterar', 'contra', 'ganha de', 'ganha do', 'ganhar de', 'ganhar do',
    'perde pra', 'perde para', 'perde do', 'vence', 'bater', 'matchup', 'matchups', 'anula'],
  items: ['item', 'itens', 'items', 'comprar', 'compro'],
  build: ['build', 'builds', 'item', 'itens', 'items', 'compro', 'comprar', 'montar', 'monta', 'ordem'],
  info: ['quem e', 'quem eh', 'que heroi', 'qual heroi', 'lore', 'historia', 'habilidade', 'habilidades', 'skill', 'skills',
    'ulti', 'ultimate', 'como funciona', 'sobre o', 'sobre a', 'o que faz', 'como joga', 'como jogar', 'poderes'],
  heroi: ['forte', 'fraco', 'meta', 'winrate', 'win rate', 'pick rate', 'pickrate', 'stats', 'status', 'ta bom', 'presta', 'bom',
    'vale a pena'],
  ranking: ['melhores herois', 'melhor heroi', 'herois mais fortes', 'heroi mais forte', 'tier list', 'tierlist', 'meta atual',
    'quem ta forte', 'quem esta forte', 'top herois', 'ranking', 'piores herois', 'pior heroi', 'mais fortes', 'mais forte'],
  item: ['o que faz', 'serve', 'como funciona', 'vale', 'presta', 'bom', 'descricao', 'item'],
};

/** Ranks citados na pergunta -> faixa (RANKS em deadlock.js). */
const RANK_WORDS = {
  baixo: ['initiate', 'seeker', 'alchemist'],
  medio: ['arcanist', 'ritualist', 'emissary'],
  alto: ['archon', 'oracle'],
  topo: ['phantom', 'ascendant', 'eternus'],
};

const HERO_ALIASES = { mo: 'mokrill', krill: 'mokrill', doorman: 'thedoorman', danny: 'deadmandanny', ratking: 'ratking', harrow: 'nurseharrow' };

/** Palavras da pergunta, sem acento, e grupos de 2-4 palavras juntas ("lady geist" -> "ladygeist"). */
function pieces(text) {
  const words = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/<@!?\d+>/g, ' ').split(/[^a-z0-9&]+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) out.add(normalize(words.slice(i, i + n).join('')));
  }
  return { words, joined: ` ${words.join(' ')} `, keys: out };
}

/** O primeiro de `list` (heróis ou itens, cada um com `keys`) citado no texto. */
function findInText(text, list, aliases = {}) {
  const { words, keys } = pieces(text);
  for (const w of words) if (aliases[w]) keys.add(aliases[w]);
  let best = null;
  for (const entry of list) {
    for (const k of entry.keys ?? []) {
      if (k.length < 3 || !keys.has(k)) continue;
      const pos = words.findIndex((w, i) => aliases[w] === k || [1, 2, 3, 4].some(n => normalize(words.slice(i, i + n).join('')) === k));
      if (!best || pos < best.pos || (pos === best.pos && k.length > best.len)) best = { entry, pos, len: k.length };
    }
  }
  return best?.entry ?? null;
}

/** Herói citado na pergunta (o primeiro que aparecer). */
export function findHeroInText(text, heroes) {
  return findInText(text, heroes, HERO_ALIASES);
}

/** Item citado na pergunta (só itens da loja). */
export function findItemInText(text, items) {
  return findInText(text, items.filter(i => i.shopable));
}

/**
 * Tenta entender a pergunta sem IA. Devolve { kind, hero?, item?, rank } ou null
 * quando não tem certeza (aí a IA classifica).
 */
export function parseQuestion(text, heroes, items = []) {
  const hero = findHeroInText(text, heroes);
  const { joined, words } = pieces(text);
  const has = list => list.some(k => joined.includes(` ${k} `));
  let rank = 'todos';
  for (const [r, list] of Object.entries(RANK_WORDS)) if (has(list)) rank = r;
  if (hero) {
    if (has(KEYWORDS.counter) && has(KEYWORDS.items)) return { kind: 'itens_contra', hero, rank };
    if (has(KEYWORDS.build)) return { kind: 'build', hero, rank };
    if (has(KEYWORDS.counter)) return { kind: 'counter', hero, rank };
    if (has(KEYWORDS.info)) return { kind: 'info', hero, rank };
    if (has(KEYWORDS.heroi)) return { kind: 'heroi', hero, rank };
    return null;
  }
  const item = findItemInText(text, items);
  if (item && (has(KEYWORDS.item) || words.length <= 3)) return { kind: 'item', item, rank };
  // 'melhor herói pra iniciante' não é ranking por win rate: a IA responde (com a complexidade dos heróis).
  if (has(KEYWORDS.ranking) && !has(['iniciante', 'iniciantes', 'novato', 'comecar', 'facil', 'faceis'])) return { kind: 'ranking', rank };
  return null;
}

/** Pergunta de iniciante ("herói fácil", "pra quem tá começando"): a IA responde com a complexidade. */
const BEGINNER = ['iniciante', 'iniciantes', 'novato', 'novatos', 'comecando', 'comecar', 'facil', 'faceis', 'simples'];
export function isBeginnerQuestion(text) {
  const { joined } = pieces(text);
  return BEGINNER.some(k => joined.includes(` ${k} `));
}

/**
 * Fatos básicos de Deadlock que a IA pode usar sempre (conferidos; nada de número de
 * patch, que muda). O resto vem dos textos oficiais (lore, habilidades, itens).
 */
export const DEADLOCK_FACTS = [
  'Deadlock é um jogo da Valve, 6 contra 6, que mistura MOBA com tiro em terceira pessoa.',
  'Almas (souls) são a moeda da partida: vêm de tropas (troopers), heróis inimigos, criaturas neutras e objetivos. '
    + 'Servem para comprar itens e, ao acumular, liberam pontos para desbloquear e melhorar habilidades. Valem só durante a partida.',
  'Itens têm três tipos: Arma (laranja), Vitalidade (verde) e Espiritual (roxo), com custos de 800, 1.600, 3.200 e 6.400 almas.',
  'Objetivos: Guardiões e Walkers nas lanes; na base, Guardiões da base, Santuários (Shrines) e o Patrono (Patron), '
    + 'que precisa ser destruído para vencer.',
  'O Chefe do meio (Mid Boss) deixa o Rejuvenescedor (Rejuvenator), um bônus para o time que o pega.',
  'A Urna de almas (Soul Urn) é um objetivo: levar a urna até o ponto de entrega dá almas ao time.',
  'Slots flex (flex slots) dão espaços extras de item e são liberados com objetivos.',
  'O mapa tem tirolesas (zip lines) para se mover rápido pelas lanes.',
].join('\n');

export const KINDS = ['build', 'counter', 'itens_contra', 'heroi', 'info', 'ranking', 'item', 'pergunta'];

/** Mensagens para o ia-gateway classificar a pergunta (JSON). */
export function gatewayMessages(text, heroes) {
  const names = heroes.map(h => (h.namePt !== h.name ? `${h.name} (${h.namePt})` : h.name)).join(', ');
  return [
    {
      role: 'system',
      content: 'Você classifica perguntas de jogadores de Deadlock (jogo da Valve) para um bot do Discord. '
        + 'Responda SÓ um JSON: {"tipo": "...", "heroi": "<nome em inglês ou null>", "item": "<nome do item ou null>", '
        + '"rank": "todos" | "baixo" | "medio" | "alto" | "topo"}. Tipos: '
        + 'build = itens/build/o que comprar para jogar DE um herói; '
        + 'counter = quais heróis ganham de um herói, como enfrentá-lo; '
        + 'itens_contra = quais itens comprar CONTRA um herói inimigo; '
        + 'heroi = se um herói está forte, win rate, pick rate; '
        + 'info = quem é um herói, lore, habilidades, como ele funciona; '
        + 'ranking = melhores/piores heróis do momento, tier list, meta; '
        + 'item = o que faz um item; '
        + 'pergunta = qualquer outra pergunta sobre Deadlock (lore geral, mapa, mecânicas, almas, patch…); '
        + 'outro = não é sobre Deadlock. '
        + 'rank: baixo = Initiate a Alchemist, medio = Arcanist a Emissary, alto = Archon e Oracle, topo = Phantom ou acima; '
        + `todos se não citar. Heróis: ${names}.`,
    },
    { role: 'user', content: String(text).slice(0, 500) },
  ];
}

/** Lê o JSON da IA (aceita texto em volta, como alguns modelos mandam). */
export function parseGatewayAnswer(texto) {
  const m = /\{[\s\S]*\}/.exec(String(texto ?? ''));
  if (!m) throw new Error('sem JSON');
  const d = JSON.parse(m[0]);
  const kind = KINDS.includes(d.tipo) ? d.tipo : null;
  const rank = ['todos', 'baixo', 'medio', 'alto', 'topo'].includes(d.rank) ? d.rank : 'todos';
  return {
    kind,
    heroName: typeof d.heroi === 'string' ? d.heroi : null,
    itemName: typeof d.item === 'string' ? d.item : null,
    rank,
  };
}

/**
 * Textos oficiais para a IA se apoiar: lore e habilidades dos heróis citados e a
 * descrição dos itens citados (tudo em português, da deadlock-api).
 */
export function officialContext(text, heroes, items = []) {
  const parts = [];
  const hero = findHeroInText(text, heroes);
  if (hero) {
    parts.push(`HERÓI ${hero.name} (${hero.namePt}) — função: ${hero.role || '?'}; tags: ${(hero.tags || []).join(', ') || '?'}.`);
    if (hero.lore) parts.push(`Lore oficial: ${hero.lore}`);
    for (const a of [...(hero.abilities?.values?.() ?? [])].sort((x, y) => x.slot - y.slot)) {
      parts.push(`Habilidade ${a.slot}: ${a.namePt} (${a.name}): ${a.desc}`);
    }
  }
  const item = findItemInText(text, items);
  if (item) parts.push(`ITEM ${item.name} (${item.namePt}), ${item.slot}, custo ${item.cost}: ${item.desc}`);
  if (isBeginnerQuestion(text)) {
    const by = n => heroes.filter(h => h.complexity === n).map(h => h.name).join(', ') || '—';
    parts.push(`COMPLEXIDADE oficial dos heróis (1 = mais fácil): 1: ${by(1)}. 2: ${by(2)}. 3: ${by(3)}.`);
  }
  return parts.join('\n').slice(0, 6000);
}

/** Mensagens para o ia-gateway responder uma pergunta aberta (texto). */
export function answerMessages(text, context) {
  return [
    {
      role: 'system',
      content: 'Você é o Frisquila, bot de um servidor de amigos no Discord, que entende muito de Deadlock '
        + '(jogo da Valve que mistura MOBA e tiro em terceira pessoa). Responda em português do Brasil, direto e '
        + 'descontraído, em até 150 palavras, com Markdown do Discord se ajudar. REGRA PRINCIPAL: afirme fatos específicos '
        + 'do jogo (lugares, personagens, história, mecânicas, números) SÓ se estiverem nos FATOS ou no CONTEXTO abaixo. '
        + 'Se a pergunta pedir algo que não está neles, diga com sinceridade que não tem essa informação confiável e sugira '
        + 'a wiki do jogo (deadlock.wiki); nunca invente. Opiniões gerais de estratégia podem, deixando claro que é dica. '
        + 'Números de desempenho (win rate, melhor build, counters) não: indique /build, /counter, /heroi, /ranking ou /item. '
        + 'Se não for sobre Deadlock, diga em uma frase que você só fala de Deadlock.\n\nFATOS:\n' + DEADLOCK_FACTS,
    },
    { role: 'user', content: context ? `CONTEXTO:\n${context}\n\nPERGUNTA: ${String(text).slice(0, 500)}` : String(text).slice(0, 500) },
  ];
}

async function callGateway({ url, token, fetchImpl = fetch }, body, timeoutMs = 30_000) {
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ia-gateway HTTP ${res.status}`);
  return res.json();
}

/**
 * Classifica a pergunta pelo ia-gateway. Se a resposta não for um JSON válido,
 * pede de novo sem aquele provedor (como o validador do automacao-vagas).
 */
export async function askGateway(cfg, messages) {
  const excluir = [];
  let rejeitado = null;
  for (let i = 0; i < 3; i++) {
    const data = await callGateway(cfg, { tarefa: 'frisquila', mensagens: messages, json: true, temperatura: 0, max_tokens: 150, excluir, rejeitado, timeout_s: 12 });
    try {
      return parseGatewayAnswer(data.texto);
    } catch (err) {
      excluir.push(data.provedor);
      rejeitado = { provedor: data.provedor, modelo: data.modelo, motivo: err.message };
    }
  }
  throw new Error('ia-gateway: nenhuma resposta válida');
}

/** Resposta em texto para uma pergunta aberta (tarefa "frisquila_resposta"). */
export async function answerGateway(cfg, messages) {
  const data = await callGateway(cfg, { tarefa: 'frisquila_resposta', mensagens: messages, temperatura: 0.2, max_tokens: 600, timeout_s: 20 }, 60_000);
  const texto = String(data.texto ?? '').trim();
  if (!texto) throw new Error('ia-gateway: resposta vazia');
  return texto;
}

export const HELP_TEXT = 'Pode me perguntar qualquer coisa de **Deadlock**. Por exemplo:\n'
  + '• `@Frisquila melhor build pra seven`\n• `@Frisquila quem countera o billy?`\n• `@Frisquila itens pra counterar o haze`\n'
  + '• `@Frisquila que herói é o vindicta?`\n• `@Frisquila melhores heróis agora`\n• `@Frisquila o que faz o toxic bullets?`\n'
  + '• `@Frisquila qual a lore do cultista?`\n'
  + 'Ou use `/frisquila pergunta:…`, `/build`, `/counter`, `/heroi`, `/ranking` e `/item`.';
