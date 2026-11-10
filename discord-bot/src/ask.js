// Pergunta livre sobre Deadlock: "@Frisquila melhor build pra seven", "quem countera o billy?",
// "haze tá forte em eternus?". Primeiro tenta entender sozinho (herói + palavra-chave);
// se não der, pergunta ao ia-gateway (tarefa "frisquila"), que só classifica a pergunta:
// os números continuam vindo da deadlock-api.

import { normalize } from './deadlock.js';

/** Palavras que indicam o tipo de pergunta (já normalizadas: minúsculas e sem acento). */
const KEYWORDS = {
  counter: ['counter', 'counters', 'countera', 'counterar', 'contra', 'ganha de', 'ganha do', 'ganhar de', 'ganhar do', 'perde pra', 'perde para', 'perde do',
    'vence', 'bater', 'matchup', 'matchups', 'anula'],
  build: ['build', 'builds', 'item', 'itens', 'items', 'compro', 'comprar', 'montar', 'monta', 'habilidade', 'habilidades', 'skill'],
  heroi: ['forte', 'fraco', 'meta', 'winrate', 'win rate', 'pick rate', 'pickrate', 'stats', 'status', 'ta bom', 'presta', 'bom'],
};

/** Ranks citados na pergunta -> faixa do /build (RANKS em deadlock.js). */
const RANK_WORDS = {
  baixo: ['initiate', 'seeker', 'alchemist'],
  medio: ['arcanist', 'ritualist', 'emissary'],
  alto: ['archon', 'oracle'],
  topo: ['phantom', 'ascendant', 'eternus'],
};

const HERO_ALIASES = { mo: 'mokrill', krill: 'mokrill', doorman: 'thedoorman', danny: 'deadmandanny', ratking: 'ratking', harrow: 'nurseharrow' };

/** Palavras da pergunta, sem acento, e grupos de 2-3 palavras juntas ("lady geist" -> "ladygeist"). */
function pieces(text) {
  const words = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/<@!?\d+>/g, ' ').split(/[^a-z0-9&]+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) out.add(normalize(words.slice(i, i + n).join('')));
  }
  return { words, joined: ` ${words.join(' ')} `, keys: out };
}

/** Herói citado na pergunta (o primeiro que aparecer), pela lista de heroes() de deadlock.js. */
export function findHeroInText(text, heroes) {
  const { words, keys } = pieces(text);
  for (const w of words) if (HERO_ALIASES[w]) keys.add(HERO_ALIASES[w]);
  let best = null;
  for (const h of heroes) {
    for (const k of h.keys) {
      if (k.length < 3 || !keys.has(k)) continue;
      // O nome que aparece primeiro ganha ("build de seven contra haze" -> Seven).
      const pos = words.findIndex((_, i) => [1, 2, 3].some(n => normalize(words.slice(i, i + n).join('')) === k));
      if (!best || pos < best.pos) best = { hero: h, pos };
    }
  }
  return best?.hero ?? null;
}

/**
 * Tenta entender a pergunta sem IA. Devolve { kind, hero, rank } ou null quando não
 * tem certeza (sem herói, ou sem nenhuma palavra-chave).
 */
export function parseQuestion(text, heroes) {
  const hero = findHeroInText(text, heroes);
  const { joined } = pieces(text);
  const has = list => list.some(k => joined.includes(` ${k} `) || (k.includes(' ') && joined.includes(k)));
  let rank = 'todos';
  for (const [r, list] of Object.entries(RANK_WORDS)) if (has(list)) rank = r;
  if (!hero) return null;
  // "contra" sozinho com "build" ("build pra seven contra haze") é build, não counter.
  const kind = has(KEYWORDS.build) ? 'build' : has(KEYWORDS.counter) ? 'counter' : has(KEYWORDS.heroi) ? 'heroi' : null;
  return kind ? { kind, hero, rank } : null;
}

/** Mensagens para o ia-gateway: só classificar a pergunta, em JSON. */
export function gatewayMessages(text, heroes) {
  const names = heroes.map(h => (h.namePt !== h.name ? `${h.name} (${h.namePt})` : h.name)).join(', ');
  return [
    {
      role: 'system',
      content: 'Você classifica perguntas de jogadores de Deadlock (jogo da Valve) para um bot do Discord. '
        + 'Responda SÓ um JSON: {"tipo": "build" | "counter" | "heroi" | "outro", "heroi": "<nome em inglês ou null>", '
        + '"rank": "todos" | "baixo" | "medio" | "alto" | "topo"}. '
        + 'build = itens/build/o que comprar; counter = quem ganha de quem, como enfrentar; heroi = se está forte, win rate, '
        + 'pick rate; outro = qualquer outra coisa. rank: baixo = Initiate a Alchemist, medio = Arcanist a Emissary, '
        + `alto = Archon e Oracle, topo = Phantom ou acima; todos se não citar. Heróis: ${names}.`,
    },
    { role: 'user', content: String(text).slice(0, 500) },
  ];
}

/** Lê o JSON da IA (aceita texto em volta, como alguns modelos mandam). */
export function parseGatewayAnswer(texto) {
  const m = /\{[\s\S]*\}/.exec(String(texto ?? ''));
  if (!m) throw new Error('sem JSON');
  const d = JSON.parse(m[0]);
  const kind = ['build', 'counter', 'heroi'].includes(d.tipo) ? d.tipo : null;
  const rank = ['todos', 'baixo', 'medio', 'alto', 'topo'].includes(d.rank) ? d.rank : 'todos';
  return { kind, heroName: typeof d.heroi === 'string' ? d.heroi : null, rank };
}

/**
 * Cliente do ia-gateway (POST /v1/chat). Se a resposta não for um JSON válido,
 * pede de novo sem aquele provedor (como o validador do automacao-vagas).
 */
export async function askGateway({ url, token, fetchImpl = fetch }, messages) {
  const excluir = [];
  let rejeitado = null;
  for (let i = 0; i < 3; i++) {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ tarefa: 'frisquila', mensagens: messages, json: true, temperatura: 0, max_tokens: 120, excluir, rejeitado }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ia-gateway HTTP ${res.status}`);
    const data = await res.json();
    try {
      return parseGatewayAnswer(data.texto);
    } catch (err) {
      excluir.push(data.provedor);
      rejeitado = { provedor: data.provedor, modelo: data.modelo, motivo: err.message };
    }
  }
  throw new Error('ia-gateway: nenhuma resposta válida');
}

export const HELP_TEXT = 'Posso te ajudar com **Deadlock**: build, counters e se um herói está forte. Por exemplo:\n'
  + '• `@Frisquila melhor build pra seven`\n• `@Frisquila quem countera o billy?`\n• `@Frisquila haze tá forte em eternus?`\n'
  + 'Ou use `/build`, `/counter` e `/heroi`.';
