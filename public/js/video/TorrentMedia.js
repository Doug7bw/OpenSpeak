// O navegador recebe as peças do torrent e serve somente o vídeo selecionado ao player.
import { TorrentPieceStore } from './TorrentPieceStore.js';

const WORKER_URL = new URL('../../torrent-worker.js', import.meta.url);
const files = new Map();

export function canOpenTorrent() {
  return globalThis.isSecureContext && !!navigator.serviceWorker && !!globalThis.RTCPeerConnection
    && !!navigator.storage?.getDirectory && !!globalThis.FileSystemFileHandle?.prototype?.createWritable;
}

export async function openTorrentMedia({ magnet, video, signal, onStatus }) {
  const value = magnet.trim();
  if (!/^magnet:\?/i.test(value)) throw new Error('video.error.torrent_invalid');
  const link = new URL(value);
  if (!link.searchParams.getAll('xt').some(value =>
    /^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i.test(value))) {
    throw new Error('video.error.torrent_invalid');
  }
  if (!canOpenTorrent()) throw new Error('video.error.torrent_unsupported');

  let client;
  let url;
  const close = () => {
    if (url) {
      files.delete(url);
      if (!files.size) navigator.serviceWorker.removeEventListener('message', serveVideo);
      url = null;
    }
    if (client && !client.destroyed) client.destroy();
  };

  try {
    const { default: WebTorrent } = await withAbort(import('../../vendor/webtorrent/webtorrent.min.js'), signal);
    if (!WebTorrent.WEBRTC_SUPPORT) throw new Error('video.error.torrent_unsupported');
    const registration = await prepareWorker(signal);
    signal.throwIfAborted();
    onStatus?.('video.torrent.searching');
    client = new WebTorrent({ dht: false, lsd: false });
    const torrent = await withAbort(new Promise((resolve, reject) => {
      // O player seleciona as peças conforme pede intervalos do arquivo.
      const onError = err => reject(new Error('video.error.torrent_failed', { cause: err }));
      client.on('error', onError);
      client.add(link.href, { deselect: true, store: TorrentPieceStore, destroyStoreOnDestroy: true }, resolve)
        .on('error', onError);
    }), signal);

    const file = torrent.files.reduce((largest, candidate) => {
      if (candidate.length <= (largest?.length ?? 0) || !candidate.type.startsWith('video/')) return largest;
      return video.canPlayType(candidate.type) ? candidate : largest;
    }, null);
    if (!file) throw new Error('video.error.torrent_no_video');

    if (!files.size) navigator.serviceWorker.addEventListener('message', serveVideo);
    url = new URL('torrent-media/' + crypto.randomUUID(), registration.scope).href;
    files.set(url, file);
    onStatus?.('video.torrent.buffering');
    return { url, name: file.name, close };
  } catch (error) {
    close();
    if (error?.message?.startsWith('video.error.torrent_') || signal.aborted) throw error;
    throw new Error('video.error.torrent_failed', { cause: error });
  }
}

async function prepareWorker(signal) {
  const serviceWorker = navigator.serviceWorker;
  const registration = await withAbort(serviceWorker.register(WORKER_URL), signal);
  if (serviceWorker.controller?.scriptURL !== WORKER_URL.href) {
    let onChange;
    const controlled = new Promise(resolve => {
      onChange = () => {
        if (serviceWorker.controller?.scriptURL === WORKER_URL.href) resolve();
      };
      serviceWorker.addEventListener('controllerchange', onChange);
      onChange();
    });
    try {
      await withAbort(controlled, signal);
    } finally {
      serviceWorker.removeEventListener('controllerchange', onChange);
    }
  }
  return registration;
}

async function withAbort(promise, signal) {
  let abort;
  const cancellation = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function serveVideo(event) {
  if (event.data?.type !== 'openspeak-torrent-media' || event.source !== navigator.serviceWorker.controller) return;
  const [port] = event.ports;
  if (!port) return;
  const file = files.get(event.data.url);
  try {
    const response = file ? videoResponse(file, event.data.range, event.data.method) : { status: 404 };
    port.postMessage(response, response.body ? [response.body] : []);
  } catch {
    port.postMessage({ status: 500 });
  } finally {
    port.close();
  }
}

function videoResponse(file, range, method) {
  const size = file.length;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': file.type,
    'X-Content-Type-Options': 'nosniff',
  };
  let start = 0;
  let end = size - 1;
  if (range !== null) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match?.[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else if (match?.[2]) {
      start = Math.max(0, size - Number(match[2]));
    } else {
      start = size;
    }
    if (start > end) {
      return { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + size } };
    }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  }
  headers['Content-Length'] = String(end - start + 1);

  let body;
  if (method === 'GET') {
    // O WebTorrent trata end=0 como fim do arquivo. Limita a sondagem bytes=0-0 a um byte.
    body = file.stream({ start, end: Math.max(1, end) });
    if (end === 0) {
      body = body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk.subarray(0, 1));
          controller.terminate();
        },
      }));
    }
  }
  return { status: range === null ? 200 : 206, headers, body };
}
