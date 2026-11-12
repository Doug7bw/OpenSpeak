// Fonte de captura compartilhada por todas as sessões de saída de um stream.
//
// No TS, `ScalableSharedVideoTransformer` recebe os quadros de uma única captura
// (DesktopCapturer/CameraCapturer), codifica uma vez e distribui para cada
// SessionOutbound ("single-encoding"). No navegador a codificação é por
// RTCRtpSender, mas mantemos a mesma topologia: UMA captura, UMA track,
// N senders (sinks). Trocar de fonte, pausar ou mudar a qualidade é aplicado a
// todos os sinks sem renegociar (replaceTrack/applyConstraints).

import { EventEmitter } from '../core/EventEmitter.js';
import { StreamType } from '../core/protocol.js';
import { openTorrentMedia } from './TorrentMedia.js';

const THUMBNAIL_WIDTH = 320;

export class SharedVideoSource extends EventEmitter {
  #fileVideo = null;
  #cleanup = null;
  #endListeners = null;
  #onEnded = () => this.emit('ended');

  constructor() {
    super();
    this.type = StreamType.NONE;
    this.stream = null; // MediaStream com as tracks originais
    this.videoTrack = null;
    this.audioTrack = null;
    this.paused = false;
    this.quality = { width: 1280, height: 720, fps: 30 };
    this.label = '';
    this.sinks = new Set();
  }

  get active() {
    return !!this.videoTrack && this.videoTrack.readyState === 'live';
  }

  get fileVideo() {
    return this.#fileVideo;
  }

  static get canCaptureFile() {
    return typeof HTMLMediaElement.prototype.captureStream === 'function';
  }

  /** Track que os sinks devem enviar agora (null quando pausado). */
  get outgoingVideoTrack() {
    return this.paused ? null : this.videoTrack;
  }

  get outgoingAudioTrack() {
    return this.paused ? null : this.audioTrack;
  }

  /**
   * Abre uma fonte. Para tela/janela o navegador mostra o seletor nativo.
   * @param {{type:number, deviceId?:string, audio:boolean, quality:object}} o
   */
  static async open({ type, deviceId, audio, quality }) {
    const src = new SharedVideoSource();
    await src.#capture({ type, deviceId, audio, quality });
    return src;
  }

