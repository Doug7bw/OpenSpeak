// Dados de Deadlock pela deadlock-api.com (pública, sem chave): heróis, itens,
// builds publicadas com as estatísticas de cada uma, counters e stats por herói.
// Tudo com cache (a API pede para não repetir consultas) e no máximo algumas
// requisições ao mesmo tempo.

const API = 'https://api.deadlock-api.com';
const HOUR = 3600_000;
const DAY_S = 86400;

/** Faixas de rank (badge = tier × 10 + subtier: Initiate 1x … Eternus 11x). */
export const RANKS = {
  todos: { label: 'Todos os ranks' },
  baixo: { label: 'Initiate a Alchemist', max: 39 },
  medio: { label: 'Arcanist a Emissary', min: 40, max: 69 },
  alto: { label: 'Archon a Oracle', min: 70, max: 89 },
  topo: { label: 'Phantom ou acima', min: 90 },
};

/** Período das estatísticas: o patch atual, com partidas suficientes. */
export const WINDOW_DAYS = 14;

/** Minúsculas, sem acento e sem nada que não seja letra/número ("Mo & Krill" -> "mokrill"). */
export const normalize = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Apelidos comuns que não saem do nome em inglês nem do traduzido. */
const ALIASES = { mo: 'Mo & Krill', krill: 'Mo & Krill', doorman: 'The Doorman', danny: 'Deadman Danny', ratking: 'Rat King', harrow: 'Nurse Harrow' };

/** Texto do jogo (com <span>, <br>, <img>) -> texto simples para o Discord. */
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Itens que mais ajudam contra um herói. Para cada item: win rate quando o herói está no
 * time inimigo menos o win rate de sempre do item. Herói forte faz todo item perder
 * contra ele, então desconta a média dessa diferença (ponderada por partidas): "gain" é
 * quanto o item fica acima da média contra o herói. Só itens com partidas suficientes nos dois.
 */
export function counterItems(vsRows, allRows, items, { limit = 8, minMatches } = {}) {
  const base = new Map(allRows.map(r => [r.item_id, r]));
  const top = Math.max(0, ...vsRows.map(r => r.matches));
  const floor = minMatches ?? Math.max(200, Math.round(top * 0.02));
  const rows = vsRows
    .map(r => ({ r, b: base.get(r.item_id), it: items.get(r.item_id) }))
    .filter(({ r, b, it }) => it?.shopable && b && r.matches >= floor && b.matches >= floor)
    .map(({ r, b, it }) => ({ item: it, matches: r.matches, winRate: r.wins / r.matches, base: b.wins / b.matches, buyTime: r.avg_buy_time_s ?? null }));
  const weight = rows.reduce((n, x) => n + x.matches, 0);
  const shift = weight ? rows.reduce((n, x) => n + (x.winRate - x.base) * x.matches, 0) / weight : 0;
  return rows.map(x => ({ ...x, gain: x.winRate - x.base - shift, shift }))
    .filter(x => x.gain > 0)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, limit);
}

/** Heróis ordenados por win rate (com pick rate), para o ranking. */
export function heroRanking(rows) {
  const total = rows.reduce((sum, r) => sum + r.matches, 0) / 12;
  return rows.filter(r => r.matches).map(r => ({
    heroId: r.hero_id, winRate: r.wins / r.matches, matches: r.matches, pickRate: total ? r.matches / total : 0,
  })).sort((a, b) => b.winRate - a.winRate);
}

/** Idiomas de build (enum de idioma da Steam) que o servidor lê: inglês, português e português do Brasil. */
const READABLE_LANGUAGES = new Set([0, 11, 22]);

