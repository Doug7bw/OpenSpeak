// Espelho local do estado do servidor (canais, clientes, streams anunciados).
// Equivalente ao "ServerConnectionHandler" do TS no lado da UI.

import { EventEmitter } from './EventEmitter.js';
import { ServerConnection } from './ServerConnection.js';
import { CloudConnection } from './CloudConnection.js';
import { Capability } from './protocol.js';

export class ConnectionHandler extends EventEmitter {
  constructor() {
    super();
    this.connection = globalThis.OpenSpeakConfig?.cloudSignaling ? new CloudConnection() : new ServerConnection();
    this.serverName = '';
    this.capabilities = [];
    this.mediaCache = new Map(); // mediaTag -> mídia pesada do perfil
    this.iceServers = [];
    this.ownClid = 0;
    this.channels = new Map();
    this.clients = new Map();
    this.streams = new Map(); // streamIdentifier -> info pública
    this.#bind();
  }

  get hasStreamingP2P() {
    return this.capabilities.includes(Capability.STREAM_P2P);
  }

  get hasStreamingSFU() {
    return this.capabilities.includes(Capability.STREAM_SFU);
  }

  get hasStreamYouTube() {
    return this.capabilities.includes(Capability.STREAM_YOUTUBE);
  }

  get hasStreamAnnotations() {
    return this.capabilities.includes(Capability.STREAM_ANNOTATIONS);
  }

  get hasProfiles() {
    return this.capabilities.includes(Capability.PROFILES);
  }

  get ownClient() {
    return this.clients.get(this.ownClid) ?? null;
  }
  get serverPingMs() { return this.ownClient?.pingMs ?? null; }

  async connect(url, { nickname, uid, password, profilePassword }) {
    await this.connection.connect(url);
    const args = { nickname, uid };
    if (password) args.password = password;
    if (profilePassword) args.profilePassword = profilePassword;
    let data;
    try { data = await this.connection.sendCommand('login', args); }
    catch (err) { this.connection.disconnect(); throw err; }
    this.applyView(data);
    this.emit('connected');
    this.emit('changed');
  }

  applyView(data) {
    this.ownClid = data.clid;
    this.serverName = data.server.name;
    this.capabilities = data.server.capabilityExtensions ?? [];
    this.iceServers = data.iceServers ?? [];
    this.channels = new Map(data.channels.map(c => [c.cid, c]));
    this.clients = new Map(data.clients.map(c => [c.clid, c]));
    this.streams = new Map(data.streams.map(s => [s.streamIdentifier, s]));
  }

  disconnect() {
    this.connection.disconnect();
  }

  moveTo(cid) {
    return this.connection.sendCommand('clientmove', { cid });
  }

  /** Reclama o apelido como perfil ou troca a senha. */
  setProfilePassword(password, currentPassword = '') {
    return this.connection.sendCommand('setprofilepassword', { password, currentPassword });
  }

  updateProfile(fields) {
    return this.connection.sendCommand('updateprofile', fields);
  }

  get hasProfileMedia() {
    return this.capabilities.includes(Capability.PROFILE_MEDIA);
  }

  /** Mídia pesada de um perfil, baixada só ao abrir um card; com cache por tag. */
  async profileMedia(client) {
    if (!client?.mediaTag) return {};
    if (!this.mediaCache.has(client.mediaTag)) {
      if (this.mediaCache.size >= 32) this.mediaCache.clear();
      this.mediaCache.set(client.mediaTag, await this.connection.sendCommand('profilemedia', { clid: client.clid }));
    }
    return this.mediaCache.get(client.mediaTag);
  }

  streamsInChannel(cid) {
    return [...this.streams.values()].filter(s => s.cid === cid);
  }

  clientName(clid) {
    const client = this.clients.get(clid);
    return client ? client.displayName || client.nickname : `#${clid}`;
  }

  #bind() {
    const c = this.connection;
    c.on('reconnecting', () => { this.reconnecting = true; this.emit('reconnecting'); });
    c.on('resumed', data => {
      this.reconnecting = false;
      const changedIdentity = data.restarted || this.ownClid !== data.clid;
      for (const [id, stream] of this.streams) {
        if (changedIdentity || !data.streams.some(s => s.streamIdentifier === id)) this.emit('streamremoved', stream);
      }
      this.applyView(data);
      this.emit('changed'); this.emit('resumed');
    });
    c.on('disconnected', info => {
      this.emit('disconnected', info);
    });
    c.on('notifycliententerview', ({ client }) => {
      this.clients.set(client.clid, client);
      this.emit('changed');
    });
    c.on('notifyclientleftview', ({ clid }) => {
      this.clients.delete(clid);
      this.emit('changed');
    });
    c.on('notifyclientlatency', ({ clid, pingMs, pingUpdatedAt }) => {
      const client = this.clients.get(clid);
      if (!client) return;
      client.pingMs = Number.isFinite(pingMs) && pingMs >= 0 ? pingMs : null;
      client.pingUpdatedAt = pingUpdatedAt;
      this.emit('changed');
    });
    c.on('notifyclientmoved', ({ clid, cid }) => {
      const client = this.clients.get(clid);
      if (client) client.cid = cid;
      this.emit('changed');
      if (clid === this.ownClid) this.emit('ownchannelchanged', cid);
    });
    c.on('notifyclientupdated', ({ client }) => {
      this.clients.set(client.clid, client);
      this.emit('changed');
    });
    c.on('notifystreamstarted', ({ stream }) => {
      this.streams.set(stream.streamIdentifier, stream);
      this.emit('streamadded', stream);
      this.emit('changed');
    });
    c.on('notifystreamupdated', ({ stream }) => {
      const prev = this.streams.get(stream.streamIdentifier);
      // a miniatura chega por notificação própria; preserve-a
      if (prev && stream.thumbnail == null && stream.access === prev.access) stream.thumbnail = prev.thumbnail;
      this.streams.set(stream.streamIdentifier, stream);
      this.emit('streamupdated', stream);
      this.emit('changed');
    });
    c.on('notifystreamthumbnail', ({ streamIdentifier, thumbnail }) => {
      const s = this.streams.get(streamIdentifier);
      if (!s) return;
      s.thumbnail = thumbnail;
      this.emit('streamupdated', s);
    });
    c.on('notifystreamstopped', ({ streamIdentifier, reason }) => {
      const s = this.streams.get(streamIdentifier);
      this.streams.delete(streamIdentifier);
      if (s) this.emit('streamremoved', s, reason);
      this.emit('changed');
    });
  }
}
