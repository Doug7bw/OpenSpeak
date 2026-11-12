// Versão mobile do site: lista quem está ao vivo e assiste a um stream por vez.

import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { StreamType } from '../core/protocol.js';
import { InboundStatus } from '../video/ScreenshareManager.js';
import { installFullscreenIdle } from './fullscreenIdle.js';
import { StreamAnnotations } from './StreamAnnotations.js';
import { YouTubePlayer } from './YouTubePlayer.js';

const TYPE_ICON = { [StreamType.CAMERA]: 'camera', [StreamType.SCREEN]: 'screen', [StreamType.WINDOW]: 'window' };

export class MobileApp {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root
   * @param {import('../core/ConnectionHandler.js').ConnectionHandler} o.handler
   * @param {import('../video/ScreenshareManager.js').ScreenshareManager} o.manager
   * @param {(err:Error) => void} o.onError
   * @param {() => void} o.onDisconnected
   */
  constructor({ root, handler, manager, onError, onDisconnected }) {
    this.root = root;
    this.handler = handler;
    this.manager = manager;
    this.onError = onError;
    this.onDisconnected = onDisconnected;
    this.watching = null;
    this.attached = null;
    this.needsTap = false; // o navegador só liberou o vídeo sem som

    this.video = h('video.mobile-video', { autoplay: true, playsInline: true });
    this.center = h('div.mobile-player-center');
    this.controls = h('div.mobile-controls');
    this.annotations = new StreamAnnotations(this.video, (id, update) => manager.sendAnnotation(id, update));
    this.mediaFrame = h('div.mobile-video-frame', this.video, this.annotations.canvas, this.center);
    this.player = h('section.mobile-player', { hidden: true }, this.mediaFrame, this.controls);
    this.list = h('div.mobile-list');
    this.status = h('span.muted');
    installFullscreenIdle(this.player);
  }

  mount() {
    const hd = this.handler;
    replaceChildren(this.root,
      h('div.mobile-app',
        h('header.mobile-header',
          icon('logo'), h('span.ellipsis', hd.serverName),
          h('span.spacer'),
          this.status,
          h('button.icon-btn', { title: t('app.disconnect'), 'aria-label': t('app.disconnect'), on: { click: () => hd.disconnect() } }, icon('power'))),
        h('div.mobile-body', this.player, this.list)));

    hd.on('changed', () => this.render());
    hd.on('streamupdated', () => this.render());
    hd.on('reconnecting', () => this.render());
    hd.on('resumed', () => this.render());
    hd.on('disconnected', () => {
      this.#attach(null);
      this.annotations.destroy();
      this.youtubePlayer?.destroy();
      this.onDisconnected();
    });
    this.manager.on('changed', () => this.render());
    this.manager.on('annotation', update => this.annotations.receive(update));
    document.addEventListener('fullscreenchange', () => this.render());
    window.addEventListener('beforeunload', () => hd.disconnect());
    this.render();
  }

  render() {
    this.status.textContent = this.handler.reconnecting ? 'Reconectando…' : '';
    const view = this.watching ? this.manager.inbound.get(this.watching) : null;
    if (this.watching && !view) this.#stopWatching();
    this.#renderPlayer(view);
    this.#renderList();
  }

