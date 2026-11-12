// Diálogo "Iniciar transmissão" / "Ajustar transmissão" (setup-stream do TS 6):
// fonte + pré-visualização à esquerda, configurações básicas/avançadas à direita.

import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import {
  StreamAccess, StreamMode, StreamType, QUALITY_PRESETS, RESOLUTIONS, FPS_OPTIONS, AUDIO_BITRATES, findPreset,
} from '../core/protocol.js';
import { SharedVideoSource } from '../video/SharedVideoSource.js';
import { canOpenTorrent } from '../video/TorrentMedia.js';
import { parseYouTubeLink } from '../video/youtube.js';

const DEBUG = new URLSearchParams(location.search).has('debug');
const TORRENT_ENABLED = false;

function segmented(options, value, onChange) {
  return h('div.segmented', options.map(o => h('button', {
    type: 'button',
    class: { active: String(o.key) === String(value), disabled: !!o.disabled },
    disabled: !!o.disabled,
    title: o.tooltip ?? '',
    on: { click: () => onChange(o.key) },
  }, o.icon ? icon(o.icon) : null, o.title)));
}

function field(label, info, control) {
  return h('label.field', h('span.field-label', label, info ? h('span.info-dot', { title: info }, icon('info')) : null), control);
}

function captureErrorKey(err) {
  if (err?.name === 'TimeoutError') return 'video.error.torrent_timeout';
  if (/^video\.error\.(file|torrent)_/.test(err?.message ?? '')) return err.message;
  if (err?.name === 'NotAllowedError') return 'video.error.permission';
  if (err?.message === 'streaming_not_supported_on_os') return 'video.error.streaming_not_supported_on_os';
  return 'video.error.no_available_source';
}

export class SetupStreamDialog {
  /**
   * @param {object} o
   * @param {import('../video/ScreenshareManager.js').ScreenshareManager} o.manager
   * @param {import('../core/ConnectionHandler.js').ConnectionHandler} o.handler
   * @param {object} o.settings
   * @param {object|null} [o.edit]   OwnStream para edição
   * @param {boolean} [o.sourceOnly] abre direto na troca de fonte
   * @param {(err:Error)=>void} o.onError
   */
  constructor({ manager, handler, settings, edit = null, sourceOnly = false, onError }) {
    this.manager = manager;
    this.handler = handler;
    this.settings = settings;
    this.edit = edit;
    this.sourceOnly = sourceOnly;
    this.onError = onError;
    const own = handler.ownClient;
    const base = edit
      ? { config: { ...edit.config }, quality: { ...edit.quality } }
      : { config: { ...settings.get('lastStreamingConfig') }, quality: { ...settings.get('lastStreamingQuality') } };
    this.config = base.config;
    this.quality = base.quality;
    if (!this.config.name) this.config.name = `Stream de ${own ? handler.clientName(own.clid) : ''}`.trim();
    this.config.mode = handler.hasStreamingSFU ? StreamMode.SFU : StreamMode.P2P; // não é escolhido na interface
    const tabsByType = { [StreamType.CAMERA]: 'camera', [StreamType.WINDOW]: 'window', [StreamType.FILE]: 'file' };
    this.sourceTab = this.config.type === StreamType.YOUTUBE && this.handler.hasStreamYouTube && !this.sourceOnly
      ? 'youtube' : (tabsByType[this.config.type] ?? 'screen');
    this.youtubeLink = '';
    this.closed = false;
    this.mediaLoad = null;
    this.torrentMagnet = '';
    this.torrentStatus = '';
    this.preview = null; // SharedVideoSource ainda não publicada
    this.cameras = [];
    this.busy = false;
    this.advanced = settings.get('preferStreamSettingsAdvancedMode');
    this.previewVideo = h('video.setup-preview-video', { autoplay: true, muted: true, playsInline: true });
    this.el = h('div.modal-backdrop', { on: { mousedown: ev => { if (ev.target === this.el) this.close(); } } });
    this.render();
    if (this.sourceTab === 'camera') this.#loadCameras();
  }

