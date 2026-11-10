// Telas dos comandos de Deadlock (/build, /counter, /heroi): embeds e botões a
// partir dos dados de deadlock.js. customId: "dl:<ação>:<arg>…".

import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { RANKS, WINDOW_DAYS } from './deadlock.js';

const COLOR = 0xc8a96a; // dourado de Deadlock
const SLOT_EMOJI = { weapon: '🟧', vitality: '🟩', spirit: '🟪' };
const MAX_CONTENT = 2000;

export const pct = x => `${(x * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
export const num = x => Math.round(x).toLocaleString('pt-BR');
const dec = x => x.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const row = (...c) => new ActionRowBuilder().addComponents(...c);

function footer(rank) {
  return { text: `deadlock-api.com · últimos ${WINDOW_DAYS} dias · ${(RANKS[rank] ?? RANKS.todos).label}` };
}

/** "#Citadel_HeroBuilds_EarlyGame" -> "Early game"; nomes livres ficam como estão. */
export function categoryName(name) {
  const known = { EarlyGame: 'Early game', MidGame: 'Mid game', LateGame: 'Late game' };
  const m = /^#Citadel_HeroBuilds_(\w+)$/.exec(name ?? '');
  if (m) return known[m[1]] ?? m[1].replace(/([a-z])([A-Z])/g, '$1 $2');
  return (name ?? '').trim() || 'Itens';
}

function itemLabel(items, id) {
  const it = items.get(id);
  if (!it) return '❔ item removido';
  return `${SLOT_EMOJI[it.slot] ?? '▫️'} ${it.name}${it.shopable ? '' : ' (removido)'}`;
}

/** Ordem de habilidades: desbloqueios (tipo 2) e melhorias (tipo 1) pelo número da habilidade. */
export function abilityOrder(build, hero) {
  const changes = build.details?.ability_order?.currency_changes ?? [];
  const slot = id => hero.abilities.get(id)?.slot;
  const unlock = changes.filter(c => c.currency_type === 2).map(c => slot(c.ability_id)).filter(Boolean);
  const upgrades = changes.filter(c => c.currency_type === 1).map(c => slot(c.ability_id)).filter(Boolean);
  if (!unlock.length && !upgrades.length) return null;
  const legend = [...hero.abilities.values()].sort((a, b) => a.slot - b.slot).map(a => `**${a.slot}** ${a.name}`).join(' · ');
  const lines = [];
  if (unlock.length) lines.push(`Desbloqueio: ${unlock.join(' → ')}`);
  if (upgrades.length) lines.push(`Melhorias: ${upgrades.join(' → ')}`);
  lines.push(legend);
  return clip(lines.join('\n'), 1024);
}

function buildStats(c) {
  return `**${pct(c.winRate)}** de vitória\n${num(c.matches)} partidas`;
}

/** Tela principal do /build: a build escolhida (a melhor, por padrão) e as outras no menu. */
export function renderBuild({ hero, rank, ranked, items, selected }) {
  if (!ranked.length) {
    return {
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle(`Sem builds de ${hero.name} com partidas suficientes`)
        .setDescription('Tente outro rank (ou **Todos os ranks**): com poucos jogos no período, os números não dizem muito.')
        .setThumbnail(hero.card).setFooter(footer(rank))],
      components: [],
    };
  }
  const current = ranked.find(c => c.id === selected) ?? ranked[0];
  const b = current.entry.hero_build;
  const best = current === ranked[0];
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: `${hero.name} · ${best ? 'melhor build agora' : 'build da comunidade'}`, iconURL: hero.icon ?? undefined })
    .setTitle(clip(b.name || 'Build sem nome', 256))
    .setThumbnail(hero.card)
    .setFooter(footer(rank));
  const desc = (b.description ?? '').trim();
  if (desc) embed.setDescription(clip(desc, 350));
  embed.addFields(
    { name: '📊 Desempenho', value: buildStats(current), inline: true },
    { name: '🗓️ Atualizada', value: `<t:${b.last_updated_timestamp}:R>\nversão ${b.version}`, inline: true },
    { name: '📝 Anotações', value: current.annotated ? `${Math.round(current.annotated * 100)}% dos itens` : 'sem anotações', inline: true },
  );
  // Build publicada: no jogo se acha pelo ID. Código só para build sem ID (montada na hora).
  if (b.hero_build_id) embed.addFields({ name: '🔎 ID para buscar no jogo', value: `**${b.hero_build_id}**` });
  const cats = (b.details?.mod_categories ?? []).filter(c => c.mods?.length);
  for (const c of cats.slice(0, 7)) {
    const list = c.mods.map(m => itemLabel(items, m.ability_id)).join(' → ');
    embed.addFields({ name: `${categoryName(c.name)}${c.optional ? ' (opcional)' : ''}`, value: clip(list, 1024) });
  }
  if (cats.length > 7) embed.addFields({ name: '…', value: `+${cats.length - 7} seções no jogo e nas anotações.` });
  const abilities = abilityOrder(b, hero);
  if (abilities) embed.addFields({ name: '🎯 Habilidades', value: abilities });
  if (current.removed) embed.addFields({ name: '⚠️ Atenção', value: `${current.removed} item(ns) desta build saíram do jogo.` });

  const menu = new StringSelectMenuBuilder().setCustomId(`dl:pick:${hero.id}:${rank}`).setPlaceholder('Outras builds boas…')
    .addOptions(ranked.slice(0, 5).map((c, i) => ({
      value: String(c.id),
      label: clip(`${i === 0 ? '🏆 ' : ''}${c.entry.hero_build.name || 'Build sem nome'}`, 100),
      description: clip(`${pct(c.winRate)} · ${num(c.matches)} partidas${c.annotated >= 0.5 ? ' · 📝 anotada' : ''}`, 100),
      default: c.id === current.id,
    })));
  const buttons = row(
    b.hero_build_id
      ? new ButtonBuilder().setCustomId(`dl:id:${b.hero_build_id}`).setLabel('Copiar ID').setEmoji('🔎').setStyle(ButtonStyle.Primary)
      : new ButtonBuilder().setCustomId(`dl:code:${current.id}`).setLabel('Código para o jogo').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dl:notes:${current.id}:${hero.id}`).setLabel('Ver anotações').setEmoji('📝').setStyle(ButtonStyle.Secondary)
      .setDisabled(!current.annotated),
    new ButtonBuilder().setCustomId(`dl:counter:${hero.id}:${rank}`).setLabel('Counters').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: ranked.length > 1 ? [row(menu), buttons] : [buttons] };
}