  static openFile({ file, audio, quality, signal }) {
    return this.#openVideo({
      audio, quality, signal,
      load: () => {
        const url = URL.createObjectURL(file);
        return { url, name: file.name, close: () => URL.revokeObjectURL(url) };
      },
    });
  }

  static openTorrent({ magnet, audio, quality, signal, onStatus }) {
    const timeout = AbortSignal.timeout(60_000);
    const loading = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return this.#openVideo({
      audio, quality, signal: loading,
      load: video => openTorrentMedia({ magnet, video, signal: loading, onStatus }),
    });
  }

  /** Prepara o player e captura apenas as faixas do vídeo. */
  static async #openVideo({ audio, quality, signal, load }) {
    if (!this.canCaptureFile) throw new Error('video.error.file_capture_unsupported');
    signal?.throwIfAborted();

    const src = new SharedVideoSource();
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    src.#fileVideo = video;

    const listeners = new AbortController();
    try {
      const media = await load(video);
      src.#cleanup = () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
        media.close();
      };
      signal?.throwIfAborted();
      await new Promise((resolve, reject) => {
        const options = { signal: listeners.signal, once: true };
        video.addEventListener('loadeddata', resolve, options);
        video.addEventListener('error', () => reject(new Error('video.error.file_unplayable')), options);
        signal?.addEventListener('abort', () => reject(signal.reason), options);
        video.src = media.url;
      });
      if (!video.videoWidth) throw new Error('video.error.file_unplayable');

      src.type = StreamType.FILE;
      src.label = media.name;
      src.stream = video.captureStream();
      src.videoTrack = src.stream.getVideoTracks()[0];
      if (!src.videoTrack) throw new Error('video.error.file_unplayable');
      if (audio) {
        src.audioTrack = src.stream.getAudioTracks()[0] ?? null;
      } else {
        for (const track of src.stream.getAudioTracks()) {
          src.stream.removeTrack(track);
          track.stop();
        }
      }
      src.#watchEnd();
      await src.applyQuality(quality);
      signal?.throwIfAborted();
      return src;
    } catch (err) {
      src.stop();
      throw err;
    } finally {
      listeners.abort();
    }
  }

  /**
   * Padrão de teste animado (canvas + tom de áudio). Útil para validar o motor
   * sem seletor de tela/câmera; habilitado na UI com `?debug`.
   */
  static openTestPattern({ audio, quality }) {
    const src = new SharedVideoSource();
    const width = quality.width > 0 ? quality.width : 1280;
    const height = quality.height > 0 ? quality.height : 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const started = performance.now();
    let frame = 0;
    const draw = () => {
      const t = (performance.now() - started) / 1000;
      const hue = (t * 40) % 360;
      ctx.fillStyle = `hsl(${hue} 55% 22%)`;
      ctx.fillRect(0, 0, width, height);
      const bars = ['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f'];
      bars.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect((i * width) / 7, height * 0.62, width / 7, height * 0.18);
      });
      const x = (Math.sin(t * 1.7) * 0.4 + 0.5) * width;
      ctx.fillStyle = '#16bcfb';
      ctx.beginPath();
      ctx.arc(x, height * 0.35, height * 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(height / 12)}px monospace`;
      ctx.fillText(`OpenSpeak ${new Date().toLocaleTimeString()}  #${frame++}`, width * 0.04, height * 0.14);
    };
    draw();
    const timer = setInterval(draw, 1000 / Math.max(1, quality.fps));
    const media = canvas.captureStream(quality.fps);
    if (audio) {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.05;
      osc.frequency.value = 440;
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      media.addTrack(dest.stream.getAudioTracks()[0]);
      src.#cleanup = () => ac.close();
    }
    const closeAudio = src.#cleanup;
    src.#cleanup = () => {
      clearInterval(timer);
      closeAudio?.();
    };
    src.type = StreamType.SCREEN;
    src.stream = media;
    src.videoTrack = media.getVideoTracks()[0];
    src.audioTrack = media.getAudioTracks()[0] ?? null;
    src.label = 'Padrão de teste';
    src.quality = { ...quality };
    src.videoTrack.contentHint = 'detail';
    return src;
  }

  async #capture({ type, deviceId, audio, quality }) {
    const video = { frameRate: { ideal: quality.fps, max: quality.fps } };
    if (quality.width > 0) {
      video.width = { max: quality.width };
      video.height = { max: quality.height };
    }
    let media;
    if (type === StreamType.CAMERA) {
      if (deviceId) video.deviceId = { exact: deviceId };
      if (quality.width > 0) {
        video.width = { ideal: quality.width };
        video.height = { ideal: quality.height };
      }
      media = await navigator.mediaDevices.getUserMedia({ video, audio: audio ? { echoCancellation: true, noiseSuppression: true } : false });
    } else {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('streaming_not_supported_on_os');
      video.displaySurface = type === StreamType.WINDOW ? 'window' : 'monitor';
      video.cursor = 'always';
      media = await navigator.mediaDevices.getDisplayMedia({
        video,
        audio: audio ? {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 2, sampleRate: 48_000, suppressLocalAudioPlayback: false,
        } : false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: audio ? 'include' : 'exclude',
        monitorTypeSurfaces: 'include',
      });
    }
    this.type = type;
    this.stream = media;
    this.videoTrack = media.getVideoTracks()[0] ?? null;
    this.audioTrack = media.getAudioTracks()[0] ?? null;
    if (!this.videoTrack) throw new Error('no_available_source');
    this.label = this.videoTrack.label;
    // O usuário pode encerrar pelo botão "Parar compartilhamento" do navegador.
    this.#watchEnd();
    // Se o usuário trocar de janela pelo seletor do navegador, o tipo pode mudar.
    const surface = this.videoTrack.getSettings().displaySurface;
    if (surface === 'window') this.type = StreamType.WINDOW;
    else if (surface === 'monitor') this.type = StreamType.SCREEN;
    await this.applyQuality(quality);
  }

  /** Aplica resolução/FPS na captura (afeta todos os sinks de uma vez). */
  async applyQuality(quality) {
    this.quality = { ...quality };
    if (!this.videoTrack) return;
    const constraints = { frameRate: { ideal: quality.fps, max: quality.fps } };
    if (quality.width > 0) {
      constraints.width = { max: quality.width };
      constraints.height = { max: quality.height };
    }
    try {
      await this.videoTrack.applyConstraints(constraints);
    } catch (err) {
      console.warn('[source] applyConstraints falhou', err);
    }
    this.videoTrack.contentHint = this.#contentHint();
    this.emit('qualitychanged', this.quality);
  }

  /**
   * Conteúdo de tela/apresentação prioriza nitidez (reduz FPS antes da
   * resolução); câmera e 60 FPS priorizam fluidez.
   */
  #contentHint() {
    if (this.type === StreamType.CAMERA || this.type === StreamType.FILE) return 'motion';
    if (this.quality.fps <= 5) return 'text';
    return this.quality.fps >= 60 ? 'motion' : 'detail';
  }

  get degradationPreference() {
    const hint = this.videoTrack?.contentHint;
    if (hint === 'motion') {
      return this.type === StreamType.CAMERA || this.type === StreamType.FILE ? 'balanced' : 'maintain-framerate';
    }
    return 'maintain-resolution';
  }

  async playFile() {
    if (!this.#fileVideo) return;
    try {
      await this.#fileVideo.play();
    } catch {
      throw new Error('video.error.file_unplayable');
    }
  }

  async setPaused(paused) {
    if (this.paused === paused) return;
    if (paused) this.#fileVideo?.pause();
    else if (this.#fileVideo) await this.playFile();
    this.paused = paused;
    this.emit('trackschanged');
  }

  /** Substitui a captura mantendo os sinks (botão "Trocar fonte"). */
  replaceWith(other) {
    this.#release();
    other.#endListeners?.abort();
    this.type = other.type;
    this.stream = other.stream;
    this.videoTrack = other.videoTrack;
    this.audioTrack = other.audioTrack;
    this.label = other.label;
    this.quality = other.quality;
    this.#fileVideo = other.#fileVideo;
    this.#cleanup = other.#cleanup;
    other.stream = other.videoTrack = other.audioTrack = null;
    other.#fileVideo = other.#cleanup = null;
    this.#watchEnd();
    this.emit('trackschanged');
  }

  #watchEnd() {
    this.#endListeners = new AbortController();
    const options = { signal: this.#endListeners.signal, once: true };
    this.videoTrack.addEventListener('ended', this.#onEnded, options);
    this.#fileVideo?.addEventListener('ended', this.#onEnded, options);
    this.#fileVideo?.addEventListener('error', this.#onEnded, options);
  }

  #release() {
    this.#endListeners?.abort();
    this.stream?.getTracks().forEach(track => track.stop());
    this.#cleanup?.();
    this.#cleanup = null;
    this.#fileVideo = null;
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
  }

  addSink(session) {
    this.sinks.add(session);
  }

  removeSink(session) {
    this.sinks.delete(session);
  }

  /** Miniatura JPEG pequena (ThumbnailCapturer do TS). */
  async captureThumbnail() {
    if (!this.active) return null;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([this.videoTrack]);
    try {
      await video.play();
      await new Promise(r => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
      const ratio = video.videoHeight / video.videoWidth || 9 / 16;
      const canvas = document.createElement('canvas');
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = Math.round(THUMBNAIL_WIDTH * ratio);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.65);
    } catch {
      return null;
    } finally {
      video.pause();
      video.srcObject = null;
    }
  }

  stop() {
    this.#release();
    this.sinks.clear();
    this.emit('stopped');
    this.removeAllListeners();
  }
}
