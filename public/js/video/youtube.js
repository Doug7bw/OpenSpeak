const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LONG_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const MAX_POSITION = 10_000_000;

export function isYouTubeVideoId(value) {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

export function isYouTubePosition(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_POSITION;
}

export function parseYouTubeLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;

  let videoId;
  if (url.hostname === 'youtu.be') {
    videoId = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  } else if (LONG_HOSTS.has(url.hostname)) {
    videoId = url.pathname === '/watch'
      ? url.searchParams.get('v')
      : /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  if (!isYouTubeVideoId(videoId)) return null;

  const time = url.searchParams.get('t') ?? url.searchParams.get('start') ?? new URLSearchParams(url.hash.slice(1)).get('t') ?? '';
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(time);
  const seconds = /^\d+$/.test(time) ? Number(time)
    : parts ? Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0) : 0;
  return { videoId, position: isYouTubePosition(seconds) ? seconds : 0 };
}

export function youtubePosition(state, elapsedMs) {
  const elapsed = state.playing ? Math.max(0, elapsedMs) * state.rate / 1000 : 0;
  return Math.min(MAX_POSITION, state.position + elapsed);
}
