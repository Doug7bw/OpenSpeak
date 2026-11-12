import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VirtualServer } from '../server/virtualServer.js';
import { LogStore, safeFileName, CLIENT_DAILY_BYTES, MAX_LINE_CHARS, MAX_LINES_PER_BATCH } from '../server/logStore.js';

const pad = n => String(n).padStart(2, '0');
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function login(server, nickname) {
  const clid = server.connect();
  const view = server.handle(clid, 'login', { nickname, uid: `uid-${nickname}` });
  return { clid, caps: view.server.capabilityExtensions };
}

test('clientlog só existe com o destino configurado (CLIENT_LOGS)', () => {
  const server = new VirtualServer({ send() {} });
  const { clid: a, caps } = login(server, 'a');
  assert.ok(!caps.includes('CLIENT_LOGS'));
  assert.throws(() => server.handle(a, 'clientlog', { lines: ['oi'] }), { code: 'unknown_command' });
});

test('clientlog grava uma linha por registro no arquivo do apelido', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'osl-'));
  const logs = new LogStore(dir);
  const server = new VirtualServer({ send() {}, clientLog: (n, c, v, l) => logs.appendClient(n, c, v, l) });
  const { clid: a, caps } = login(server, 'Jo/na:s');
  assert.ok(caps.includes('CLIENT_LOGS'));
  server.handle(a, 'clientlog', { version: '1.0.42', lines: ['primeira', 'segunda\nforjada', 3] });
  assert.throws(() => server.handle(a, 'clientlog', { lines: 'texto' }), { code: 'invalid_args' });
  assert.throws(() => server.handle(a, 'clientlog', { lines: Array(501).fill('x') }), { code: 'payload_too_large' });
  const rows = readFileSync(path.join(dir, 'clients', day(), 'Jo_na_s.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes(`[clid ${a} v1.0.42] primeira`));
  assert.ok(rows[1].endsWith('segunda forjada'));
});

test('LogStore: cota diária por cliente e limpeza dos dias velhos', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'osl-'));
  const logs = new LogStore(dir, 14);
  const big = 'a'.repeat(MAX_LINE_CHARS);
  for (let i = 0; i < 100 && logs.appendClient('x', 1, '', Array(MAX_LINES_PER_BATCH).fill(big)) > 0; i++);
  const file = path.join(dir, 'clients', day(), 'x.log');
  assert.ok(readFileSync(file).length <= CLIENT_DAILY_BYTES + 1024);
  assert.equal(logs.appendClient('x', 1, '', ['mais']), 0);

  const old = new Date(); old.setDate(old.getDate() - 20);
  mkdirSync(path.join(dir, 'clients', day(old)), { recursive: true });
  writeFileSync(path.join(dir, `server-${day(old)}.log`), '');
  logs.appendServer('linha do servidor');
  logs.prune();
  assert.ok(!existsSync(path.join(dir, `server-${day(old)}.log`)));
  assert.ok(!existsSync(path.join(dir, 'clients', day(old))));
  assert.ok(existsSync(file));
  assert.ok(existsSync(path.join(dir, `server-${day()}.log`)));
  assert.equal(safeFileName('..'), 'sem-nome');
});