  /** Trocar de stream sai do anterior; assistir é sempre um por vez. */
  #watch(id) {
    if (id === this.watching) return;
    if (this.watching) this.#leave();
    this.watching = id;
    // Dentro do toque, para o navegador liberar o som quando o vídeo chegar.
    this.video.play().catch(() => {});
    this.manager.joinStream(id).catch(this.onError);
  }

  #leave() {
    const id = this.watching;
    this.#stopWatching();
    this.manager.leaveStream(id).catch(this.onError);
  }

  #stopWatching() {
    this.watching = null;
    this.#attach(null);
    if (document.fullscreenElement === this.player) document.exitFullscreen().catch(() => {});
  }

  #attach(mediaStream) {
    if (this.attached === mediaStream) return;
    this.attached = mediaStream;
    this.needsTap = false;
    this.video.muted = false;
    this.video.srcObject = mediaStream;
    if (mediaStream) this.video.play().catch(() => this.#playMuted());
  }

  /** Sem gesto recente o celular recusa vídeo com som; melhor mudo que parado. */
  #playMuted() {
    this.video.muted = true;
    this.needsTap = true;
    this.video.play().catch(() => {});
    this.render();
  }

  #unmute() {
    this.video.muted = !this.video.muted;
    this.needsTap = false;
    this.video.play().catch(() => {});
    this.render();
  }

  #toggleFullscreen() {
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
    if (!this.player.requestFullscreen) return void this.video.webkitEnterFullscreen?.(); // iPhone
    this.player.requestFullscreen().then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  }

  #renderPlayer(view) {
    this.player.hidden = !view;
    this.annotations.update(view ? this.manager.annotationContext(view.streamIdentifier) : null);
    const youtube = view?.status === InboundStatus.PLAYING ? view.youtube : null;
    this.mediaFrame.hidden = !!youtube;
    this.player.classList.toggle('youtube', !!youtube);
    if (youtube) return this.#renderYouTube(view, youtube);
    this.youtubePlayer?.destroy();
    this.youtubePlayer = null;
    if (!view) return;
    const info = this.handler.streams.get(view.streamIdentifier);
    const playing = view.status === InboundStatus.PLAYING || view.status === InboundStatus.RECONNECTING;
    this.#attach(playing ? view.session?.mediaStream ?? null : null);
    replaceChildren(this.center, this.#playerCenter(view, info));
    const fullscreen = document.fullscreenElement === this.player;
    replaceChildren(this.controls,
      h('div.mobile-now',
        h('strong.ellipsis', info?.name ?? ''),
        h('span.muted.ellipsis', info ? this.handler.clientName(info.ownerClid) : '')),
      playing ? this.#control(this.video.muted ? 'mute' : 'volume', t('video.action.volume'), () => this.#unmute()) : null,
      this.annotations.enabled ? this.annotations.controls : null,
      playing ? this.#control(fullscreen ? 'fullscreenExit' : 'fullscreen',
        t(fullscreen ? 'video.action.fullscreen.close' : 'video.action.fullscreen.open'), () => this.#toggleFullscreen()) : null,
      this.#control('leave', t('video.action.leave'), () => this.#leave(), 'danger'));
  }

  #renderYouTube(view, youtube) {
    this.#attach(null);
    if (!this.youtubePlayer) {
      this.youtubePlayer = new YouTubePlayer();
      this.controls.before(this.youtubePlayer.el);
    }
    this.youtubePlayer.update(youtube);
    const info = this.handler.streams.get(view.streamIdentifier);
    replaceChildren(this.controls,
      h('div.mobile-now', h('strong.ellipsis', info?.name ?? 'YouTube')),
      this.#control('sync', t('video.youtube.sync'), () => this.youtubePlayer.resync()),
      this.#control('leave', t('video.action.leave'), () => this.#leave(), 'danger'));
  }

  #playerCenter(view, info) {
    const id = view.streamIdentifier;
    if (view.status === InboundStatus.ERROR) {
      return h('div.stream-preview__error',
        h('div.stream-preview__error__text', icon('warning'), t(view.error.key, view.error.params)),
        h('button.btn', { on: { click: () => this.manager.joinStream(id).catch(this.onError) } }, t('video.action.retry')));
    }
    if (view.status === InboundStatus.WAITING || view.status === InboundStatus.CONNECTING) {
      return h('div.status-pill', h('span.spinner'), t(view.status === InboundStatus.WAITING ? 'video.join.status.waiting_for_answer' : 'video.join.status.connecting'));
    }
    if (view.status === InboundStatus.RECONNECTING) return h('div.status-pill', h('span.spinner'), t('video.join.status.reconnecting'));
    if (this.needsTap) return h('button.btn.primary', { on: { click: () => this.#unmute() } }, icon('volume'), t('video.mobile.unmute'));
    if (info?.paused) return h('div.paused-label', icon('pause'), t('video.stream.paused'));
    return null;
  }

  #control(iconName, title, onClick, cls = '') {
    return h('button.mobile-control', { class: cls, title, 'aria-label': title, on: { click: onClick } }, icon(iconName));
  }

  #streams() {
    const own = this.handler.ownClient;
    if (!own) return [];
    return this.handler.streamsInChannel(own.cid)
      .filter(s => !this.manager.ownStreams.has(s.streamIdentifier))
      .sort((a, b) => a.created - b.created);
  }

  #renderList() {
    const streams = this.#streams();
    replaceChildren(this.list,
      streams.length
        ? [h('h2.mobile-list-title', t('video.mobile.live_now')), streams.map(s => this.#card(s))]
        : h('div.stream-empty',
          icon('stream', 'big'),
          h('h3', t('video.stream.empty')),
          h('p', t('video.mobile.empty.hint'))),
      h('p.mobile-note', t('video.mobile.watch_only')));
  }

  #card(s) {
    return h('button.mobile-card', {
      class: { watching: s.streamIdentifier === this.watching },
      on: { click: () => this.#watch(s.streamIdentifier) },
    },
    h('span.mobile-card-thumb', { style: s.thumbnail ? { backgroundImage: `url("${s.thumbnail}")` } : null },
      s.thumbnail ? null : icon(TYPE_ICON[s.type] ?? 'stream'),
      h('span.badge.live', t('video.stream.live'))),
    h('span.mobile-card-text',
      h('strong.ellipsis', s.name),
      h('span.muted.ellipsis', this.handler.clientName(s.ownerClid))),
    h('span.viewer-count', icon('users'), String(s.viewerCount ?? 0)));
  }
}
