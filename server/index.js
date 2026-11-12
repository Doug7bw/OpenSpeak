// Ponto de entrada: serve o cliente web (public/) e a sinalização via WebSocket (/ws).
//
// Variáveis de ambiente:
//   PORT                 porta (padrão 9988)
//   HOST                 interface (padrão 0.0.0.0)
//   OPENSPEAK_NAME       nome do servidor
//   OPENSPEAK_CERT/KEY   caminhos de certificado PEM para HTTPS (necessário para
//                        captura de tela fora de localhost)
//   OPENSPEAK_ICE        JSON com a lista de iceServers (padrão: STUN público)
//   OPENSPEAK_LIVE_WEBHOOK         URL que recebe POST do /api/live quando muda (bot do Discord)
//   OPENSPEAK_LIVE_WEBHOOK_SECRET  enviado no header X-OpenSpeak-Secret
//   OPENSPEAK_PROFILES_FILE  JSON dos perfis (padrão: ~/.openspeak/profiles.json)
//   OPENSPEAK_LOG_DIR    registros do servidor e dos clientes (padrão: ~/.openspeak/logs; "off" desliga)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { VirtualServer, CommandError } from './virtualServer.js';
import { ProfileStore } from './profileStore.js';
import { LogStore } from './logStore.js';
import { ReturnCode } from './protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT ?? 9988);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_MESSAGE_BYTES = 512 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function parseIceServers() {
  if (!process.env.OPENSPEAK_ICE) return [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    const parsed = JSON.parse(process.env.OPENSPEAK_ICE);
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    console.warn('[openspeak] OPENSPEAK_ICE inválido, usando padrão:', err.message);
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

function serveStatic(req, res) {
  // Bot do Discord: transmissões ao vivo marcadas para anunciar (só leitura).
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/live') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(server.liveSnapshot()));
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  // "/v/<versão>/..." é o mesmo arquivo (cache do proxy da atividade do Discord).
  pathname = pathname.replace(/^\/v\/[\w.-]+\//, '/');
  const file = path.resolve(ROOT, '.' + pathname);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const cert = process.env.OPENSPEAK_CERT;
const key = process.env.OPENSPEAK_KEY;
const secure = !!(cert && key);
const httpServer = secure
  ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, serveStatic)
  : http.createServer(serveStatic);

const sockets = new Map(); // clid -> ws

// Bot do Discord: avisa na hora em vez de esperar a próxima consulta ao /api/live.
const LIVE_WEBHOOK = process.env.OPENSPEAK_LIVE_WEBHOOK ?? '';
let liveTimer = null;
let lastLive = '';
function liveChanged() {
  if (!/^https?:\/\//.test(LIVE_WEBHOOK) || liveTimer) return;
  liveTimer = setTimeout(async () => { // junta mudanças seguidas num POST só
    liveTimer = null;
    const body = JSON.stringify(server.liveSnapshot());
    if (body === lastLive) return;
    lastLive = body;
    const headers = { 'content-type': 'application/json' };
    if (process.env.OPENSPEAK_LIVE_WEBHOOK_SECRET) headers['x-openspeak-secret'] = process.env.OPENSPEAK_LIVE_WEBHOOK_SECRET;
    try {
      const res = await fetch(LIVE_WEBHOOK, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastLive = ''; // a próxima mudança reenvia tudo
      console.warn('[openspeak] webhook do bot falhou:', err.message);
    }
  }, 300);
}

// Registros: o console continua igual e cada linha vai também para o arquivo do dia.
const LOG_DIR = process.env.OPENSPEAK_LOG_DIR ?? path.join(os.homedir(), '.openspeak', 'logs');
const logs = LOG_DIR.toLowerCase() === 'off' ? null : new LogStore(LOG_DIR);
const logText = (p) => {
  if (p instanceof Error) return p.stack ?? String(p);
  if (typeof p === 'string') return p;
  try { return JSON.stringify(p); } catch { return String(p); }
};
if (logs) {
  for (const [method, level] of [['log', 'I'], ['info', 'I'], ['warn', 'W'], ['error', 'C']]) {
    const original = console[method].bind(console);
    console[method] = (...parts) => {
      logs.appendServer(`${level} ${parts.map((p) => logText(p)).join(' ')}`);
      original(...parts);
    };
  }
  logs.prune();
  setInterval(() => logs.prune(), 60 * 60 * 1000).unref();
}

const server = new VirtualServer({
  clientLog: logs ? (nickname, clid, version, lines) => logs.appendClient(nickname, clid, version, lines) : null,
  name: process.env.OPENSPEAK_NAME ?? 'OpenSpeak',
  iceServers: parseIceServers(),
  onLiveChanged: liveChanged,
  profiles: new ProfileStore(process.env.OPENSPEAK_PROFILES_FILE ?? path.join(os.homedir(), '.openspeak', 'profiles.json')),
  send(clid, message) {
    const ws = sockets.get(clid);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  },
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws, req) => {
  const clid = server.connect();
  sockets.set(clid, ws);
  ws.isAlive = true;
  console.log(`[openspeak] conexão clid=${clid} de ${req.socket.remoteAddress}`);

  const ping = () => {
    ws.pingPayload = Buffer.from(String(Date.now()));
    ws.pingStarted = process.hrtime.bigint();
    ws.ping(ws.pingPayload);
  };
  ws.measurePing = ping;
  ws.on('pong', payload => {
    ws.isAlive = true;
    if (ws.pingStarted && payload.equals(ws.pingPayload)) {
      server.setClientLatency(clid, Number(process.hrtime.bigint() - ws.pingStarted) / 1e6);
      ws.pingStarted = null;
    }
  });
  ping();

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg?.type !== 'cmd' || typeof msg.cmd !== 'string') return;
    const reply = { type: 'res', id: msg.id };
    try {
      reply.data = server.handle(clid, msg.cmd, msg.args) ?? {};
      reply.return_code = ReturnCode.OK;
    } catch (err) {
      if (err instanceof CommandError) {
        reply.return_code = err.code;
        reply.error = err.message;
      } else {
        console.error(`[openspeak] erro em ${msg.cmd}:`, err);
        reply.return_code = 'internal_error';
        reply.error = 'erro interno';
      }
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
  });

  ws.on('close', () => {
    sockets.delete(clid);
    server.disconnect(clid);
    console.log(`[openspeak] desconectado clid=${clid}`);
  });
});

// Keep-alive: derruba sockets mortos para liberar streams presos.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.measurePing();
  }
}, 15_000);
wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, HOST, () => {
  const scheme = secure ? 'https' : 'http';
  console.log(`[openspeak] servidor "${server.name}" em ${scheme}://localhost:${PORT}`);
  console.log(logs ? `[openspeak] registros do servidor e dos clientes em ${logs.dir}` : '[openspeak] registros em arquivo desligados (OPENSPEAK_LOG_DIR=off)');
  if (!secure) console.log('[openspeak] dica: fora de localhost o navegador exige HTTPS para capturar tela/câmera (ver README).');
});
