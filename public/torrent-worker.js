// A URL virtual só é atendida pela aba dona do vídeo. O servidor HTTP não recebe as peças.
const mediaPath = new URL('torrent-media/', self.registration.scope).href;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const { request } = event;
  if (!request.url.startsWith(mediaPath)) return;
  if (request.destination !== 'video' || !['GET', 'HEAD'].includes(request.method)) {
    event.respondWith(new Response(null, { status: 404 }));
    return;
  }
  event.respondWith(readVideo(event));
});

async function readVideo({ request, clientId }) {
  const client = clientId ? await self.clients.get(clientId) : null;
  if (!client) return new Response(null, { status: 404 });

  const { port1, port2 } = new MessageChannel();
  let timeout;
  try {
    const response = await new Promise(resolve => {
      timeout = setTimeout(() => resolve({ status: 504 }), 5000);
      port1.onmessage = ({ data }) => resolve(data);
      client.postMessage({
        type: 'openspeak-torrent-media',
        url: request.url,
        method: request.method,
        range: request.headers.get('Range'),
      }, [port2]);
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  } finally {
    clearTimeout(timeout);
    port1.close();
  }
}
