import { h, replaceChildren } from './dom.js';
import { t } from './i18n.js';
import { youtubePosition } from '../video/youtube.js';

const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const MIN_SIZE = 200;
let apiPromise;

function loadAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const script = h('script', { src: 'https://www.youtube.com/iframe_api', async: true });
    const finish = error => {
      clearTimeout(timeout);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve(window.YT);
      }
    };
    const ready = () => {
      finish();
      previous?.();
    };
    const timeout = setTimeout(() => finish(new Error('YouTube IFrame API')), 12_000);
    window.onYouTubeIframeAPIReady = ready;
    script.addEventListener('error', () => finish(new Error('YouTube IFrame API')), { once: true });
    document.head.append(script);
  }).catch(error => {
    apiPromise = undefined;
    throw error;
  });
  return apiPromise;
}

export class YouTubePlayer {
  constructor(publish = null) {
    this.publish = publish;
    this.state = null;
    this.lastSent = null;
    this.player = null;
    this.ready = false;
    this.closed = false;
    this.visible = false;
    this.blocked = false;
    this.loading = false;
    this.failed = false;
    this.frame = null;
    this.slot = h('div.youtube-embed');
    this.status = h('p.youtube-status', { role: 'status', hidden: true });
    this.el = h('div.youtube-player', this.slot, this.status);
    this.onVisibility = () => { if (!this.publish && !document.hidden) this.#sync(true); };
    document.addEventListener('visibilitychange', this.onVisibility);

    this.sizeObserver = new ResizeObserver(() => this.#fit());
    this.sizeObserver.observe(this.slot);
    this.visibilityObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.intersectionRatio >= 0.5;
      if (this.visible && !this.publish) this.#sync(true);
    }, { threshold: 0.5 });
    this.visibilityObserver.observe(this.slot);
    this.timer = setInterval(() => {
      if (this.publish) this.#report();
      else this.#sync(false);
    }, 1000);
  }

  update(state) {
    if (this.state === state) return;
    this.state = state;
    this.receivedAt = performance.now();
    if (!this.frame) this.#fit();
    if (!this.publish) this.#sync(true);
  }

  resync() {
    this.blocked = false;
    this.#sync(true);
  }

  destroy() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.readyTimeout);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.visibilityObserver.disconnect();
    this.sizeObserver.disconnect();
    this.player?.destroy();
    this.el.remove();
  }

  #fit() {
    if (this.closed || !this.state || !this.el.isConnected) return;
    const fits = this.slot.clientWidth >= MIN_SIZE && this.slot.clientHeight >= MIN_SIZE;
    if (this.frame) this.frame.hidden = !fits;
    if (!fits) {
      this.#status('video.youtube.enlarge');
      return;
    }
    if (!this.failed && !this.blocked) this.#status('');
    if (!this.frame && !this.loading && !this.failed) this.#load();
  }

  async #load() {
    this.loading = true;
    try {
      const YT = await loadAPI();
      if (this.closed) return;
      if (this.slot.clientWidth < MIN_SIZE || this.slot.clientHeight < MIN_SIZE) return;
      const url = new URL('https://www.youtube.com/embed/' + this.state.videoId);
      url.search = new URLSearchParams({
        enablejsapi: '1', origin: location.origin, playsinline: '1', rel: '0',
        start: String(Math.floor(youtubePosition(this.state, performance.now() - this.receivedAt))),
      });
      this.frame = h('iframe', {
        src: url.href, title: 'YouTube', allowFullscreen: true,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        referrerpolicy: 'strict-origin-when-cross-origin',
      });
      replaceChildren(this.slot, this.frame);
      this.readyTimeout = setTimeout(() => this.#error('video.youtube.unavailable'), 15_000);
      this.player = new YT.Player(this.frame, {
        events: {
          onReady: () => {
            if (this.closed) return;
            clearTimeout(this.readyTimeout);
            this.ready = true;
            this.failed = false;
            this.#status('');
            if (!this.publish) this.#sync(true);
          },
          onStateChange: ({ data }) => {
            if (this.publish) this.#report();
            else if (data === PLAYING && this.blocked) {
              this.blocked = false;
              this.#status('');
              this.#sync(true);
            }
          },
          onPlaybackRateChange: () => this.#report(),
          onAutoplayBlocked: () => {
            this.blocked = true;
            this.#status('video.youtube.autoplay');
          },
          onError: () => this.#error('video.youtube.unavailable'),
        },
      });
    } catch {
      this.#error('video.youtube.unavailable');
    } finally {
      this.loading = false;
    }
  }

  #sync(force) {
    if (!this.ready || this.closed || this.failed || !this.visible || this.frame?.hidden || document.hidden) return;
    const player = this.player;
    const state = this.state;
    const status = player.getPlayerState();
    if (state.playing && this.blocked) return;
    if (!force && (status !== PLAYING || !state.playing)) return;
    const position = youtubePosition(state, performance.now() - this.receivedAt);
    if (player.getPlaybackRate() !== state.rate) player.setPlaybackRate(state.rate);
    if (!state.playing && [PLAYING, BUFFERING].includes(status)) player.pauseVideo();
    if (Math.abs(player.getCurrentTime() - position) > (force ? 0.8 : 2)) {
      if (!state.playing && ![PLAYING, PAUSED, BUFFERING].includes(status)) {
        player.cueVideoById({ videoId: state.videoId, startSeconds: position });
      } else if (state.playing || status !== ENDED) {
        player.seekTo(position, true);
      }
    }
    if (state.playing && !this.blocked && ![PLAYING, BUFFERING].includes(status)) player.playVideo();
  }

  #report() {
    if (!this.publish || !this.ready || this.closed || this.failed) return;
    const status = this.player.getPlayerState();
    if (![PLAYING, PAUSED, ENDED].includes(status)) return;
    const state = { position: this.player.getCurrentTime(), playing: status === PLAYING, rate: this.player.getPlaybackRate() };
    if (!Number.isFinite(state.position) || !Number.isFinite(state.rate)) return;
    const now = performance.now();
    const last = this.lastSent;
    if (last && state.playing === last.playing && state.rate === last.rate
      && Math.abs(state.position - youtubePosition(last, now - last.at)) < 1.25
      && (!state.playing || now - last.at < 15_000)) return;
    const sent = { ...state, at: now };
    this.lastSent = sent;
    this.publish(state).catch(() => {
      if (this.lastSent === sent) this.lastSent = null;
    });
  }

  #status(key) {
    this.status.hidden = !key;
    this.status.textContent = key ? t(key) : '';
  }

  #error(key) {
    if (this.closed) return;
    clearTimeout(this.readyTimeout);
    this.failed = true;
    this.#status(key);
  }
}
