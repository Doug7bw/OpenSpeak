// Imagem da build (PNG): cada seção vira um título e uma grade de ícones da esquerda
// para a direita, como na loja do jogo, com moldura na cor do tipo do item (arma,
// vitalidade, espiritual), o número da ordem e o custo. Ícones da deadlock-api, com cache.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import { categoryName } from './dlview.js';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSans-Bold.ttf'), 'Frisquila Bold');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSans-Regular.ttf'), 'Frisquila');

const W = 960;
const PAD = 24;
const ICON = 64;
const GAP = 12;
const COST_H = 20;
const TITLE_H = 40;
const SECTION_GAP = 14;
const PER_ROW = Math.floor((W - 2 * PAD + GAP) / (ICON + GAP));

/** Cores do jogo por tipo de item. */
const SLOT_COLOR = { weapon: '#d08a2a', vitality: '#63a33f', spirit: '#9a63d6' };
const BG = '#17191e';
const CARD = '#23262d';
const TEXT = '#e9e4d8';
const MUTED = '#9aa0aa';

const iconCache = new Map(); // url -> Promise<Image|null>

/** Ícone de um item (cache para sempre: os arquivos não mudam de nome entre versões). */
export function loadIcon(url, fetchImpl = fetch) {
  if (!url) return Promise.resolve(null);
  let pending = iconCache.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        return await loadImage(Buffer.from(await res.arrayBuffer()));
      } catch {
        return null;
      }
    })();
    pending.then(img => { if (!img) iconCache.delete(url); }); // falhou: tenta de novo da próxima vez
    iconCache.set(url, pending);
  }
  return pending;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Seções com itens, na ordem da build (as mesmas do jogo). */
export function layoutSections(build) {
  return (build.details?.mod_categories ?? []).filter(c => c.mods?.length).map(c => ({
    title: `${categoryName(c.name)}${c.optional ? ' (opcional)' : ''}`,
    mods: c.mods,
    rows: Math.ceil(c.mods.length / PER_ROW),
  }));
}

export function imageHeight(sections) {
  return PAD + sections.reduce((h, s) => h + TITLE_H + s.rows * (ICON + COST_H + 8) + SECTION_GAP, 0) + PAD - SECTION_GAP;
}

/**
 * PNG da build. `items`: id -> {name, slot, cost, image}. Ícones que não carregam
 * viram um quadro com as iniciais do item.
 */
export async function renderBuildImage({ build, items, fetchImpl = fetch }) {
  const sections = layoutSections(build);
  if (!sections.length) return null;
  const urls = new Set(sections.flatMap(s => s.mods.map(m => items.get(m.ability_id)?.image).filter(Boolean)));
  const icons = new Map();
  const list = [...urls];
  for (let i = 0; i < list.length; i += 8) { // até 8 downloads ao mesmo tempo
    await Promise.all(list.slice(i, i + 8).map(async u => icons.set(u, await loadIcon(u, fetchImpl))));
  }

  const H = imageHeight(sections);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  let y = PAD;
  for (const s of sections) {
    ctx.fillStyle = TEXT;
    ctx.font = '22px "Frisquila Bold"';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.title, PAD, y + TITLE_H / 2 - 4);
    const titleW = ctx.measureText(s.title).width;
    ctx.fillStyle = MUTED;
    ctx.font = '15px "Frisquila"';
    ctx.fillText(`${s.mods.length} ${s.mods.length === 1 ? 'item' : 'itens'}`, PAD + titleW + 12, y + TITLE_H / 2 - 3);
    y += TITLE_H;

    s.mods.forEach((m, i) => {
      const col = i % PER_ROW;
      const row = Math.floor(i / PER_ROW);
      const x = PAD + col * (ICON + GAP);
      const top = y + row * (ICON + COST_H + 8);
      const it = items.get(m.ability_id);
      const color = SLOT_COLOR[it?.slot] ?? '#5c6370';

      roundRect(ctx, x, top, ICON, ICON, 10);
      ctx.fillStyle = CARD;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
      const img = it?.image ? icons.get(it.image) : null;
      if (img) {
        const inner = ICON - 14;
        ctx.drawImage(img, x + 7, top + 7, inner, inner);
      } else {
        ctx.fillStyle = TEXT;
        ctx.font = '18px "Frisquila Bold"';
        ctx.textAlign = 'center';
        ctx.fillText((it?.name ?? '?').split(/\s+/).map(p => p[0]).join('').slice(0, 3), x + ICON / 2, top + ICON / 2);
        ctx.textAlign = 'left';
      }
      // número da ordem (esquerda para a direita)
      ctx.beginPath();
      ctx.arc(x + 4, top + 4, 11, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '13px "Frisquila Bold"';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x + 4, top + 5);
      // custo
      if (it?.cost) {
        ctx.fillStyle = MUTED;
        ctx.font = '14px "Frisquila"';
        ctx.fillText(it.cost.toLocaleString('pt-BR'), x + ICON / 2, top + ICON + COST_H / 2 + 2);
      }
      ctx.textAlign = 'left';
      if (!it?.shopable && it) { // item que saiu do jogo
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x + 6, top + ICON - 6);
        ctx.lineTo(x + ICON - 6, top + 6);
        ctx.stroke();
      }
    });
    y += s.rows * (ICON + COST_H + 8) + SECTION_GAP;
  }
  return canvas.toBuffer('image/png');
}