  open() {
    document.body.append(this.el);
    this._keyHandler = ev => { if (ev.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._keyHandler);
  }

  close() {
    this.closed = true;
    this.mediaLoad?.abort();
    this.preview?.stop();
    this.preview = null;
    document.removeEventListener('keydown', this._keyHandler);
    this.el.remove();
  }

  get presetId() {
    return findPreset(this.quality, this.config.bitrate)?.id ?? 'custom';
  }

  render() {
    const title = this.edit ? t('video.setup.title.edit') : t('video.setup.title');
    replaceChildren(this.el,
      h('div.modal.setup-stream', { role: 'dialog', 'aria-label': title },
        h('header.modal-header', icon('stream'), h('h2', title),
          h('span.spacer'), h('button.icon-btn', { title: t('app.close'), on: { click: () => this.close() } }, icon('close'))),
        h('div.setup-stream__body',
          this.#sourcePanel(),
          this.sourceOnly ? null : this.#settingsPanel()),
        h('footer.modal-footer',
          h('span.spacer'),
          h('button.btn.ghost', { on: { click: () => this.close() } }, t('app.cancel')),
          this.#primaryButton())));
  }

  #primaryButton() {
    if (this.sourceOnly) {
      return h('button.btn.primary', { disabled: !this.preview || this.busy, on: { click: () => this.#applySource() } },
        icon('swap'), t('video.action.change_source'));
    }
    if (this.edit) {
      return h('button.btn.primary', { disabled: this.busy, on: { click: () => this.#applyEdit() } },
        icon('check'), t('video.setup.adjust_settings'));
    }
    return h('button.btn.attention', { disabled: (this.sourceTab !== 'youtube' && !this.preview) || this.busy, on: { click: () => this.#goLive() } },
      this.busy ? h('span.spinner') : icon('stream'), t('video.action.go_live'));
  }

  // ------------------------------------------------------------ fonte

  #sourcePanel() {
    if (this.edit && !this.sourceOnly) {
      // Editando: mostra a captura atual.
      this.#setPreviewStream(this.edit.source.stream);
      return h('div.setup-stream__preview',
        h('div.preview-frame', this.previewVideo),
        h('div.preview-caption', icon('stream'), h('span.ellipsis', this.edit.source.label || '')));
    }
    const tabs = [
      { key: 'screen', title: t('video.sources.screens'), icon: 'screen', disabled: !this.manager.canCaptureScreen },
      { key: 'window', title: t('video.sources.apps'), icon: 'window', disabled: !this.manager.canCaptureScreen },
      { key: 'camera', title: t('video.sources.cameras'), icon: 'camera' },
      { key: 'file', title: t('video.sources.files'), icon: 'stream', disabled: !SharedVideoSource.canCaptureFile,
        tooltip: SharedVideoSource.canCaptureFile ? '' : t('video.error.file_capture_unsupported') },
    ];
    const torrentSupported = TORRENT_ENABLED && SharedVideoSource.canCaptureFile && canOpenTorrent();
    if (TORRENT_ENABLED) tabs.push({ key: 'torrent', title: t('video.sources.torrent'), icon: 'globe', disabled: !torrentSupported,
      tooltip: torrentSupported ? '' : t('video.error.torrent_unsupported') });
    if (!this.sourceOnly && this.handler.hasStreamYouTube) tabs.push({ key: 'youtube', title: 'YouTube', icon: 'stream' });
    const isYouTube = this.sourceTab === 'youtube';
    if (DEBUG) tabs.push({ key: 'test', title: 'Teste', icon: 'chart' });
    let body;
    if (this.sourceTab === 'camera') {
      body = this.cameras.length
        ? h('div.source-list', this.cameras.map(cam => h('button.source-item', {
          class: { active: this.preview?.videoTrack?.getSettings().deviceId === cam.deviceId },
          on: { click: () => this.#pick(StreamType.CAMERA, { deviceId: cam.deviceId }) },
        }, icon('camera'), h('span.ellipsis', cam.label || 'Câmera'))))
        : h('div.source-empty', t('video.sources.no_camera'));
    } else if (this.sourceTab === 'file') {
      const input = h('input', {
        type: 'file', accept: 'video/*,.mp4,.webm,.m4v,.mov,.mkv', hidden: true,
        on: { change: () => {
          const [file] = input.files;
          if (file) this.#pick(StreamType.FILE, { file });
        } },
      });
      body = h('div.source-pick',
        input,
        h('button.btn.primary', {
          disabled: this.busy || !SharedVideoSource.canCaptureFile,
          on: { click: () => input.click() },
        }, icon('stream'), t('video.setup.pick_file')),
        !this.edit ? h('p.muted', t('video.setup.file.info')) : null);
    } else if (isYouTube) {
      body = [
        field(t('video.youtube.link'), null, h('input.input', {
          type: 'url', placeholder: 'https://www.youtube.com/watch?v=…', autocomplete: 'off',
          value: this.youtubeLink, disabled: this.busy,
          on: {
            input: ev => { this.youtubeLink = ev.target.value; },
            keydown: ev => { if (ev.key === 'Enter') this.#goLive(); },
          },
        })),
        h('p.muted', t('video.youtube.setup_hint')),
      ];
    } else if (this.sourceTab === 'torrent') {
      body = h('form.torrent-source', { on: { submit: ev => {
        ev.preventDefault();
        this.#pick('torrent', { magnet: this.torrentMagnet });
      } } },
        field(t('video.torrent.magnet'), null, h('input.input', {
          type: 'text', placeholder: 'magnet:?xt=urn:btih:…', autocomplete: 'off', spellcheck: 'false',
          value: this.torrentMagnet, disabled: this.busy, required: true,
          on: { input: ev => { this.torrentMagnet = ev.target.value; } },
        })),
        h('div.source-pick',
          h('button.btn.primary', { type: 'submit', disabled: this.busy || !torrentSupported },
            this.torrentStatus ? h('span.spinner') : icon('globe'), t('video.torrent.load')),
          this.torrentStatus ? h('p.muted', { role: 'status' }, t(this.torrentStatus)) : null),
        !this.edit && this.preview?.fileVideo && !this.torrentStatus ? h('p.muted', t('video.setup.file.info')) : null);
    } else if (this.sourceTab === 'test') {
      body = h('div.source-pick',
        h('button.btn.primary', { on: { click: () => this.#pick('test') } }, icon('chart'), 'Padrão de teste'));
    } else {
      body = h('div.source-pick',
        h('button.btn.primary', {
          disabled: this.busy,
          on: { click: () => this.#pick(this.sourceTab === 'window' ? StreamType.WINDOW : StreamType.SCREEN) },
        }, icon(this.sourceTab === 'window' ? 'window' : 'screen'), t('video.setup.pick')),
        h('p.muted', t('video.setup.pick.info')));
    }
    const fileVideo = this.preview?.fileVideo;
    if (fileVideo) fileVideo.classList.add('setup-preview-video');
    else if (this.preview) this.#setPreviewStream(this.preview.stream);
    return h('div.setup-stream__preview',
      segmented(tabs, this.sourceTab, key => {
        if (key !== 'torrent' && this.torrentStatus) this.mediaLoad?.abort();
        this.sourceTab = key;
        if (key === 'camera') this.#loadCameras();
        this.render();
      }),
      isYouTube ? null : h('div.preview-frame',
        this.preview ? (fileVideo ?? this.previewVideo) : h('div.preview-placeholder', icon('stream', 'big'), t('video.stream.select'))),
      !isYouTube && this.preview ? h('div.preview-caption', icon('check'), h('span.ellipsis', this.preview.label)) : null,
      body,
      isYouTube ? null : h('label.toggle',
        h('input', { type: 'checkbox', disabled: this.busy, checked: this.config.audio, on: { change: ev => {
          this.config.audio = ev.target.checked;
          // o áudio é decidido na captura: força escolher a fonte de novo
          if (this.preview) {
            this.preview.stop();
            this.preview = null;
          }
          this.render();
        } } }),
        h('span.toggle-ui'),
        h('span', t('video.audio')),
        h('span.info-dot', { title: t('video.audio.info') }, icon('info'))));
  }

  #setPreviewStream(stream) {
    if (this.previewVideo.srcObject !== stream) {
      this.previewVideo.srcObject = stream;
      this.previewVideo.play().catch(() => {});
    }
  }

  async #loadCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.cameras = devices.filter(d => d.kind === 'videoinput');
    } catch {
      this.cameras = [];
    }
    if (!this.closed) this.render();
  }

  async #pick(type, { deviceId, file, magnet } = {}) {
    if (this.busy) return;
    this.busy = true;
    if (type === 'torrent') this.torrentStatus = 'video.torrent.searching';
    this.render();
    try {
      const options = { audio: this.config.audio, quality: this.quality };
      let src;
      if (file || type === 'torrent') {
        this.mediaLoad = new AbortController();
        const signal = this.mediaLoad.signal;
        src = file
          ? await SharedVideoSource.openFile({ ...options, file, signal })
          : await SharedVideoSource.openTorrent({ ...options, magnet, signal, onStatus: key => {
            this.torrentStatus = key;
            if (!this.closed) this.render();
          } });
      } else if (type === 'test') {
        src = SharedVideoSource.openTestPattern(options);
      } else {
        src = await SharedVideoSource.open({ ...options, type, deviceId });
      }
      if (this.closed) {
        src.stop();
        return;
      }
      this.preview?.stop();
      this.preview = src;
      this.config.type = src.type;
      if (type === StreamType.CAMERA && !this.cameras.some(c => c.label)) this.#loadCameras();
    } catch (err) {
      if (!this.closed && err?.name !== 'AbortError') this.onError(new Error(t(captureErrorKey(err))));
    } finally {
      this.mediaLoad = null;
      this.torrentStatus = '';
      this.busy = false;
      if (!this.closed) this.render();
    }
  }

  // ------------------------------------------------------- configurações

  #settingsPanel() {
    const c = this.config;
    const q = this.quality;
    const isYouTube = this.sourceTab === 'youtube';
    const presetOptions = QUALITY_PRESETS.map(p => ({ key: p.id, title: t(p.label) }));
    const accessOptions = [
      { key: StreamAccess.PUBLIC, title: t('video.privacy.public'), icon: 'globe' },
      { key: StreamAccess.CONTACTS_ONLY, title: t('video.privacy.contacts'), icon: 'contacts' },
      { key: StreamAccess.PRIVATE, title: t('video.privacy.private'), icon: 'lock' },
    ];
    const accessInfo = {
      [StreamAccess.PUBLIC]: 'video.privacy.public.info',
      [StreamAccess.CONTACTS_ONLY]: 'video.privacy.contacts.info',
      [StreamAccess.PRIVATE]: 'video.privacy.private.info',
    }[c.access];
    const resolutionId = RESOLUTIONS.find(r => r.width === q.width && r.height === q.height)?.id ?? 'source';

    return h('div.setup-stream__settings',
      h('h3.section-title', t('video.setup.section.basic')),
      field(t('video.name'), null, h('input.input', {
        value: c.name, maxLength: 64, on: { input: ev => { c.name = ev.target.value; } },
      })),
      isYouTube ? null : field(t('video.preset'), t('video.preset.info'), h('div',
        segmented(presetOptions, this.presetId, id => this.#applyPreset(id)),
        this.presetId === 'custom' ? h('div.hint', t('video.preset.custom')) : null)),
      field(t('video.privacy'), null, h('div', segmented(accessOptions, c.access, v => { c.access = Number(v); this.render(); }),
        h('div.hint', t(accessInfo)))),

      isYouTube ? this.#viewerLimitField() : h('button.expander', {
        class: { open: this.advanced },
        on: { click: () => {
          this.advanced = !this.advanced;
          this.settings.set('preferStreamSettingsAdvancedMode', this.advanced);
          this.render();
        } },
      }, icon('chevronDown'), t('video.setup.section.advanced')),
      this.advanced && !isYouTube ? h('div.advanced',
        field(t('video.resolution'), t('video.resolution.info'), h('select.input', {
          on: { change: ev => {
            const r = RESOLUTIONS.find(x => x.id === ev.target.value);
            q.width = r.width;
            q.height = r.height;
            this.render();
          } },
        }, RESOLUTIONS.map(r => h('option', { value: r.id, selected: r.id === resolutionId }, t(`video.preset.${r.id}`)))))
        ,
        field(t('video.fps'), t('video.fps.info'), segmented(FPS_OPTIONS.map(f => ({ key: f, title: String(f) })), q.fps,
          v => { q.fps = Number(v); this.render(); })),
        field(`${t('video.bitrate')} — ${(c.bitrate / 1000).toLocaleString('pt-BR')} Kbps`, t('video.bitrate.info'), h('input.range', {
          type: 'range', min: '250', max: '20000', step: '250', value: String(c.bitrate / 1000),
          on: {
            input: ev => {
              c.bitrate = Number(ev.target.value) * 1000;
              ev.target.closest('.field').querySelector('.field-label').firstChild.textContent =
                `${t('video.bitrate')} — ${(c.bitrate / 1000).toLocaleString('pt-BR')} Kbps`;
            },
            change: () => this.render(),
          },
        })),
        this.#viewerLimitField(),
        h('label.toggle',
          h('input', { type: 'checkbox', checked: c.announce !== false, on: { change: ev => { c.announce = ev.target.checked; } } }),
          h('span.toggle-ui'),
          h('span', t('video.announce')),
          h('span.info-dot', { title: t('video.announce.info') }, icon('info'))),
        c.audio ? field(t('video.audio.bitrate'), null, segmented(
          AUDIO_BITRATES.map(b => ({ key: b, title: String(b / 1000) })), q.audioBitrate,
          v => { q.audioBitrate = Number(v); this.render(); })) : null,
      ) : null,
    );
  }

  #viewerLimitField() {
    return field(t('video.viewer_limit'), t('video.viewer_limit.info'), h('input.input', {
      type: 'number', min: '0', max: '1000', value: String(this.config.viewerLimit),
      on: { input: ev => { this.config.viewerLimit = Math.max(0, Math.min(1000, Number(ev.target.value) || 0)); } },
    }));
  }

  #applyPreset(id) {
    const p = QUALITY_PRESETS.find(x => x.id === id);
    if (!p) return;
    this.quality = { width: p.width, height: p.height, fps: p.fps, audioBitrate: p.audioBitrate };
    this.config.bitrate = p.bitrate;
    this.render();
  }

  // ------------------------------------------------------------- ações

  #persist() {
    this.settings.set('lastStreamingConfig', { ...this.config, name: '' });
    this.settings.set('lastStreamingQuality', { ...this.quality });
  }

  async #goLive() {
    if (this.busy) return;
    const source = this.preview;
    const isYouTube = this.sourceTab === 'youtube';
    const youtube = isYouTube ? parseYouTubeLink(this.youtubeLink) : null;
    if (isYouTube && !youtube) {
      this.onError(new Error('video.youtube.invalid_link'));
      return;
    }
    if (!isYouTube && !source) return;
    this.busy = true;
    this.render();
    try {
      if (youtube) {
        await this.manager.startYouTube({ config: this.config, quality: { ...this.quality }, youtube });
        this.config.type = StreamType.YOUTUBE;
      } else {
        await source.applyQuality(this.quality);
        if (this.closed) return;
        this.preview = null; // a posse passa para o ScreenshareManager
        await this.manager.startStream({ config: { ...this.config }, quality: { ...this.quality }, source });
      }
      this.#persist();
      this.close();
    } catch (err) {
      if (this.closed) return;
      this.busy = false;
      this.render();
      this.onError(err);
    }
  }

  async #applyEdit() {
    this.busy = true;
    this.render();
    try {
      await this.manager.updateStream(this.edit.streamIdentifier, { config: { ...this.config }, quality: { ...this.quality } });
      this.#persist();
      this.close();
    } catch (err) {
      this.busy = false;
      this.render();
      this.onError(err);
    }
  }

  async #applySource() {
    if (!this.preview) return;
    this.busy = true;
    try {
      const source = this.preview;
      this.preview = null; // a posse passa para o stream
      await this.manager.changeSource(this.edit.streamIdentifier, source);
      this.close();
    } catch (err) {
      this.busy = false;
      this.render();
      this.onError(err);
    }
  }
}
