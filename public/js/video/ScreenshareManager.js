// Orquestrador central (com::teamspeak::video::ScreenshareManager).
//
// - Streams próprios: captura compartilhada + uma SessionOutbound por espectador
//   (P2P) ou uma só, com o servidor (SFU, clid 0), que repassa aos espectadores.
// - Streams assistidos: uma SessionInbound por stream.
// - Pedidos de entrada, privacidade, limite de espectadores, kick/ban.
// - Roteia `notifystreamsignaling` para a sessão correta.

import { EventEmitter } from '../core/EventEmitter.js';
import { StreamAccess, StreamMode, StreamType, LeaveReason, Severity, RELAY_CLID } from '../core/protocol.js';
import { SharedVideoSource } from './SharedVideoSource.js';
import { SessionOutbound } from './SessionOutbound.js';
import { SessionInbound } from './SessionInbound.js';
import { SessionState } from './StreamBase.js';
import { StatsCollector } from './StatsCollector.js';
import { localDecodeCodecs } from './codecs.js';

const THUMBNAIL_INTERVAL_MS = 10_000;
const EARLY_SIGNAL_TTL_MS = 5_000;

export const InboundStatus = Object.freeze({
  WAITING: 'waiting', // aguardando o transmissor aceitar
  CONNECTING: 'connecting',
  PLAYING: 'playing',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

const JOIN_ERROR_KEYS = {
  banned: 'video.join.error.banned',
  viewer_limit: 'video.join.error.viewer_limit',
  not_in_channel: 'video.join.error.not_in_channel',
  stream_not_found: 'video.join.error.stream_gone',
};

export class ScreenshareManager extends EventEmitter {
  /**
   * @param {import('../core/ConnectionHandler.js').ConnectionHandler} handler
   * @param {{ contacts: { has(uid:string):boolean }, settings: { preferredCodec:string } }} deps
   */
  constructor(handler, { contacts, settings }) {
    super();
    this.handler = handler;
    this.connection = handler.connection;
    this.contacts = contacts;
    this.settings = settings;
    this.ownStreams = new Map(); // streamIdentifier -> OwnStream
    this.inbound = new Map(); // streamIdentifier -> InboundStream
    this._earlySignals = new Map();
    this.#bind();
  }

  get isSupported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices);
  }

  get canCaptureScreen() {
    return !!navigator.mediaDevices?.getDisplayMedia;
  }

  // ===================================================== streams próprios

  /**
   * Abre a fonte e anuncia o stream (setupstream).
   * @param {{config:object, quality:object, source?:SharedVideoSource, deviceId?:string}} o
   */
  async startStream({ config, quality, source }) {
    // Com relay, toda transmissão vai pelo servidor (SFU): o P2P está desativado
    // e fora da interface. Sem relay (servidor Node/sala web), P2P é o único modo.
    const sfu = this.handler.hasStreamingSFU;
    config = { ...config, mode: sfu ? StreamMode.SFU : StreamMode.P2P };
    if (!sfu && !this.handler.hasStreamingP2P) {
      source?.stop();
      throw new Error('streaming_not_supported_by_server');
    }
    source ??= await SharedVideoSource.open({ type: config.type, audio: config.audio, quality });
    const paused = source.type === StreamType.FILE;
    let streamIdentifier;
    try {
      if (paused) {
        if (!source.active || source.fileVideo.error) throw new Error('video.error.file_unplayable');
        await source.setPaused(true);
      }
      ({ streamIdentifier } = await this.connection.sendCommand('setupstream', {
        ...this.#wireConfig(config),
        type: source.type,
        ...(paused ? { paused } : {}),
        quality: { width: quality.width, height: quality.height, fps: quality.fps },
      }));
    } catch (err) {
      source.stop();
      throw err;
    }
    const own = {
      streamIdentifier,
      config: { ...config, type: source.type },
      quality: { ...quality },
      source,
      sessions: new Map(),
      joinRequests: new Map(),
      viewers: new Set(),
      banned: new Set(),
      paused,
      thumbTimer: null,
    };
    this.ownStreams.set(streamIdentifier, own);
    source.on('ended', () => this.stopStream(streamIdentifier).catch(() => {}));
    // SFU: um único envio, para o servidor, que repassa aos espectadores.
    if (sfu) this.#addOutbound(own, RELAY_CLID, ['video/H264']);
    this.#scheduleThumbnails(own);
    this.emit('ownstreamstarted', own);
    this.emit('changed');
    return own;
  }

  async startYouTube({ config, quality, youtube }) {
    if (!this.handler.hasStreamYouTube) throw new Error('video.youtube.unsupported');
    if (this.#youtubeInUse()) throw new Error('video.youtube.in_use');
    this.openingYouTube = true;
    try {
      config = { ...config, type: StreamType.YOUTUBE, mode: StreamMode.NONE, audio: true };
      const { streamIdentifier } = await this.connection.sendCommand('setupstream', { ...this.#wireConfig(config), ...youtube });
      const own = {
        streamIdentifier, config, quality, source: null, youtube: { ...youtube, rate: 1, playing: false },
        sessions: new Map(), joinRequests: new Map(), viewers: new Set(), banned: new Set(), paused: true,
      };
      this.ownStreams.set(streamIdentifier, own);
      this.emit('ownstreamstarted', own);
      this.emit('changed');
      return own;
    } finally {
      this.openingYouTube = false;
    }
  }

  #youtubeInUse() {
    return this.openingYouTube || [...this.ownStreams.values()].some(own => own.youtube)
      || [...this.inbound.values()].some(view => view.type === StreamType.YOUTUBE && view.status !== InboundStatus.ERROR);
  }

  publishYouTube(streamIdentifier, state) {
    if (!this.ownStreams.get(streamIdentifier)?.youtube) return Promise.resolve();
    return this.connection.sendCommand('streamyoutube', { streamIdentifier, ...state });
  }

  async updateStream(streamIdentifier, { config, quality }) {
    const own = this.#own(streamIdentifier);
    // O modo não muda com o stream no ar.
    if (config) own.config = { ...own.config, ...config, mode: own.config.mode };
    if (quality) {
      own.quality = { ...own.quality, ...quality };
      await own.source?.applyQuality(own.quality);
    }
    for (const { session } of own.sessions.values()) {
      session.applyEncoding({ bitrate: own.config.bitrate, audioBitrate: own.quality.audioBitrate, quality: own.quality });
    }
    await this.connection.sendCommand('updatestream', {
      streamIdentifier,
      ...this.#wireConfig(own.config),
      quality: { width: own.quality.width, height: own.quality.height, fps: own.quality.fps },
    });
    this.#scheduleThumbnails(own);
    // Uma mudança para "público" libera pedidos pendentes.
    for (const req of [...own.joinRequests.values()]) this.#maybeAutoAccept(own, req);
    this.emit('changed');
  }

  /** Troca a captura de um stream ativo sem renegociar com os espectadores. */
  async changeSource(streamIdentifier, next) {
    let own;
    try {
      own = this.#own(streamIdentifier);
      await next.applyQuality(own.quality);
      if (!own.paused && next.fileVideo) await next.playFile();
      if (!this.ownStreams.has(streamIdentifier)) throw new Error('stream_not_found');
      if (next.fileVideo && (!next.active || next.fileVideo.error)) throw new Error('video.error.file_unplayable');
    } catch (err) {
      next.stop();
      throw err;
    }
    own.source.replaceWith(next);
    own.config.type = own.source.type;
    await this.connection.sendCommand('updatestream', { streamIdentifier, type: own.source.type });
    this.emit('changed');
  }

  async setPaused(streamIdentifier, paused) {
    const own = this.#own(streamIdentifier);
    await own.source.setPaused(paused);
    if (!this.ownStreams.has(streamIdentifier)) return;
    own.paused = paused;
    await this.connection.sendCommand('updatestream', { streamIdentifier, paused });
    this.emit('changed');
  }

  async stopStream(streamIdentifier) {
    const own = this.ownStreams.get(streamIdentifier);
    if (!own) return;
    this.#disposeOwn(own);
    try {
      await this.connection.sendCommand('stopstream', { streamIdentifier });
    } catch (err) {
      if (err.returnCode !== 'stream_not_found') throw err;
    }
  }

  async respondJoinRequest(streamIdentifier, clid, { accept, ban = false }) {
    const own = this.#own(streamIdentifier);
    if (accept && this.#viewerLimitReached(own)) throw new Error('viewer_limit_reached');
    own.joinRequests.delete(clid);
    this.emit('changed');
    await this.connection.sendCommand('respondjoinstreamrequest', { streamIdentifier, clid, accept, ban });
  }

  async removeViewer(streamIdentifier, clid, { ban = false } = {}) {
    await this.connection.sendCommand('removeclientfromstream', {
      streamIdentifier, clid, reason: ban ? LeaveReason.BANNED : LeaveReason.KICKED,
    });
  }

  async unban(streamIdentifier, uid) {
    await this.connection.sendCommand('streamunban', { streamIdentifier, uid });
  }

  // ===================================================== streams assistidos

  async joinStream(streamIdentifier) {
    const info = this.handler.streams.get(streamIdentifier);
    if (!info) throw new Error('stream_not_found');
    const existing = this.inbound.get(streamIdentifier);
    if (existing && existing.status !== InboundStatus.ERROR) return existing;
    if (info.type === StreamType.YOUTUBE) {
      if (!this.handler.hasStreamYouTube) throw new Error('video.youtube.unsupported');
      if (this.#youtubeInUse()) throw new Error('video.youtube.in_use');
    }
    if (existing) this.#disposeInbound(existing);
    const view = {
      streamIdentifier,
      type: info.type,
      ownerClid: info.ownerClid,
      peerClid: info.ownerClid,
      status: InboundStatus.WAITING,
      error: null,
      session: null,
      stats: null,
      // Simulcast (SFU nativo): camada que o servidor manda e a escolha do usuário.
      simulcast: false,
      layer: 'high',
      qualityPreference: 'auto',
    };
    this.inbound.set(streamIdentifier, view);
    this.emit('changed');
    try {
      const args = info.type === StreamType.YOUTUBE ? { youtube: true } : { codecs: localDecodeCodecs() };
      await this.connection.sendCommand('joinstreamrequest', { streamIdentifier, ...args });
    } catch (err) {
      this.#setInboundError(view, JOIN_ERROR_KEYS[err.returnCode] ?? 'video.join.error.generic', { reason: err.message });
    }
    return view;
  }

  /** Abortar pedido pendente ou sair de um stream. */
  async leaveStream(streamIdentifier) {
    const view = this.inbound.get(streamIdentifier);
    if (!view) return;
    const wasActive = view.status !== InboundStatus.ERROR;
    this.#disposeInbound(view);
    this.inbound.delete(streamIdentifier);
    this.emit('changed');
    if (wasActive && this.handler.streams.has(streamIdentifier)) {
      await this.connection.sendCommand('removeclientfromstream', { streamIdentifier }).catch(() => {});
    }
  }

  dismissInbound(streamIdentifier) {
    const view = this.inbound.get(streamIdentifier);
    if (view?.status === InboundStatus.ERROR) {
      this.inbound.delete(streamIdentifier);
      this.emit('changed');
    }
  }

  // ============================================================ consultas

  /** Pior severidade entre os espectadores de um stream próprio. */
  ownStreamSeverity(own) {
    let worst = Severity.OK;
    for (const { stats } of own.sessions.values()) worst = Math.max(worst, stats.worstSeverity);
    return worst;
  }

  // ============================================================ internos

  #bind() {
    const c = this.connection;
    c.on('notifyjoinstreamrequest', a => this.#onJoinRequest(a));
    c.on('notifystreamclientjoined', a => this.#onClientJoined(a));
    c.on('notifystreamclientleft', a => this.#onClientLeft(a));
    c.on('notifystreamattendees', a => this.#onAttendees(a));
    c.on('notifyrespondjoinstreamrequest', a => this.#onJoinResponse(a));
    c.on('notifystreamsignaling', a => this.#onSignaling(a));
    c.on('notifystreamannotation', annotation => this.emit('annotation', annotation));
    c.on('notifystreamyoutube', ({ streamIdentifier, youtube }) => this.#updateYouTube(streamIdentifier, youtube));
    this.handler.on('resumed', () => {
      for (const [streamIdentifier, view] of this.inbound) {
        if (!view.youtube) continue;
        c.sendCommand('getstreamyoutube', { streamIdentifier })
          .then(({ youtube }) => this.#updateYouTube(streamIdentifier, youtube)).catch(() => {});
      }
    });
    c.on('notifystreambanadded', ({ streamIdentifier, uid }) => {
      this.ownStreams.get(streamIdentifier)?.banned.add(uid);
      this.emit('changed');
    });
    c.on('notifystreambanremoved', ({ streamIdentifier, uid }) => {
      this.ownStreams.get(streamIdentifier)?.banned.delete(uid);
      this.emit('changed');
    });
    this.handler.on('streamremoved', stream => {
      const own = this.ownStreams.get(stream.streamIdentifier);
      if (own) this.#disposeOwn(own);
      const view = this.inbound.get(stream.streamIdentifier);
      if (view) {
        this.#disposeInbound(view);
        this.inbound.delete(stream.streamIdentifier);
        this.emit('changed');
      }
    });
    this.handler.on('disconnected', () => this.dispose());
  }

  #onJoinRequest({ streamIdentifier, clid, nickname, uid, codecs }) {
    const own = this.ownStreams.get(streamIdentifier);
    if (!own) return;
    const req = { clid, nickname, uid, codecs, since: Date.now() };
    own.joinRequests.set(clid, req);
    if (!this.#maybeAutoAccept(own, req)) {
      this.emit('joinrequest', own, req);
      this.emit('changed');
    }
  }

  /** Privacidade: Público aceita todos; Contatos aceita contatos; Privado pergunta. */
  #maybeAutoAccept(own, req) {
    const auto = own.config.access === StreamAccess.PUBLIC
      || (own.config.access === StreamAccess.CONTACTS_ONLY && this.contacts.has(req.uid));
    if (!auto || this.#viewerLimitReached(own)) return false;
    this.respondJoinRequest(own.streamIdentifier, req.clid, { accept: true }).catch(err => {
      console.warn('[screenshare] aceite automático falhou', err);
    });
    return true;
  }

  annotationContext(streamIdentifier) {
    if (!this.handler.hasStreamAnnotations) return null;
    const own = this.ownStreams.get(streamIdentifier);
    const view = this.inbound.get(streamIdentifier);
    if (own?.youtube || view?.youtube) return null;
    if (!own && view?.status !== InboundStatus.PLAYING && view?.status !== InboundStatus.RECONNECTING) return null;

    const clid = this.handler.ownClid;
    const owner = own ? clid : view.ownerClid;
    const viewers = own ? own.viewers : (view.attendees ?? []);
    const participants = new Map([owner, ...viewers].map(id => [id, this.handler.clientName(id)]));
    return { streamIdentifier, self: { clid, name: this.handler.clientName(clid) }, participants };
  }

  sendAnnotation(streamIdentifier, { strokeId, points }) {
    if (!this.handler.hasStreamAnnotations || this.handler.reconnecting) return;
    this.connection.sendCommand('streamannotation', { streamIdentifier, strokeId, points }).catch(() => {});
  }

  /**
   * Apelidos de quem assiste: nas minhas transmissões e nas que estou assistindo
   * (o servidor manda a lista aos espectadores); null se não sei.
   */
  viewerNames(streamIdentifier) {
    const own = this.ownStreams.get(streamIdentifier);
    const clids = own ? [...own.viewers].sort((a, b) => a - b) : this.inbound.get(streamIdentifier)?.attendees;
    if (!clids) return null;
    return clids.map(clid => this.handler.clientName(clid) + (clid === this.handler.ownClid ? ' (você)' : ''));
  }

  /** Streams que estou assistindo ou pedindo para assistir (sem os com erro). */
  watchedStreams() {
    return [...this.inbound.values()].filter(v => v.status !== InboundStatus.ERROR).map(v => v.streamIdentifier);
  }

  #viewerLimitReached(own) {
    return own.config.viewerLimit > 0 && own.viewers.size >= own.config.viewerLimit;
  }

  async #onClientJoined({ streamIdentifier, clid, codecs }) {
    const own = this.ownStreams.get(streamIdentifier);
    if (!own) return;
    own.viewers.add(clid);
    if (own.youtube) {
      this.emit('changed');
      return;
    }
    if (own.config.mode === StreamMode.SFU) {
      // A mídia sai pelo relay do servidor; aqui só a lista de espectadores.
      this.emit('changed');
      return;
    }
    console.info(`[screenshare] ResolveJoinRequest - adicionando espectador ${clid} ao stream ${streamIdentifier}`);
    await this.#addOutbound(own, clid, codecs);
  }

  /** Sessão de saída para um espectador (P2P) ou para o servidor (SFU, peerClid 0). */
  async #addOutbound(own, peerClid, codecs) {
    const { streamIdentifier } = own;
    const relay = peerClid === RELAY_CLID;
    own.sessions.get(peerClid)?.session.close();
    const session = new SessionOutbound({
      streamIdentifier,
      peerClid,
      iceServers: this.handler.iceServers,
      sendSignaling: payload => this.connection.sendCommand('streamsignaling', { streamIdentifier, clid: peerClid, payload }),
      source: own.source,
      remoteCodecs: codecs,
      // SFU: codec fixo (H.264) e uma camada só; o servidor repassa sem transcodificar.
      preferredCodec: relay ? 'video/H264' : this.settings.preferredCodec,
      scalability: !relay,
      encoding: { bitrate: own.config.bitrate, audioBitrate: own.quality.audioBitrate, quality: own.quality },
    });
    const stats = new StatsCollector(session, () => own.quality);
    own.sessions.set(peerClid, { session, stats });
    session.on('statechange', () => this.emit('changed'));
    session.on('failed', () => {
      if (relay) {
        // Sem o servidor não há para quem transmitir: encerra o stream.
        this.emit('error', 'video.error.sfu_connection_lost');
        this.stopStream(streamIdentifier).catch(() => {});
        return;
      }
      // SessionOutbound::OnConnectionStatusChanged -> RemoveOutboundStream
      this.connection.sendCommand('removeclientfromstream', { streamIdentifier, clid: peerClid, reason: LeaveReason.FAILED }).catch(() => {});
    });
    stats.on('stats', () => this.emit('stats', streamIdentifier));
    try {
      await session.start();
      stats.start();
    } catch (err) {
      console.error('[screenshare] falha ao iniciar sessão de saída', err);
      session.fail(err);
    }
    this.emit('changed');
  }

  #onClientLeft({ streamIdentifier, clid, reason, wasPending }) {
    const own = this.ownStreams.get(streamIdentifier);
    if (own) {
      own.joinRequests.delete(clid);
      own.viewers.delete(clid);
      const entry = own.sessions.get(clid);
      if (entry) {
        entry.stats.stop();
        entry.session.close();
        own.sessions.delete(clid);
      }
      this.emit('changed');
      return;
    }
    if (clid !== this.handler.ownClid) return;
    const view = this.inbound.get(streamIdentifier);
    if (!view || view.status === InboundStatus.ERROR) return;
    if (reason === LeaveReason.KICKED) this.#setInboundError(view, 'video.join.error.kicked');
    else if (reason === LeaveReason.BANNED) this.#setInboundError(view, 'video.join.error.banned');
    else if (reason === LeaveReason.FAILED) this.#setInboundError(view, 'video.join.error.connection_lost');
    else if (!wasPending) {
      this.#disposeInbound(view);
      this.inbound.delete(streamIdentifier);
      this.emit('changed');
    }
  }

  #onAttendees({ streamIdentifier, viewers }) {
    const own = this.ownStreams.get(streamIdentifier);
    if (own) {
      own.viewers = new Set(viewers);
      this.emit('changed');
    }
    // Espectadores também recebem a lista de quem assiste junto.
    const view = this.inbound.get(streamIdentifier);
    if (view) {
      view.attendees = [...viewers];
      this.emit('changed');
    }
  }

  #updateYouTube(streamIdentifier, youtube) {
    const view = this.inbound.get(streamIdentifier);
    if (!view?.youtube || view.status !== InboundStatus.PLAYING) return;
    view.youtube = youtube;
    this.emit('changed');
  }

  #onJoinResponse({ streamIdentifier, accepted, reason, peerClid, youtube }) {
    const view = this.inbound.get(streamIdentifier);
    if (!view) return;
    if (!accepted) {
      this.#setInboundError(view, reason === LeaveReason.BANNED ? 'video.join.error.banned' : 'video.join.error.denied');
      return;
    }
    if (view.type === StreamType.YOUTUBE) {
      if (!youtube) {
        this.#setInboundError(view, 'video.youtube.unavailable');
        return;
      }
      view.youtube = youtube;
      view.status = InboundStatus.PLAYING;
      this.emit('changed');
      return;
    }
    view.status = InboundStatus.CONNECTING;
    // P2P: negocia com o dono; SFU: com o servidor (0). Servidores antigos não mandam peerClid.
    view.peerClid = peerClid ?? view.ownerClid;
    const session = new SessionInbound({
      streamIdentifier,
      peerClid: view.peerClid,
      iceServers: this.handler.iceServers,
      sendSignaling: payload => this.connection.sendCommand('streamsignaling', { streamIdentifier, clid: view.peerClid, payload }),
    });
    view.session = session;
    view.stats = new StatsCollector(session, () => this.handler.streams.get(streamIdentifier)?.quality ?? null);
    view.stats.on('stats', () => this.emit('stats', streamIdentifier));
    session.on('statechange', state => {
      if (state === SessionState.CONNECTED) view.status = InboundStatus.PLAYING;
      else if (state === SessionState.RECONNECTING) view.status = InboundStatus.RECONNECTING;
      this.emit('changed');
    });
    session.on('track', () => this.emit('changed'));
    session.on('failed', () => {
      this.#setInboundError(view, 'video.join.error.connection_lost');
      this.connection.sendCommand('removeclientfromstream', { streamIdentifier }).catch(() => {});
    });
    session.start();
    view.stats.start();
    for (const payload of this.#takeEarlySignals(streamIdentifier)) session.onSignalingMessage(payload);
    if (view.peerClid === RELAY_CLID && view.qualityPreference !== 'auto') this.#sendQualityPreference(view);
    this.emit('changed');
  }

  /** Qualidade de um stream assistido no SFU com simulcast: 'auto' | 'high' | 'low'. */
  setQualityPreference(streamIdentifier, preference) {
    const view = this.inbound.get(streamIdentifier);
    if (!view) return;
    const pref = preference === 'high' || preference === 'low' ? preference : 'auto';
    if (view.qualityPreference === pref) return;
    view.qualityPreference = pref;
    if (view.session && view.peerClid === RELAY_CLID) this.#sendQualityPreference(view);
    this.emit('changed');
  }

  #sendQualityPreference(view) {
    this.connection.sendCommand('streamsignaling', {
      streamIdentifier: view.streamIdentifier, clid: RELAY_CLID, payload: { type: 'layer', preference: view.qualityPreference },
    }).catch(() => {});
  }

  #onSignaling({ streamIdentifier, clid, payload }) {
    const own = this.ownStreams.get(streamIdentifier);
    if (own) {
      own.sessions.get(clid)?.session.onSignalingMessage(payload);
      return;
    }
    const view = this.inbound.get(streamIdentifier);
    if (view && clid === RELAY_CLID && payload?.type === 'layer') {
      // Camada do simulcast que o servidor está mandando (pode chegar antes da resposta de entrada).
      view.simulcast = !!payload.simulcast;
      view.layer = payload.layer === 'low' ? 'low' : 'high';
      this.emit('changed');
      return;
    }
    if (view?.session) {
      if (clid === view.peerClid) view.session.onSignalingMessage(payload);
      return;
    }
    // Oferta chegou antes da resposta de entrada ser processada: guarda.
    const list = this._earlySignals.get(streamIdentifier) ?? [];
    list.push({ payload, at: Date.now() });
    this._earlySignals.set(streamIdentifier, list);
  }

  #takeEarlySignals(streamIdentifier) {
    const list = this._earlySignals.get(streamIdentifier) ?? [];
    this._earlySignals.delete(streamIdentifier);
    const now = Date.now();
    return list.filter(e => now - e.at < EARLY_SIGNAL_TTL_MS).map(e => e.payload);
  }

  #setInboundError(view, key, params = {}) {
    if (view.session) {
      view.stats?.stop();
      view.session.close();
      view.session = null;
    }
    view.status = InboundStatus.ERROR;
    view.error = { key, params };
    this.emit('changed');
  }

  #scheduleThumbnails(own) {
    clearInterval(own.thumbTimer);
    own.thumbTimer = null;
    if (!own.source || own.config.access !== StreamAccess.PUBLIC) return;
    const publish = async () => {
      if (own.paused || !this.ownStreams.has(own.streamIdentifier)) return;
      const thumbnail = await own.source.captureThumbnail();
      if (!thumbnail) return;
      this.connection.sendCommand('streamthumbnail', { streamIdentifier: own.streamIdentifier, thumbnail }).catch(() => {});
    };
    setTimeout(publish, 1500);
    own.thumbTimer = setInterval(publish, THUMBNAIL_INTERVAL_MS);
  }

  #wireConfig(config) {
    return {
      name: config.name,
      type: config.type,
      access: config.access,
      mode: config.mode,
      bitrate: config.bitrate,
      viewerLimit: config.viewerLimit,
      audio: config.audio,
      announce: config.announce !== false,
    };
  }

  #own(streamIdentifier) {
    const own = this.ownStreams.get(streamIdentifier);
    if (!own) throw new Error('stream_not_found');
    return own;
  }

  #disposeOwn(own) {
    if (!this.ownStreams.has(own.streamIdentifier)) return;
    clearInterval(own.thumbTimer);
    for (const { session, stats } of own.sessions.values()) {
      stats.stop();
      session.close();
    }
    own.sessions.clear();
    own.source?.stop();
    this.ownStreams.delete(own.streamIdentifier);
    this.emit('ownstreamstopped', own);
    this.emit('changed');
  }

  #disposeInbound(view) {
    view.stats?.stop();
    view.session?.close();
    view.session = null;
  }

  dispose() {
    for (const own of [...this.ownStreams.values()]) this.#disposeOwn(own);
    for (const view of this.inbound.values()) this.#disposeInbound(view);
    this.inbound.clear();
    this.emit('changed');
  }
}
