// Espelho de server/protocol.js + presets de qualidade do cliente.
// Valores extraídos do cliente TeamSpeak 6 (docs/ANALISE_TEAMSPEAK_P2P.md §3).

export const StreamAccess = Object.freeze({ NONE: 0, PUBLIC: 1, CONTACTS_ONLY: 2, PRIVATE: 3 });
export const StreamMode = Object.freeze({ NONE: 0, P2P: 1, SFU: 2 });
export const StreamType = Object.freeze({ NONE: 0, CAMERA: 1, SCREEN: 2, WINDOW: 3, EXISTING_SESSION: 4, FILE: 5, YOUTUBE: 6 });
export const LeaveReason = Object.freeze({
  NONE: 0, LEFT: 1, DENIED: 2, FAILED: 3, KICKED: 4, BANNED: 5, STREAM_STOPPED: 6, VIEWER_LIMIT: 7,
});

export const Capability = Object.freeze({ STREAM_P2P: 'STREAM_P2P', STREAM_SFU: 'STREAM_SFU', PROFILES: 'PROFILES', PROFILE_MEDIA: 'PROFILE_MEDIA', STREAM_ANNOTATIONS: 'STREAM_ANNOTATIONS', STREAM_YOUTUBE: 'STREAM_YOUTUBE' });

export const ANNOTATION_SCALE = 10_000;
export const MAX_ANNOTATION_POINTS = 32;

// clid reservado do servidor como par WebRTC nos streams SFU (`streamsignaling`/`peerClid`).
export const RELAY_CLID = 0;

// Presets (bitrate em bps). width/height -1 = resolução da fonte.
export const QUALITY_PRESETS = Object.freeze([
  { id: '360', label: 'video.preset.360', bitrate: 500_000, width: 640, height: 360, fps: 30, audioBitrate: 64_000 },
  { id: '480', label: 'video.preset.480', bitrate: 1_000_000, width: 852, height: 480, fps: 30, audioBitrate: 96_000 },
  { id: '720', label: 'video.preset.720', bitrate: 3_000_000, width: 1280, height: 720, fps: 30, audioBitrate: 128_000 },
  { id: '1080', label: 'video.preset.1080', bitrate: 5_000_000, width: 1920, height: 1080, fps: 30, audioBitrate: 192_000 },
  { id: '1440', label: 'video.preset.1440', bitrate: 6_500_000, width: 2560, height: 1440, fps: 30, audioBitrate: 256_000 },
  { id: 'source', label: 'video.preset.source', bitrate: 8_000_000, width: -1, height: -1, fps: 30, audioBitrate: 320_000 },
  { id: 'presentation', label: 'video.preset.presentation', bitrate: 2_000_000, width: -1, height: -1, fps: 5, audioBitrate: 320_000 },
]);
export const DEFAULT_PRESET_ID = '720';

export const RESOLUTIONS = Object.freeze([
  { id: '360', width: 640, height: 360 },
  { id: '480', width: 852, height: 480 },
  { id: '720', width: 1280, height: 720 },
  { id: '1080', width: 1920, height: 1080 },
  { id: '1440', width: 2560, height: 1440 },
  { id: 'source', width: -1, height: -1 },
]);
export const FPS_OPTIONS = Object.freeze([5, 30, 60]);
export const AUDIO_BITRATES = Object.freeze([64_000, 96_000, 128_000, 192_000, 256_000, 320_000]);

export function findPreset(quality, bitrate) {
  return QUALITY_PRESETS.find(p =>
    p.width === quality.width && p.height === quality.height && p.fps === quality.fps && p.bitrate === bitrate) ?? null;
}

export const Severity = Object.freeze({ OK: 0, MINOR: 1, MAJOR: 2 });