/** ID da build publicada (privado): só o número no texto, fácil de copiar no celular. */
export function renderBuildId(id) {
  return {
    content: String(id),
    embeds: [new EmbedBuilder().setColor(COLOR).setDescription('Copie o ID acima (no celular: segure a mensagem → Copiar texto) '
      + 'e, no jogo, procure por ele na tela de builds do herói.')],
  };
}

/**
 * Código para colar no jogo (privado). Até 2000 caracteres vai no texto da
 * mensagem. Build muito anotada passa disso: aí o texto leva o código **sem as
 * anotações** (fácil de copiar) e o completo vai num arquivo.
 */
export function renderCode({ hero, build, code, lite }) {
  const where = `cole no jogo, na tela de builds ${hero ? `do ${hero.name} ` : ''}(importar build).`;
  const copy = '(no celular: segure a mensagem → Copiar texto)';
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(`📋 ${clip(build.name || 'Build', 200)}`);
  if (code.length <= MAX_CONTENT) {
    embed.setDescription(`Copie o código acima ${copy} e ${where}`);
    return { content: code, embeds: [embed] };
  }
  const file = new AttachmentBuilder(Buffer.from(code), { name: `build-${build.hero_build_id}.txt` });
  if (lite && lite.length <= MAX_CONTENT) {
    embed.setDescription(`Esta build é muito anotada, então o código completo não cabe numa mensagem.\n\n`
      + `• **Acima:** o código **sem as anotações**, com os mesmos itens e habilidades. Copie ${copy} e ${where}\n`
      + `• **No arquivo:** o código completo, com as anotações de cada item.`);
    return { content: lite, embeds: [embed], files: [file] };
  }
  embed.setDescription(`Copie o código do arquivo anexado e ${where}`);
  return { embeds: [embed], files: [file] };
}

/** A mesma build sem as anotações (itens, seções e habilidades iguais): código bem menor. */
export function withoutAnnotations(build) {
  return {
    ...build,
    description: '',
    details: build.details && {
      ...build.details,
      mod_categories: (build.details.mod_categories ?? []).map(c => ({ ...c, description: '', mods: (c.mods ?? []).map(m => ({ ...m, annotation: undefined })) })),
    },
  };
}

/**
 * Anotações item a item, em uma ou mais mensagens (o Discord limita a 10 embeds
 * e ~6000 caracteres por mensagem).
 */
