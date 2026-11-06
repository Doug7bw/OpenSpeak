// Diálogo "Iniciar transmissão" / "Ajustar transmissão" (setup-stream do TS 6):
// fonte + pré-visualização à esquerda, configurações básicas/avançadas à direita.

import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import {
  StreamAccess, StreamMode, StreamType, QUALITY_PRESETS, RESOLUTIONS, FPS_OPTIONS, AUDIO_BITRATES, findPreset,
} from '../core/protocol.js';
import { SharedVideoSource } from '../video/SharedVideoSource.js';

const DEBUG = new URLSearchParams(location.search).has('debug');

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
    this.sourceTab = this.config.type === StreamType.CAMERA ? 'camera' : this.config.type === StreamType.WINDOW ? 'window' : 'screen';
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
    return h('button.btn.attention', { disabled: !this.preview || this.busy, on: { click: () => this.#goLive() } },
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
    ];
    if (DEBUG) tabs.push({ key: 'test', title: 'Teste', icon: 'chart' });
    let body;
    if (this.sourceTab === 'camera') {
      body = this.cameras.length
        ? h('div.source-list', this.cameras.map(cam => h('button.source-item', {
          class: { active: this.preview?.videoTrack?.getSettings().deviceId === cam.deviceId },
          on: { click: () => this.#pick(StreamType.CAMERA, cam.deviceId) },
        }, icon('camera'), h('span.ellipsis', cam.label || 'Câmera'))))
        : h('div.source-empty', t('video.sources.no_camera'));
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
    if (this.preview) this.#setPreviewStream(this.preview.stream);
    return h('div.setup-stream__preview',
      segmented(tabs, this.sourceTab, key => {
        this.sourceTab = key;
        if (key === 'camera') this.#loadCameras();
        this.render();
      }),
      h('div.preview-frame',
        this.preview ? this.previewVideo : h('div.preview-placeholder', icon('stream', 'big'), t('video.stream.select'))),
      this.preview ? h('div.preview-caption', icon('check'), h('span.ellipsis', this.preview.label)) : null,
      body,
      h('label.toggle',
        h('input', { type: 'checkbox', checked: this.config.audio, on: { change: ev => {
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
    this.render();
  }

  async #pick(type, deviceId) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const src = type === 'test'
        ? SharedVideoSource.openTestPattern({ audio: this.config.audio, quality: this.quality })
        : await SharedVideoSource.open({ type, deviceId, audio: this.config.audio, quality: this.quality });
      this.preview?.stop();
      this.preview = src;
      this.config.type = src.type;
      if (type === StreamType.CAMERA && !this.cameras.some(c => c.label)) this.#loadCameras();
    } catch (err) {
      if (err?.name !== 'AbortError') this.onError(new Error(t(captureErrorKey(err))));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  // ------------------------------------------------------- configurações

  #settingsPanel() {
    const c = this.config;
    const q = this.quality;
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
      field(t('video.preset'), t('video.preset.info'), h('div',
        segmented(presetOptions, this.presetId, id => this.#applyPreset(id)),
        this.presetId === 'custom' ? h('div.hint', t('video.preset.custom')) : null)),
      field(t('video.privacy'), null, h('div', segmented(accessOptions, c.access, v => { c.access = Number(v); this.render(); }),
        h('div.hint', t(accessInfo)))),

      h('button.expander', {
        class: { open: this.advanced },
        on: { click: () => {
          this.advanced = !this.advanced;
          this.settings.set('preferStreamSettingsAdvancedMode', this.advanced);
          this.render();
        } },
      }, icon('chevronDown'), t('video.setup.section.advanced')),
      this.advanced ? h('div.advanced',
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
        field(t('video.viewer_limit'), t('video.viewer_limit.info'), h('input.input', {
          type: 'number', min: '0', max: '1000', value: String(c.viewerLimit),
          on: { input: ev => { c.viewerLimit = Math.max(0, Math.min(1000, Number(ev.target.value) || 0)); } },
        })),
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
    if (!this.preview) return;
    this.busy = true;
    this.render();
    try {
      await this.preview.applyQuality(this.quality);
      const source = this.preview;
      this.preview = null; // a posse passa para o ScreenshareManager
      await this.manager.startStream({ config: { ...this.config }, quality: { ...this.quality }, source });
      this.#persist();
      this.close();
    } catch (err) {
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