/** Limite inferior do intervalo de Wilson (95%): win rate "garantido" pelo número de partidas. */
export function wilsonLower(wins, n, z = 1.96) {
  if (!n) return 0;
  const p = wins / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/**
 * Ordena builds publicadas pela qualidade: win rate com confiança (Wilson), um
 * bônus para as anotadas e um castigo para as que têm itens que saíram do jogo.
 * `stats`: linhas do hero-build-stats; `builds`: id -> resposta do /v1/builds;
 * `items`: id -> item. Só entram builds com partidas suficientes.
 */
export function rankBuilds(stats, builds, items, { minMatches = 50 } = {}) {
  const top = Math.max(0, ...stats.map(s => s.matches));
  const floor = Math.max(minMatches, Math.round(top * 0.05)); // partidas suficientes: 5% da mais jogada
  const out = [];
  for (const s of stats) {
    const entry = builds.get(s.hero_build_id);
    if (!entry || s.matches < floor) continue;
    const mods = (entry.hero_build.details?.mod_categories ?? []).flatMap(c => c.mods ?? []);
    if (!mods.length) continue;
    const removed = mods.filter(m => !items.get(m.ability_id)?.shopable).length;
    const annotated = mods.filter(m => m.annotation?.trim()).length / mods.length;
    const wilson = wilsonLower(s.wins, s.matches);
    const readable = READABLE_LANGUAGES.has(entry.hero_build.language ?? 0);
    out.push({
      id: s.hero_build_id,
      entry,
      matches: s.matches,
      wins: s.wins,
      winRate: s.wins / s.matches,
      annotated,
      removed,
      readable,
      // Em outro idioma (russo, chinês…) só aparece se não houver opção em inglês/português.
      score: wilson + 0.01 * annotated - (removed ? 0.05 : 0) - (readable ? 0 : 0.1),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Quem ganha do herói e de quem ele ganha. `rows`: hero-counter-stats (cada linha
 * = hero_id contra enemy_hero_id, com as vitórias do hero_id).
 */
export function counters(rows, heroId, { limit = 6 } = {}) {
  const against = rows.filter(r => r.enemy_hero_id === heroId && r.hero_id !== heroId);
  const mine = rows.filter(r => r.hero_id === heroId && r.enemy_hero_id !== heroId);
  const median = arr => {
    const v = arr.map(r => r.matches_played).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };
  const floor = Math.max(50, Math.round(median([...against, ...mine]) * 0.25));
  const pick = (list, idKey) => list.filter(r => r.matches_played >= floor)
    .map(r => ({ heroId: r[idKey], winRate: r.wins / r.matches_played, matches: r.matches_played }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, limit);
  return { beatenBy: pick(against, 'hero_id'), beats: pick(mine, 'enemy_hero_id'), minMatches: floor };
}

/** Resumo do herói a partir do hero-stats (todas as linhas, para pick rate e posição). */
export function heroSummary(rows, heroId) {
  const row = rows.find(r => r.hero_id === heroId);
  if (!row || !row.matches) return null;
  const totalMatches = rows.reduce((sum, r) => sum + r.matches, 0) / 12; // 12 heróis por partida
  const byWinRate = rows.filter(r => r.matches).map(r => ({ id: r.hero_id, wr: r.wins / r.matches })).sort((a, b) => b.wr - a.wr);
  return {
    winRate: row.wins / row.matches,
    matches: row.matches,
    pickRate: totalMatches ? row.matches / totalMatches : 0,
    kills: row.total_kills / row.matches,
    deaths: row.total_deaths / row.matches,
    assists: row.total_assists / row.matches,
    position: byWinRate.findIndex(r => r.id === heroId) + 1,
    heroes: byWinRate.length,
  };
}

export class DeadlockData {
  constructor({ fetchImpl = fetch, now = () => Date.now(), log = () => {} } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.cache = new Map(); // url -> { at, ttl, promise }
    this.active = 0;
    this.waiting = [];
  }

  /** No máximo 4 requisições ao mesmo tempo (a API pede para não disparar em paralelo). */
  async slot(job) {
    if (this.active >= 4) await new Promise(resolve => this.waiting.push(resolve));
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  async request(url, retry = true) {
    const res = await this.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Frisquila-DiscordBot (github.com/JonasHenriqueDev/OpenSpeak)' },
      signal: AbortSignal.timeout(20_000),
    });
    if ((res.status === 503 || res.status === 429) && retry) {
      const wait = Math.min(10, Number(res.headers.get('retry-after')) || 3);
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      return this.request(url, false);
    }
    if (!res.ok) throw new Error(`deadlock-api respondeu HTTP ${res.status}`);
    return res.json();
  }

  get(path, params = {}, ttl = HOUR) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
    const url = `${API}${path}${qs.size ? `?${qs}` : ''}`;
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < hit.ttl) return hit.promise;
    const promise = this.slot(() => this.request(url));
    this.cache.set(url, { at: this.now(), ttl, promise });
    promise.catch(() => this.cache.delete(url)); // erro não fica no cache
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }

  /** Início da janela, arredondado à hora (para o cache valer entre consultas). */
  since(days = WINDOW_DAYS) {
    const t = Math.floor(this.now() / 1000) - days * DAY_S;
    return t - (t % 3600);
  }

  rankParams(rank) {
    const r = RANKS[rank] ?? RANKS.todos;
    return { min_average_badge: r.min, max_average_badge: r.max };
  }

  /**
   * Heróis jogáveis: nome em inglês (o que a comunidade usa) e em português, lore,
   * função, tags e as 4 habilidades (nome e descrição em português).
   */
  async heroes() {
    const [en, pt, items, itemsPt] = await Promise.all([
      this.get('/v1/assets/heroes', { language: 'english', only_active: true }, 6 * HOUR),
      this.get('/v1/assets/heroes', { language: 'brazilian', only_active: true }, 6 * HOUR),
      this.get('/v1/assets/items', { language: 'english' }, 6 * HOUR),
      this.get('/v1/assets/items', { language: 'brazilian' }, 6 * HOUR),
    ]);
    const ptHero = new Map(pt.map(h => [h.id, h]));
    const ptName = new Map(pt.map(h => [h.id, h.name]));
    const ptItem = new Map(itemsPt.map(i => [i.id, i]));
    const byClass = new Map(items.filter(i => i.type === 'ability').map(i => [i.class_name, i]));
    return en.filter(h => h.player_selectable && !h.disabled && !h.in_development).map(h => {
      const abilities = new Map();
      for (let n = 1; n <= 4; n++) {
        const a = byClass.get(h.items?.[`signature${n}`]);
        if (a) {
          const ap = ptItem.get(a.id);
          abilities.set(a.id, { slot: n, name: a.name, namePt: ap?.name ?? a.name, image: a.image, desc: stripHtml(ap?.description?.desc ?? '') });
        }
      }
      return {
        id: h.id, name: h.name, namePt: ptName.get(h.id) ?? h.name,
        icon: h.images?.icon_image_small ?? null, card: h.images?.icon_hero_card ?? null,
        keys: [normalize(h.name), normalize(ptName.get(h.id)), normalize(String(h.class_name).replace(/^hero_/, ''))].filter(Boolean),
        abilities,
        lore: stripHtml(ptHero.get(h.id)?.description?.lore ?? h.description?.lore ?? ''),
        role: h.hero_type ?? '', tags: h.tags ?? [], complexity: h.complexity ?? null, gunTag: h.gun_tag ?? '',
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Itens da loja: nome em inglês e português, descrição em português, tipo, tier, custo e ícone. */
  async items() {
    const [list, pt] = await Promise.all([
      this.get('/v1/assets/items', { language: 'english' }, 6 * HOUR),
      this.get('/v1/assets/items', { language: 'brazilian' }, 6 * HOUR),
    ]);
    const ptItem = new Map(pt.map(i => [i.id, i]));
    return new Map(list.filter(i => i.type === 'upgrade').map(i => {
      const p = ptItem.get(i.id);
      return [i.id, {
        id: i.id, name: i.name, namePt: p?.name ?? i.name, slot: i.item_slot_type, tier: i.item_tier, cost: i.cost,
        shopable: !!i.shopable, image: i.shop_image ?? i.image, desc: stripHtml(p?.description?.desc ?? i.description?.desc ?? ''),
        keys: [normalize(i.name), normalize(p?.name)].filter(k => k && k.length >= 3),
      }];
    }));
  }

  /** Item pelo ID (autocomplete) ou pelo nome (inglês ou português). */
  async findItem(text) {
    const items = [...(await this.items()).values()].filter(i => i.shopable);
    const id = Number(text);
    if (Number.isInteger(id) && id > 0) {
      const byId = items.find(i => i.id === id);
      if (byId) return byId;
    }
    const q = normalize(text);
    if (!q) return null;
    return items.find(i => i.keys.includes(q)) ?? items.find(i => i.keys.some(k => k.startsWith(q)))
      ?? (q.length >= 4 ? items.find(i => i.keys.some(k => k.includes(q))) : null) ?? null;
  }

  async itemChoices(text) {
    const q = normalize(text);
    const items = [...(await this.items()).values()].filter(i => i.shopable && (!q || i.keys.some(k => k.includes(q))));
    return items.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25)
      .map(i => ({ name: i.namePt !== i.name ? `${i.name} (${i.namePt})` : i.name, value: String(i.id) }));
  }

  /** Itens que mais ganham contra o herói (comparados ao win rate normal de cada item). */
  async counterItems(heroId, rank = 'todos') {
    const params = { min_unix_timestamp: this.since(), min_matches: 100, ...this.rankParams(rank) };
    const [vs, all, items] = await Promise.all([
      this.get('/v1/analytics/item-stats', { ...params, enemy_hero_ids: heroId }),
      this.get('/v1/analytics/item-stats', params),
      this.items(),
    ]);
    return counterItems(vs, all, items, { minMatches: rank === 'todos' ? undefined : 100 });
  }

  /** Win rate de um item (geral, no período). */
  async itemStats(itemId, rank = 'todos') {
    const rows = await this.get('/v1/analytics/item-stats', { min_unix_timestamp: this.since(), min_matches: 100, ...this.rankParams(rank) });
    const r = rows.find(x => x.item_id === itemId);
    return r ? { winRate: r.wins / r.matches, matches: r.matches, buyTime: r.avg_buy_time_s ?? null } : null;
  }

  async ranking(rank = 'todos') {
    const rows = await this.get('/v1/analytics/hero-stats', { min_unix_timestamp: this.since(), ...this.rankParams(rank) });
    return heroRanking(rows);
  }

  /** Herói pelo ID (do autocomplete) ou pelo nome digitado (inglês, português ou apelido). */
  async findHero(text) {
    const heroes = await this.heroes();
    const id = Number(text);
    if (Number.isInteger(id) && id > 0) {
      const byId = heroes.find(h => h.id === id);
      if (byId) return byId;
    }
    let q = normalize(text);
    if (!q) return null;
    if (ALIASES[q]) q = normalize(ALIASES[q]);
    return heroes.find(h => h.keys.includes(q))
      ?? heroes.find(h => h.keys.some(k => k.startsWith(q)))
      ?? (q.length >= 3 ? heroes.find(h => h.keys.some(k => k.includes(q))) : null)
      ?? null;
  }

  /** Opções do autocomplete (até 25). */
  async heroChoices(text) {
    const heroes = await this.heroes();
    const q = normalize(text);
    const list = q ? heroes.filter(h => h.keys.some(k => k.includes(q))) : heroes;
    return list.slice(0, 25).map(h => ({ name: h.namePt !== h.name ? `${h.name} (${h.namePt})` : h.name, value: String(h.id) }));
  }

  async build(id) {
    const list = await this.get('/v1/builds', { build_id: id, only_latest: true });
    return list?.[0] ?? null;
  }

  /**
   * Melhores builds publicadas do herói: as mais jogadas no período (com as
   * partidas e vitórias de quem começou a partida com elas), ordenadas por
   * rankBuilds. Busca os detalhes só das 15 mais jogadas.
   */
  async bestBuilds(heroId, rank = 'todos') {
    const [items, stats] = await Promise.all([
      this.items(),
      this.get('/v1/analytics/hero-build-stats', {
        hero_ids: heroId, min_unix_timestamp: this.since(), min_matches: 20, ...this.rankParams(rank),
      }),
    ]);
    const mostPlayed = [...stats].sort((a, b) => b.matches - a.matches).slice(0, 15);
    const builds = new Map();
    await Promise.all(mostPlayed.map(async s => {
      try {
        const b = await this.build(s.hero_build_id);
        if (b?.hero_build?.hero_id === heroId) builds.set(s.hero_build_id, b);
      } catch (err) {
        this.log(`deadlock: build ${s.hero_build_id}:`, err.message);
      }
    }));
    return { ranked: rankBuilds(mostPlayed, builds, items, { minMatches: rank === 'todos' ? 300 : 100 }), items };
  }

  async counters(heroId, rank = 'todos') {
    const rows = await this.get('/v1/analytics/hero-counter-stats', { min_unix_timestamp: this.since(), ...this.rankParams(rank) });
    return counters(rows, heroId);
  }

  async heroSummary(heroId, rank = 'todos') {
    const rows = await this.get('/v1/analytics/hero-stats', { min_unix_timestamp: this.since(), ...this.rankParams(rank) });
    return heroSummary(rows, heroId);
  }
}
