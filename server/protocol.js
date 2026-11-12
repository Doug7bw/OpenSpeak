// Constantes compartilhadas pelo servidor. O cliente tem um espelho em
// public/js/core/protocol.js (mantenha os dois em sincronia).
//
// Os valores numéricos seguem os enums do cliente TeamSpeak 6
// (ver docs/ANALISE_TEAMSPEAK_P2P.md §3).

export const StreamAccess = Object.freeze({ NONE: 0, PUBLIC: 1, CONTACTS_ONLY: 2, PRIVATE: 3 });
export const StreamMode = Object.freeze({ NONE: 0, P2P: 1, SFU: 2 });
export const StreamType = Object.freeze({ NONE: 0, CAMERA: 1, SCREEN: 2, WINDOW: 3, EXISTING_SESSION: 4, FILE: 5, YOUTUBE: 6 });
export const LeaveReason = Object.freeze({
  NONE: 0, LEFT: 1, DENIED: 2, FAILED: 3, KICKED: 4, BANNED: 5, STREAM_STOPPED: 6, VIEWER_LIMIT: 7,
});

export const ReturnCode = Object.freeze({
  OK: 'ok',
  INVALID_ARGS: 'invalid_args',
  NOT_LOGGED_IN: 'not_logged_in',
  UNKNOWN_COMMAND: 'unknown_command',
  STREAM_NOT_FOUND: 'stream_not_found',
  CLIENT_NOT_FOUND: 'client_not_found',
  CHANNEL_NOT_FOUND: 'channel_not_found',
  PERMISSION_DENIED: 'permission_denied',
  NOT_IN_CHANNEL: 'not_in_channel',
  MODE_NOT_SUPPORTED: 'mode_not_supported',
  STREAM_LIMIT: 'stream_limit',
  VIEWER_LIMIT: 'viewer_limit',
  BANNED: 'banned',
  ALREADY_JOINED: 'already_joined',
  NO_PENDING_REQUEST: 'no_pending_request',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  PROFILE_PASSWORD: 'profile_password',
  PROFILE_LOCKED: 'profile_locked',
  PROFILE_REQUIRED: 'profile_required',
});

// Extensões anunciadas em capabilityExtensions (igual ao TS: STREAM_P2P / STREAM_SFU).
export const CAPABILITIES = Object.freeze(['STREAM_P2P']);
// Só com um ProfileStore (a sala web do Vercel não guarda perfis).
export const CAP_PROFILES = 'PROFILES';
export const CAP_PROFILE_MEDIA = 'PROFILE_MEDIA';
export const CAP_STREAM_ANNOTATIONS = 'STREAM_ANNOTATIONS';
export const CAP_STREAM_YOUTUBE = 'STREAM_YOUTUBE';
// O servidor guarda os registros que o cliente manda com `clientlog` {version, lines}.
export const CAP_CLIENT_LOGS = 'CLIENT_LOGS';
export const CLIENT_LOG_MAX_LINES = 500;

export const ANNOTATION_SCALE = 10_000;
export const MAX_ANNOTATION_POINTS = 32;
export const MAX_ANNOTATION_BATCHES_PER_SECOND = 24;

export const MAX_STREAMS_PER_CLIENT = 3;
export const MAX_THUMBNAIL_BYTES = 256 * 1024;
export const MAX_SIGNALING_BYTES = 64 * 1024;
export const MAX_AVATAR_BYTES = 64 * 1024;
// Banner e GIF da foto: cabem numa mensagem de sinalização junto com a capa da foto.
export const MAX_PROFILE_MEDIA_BYTES = 440 * 1024;
