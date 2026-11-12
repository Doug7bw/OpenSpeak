import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { VirtualServer, CommandError } from './virtualServer.js';

export const SESSION_GRACE_MS = 90_000;
export const MAX_ROOM_CLIENTS = 32;
// A kick blocks fresh logins briefly so the client's automatic re-login is refused.
export const KICK_COOLDOWN_MS = 60_000;
const MAX_BANS = 200;
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(24).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const reject = (code, message) => { throw new CommandError(code, message); };
// Only a salted hash of the address is stored or shown in the admin panel.
export const hashIp = ip => (ip ? digest(`openspeak-ip:${ip}`).slice(0, 16) : '');
const newPolicy = () => ({ locked: false, bans: [] });

// GET + atomic compare/commit/publish. No instance owns a room; reconnects can
// land anywhere, and concurrent commands retry against the latest snapshot.
export class CloudRoom {
  constructor(store, now = Date.now) {
    this.store = store;
    this.now = now;
  }

  async #transact(mutate) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = await this.store.read();
      const state = before ? JSON.parse(before) : { sessions: {}, revision: 0 };
      const events = [];
      // Traços ao vivo excedem a frequência de comandos da sala com Redis.
      const room = new VirtualServer({ name: 'OpenSpeak • Sala web', iceServers: [], streamAnnotations: false, idPrefix: `${secret()}-`,
        send: (clid, message) => events.push({ clid, message }) });
      room.restore(state.room);
      for (const [clid, entry] of Object.entries(state.sessions)) {
        if (entry.until < this.now()) {
          room.disconnect(Number(clid));
          delete state.sessions[clid];
        }
      }
      const result = mutate(state, room, events);
      state.room = room.snapshot();
      state.revision++;
      if (await this.store.commit(before, JSON.stringify(state), events)) return result;
    }
    reject('busy', 'Sala ocupada. Tente novamente.');
  }

  async #policy() {
    const raw = await this.store.readPolicy();
    const policy = raw ? JSON.parse(raw) : newPolicy();
    policy.bans = policy.bans.filter(b => b.until === null || b.until > this.now());
    return { raw, policy };
  }

  async #updatePolicy(mutate) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { raw, policy } = await this.#policy();
      const result = mutate(policy);
      if (await this.store.commitPolicy(raw, JSON.stringify(policy))) return result;
    }
    reject('busy', 'Sala ocupada. Tente novamente.');
  }

  async execute(session, cmd, args = {}, meta = {}) {
    const fresh = cmd === 'login' && !args.resumeToken;
    const { policy } = fresh ? await this.#policy() : {};
    return this.#transact((state, room) => {
      let current = { ...session }, data;
      if (cmd === 'login') {
        const entry = state.sessions[args.resumeClid];
        if (args.resumeToken) {
          if (!entry || !equal(digest(args.resumeToken), entry.tokenHash))
            reject('session_expired', 'A sessão expirou. Conecte novamente.');
          current = { clid: Number(args.resumeClid), token: args.resumeToken, lease: secret() };
          entry.lease = current.lease;
          entry.until = this.now() + SESSION_GRACE_MS;
          data = { ...room.view(current.clid), resumed: true };
        } else {
          // Kicked/banned/locked use access_denied: web and native clients stop retrying on it.
          const ipHash = hashIp(meta.ip);
          const ban = policy.bans.find(b => (b.uid && b.uid === args.uid) || (b.ipHash && b.ipHash === ipHash));
          if (ban) reject('access_denied', ban.kind === 'kick'
            ? 'Você foi removido da sala. Tente novamente em instantes.' : 'Você está banido desta sala.');
          if (policy.locked) reject('access_denied', 'A sala está trancada pelo administrador.');
          if (room.clients.size >= MAX_ROOM_CLIENTS) reject('room_full', `Sala cheia (${MAX_ROOM_CLIENTS} participantes).`);
          current = { clid: room.connect(), token: secret(), lease: secret() };
          data = room.handle(current.clid, 'login', args);
          state.sessions[current.clid] = { tokenHash: digest(current.token), lease: current.lease,
            until: this.now() + SESSION_GRACE_MS, ipHash, since: this.now() };
        }
        data.resumeToken = current.token;
        data.tailscaleOnly = true;
      } else {
        const entry = state.sessions[current.clid];
        if (!entry || entry.lease !== current.lease || !equal(digest(current.token || ''), entry.tokenHash))
          reject('session_expired', 'A sessão expirou. Conecte novamente.');
        entry.until = this.now() + SESSION_GRACE_MS;
        if (cmd === 'logout') {
          room.disconnect(current.clid);
          delete state.sessions[current.clid];
          data = {};
        } else if (cmd === 'heartbeat' || cmd === 'sync') {
          data = cmd === 'sync' ? room.view(current.clid) : {};
        } else {
          data = room.handle(current.clid, cmd, args);
        }
      }
      return { session: current, data };
    });
  }

  // ------------------------------------------------------------------ admin

  async status() {
    const raw = await this.store.read();
    const state = raw ? JSON.parse(raw) : { sessions: {}, revision: 0 };
    const { policy } = await this.#policy();
    const room = new VirtualServer({ send: () => {} });
    room.restore(state.room);
    const now = this.now();
    const channels = Object.fromEntries([...room.channels.values()].map(c => [c.cid, c.name]));
    const streams = [...room.streams.values()];
    const clients = [...room.clients.values()].filter(c => c.loggedIn).map(c => {
      const entry = state.sessions[c.clid] ?? {};
      return { clid: c.clid, nickname: c.nickname, uid: c.uid, channel: channels[c.cid] ?? '—',
        inputMuted: c.inputMuted, outputMuted: c.outputMuted, ipHash: entry.ipHash || '',
        since: entry.since ?? null, lastSeen: entry.until ? entry.until - SESSION_GRACE_MS : null,
        expired: !entry.until || entry.until < now,
        streams: streams.filter(s => s.ownerClid === c.clid).map(s => ({ name: s.name, viewers: s.viewers.size })) };
    }).filter(c => !c.expired);
    return { revision: state.revision, maxClients: MAX_ROOM_CLIENTS, graceMs: SESSION_GRACE_MS, clients,
      streams: streams.length, locked: policy.locked,
      bans: policy.bans.filter(b => b.kind === 'ban') };
  }

  /** Kick (minutes = 0) or ban (minutes > 0, null = permanent); the socket is closed through the event channel. */
  async kick(clid, { minutes = 0, reason = '' } = {}) {
    const target = await this.#transact((state, room, events) => {
      const client = room.clients.get(Number(clid));
      if (!client?.loggedIn) reject('client_not_found', 'Participante não encontrado.');
      const ipHash = state.sessions[client.clid]?.ipHash || '';
      room.disconnect(client.clid);
      delete state.sessions[client.clid];
      events.push({ clid: client.clid, message: { type: 'close', code: 4001,
        reason: minutes === 0 ? 'Removido pelo administrador' : 'Banido pelo administrador' } });
      return { clid: client.clid, nickname: client.nickname, uid: client.uid, ipHash };
    });
    // Clients wait at least 1 s before reconnecting, so the ban lands before their re-login.
    await this.#updatePolicy(policy => {
      const ban = minutes !== 0;
      policy.bans = [{ id: secret().slice(0, 12), kind: ban ? 'ban' : 'kick', uid: target.uid, ipHash: target.ipHash,
        nickname: target.nickname, reason: String(reason).slice(0, 120), created: this.now(),
        until: minutes === null ? null : this.now() + (ban ? minutes * 60_000 : KICK_COOLDOWN_MS) },
      ...policy.bans].slice(0, MAX_BANS);
    });
    return { clid: target.clid, nickname: target.nickname };
  }

  unban(id) {
    return this.#updatePolicy(policy => {
      const before = policy.bans.length;
      policy.bans = policy.bans.filter(b => b.id !== id);
      if (policy.bans.length === before) reject('not_found', 'Banimento não encontrado.');
      return {};
    });
  }

  setLocked(locked) {
    return this.#updatePolicy(policy => { policy.locked = !!locked; return { locked: policy.locked }; });
  }

  /** Drops every participant and stream but keeps bans and the lock. */
  reset() {
    return this.#transact((state, room, events) => {
      const clids = [...room.clients.keys()];
      for (const clid of clids)
        events.push({ clid, message: { type: 'close', code: 4002, reason: 'Sala reiniciada pelo administrador' } });
      const fresh = new VirtualServer({ send: () => {}, idPrefix: `${secret()}-` });
      fresh.nextClid = room.nextClid; // never hand out a clid an old socket still maps to
      room.restore(fresh.snapshot());
      state.sessions = {};
      return { disconnected: clids.length };
    });
  }
}
