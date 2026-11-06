// Área central de streams: grade automática / foco, paginação e barra inferior.

import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { StreamTile } from './StreamTile.js';
import { gridLayout, focusLayout, moveRect, resizeRect, resolveOverlaps, packRects, rectToFraction, rectFromFraction } from '../video/layout.js';
import { Severity } from '../core/protocol.js';

const GAP = 8;

export class StreamArea {
  /**
   * @param {object} o
   * @param {import('../core/ConnectionHandler.js').ConnectionHandler} o.handler
   * @param {import('../video/ScreenshareManager.js').ScreenshareManager} o.manager
   * @param {object} o.settings
   * @param {object} o.actions  callbacks de alto nível (abrir diálogos/painéis)
   */
  constructor({ handler, manager, settings, actions }) {
    this.handler = handler;
    this.manager = manager;
    this.settings = settings;
    this.actions = actions;
    this.tiles = new Map();
    this.focusId = null;
    this.offset = 0;
    this.perPage = 0;
    // Previews ajustados à mão, em frações da área (ver rectToFraction).
    this.customRects = new Map();
    // Já alinhados pelo botão: o próximo clique deixa todos do mesmo tamanho.
    this.organized = false;

    this.stage = h('div.stream-stage');
    this.empty = h('div.stream-empty');
    this.pagerPrev = h('button.pager.prev', { title: '', on: { click: () => this.#page(-1) } }, icon('chevronLeft'));
    this.pagerNext = h('button.pager.next', { on: { click: () => this.#page(1) } }, icon('chevronRight'));
    this.toolbar = h('div.stream-toolbar');
    this.el = h('section.stream-area',
      h('div.stream-stage-wrap', this.stage, this.empty, this.pagerPrev, this.pagerNext),
      this.toolbar);

    new ResizeObserver(() => this.layout()).observe(this.stage);
    document.addEventListener('fullscreenchange', () => this.render());
  }

  /** Lista ordenada do que aparece na área (canal atual). */
  #items() {
    const own = this.handler.ownClient;
    if (!own) return [];
    const hidden = new Set(this.settings.get('hiddenStreams'));
    const showOwn = this.settings.get('showOwnStreams');
    const showInactive = this.settings.get('showInactiveStreams');
    const items = [];
    for (const info of this.handler.streamsInChannel(own.cid)) {
      const ownStream = this.manager.ownStreams.get(info.streamIdentifier);
      if (ownStream) {
        if (showOwn) items.push({ kind: 'own', info, own: ownStream });
        continue;
      }
      const view = this.manager.inbound.get(info.streamIdentifier) ?? null;
      if (hidden.has(info.streamIdentifier) && !view) continue;
      if (!showInactive && !view) continue;
      items.push({ kind: 'remote', info, view });
    }
    items.sort((a, b) => (a.kind === b.kind ? a.info.created - b.info.created : a.kind === 'own' ? -1 : 1));
    return items;
  }

  render() {
    const items = this.#items();
    this.items = items;
    const ids = new Set(items.map(i => i.info.streamIdentifier));
    for (const [id, tile] of this.tiles) {
      if (!ids.has(id)) {
        tile.destroy();
        this.tiles.delete(id);
        this.customRects.delete(id);
        this.organized = false;
      }
    }
    if (this.focusId && !ids.has(this.focusId)) this.focusId = null;
    for (const item of items) {
      const id = item.info.streamIdentifier;
      let tile = this.tiles.get(id);
      if (!tile) {
        tile = new StreamTile(id, this.#tileActions());
        this.organized = false;
        this.tiles.set(id, tile);
        this.stage.append(tile.el);
      }
      tile.update({
        ...item,
        ownerName: this.handler.clientName(item.info.ownerClid),
        severity: this.#severity(item),
        isFocused: this.focusId === id,
      });
    }
    this.#renderEmpty(items);
    this.#renderToolbar();
    this.layout();
  }

  /** Atualização leve apenas dos indicadores de problemas. */
  refreshStats(streamIdentifier) {
    const tile = this.tiles.get(streamIdentifier);
    const item = this.items?.find(i => i.info.streamIdentifier === streamIdentifier);
    if (!tile || !item) return;
    const severity = this.#severity(item);
    if (severity !== tile.model?.severity) tile.update({ ...tile.model, severity });
  }

  #severity(item) {
    if (item.kind === 'own') return this.manager.ownStreamSeverity(item.own);
    return item.view?.stats?.worstSeverity ?? Severity.OK;
  }

  layout() {
    const items = this.items ?? [];
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    const focusIndex = this.focusId ? items.findIndex(i => i.info.streamIdentifier === this.focusId) : -1;
    const result = focusIndex >= 0
      ? focusLayout(items.length, focusIndex, width, height, { gap: GAP, offset: this.offset })
      : gridLayout(items.length, width, height, { gap: GAP, offset: this.offset });
    this.perPage = result.perPage;
    const visible = new Set();
    const ids = result.tiles.map(rect => items[rect.index].info.streamIdentifier);
    const custom = focusIndex < 0 && this.customRects.size
      ? resolveOverlaps(result.tiles.map((rect, i) => {
        const saved = this.customRects.get(ids[i]);
        return saved ? rectFromFraction(saved, width, height) : { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      }), -1, width, height, GAP)
      : null;
    result.tiles.forEach((rect, i) => {
      const tile = this.tiles.get(ids[i]);
      tile.setRect(custom?.[i] ?? rect, rect.focused);
      tile.setArrangeable(focusIndex < 0);
      tile.setHidden(false);
      visible.add(ids[i]);
    });
    for (const [id, tile] of this.tiles) if (!visible.has(id)) tile.setHidden(true);
    const pageable = focusIndex >= 0 ? items.length - 1 : items.length;
    this.pagerPrev.hidden = this.offset <= 0;
    this.pagerNext.hidden = this.offset + this.perPage >= pageable || this.perPage === 0;
  }

  /** Guarda como os previews estão no início do gesto e devolve o do ponteiro. */
  #beginArrange(id) {
    this.arrangeStart = [...this.tiles].filter(([, tile]) => !tile.el.hidden).map(([tileId, tile]) => ({ id: tileId, rect: tile.rect }));
    return this.tiles.get(id).rect;
  }

  /** A conta parte sempre do início do gesto: quem foi empurrado volta se o preview sair de cima. */
  #arrangeTo(id, rect) {
    const { clientWidth: width, clientHeight: height } = this.stage;
    const start = this.arrangeStart;
    const fixed = start.findIndex(s => s.id === id);
    const rects = resolveOverlaps(start.map((s, i) => (i === fixed ? rect : s.rect)), fixed, width, height, GAP);
    if (!rects) return;
    const firstChange = !this.customRects.size;
    this.organized = false;
    start.forEach((s, i) => {
      this.customRects.set(s.id, rectToFraction(rects[i], width, height));
      this.tiles.get(s.id).setRect(rects[i]);
    });
    if (firstChange) this.#renderToolbar();
  }

  /** Sai do foco e alinha os previews sem mudar o tamanho; de novo, deixa todos iguais. */
  #organize() {
    if (this.organized && !this.focusId) this.customRects.clear();
    this.organized = false;
    this.focusId = null;
    this.offset = 0;
    this.render();
    if (!this.customRects.size) return;
    const { clientWidth: width, clientHeight: height } = this.stage;
    const shown = [...this.tiles].filter(([, tile]) => !tile.el.hidden);
    const rects = packRects(shown.map(([, tile]) => tile.rect), width, height, GAP);
    if (!rects) {
      this.customRects.clear();
      this.render();
      return;
    }
    shown.forEach(([id, tile], i) => {
      this.customRects.set(id, rectToFraction(rects[i], width, height));
      tile.setRect(rects[i]);
    });
    this.organized = true;
  }

  #page(dir) {
    this.offset = Math.max(0, this.offset + dir * Math.max(1, this.perPage));
    this.layout();
  }

  #renderEmpty(items) {
    this.empty.hidden = items.length > 0;
    if (items.length) return;
    const hiddenCount = this.settings.get('hiddenStreams')
      .filter(id => this.handler.streams.get(id)?.cid === this.handler.ownClient?.cid).length;
    replaceChildren(this.empty,
      icon('stream', 'big'),
      h('h3', hiddenCount ? t('video.stream.empty_due_to_hidden') : t('video.stream.empty')),
      h('p', t('video.stream.empty.hint')),
      this.handler.hasStreamingP2P
        ? h('button.btn.attention', { on: { click: () => this.actions.startStream() } }, icon('stream'), t('video.action.start_stream'))
        : null);
  }

  #renderToolbar() {
    const items = this.items ?? [];
    const hidden = this.settings.get('hiddenStreams')
      .filter(id => this.handler.streams.get(id)?.cid === this.handler.ownClient?.cid);
    const pendingTotal = [...this.manager.ownStreams.values()].reduce((n, o) => n + o.joinRequests.size, 0);
    replaceChildren(this.toolbar,
      this.handler.hasStreamingP2P
        ? h('button.btn.attention', { on: { click: () => this.actions.startStream() } }, icon('stream'), t('video.action.start_stream'))
        : null,
      pendingTotal ? h('button.btn.warn', {
        title: t('video.join_requests.tooltip'),
        on: { click: () => this.actions.manageViewers([...this.manager.ownStreams.keys()][0]) },
      }, icon('users'), String(pendingTotal)) : null,
      h('span.toolbar-count', t('video.streams', { count: items.length })),
      h('span.spacer'),
      items.length ? h('button.btn.ghost', {
        title: t('video.layout.auto.tooltip'),
        'aria-label': t('video.layout.auto'),
        disabled: !this.focusId && !this.customRects.size,
        on: { click: () => this.#organize() },
      }, icon('grid')) : null,
      hidden.length ? h('button.btn.ghost', {
        on: { click: ev => this.actions.manageHidden(ev.currentTarget) },
      }, icon('eyeOff'), `${t('video.stream.manage_hidden_streams')} (${hidden.length})`) : null,
      h('button.btn.ghost', { on: { click: ev => this.actions.viewSettings(ev.currentTarget) } }, icon('settings'), t('video.view_settings')),
    );
  }

  #tileActions() {
    const m = this.manager;
    const a = this.actions;
    const guard = p => Promise.resolve(p).catch(err => a.error(err));
    return {
      joinStream: id => guard(m.joinStream(id)),
      leaveStream: id => guard(m.leaveStream(id)),
      dismiss: id => m.dismissInbound(id),
      viewerNames: id => m.viewerNames(id),
      stopStream: id => guard(m.stopStream(id)),
      togglePause: id => guard(m.setPaused(id, !m.ownStreams.get(id)?.paused)),
      changeSource: id => a.changeSource(id),
      editStream: id => a.editStream(id),
      manageViewers: id => a.manageViewers(id),
      showStats: id => a.showStats(id),
      setQuality: (id, pref) => m.setQualityPreference(id, pref),
      hideStream: id => {
        const list = this.settings.get('hiddenStreams');
        if (!list.includes(id)) this.settings.set('hiddenStreams', [...list, id]);
        guard(m.leaveStream(id));
        this.render();
      },
      toggleFocus: id => {
        this.focusId = this.focusId === id ? null : id;
        this.offset = 0;
        this.render();
      },
      beginArrange: id => this.#beginArrange(id),
      moveTile: (id, start, dx, dy) => this.#arrangeTo(id,
        moveRect(start, dx, dy, this.stage.clientWidth, this.stage.clientHeight)),
      resizeTile: (id, start, left, top, dx, dy) => this.#arrangeTo(id,
        resizeRect(start, left, top, dx, dy, this.stage.clientWidth, this.stage.clientHeight)),
    };
  }
}
