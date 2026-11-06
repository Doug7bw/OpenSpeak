// Preferências locais (equivalente a workflowSettings do TS: lastStreamingConfig etc.).

import { EventEmitter } from '../core/EventEmitter.js';
import { StreamAccess, StreamMode, StreamType, DEFAULT_PRESET_ID, QUALITY_PRESETS } from '../core/protocol.js';

// `?profile=nome` mantém identidades separadas (ex.: duas abas no mesmo navegador).
const PROFILE = new URLSearchParams(location.search).get('profile');
const KEY = `openspeak.settings.v1${PROFILE ? `.${PROFILE.replace(/[^\w-]/g, '')}` : ''}`;

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function randomUid() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
}

const preset = QUALITY_PRESETS.find(p => p.id === DEFAULT_PRESET_ID);

const DEFAULTS = {
  nickname: '',
  serverUrl: '',
  serverPassword: '', // servidor privado (OPENSPEAK_PASSWORD), lembrada após digitar
  profilePasswords: {}, // por servidor e apelido (não vai para outro servidor)
  preferredCodec: 'auto',
  contacts: [], // uids
  hiddenStreams: [],
  showOwnStreams: true,
  showInactiveStreams: true,
  lastStreamingConfig: {
    name: '',
    type: StreamType.SCREEN,
    access: StreamAccess.PUBLIC,
    mode: StreamMode.SFU,
    bitrate: preset.bitrate,
    viewerLimit: 0,
    audio: true,
    announce: true,
  },
  lastStreamingQuality: { width: preset.width, height: preset.height, fps: preset.fps, audioBitrate: preset.audioBitrate },
  preferStreamSettingsAdvancedMode: false,
  soundEffects: true,
  soundTheme: 'suave', // ver SOUND_THEMES em ui/sounds.js
  soundVolume: 60,
};

class Settings extends EventEmitter {
  constructor() {
    super();
    const stored = load();
    this.data = { ...structuredClone(DEFAULTS), ...stored };
    if (!this.data.uid) {
      this.data.uid = randomUid();
      this.save();
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    this.emit('changed', key, value);
  }

  get preferredCodec() {
    return this.data.preferredCodec;
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // armazenamento indisponível (aba privada): segue só em memória
    }
  }
}

export const settings = new Settings();

export const contacts = {
  has(uid) {
    return settings.get('contacts').includes(uid);
  },
  toggle(uid) {
    const list = settings.get('contacts');
    settings.set('contacts', list.includes(uid) ? list.filter(u => u !== uid) : [...list, uid]);
  },
};