export function renderNotes({ build, items }) {
  const embeds = [];
  for (const c of build.details?.mod_categories ?? []) {
    if (!c.mods?.length) continue;
    const lines = [];
    if (c.description?.trim()) lines.push(`*${clip(c.description.trim(), 300)}*\n`);
    c.mods.forEach((m, i) => {
      const it = items.get(m.ability_id);
      const cost = it?.cost ? ` — ${num(it.cost)}` : '';
      lines.push(`**${i + 1}. ${itemLabel(items, m.ability_id)}**${cost}`);
      if (m.annotation?.trim()) lines.push(`> ${clip(m.annotation.trim().replace(/\n+/g, ' '), 350)}`);
    });
    let text = lines.join('\n');
    const title = `${categoryName(c.name)}${c.optional ? ' (opcional)' : ''}`;
    // Seção grande demais: divide em mais de um embed.
    for (let part = 0; text.length; part++) {
      let cut = text.length <= 3900 ? text.length : text.lastIndexOf('\n**', 3900);
      if (cut <= 0) cut = 3900;
      embeds.push(new EmbedBuilder().setColor(COLOR).setTitle(part ? `${title} (cont.)` : title).setDescription(text.slice(0, cut)));
      text = text.slice(cut).replace(/^\n/, '');
    }
  }
  const messages = [];
  let current = [];
  let size = 0;
  for (const e of embeds) {
    const len = (e.data.title?.length ?? 0) + (e.data.description?.length ?? 0);
    if (current.length && (current.length === 10 || size + len > 5800)) {
      messages.push({ embeds: current });
      current = [];
      size = 0;
    }
    current.push(e);
    size += len;
  }
  if (current.length) messages.push({ embeds: current });
  if (messages.length) messages[0].embeds[0].setAuthor({ name: `📝 Anotações · ${clip(build.name || 'Build', 200)}` });
  return messages.length ? messages : [{ content: 'Esta build não tem anotações.' }];
}

function heroLines(list, heroes) {
  if (!list.length) return 'Sem partidas suficientes.';
  return list.map(x => `**${heroes.get(x.heroId)?.name ?? `#${x.heroId}`}** — ${pct(x.winRate)} · ${num(x.matches)} partidas`).join('\n');
}

export function renderCounters({ hero, rank, data, heroes }) {
  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: 'Counters', iconURL: hero.icon ?? undefined })
    .setTitle(`🛡️ ${hero.name}`)
    .setThumbnail(hero.card)
    .setDescription(`Win rate de cada herói contra o **${hero.name}** (e o dele contra os outros). Só confrontos com pelo menos ${num(data.minMatches)} partidas.`)
    .addFields(
      { name: `😰 Quem ganha do ${hero.name}`, value: heroLines(data.beatenBy, heroes) },
      { name: `💪 ${hero.name} ganha de`, value: heroLines(data.beats, heroes) },
    )
    .setFooter(footer(rank));
  const buttons = row(
    new ButtonBuilder().setCustomId(`dl:build:${hero.id}:${rank}`).setLabel(`Build do ${hero.name}`).setEmoji('🛠️').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [buttons] };
}

export function renderHero({ hero, rank, summary }) {
  const embed = new EmbedBuilder().setColor(COLOR).setThumbnail(hero.card).setFooter(footer(rank))
    .setTitle(hero.namePt !== hero.name ? `${hero.name} (${hero.namePt})` : hero.name);
  if (!summary) embed.setDescription('Sem partidas suficientes nesse rank.');
  else {
    const verdict = summary.winRate >= 0.53 ? '🔥 forte no patch' : summary.winRate >= 0.5 ? '👍 equilibrado' : summary.winRate >= 0.47 ? '😐 um pouco abaixo' : '🥶 fraco no patch';
    embed.setDescription(verdict).addFields(
      { name: 'Win rate', value: `**${pct(summary.winRate)}**\n#${summary.position} de ${summary.heroes}`, inline: true },
      { name: 'Pick rate', value: `**${pct(summary.pickRate)}**\ndas partidas`, inline: true },
      { name: 'Partidas', value: num(summary.matches), inline: true },
      { name: 'Média por partida', value: `${dec(summary.kills)} abates · ${dec(summary.deaths)} mortes · ${dec(summary.assists)} assistências` },
    );
  }
  const buttons = row(
    new ButtonBuilder().setCustomId(`dl:build:${hero.id}:${rank}`).setLabel('Build').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dl:counter:${hero.id}:${rank}`).setLabel('Counters').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [buttons] };
}
