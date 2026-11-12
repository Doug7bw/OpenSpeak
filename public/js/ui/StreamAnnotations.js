import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { ANNOTATION_SCALE, MAX_ANNOTATION_POINTS } from '../core/protocol.js';

const STROKE_LIFETIME = 5_000;
const NAME_LIFETIME = 3_000;
const HOVER_WIDTH = 16;
const FLUSH_INTERVAL = 100;
const MAX_STROKES = 64;
const MAX_STROKE_LENGTH = 1024;
const COLORS = ['#67e8f9', '#fbbf24', '#f9a8d4', '#bef264', '#c4b5fd', '#fdba74'];

export class StreamAnnotations {
  #streamIdentifier = null;
  #self = null;
  #participants = new Map();
  #strokes = new Map();
  #hiddenAuthors = new Set();
  #showOthers = true;
  #drawing = false;
  #active = null;
  #hover = null;
  #flushTimer = null;
  #expiryTimer = null;
  #frame = null;
  #authorsKey = '';
  #listeners = new AbortController();

  constructor(video, send) {
    this.video = video;
    this.send = send;
    this.canvas = h('canvas.stream-annotations', {
      hidden: true, 'aria-hidden': 'true',
      on: {
        pointerdown: ev => this.#start(ev),
        pointerenter: ev => this.#trackHover(ev),
        pointermove: ev => {
          this.#trackHover(ev);
          this.#move(ev);
        },
        pointerleave: () => this.#clearHover(),
        pointerup: ev => this.#finish(ev, true),
        pointercancel: ev => this.#finish(ev),
        lostpointercapture: ev => this.#finish(ev),
        dblclick: ev => ev.stopPropagation(),
      },
    });
    this.drawButton = h('button.tile-btn.annotation-button', {
      type: 'button', title: t('video.draw.start'), 'aria-label': t('video.draw.start'), 'aria-pressed': 'false',
      on: { click: () => this.#setDrawing(!this.#drawing) },
    }, icon('pen'));
    this.showCheckbox = h('input', { type: 'checkbox', checked: true, on: { change: ev => {
      this.#showOthers = ev.target.checked;
      this.#queuePaint();
    } } });
    this.authors = h('div.annotation-authors');
    this.settings = h('details.annotation-settings',
      h('summary.tile-btn.annotation-button', { title: t('video.draw.visibility'), 'aria-label': t('video.draw.visibility') }, icon('eye')),
      h('div.annotation-menu',
        h('label', this.showCheckbox, t('video.draw.show_others')),
        this.authors));
    this.controls = [this.drawButton, this.settings];
    this.resizer = new ResizeObserver(() => this.#queuePaint());
    this.resizer.observe(this.canvas);
    const options = { signal: this.#listeners.signal };
    video.addEventListener('resize', () => this.#queuePaint(), options);
    video.addEventListener('pointerenter', ev => this.#trackHover(ev), options);
    video.addEventListener('pointermove', ev => this.#trackHover(ev), options);
    video.addEventListener('pointerleave', () => this.#clearHover(), options);
  }

  get enabled() {
    return !!this.#streamIdentifier;
  }

  update(context) {
    const { streamIdentifier = null, self = null, participants = new Map() } = context ?? {};
    if (streamIdentifier !== this.#streamIdentifier) {
      this.#setDrawing(false);
      this.#strokes.clear();
      this.#hover = null;
      this.#hiddenAuthors.clear();
      this.#showOthers = true;
      this.showCheckbox.checked = true;
      this.settings.open = false;
      this.#streamIdentifier = streamIdentifier;
      this.canvas.hidden = !streamIdentifier;
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
      this.#queuePaint();
    }
    this.#self = self;
    this.#participants = participants;
    this.#renderAuthors();
  }

  receive({ streamIdentifier, clid, name, strokeId, points }) {
    if (streamIdentifier !== this.#streamIdentifier || !points.length) return;
    const now = performance.now();
    const key = clid + ':' + strokeId;
    let stroke = this.#strokes.get(key);
    if (stroke && stroke.until <= now) return;
    if (!stroke) {
      if (this.#strokes.size >= MAX_STROKES) this.#strokes.delete(this.#strokes.keys().next().value);
      stroke = { clid, name, points: [], until: now + STROKE_LIFETIME, nameUntil: now + NAME_LIFETIME };
      this.#strokes.set(key, stroke);
    }
    stroke.points.push(...points);
    if (stroke.points.length > MAX_STROKE_LENGTH) stroke.points.splice(0, stroke.points.length - MAX_STROKE_LENGTH);
    if (this.#expiryTimer === null) this.#expiryTimer = setTimeout(() => this.#expire(), NAME_LIFETIME);
    this.#queuePaint();
    if (!this.#participants.has(clid) && clid !== this.#self?.clid) this.#renderAuthors();
  }

  destroy() {
    this.#setDrawing(false);
    this.#listeners.abort();
    this.resizer.disconnect();
    clearTimeout(this.#expiryTimer);
    this.#cancelPaint();
  }

  #setDrawing(enabled) {
    if (!enabled) this.#finish();
    this.#drawing = enabled;
    this.canvas.classList.toggle('drawing', enabled);
    this.drawButton.classList.toggle('active', enabled);
    this.drawButton.setAttribute('aria-pressed', String(enabled));
    const label = t(enabled ? 'video.draw.stop' : 'video.draw.start');
    this.drawButton.title = label;
    this.drawButton.setAttribute('aria-label', label);
  }

  #start(ev) {
    if (!this.#drawing || !this.#self || this.#active || ev.button !== 0) return;
    const point = this.#point(ev);
    if (!point) return;
    ev.preventDefault();
    this.canvas.setPointerCapture(ev.pointerId);
    const id = Array.from(crypto.getRandomValues(new Uint32Array(2)), value => value.toString(36)).join('-');
    this.#active = { pointerId: ev.pointerId, id, pending: [], last: null, until: performance.now() + STROKE_LIFETIME };
    this.#append(point);
    this.#flush();
  }

  #move(ev) {
    const active = this.#active;
    if (!active || ev.pointerId !== active.pointerId || performance.now() >= active.until) return;
    this.#append(this.#point(ev, true));
    if (active.pending.length) this.#flushTimer ??= setTimeout(() => this.#flush(), FLUSH_INTERVAL);
  }

  #finish(ev, includePoint = false) {
    const active = this.#active;
    if (!active || (ev && ev.pointerId !== active.pointerId)) return;
    if (includePoint) this.#append(this.#point(ev, true));
    this.#flush();
    this.#active = null;
    if (this.canvas.hasPointerCapture(active.pointerId)) this.canvas.releasePointerCapture(active.pointerId);
  }

  #append(point) {
    const active = this.#active;
    if (performance.now() >= active.until || !point || (active.last?.[0] === point[0] && active.last?.[1] === point[1])) return;
    active.last = point;
    active.pending.push(point);
    if (active.pending.length > MAX_ANNOTATION_POINTS) active.pending.splice(1, 1);
    this.receive({
      streamIdentifier: this.#streamIdentifier, ...this.#self, strokeId: active.id, points: [point],
    });
  }

  #flush() {
    clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    const active = this.#active;
    if (!active?.pending.length) return;
    const points = active.pending.splice(0);
    if (performance.now() < active.until) this.send(this.#streamIdentifier, { strokeId: active.id, points });
  }

  #trackHover(ev) {
    if (!this.enabled || ev.pointerType === 'touch') return;
    this.#hover = { clientX: ev.clientX, clientY: ev.clientY };
    this.#queuePaint();
  }

  #clearHover() {
    if (!this.#hover) return;
    this.#hover = null;
    this.#queuePaint();
  }

  #videoRect(width, height) {
    if (!this.video.videoWidth || !this.video.videoHeight || !width || !height) return null;
    const scale = Math.min(width / this.video.videoWidth, height / this.video.videoHeight);
    const w = this.video.videoWidth * scale;
    const h = this.video.videoHeight * scale;
    return { x: (width - w) / 2, y: (height - h) / 2, w, h };
  }

  #point(ev, clamp = false) {
    const box = this.canvas.getBoundingClientRect();
    const frame = this.#videoRect(box.width, box.height);
    if (!frame) return null;
    const x = (ev.clientX - box.left - frame.x) / frame.w;
    const y = (ev.clientY - box.top - frame.y) / frame.h;
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return [x, y].map(value => Math.round(Math.max(0, Math.min(1, value)) * ANNOTATION_SCALE));
  }

  #expire() {
    this.#expiryTimer = null;
    const now = performance.now();
    let next = Infinity;
    for (const stroke of this.#strokes.values()) {
      if (stroke.until <= now) {
        // Retém apenas o identificador no mapa limitado para ignorar lotes atrasados.
        stroke.points.length = 0;
        continue;
      }
      next = Math.min(next, stroke.until);
      if (stroke.nameUntil > now) next = Math.min(next, stroke.nameUntil);
    }
    if (Number.isFinite(next)) this.#expiryTimer = setTimeout(() => this.#expire(), next - now);
    this.#renderAuthors();
    this.#queuePaint();
  }

  #renderAuthors() {
    const authors = new Map(this.#participants);
    const now = performance.now();
    for (const { clid, name, until } of this.#strokes.values()) {
      if (until > now && !authors.has(clid)) authors.set(clid, name);
    }
    authors.delete(this.#self?.clid);
    const key = JSON.stringify([...authors]);
    if (key === this.#authorsKey) return;
    this.#authorsKey = key;
    replaceChildren(this.authors, [...authors].map(([clid, name]) =>
      h('label',
        h('input', { type: 'checkbox', checked: !this.#hiddenAuthors.has(clid), on: { change: ev => {
          if (ev.target.checked) this.#hiddenAuthors.delete(clid);
          else this.#hiddenAuthors.add(clid);
          this.#queuePaint();
        } } }),
        h('span.ellipsis', name))));
  }

  #queuePaint() {
    const view = this.canvas.ownerDocument.defaultView;
    if (!view || this.#frame?.view === view) return;
    this.#cancelPaint();
    const id = view.requestAnimationFrame(() => {
      this.#frame = null;
      this.#paint();
    });
    this.#frame = { view, id };
  }

  #cancelPaint() {
    this.#frame?.view.cancelAnimationFrame(this.#frame.id);
    this.#frame = null;
  }

  #paint() {
    const canvas = this.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const scale = Math.min(2, canvas.ownerDocument.defaultView?.devicePixelRatio || 1);
    const frame = this.#videoRect(width, height);
    const now = performance.now();
    const strokes = frame ? [...this.#strokes.values()].filter(stroke => stroke.until > now) : [];
    const hasStrokes = strokes.length > 0;
    const px = hasStrokes ? Math.max(1, Math.round(width * scale)) : 1;
    const py = hasStrokes ? Math.max(1, Math.round(height * scale)) : 1;
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== py) canvas.height = py;
    if (!hasStrokes) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.clip();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const cursor = this.#hover && this.#point(this.#hover);
    // isPointInStroke usa pixels do canvas, independentemente da transformação.
    const hover = cursor && [
      (frame.x + cursor[0] * frame.w / ANNOTATION_SCALE) * scale,
      (frame.y + cursor[1] * frame.h / ANNOTATION_SCALE) * scale,
    ];
    for (const stroke of strokes) {
      if (stroke.clid !== this.#self?.clid && (!this.#showOthers || this.#hiddenAuthors.has(stroke.clid))) continue;
      this.#paintStroke(ctx, frame, stroke, now < stroke.nameUntil, hover);
    }
    ctx.restore();
  }

  #paintStroke(ctx, frame, { clid, name, points }, showName, hover) {
    const color = COLORS[clid % COLORS.length];
    let x, y;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const [pointX, pointY] = points[i];
      x = frame.x + pointX * frame.w / ANNOTATION_SCALE;
      y = frame.y + pointY * frame.h / ANNOTATION_SCALE;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (points.length === 1) {
      ctx.fillStyle = color;
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    if (!showName && hover) {
      ctx.save();
      ctx.lineWidth = HOVER_WIDTH;
      showName = ctx.isPointInStroke(...hover);
      ctx.restore();
    }
    if (!showName) return;

    const labelWidth = Math.min(ctx.measureText(name).width + 10, frame.w);
    const labelX = Math.max(frame.x, Math.min(x + 8, frame.x + frame.w - labelWidth));
    const labelY = Math.max(frame.y, Math.min(y - 21, frame.y + frame.h - 16));
    ctx.fillStyle = '#111827e8';
    ctx.fillRect(labelX, labelY, labelWidth, 16);
    ctx.fillStyle = color;
    ctx.fillText(name, labelX + 5, labelY + 8, Math.max(1, labelWidth - 10));
  }
}
