// Registros (logs) guardados no servidor, iguais ao native/server/LogStore.cpp:
//   <pasta>/server-AAAA-MM-DD.log              o que o próprio servidor registrou
//   <pasta>/clients/AAAA-MM-DD/<apelido>.log   o que cada cliente mandou (`clientlog`)
// Um arquivo por dia; os mais velhos que `keepDays` são apagados. Cota diária por cliente.
import fs from 'node:fs';
import path from 'node:path';

export const CLIENT_DAILY_BYTES = 8 * 1024 * 1024;
export const MAX_LINES_PER_BATCH = 500;
export const MAX_LINE_CHARS = 4000;

const pad = (n, w = 2) => String(n).padStart(w, '0');
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d = new Date()) =>
  `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

// Uma linha por registro: quebras e caracteres de controle viram espaço.
function oneLine(text, maxChars) {
  let s = String(text);
  if (s.length > maxChars) s = `${s.slice(0, maxChars)} […]`;
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export function safeFileName(nickname) {
  let s = String(nickname ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '_').trim().replace(/^\.+/, '');
  return (s || 'sem-nome').slice(0, 48);
}

export class LogStore {
  #used = new Map();
  #usedDay = '';
  #pruned = '';

  constructor(dir, keepDays = 14) {
    this.dir = dir;
    this.keepDays = keepDays;
    fs.mkdirSync(dir, { recursive: true });
  }

  appendServer(line) {
    try {
      fs.appendFileSync(path.join(this.dir, `server-${day()}.log`), `${stamp()} ${oneLine(line, MAX_LINE_CHARS * 4)}\n`);
    } catch { /* disco cheio etc.: o console continua */ }
  }

  /** Devolve quantas linhas foram gravadas. */
  appendClient(nickname, clid, version, lines) {
    const today = day();
    if (this.#usedDay !== today) { this.#used.clear(); this.#usedDay = today; }
    const dayDir = path.join(this.dir, 'clients', today);
    const file = path.join(dayDir, `${safeFileName(nickname)}.log`);
    try {
      fs.mkdirSync(dayDir, { recursive: true });
      let used = this.#used.get(file);
      if (used === undefined) used = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (used >= CLIENT_DAILY_BYTES) return 0;
      const prefix = `${stamp()} [clid ${clid}${version ? ` v${oneLine(version, 32)}` : ''}] `;
      let out = '';
      let written = 0;
      for (const line of lines.slice(0, MAX_LINES_PER_BATCH)) {
        const row = `${prefix}${oneLine(line, MAX_LINE_CHARS)}\n`;
        if (used + Buffer.byteLength(out) + Buffer.byteLength(row) > CLIENT_DAILY_BYTES) {
          out += `${prefix}(cota diária de registros atingida; o resto de hoje foi descartado)\n`;
          fs.appendFileSync(file, out);
          this.#used.set(file, CLIENT_DAILY_BYTES);
          return written;
        }
        out += row;
        written++;
      }
      fs.appendFileSync(file, out);
      this.#used.set(file, used + Buffer.byteLength(out));
      return written;
    } catch {
      return 0;
    }
  }

  prune() {
    const today = day();
    if (this.#pruned === today) return;
    this.#pruned = today;
    const oldest = new Date();
    oldest.setDate(oldest.getDate() - this.keepDays);
    const limit = day(oldest);
    const tooOld = (name) => { const m = /(\d{4}-\d{2}-\d{2})/.exec(name); return m && m[1] < limit; };
    try {
      for (const f of fs.readdirSync(this.dir))
        if (/^server-.*\.log$/.test(f) && tooOld(f)) fs.rmSync(path.join(this.dir, f), { force: true });
      const clients = path.join(this.dir, 'clients');
      if (fs.existsSync(clients))
        for (const d of fs.readdirSync(clients))
          if (tooOld(d)) fs.rmSync(path.join(clients, d), { recursive: true, force: true });
    } catch { /* tenta de novo amanhã */ }
  }
}
