// Servidor virtual: canais, clientes e o registro de streams.
//
// Reproduz a parte do servidor TeamSpeak que media a transmissão P2P: ele nunca
// toca em mídia, apenas guarda o estado dos streams, aplica privacidade/limites
// e encaminha a sinalização WebRTC (`streamsignaling` -> `notifystreamsignaling`)
// entre o transmissor e cada espectador.

import {
  StreamAccess, StreamMode, StreamType, LeaveReason, ReturnCode, CAPABILITIES,
  CAP_PROFILES, CAP_PROFILE_MEDIA, CAP_STREAM_ANNOTATIONS, CAP_STREAM_YOUTUBE,
  ANNOTATION_SCALE, MAX_ANNOTATION_POINTS, MAX_ANNOTATION_BATCHES_PER_SECOND,
  MAX_STREAMS_PER_CLIENT, MAX_THUMBNAIL_BYTES, MAX_SIGNALING_BYTES, MAX_AVATAR_BYTES, MAX_PROFILE_MEDIA_BYTES,
} from './protocol.js';
import { profileKey } from './profileStore.js';
import { isYouTubeVideoId, isYouTubePosition, youtubePosition } from '../public/js/video/youtube.js';

class CommandError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new CommandError(code, message); };

function currentYouTube({ updatedAt, ...state }) {
  return { ...state, position: youtubePosition(state, Date.now() - updatedAt) };
}

// Uma sala só: todos se encontram no "Geral".
export const DEFAULT_CHANNELS = [
  { name: 'Geral', description: 'Canal padrão' },
];

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Mudanças de stream (inclusive espectadores), apelido e entrada/saída de usuários (contador "online" do bot).
const LIVE_COMMANDS = new Set(['notifystreamstarted', 'notifystreamupdated', 'notifystreamstopped', 'notifyclientupdated',
  'notifycliententerview', 'notifyclientleftview']);

function cleanString(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, maxLength);
}

export class VirtualServer {
  /**
   * @param {object} options
   * @param {(clid:number, message:object) => void} options.send
   * @param {string} [options.name]
   * @param {object[]} [options.iceServers]
   * @param {() => void} [options.onLiveChanged] algo do liveSnapshot() pode ter mudado (webhook do bot)
   * @param {{name:string, description:string}[]} [options.channels] canais (padrão: só o "Geral")
   * @param {import('./profileStore.js').ProfileStore|null} [options.profiles] perfis (sem ele, servidor sem PROFILES)
   */
  constructor({ send, name = 'OpenSpeak', iceServers = [], idPrefix = '', onLiveChanged = null,
    channels = DEFAULT_CHANNELS, profiles = null, streamAnnotations = true }) {
    this.send = send;
    this.profiles = profiles;
    this.streamAnnotations = streamAnnotations;
    this.onLiveChanged = onLiveChanged;
    this.name = name;
    this.iceServers = iceServers;
    this.clients = new Map(); // clid -> client
    this.channels = new Map(); // cid -> channel
    this.streams = new Map(); // streamIdentifier -> stream
    this.nextClid = 1;
    this.nextStreamId = 1;
    this.idPrefix = idPrefix;
    let cid = 1;
    for (const ch of channels) {
      this.channels.set(cid, { cid, order: cid, ...ch });
      cid++;
    }
    this.defaultChannel = 1;
  }

  // ---------------------------------------------------------------- conexão

  connect() {
    const clid = this.nextClid++;
    this.clients.set(clid, { clid, loggedIn: false, nickname: '', uid: '', cid: 0, inputMuted: false, outputMuted: false });
    return clid;
  }
  setClientLatency(clid, milliseconds) {
    const client = this.clients.get(clid);
    if (!client) return;
    client.pingMs = Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.min(90_000, milliseconds) : null;
    client.pingUpdatedAt = Date.now();
    if (client.loggedIn) this.#broadcast({cmd:'notifyclientlatency',args:{clid,pingMs:client.pingMs,pingUpdatedAt:client.pingUpdatedAt}});
  }

  snapshot() {
    return {
      nextClid: this.nextClid, nextStreamId: this.nextStreamId, idPrefix: this.idPrefix,
      clients: [...this.clients],
      streams: [...this.streams].map(([id, s]) => [id, { ...s,
        viewers: [...s.viewers], pending: [...s.pending], banned: [...s.banned] }]),
    };
  }

  restore(state) {
    if (!state) return;
    this.nextClid = state.nextClid;
    this.nextStreamId = state.nextStreamId;
    this.idPrefix = state.idPrefix || '';
    this.clients = new Map(state.clients);
    this.streams = new Map(state.streams.map(([id, s]) => [id, { ...s,
      viewers: new Set(s.viewers), pending: new Map(s.pending), banned: new Set(s.banned) }]));
  }

  view(clid) {
    if (!this.clients.get(clid)?.loggedIn) fail(ReturnCode.NOT_LOGGED_IN);
    return { clid, server: { name: this.name, capabilityExtensions: this.#capabilities() },
      iceServers: this.iceServers, channels: [...this.channels.values()],
      clients: [...this.clients.values()].filter(c => c.loggedIn).map(c => this.#publicClient(c)),
      streams: [...this.streams.values()].map(s => this.#publicStream(s)) };
  }

  /**
   * Transmissões que o dono deixou anunciar, para o bot do Discord (GET /api/live).
   * Só nomes públicos: nada de uid, IP ou miniatura. Espelho de liveSnapshot() no nativo.
   */
  liveSnapshot() {
    const streams = [...this.streams.values()].filter(s => s.announce !== false).map(s => ({
      id: s.streamIdentifier,
      name: s.name,
      owner: this.#shownName(this.clients.get(s.ownerClid)),
      channel: this.channels.get(s.cid)?.name ?? '',
      app: s.app ?? '',
      type: s.type, access: s.access, mode: s.mode, paused: s.paused, audio: s.audio,
      viewers: s.viewers.size, started: s.created,
      // Apelidos de quem assiste (os mesmos que a sala mostra), para o bot listar no fim.
      viewerNames: [...s.viewers].filter(clid => this.clients.has(clid)).map(clid => this.#shownName(this.clients.get(clid))),
      quality: { width: s.quality.width, height: s.quality.height, fps: s.quality.fps },
    }));
    // Só contagens agregadas. O servidor Node não carrega mídia (só P2P): sem Mbps.
    const stats = {
      clients: [...this.clients.values()].filter(c => c.loggedIn).length,
      streams: this.streams.size,
      viewers: [...this.streams.values()].reduce((sum, s) => sum + s.viewers.size, 0),
      mbps: null,
    };
    return { server: this.name, streams, stats };
  }

  disconnect(clid) {
    const client = this.clients.get(clid);
    if (!client) return;
    if (client.loggedIn) {
      this.#detachFromStreams(client, LeaveReason.LEFT);
      this.clients.delete(clid);
      this.#broadcast({ cmd: 'notifyclientleftview', args: { clid } });
    } else {
      this.clients.delete(clid);
    }
  }

  /** Executa um comando e devolve `data` da resposta, ou lança CommandError. */
  handle(clid, cmd, args = {}) {
    const client = this.clients.get(clid);
    if (!client) fail(ReturnCode.CLIENT_NOT_FOUND);
    if (cmd !== 'login' && !client.loggedIn) fail(ReturnCode.NOT_LOGGED_IN);
    const handler = this.#commands[cmd];
    if (!handler) fail(ReturnCode.UNKNOWN_COMMAND, `comando desconhecido: ${cmd}`);
    return handler.call(this, client, args ?? {});
  }

  // --------------------------------------------------------------- comandos

  #commands = {
    login(client, args) {
      if (client.loggedIn) fail(ReturnCode.INVALID_ARGS, 'já autenticado');
      const nickname = cleanString(args.nickname, 32);
      const uid = cleanString(args.uid, 64);
      if (!nickname || !uid) fail(ReturnCode.INVALID_ARGS, 'nickname e uid são obrigatórios');
      this.profiles?.refresh();
      const profile = this.profiles?.get(nickname);
      if (profile) {
        this.#checkProfilePassword(profileKey(nickname), args.profilePassword);
        client.profile = profileKey(nickname);
      }
      client.nickname = profile?.nickname ?? nickname;
      client.uid = uid;
      client.cid = this.defaultChannel;
      client.loggedIn = true;
      this.#broadcast({ cmd: 'notifycliententerview', args: { client: this.#publicClient(client) } }, client.clid);
      return {
        clid: client.clid,
        server: { name: this.name, capabilityExtensions: this.#capabilities() },
        iceServers: this.iceServers,
        channels: [...this.channels.values()],
        clients: [...this.clients.values()].filter(c => c.loggedIn).map(c => this.#publicClient(c)),
        streams: [...this.streams.values()].map(s => this.#publicStream(s)),
      };
    },

    clientmove(client, args) {
      const cid = Number(args.cid);
      if (!this.channels.has(cid)) fail(ReturnCode.CHANNEL_NOT_FOUND);
      if (client.cid === cid) return {};
      // Streams pertencem ao canal: sair do canal encerra os próprios streams
      // e a participação nos streams do canal anterior.
      this.#detachFromStreams(client, LeaveReason.LEFT);
      client.cid = cid;
      this.#broadcast({ cmd: 'notifyclientmoved', args: { clid: client.clid, cid } });
      return {};
    },

    clientupdate(client, args) {
      if ('nickname' in args) {
        const nickname = cleanString(args.nickname, 32);
        if (!nickname) fail(ReturnCode.INVALID_ARGS);
        // O apelido é a identidade do perfil: nem o dono troca, nem outro assume.
        if (client.profile) fail(ReturnCode.PERMISSION_DENIED, 'o apelido de um perfil não muda');
        if (this.profiles?.get(nickname)) fail(ReturnCode.PROFILE_PASSWORD);
        client.nickname = nickname;
      }
      if ('inputMuted' in args) client.inputMuted = !!args.inputMuted;
      if ('outputMuted' in args) client.outputMuted = !!args.outputMuted;
      this.#broadcast({ cmd: 'notifyclientupdated', args: { client: this.#publicClient(client) } });
      return {};
    },

    setprofilepassword(client, args) {
      if (!this.profiles) fail(ReturnCode.MODE_NOT_SUPPORTED);
      const password = typeof args.password === 'string' ? args.password : '';
      if (password.length < 4 || password.length > 128) fail(ReturnCode.INVALID_ARGS, 'a senha deve ter de 4 a 128 caracteres');
      this.profiles.refresh();
      if (client.profile) {
        this.#checkProfilePassword(client.profile, args.currentPassword);
        this.profiles.setPassword(client.profile, password);
        return {};
      }
      if (this.profiles.get(client.nickname)) fail(ReturnCode.PROFILE_PASSWORD);
      client.profile = this.profiles.claim(client.nickname, password);
      this.#broadcast({ cmd: 'notifyclientupdated', args: { client: this.#publicClient(client) } });
      return {};
    },

    updateprofile(client, args) {
      if (!this.profiles) fail(ReturnCode.MODE_NOT_SUPPORTED);
      if (!client.profile) fail(ReturnCode.PROFILE_REQUIRED);
      this.profiles.refresh();
      const fields = {};
      if ('displayName' in args) fields.displayName = cleanString(args.displayName, 32);
      if ('description' in args) fields.description = cleanString(args.description, 190);
      if ('color' in args) {
        if (args.color !== '' && !/^#[0-9a-fA-F]{6}$/.test(args.color)) fail(ReturnCode.INVALID_ARGS);
        fields.color = args.color;
      }
      if ('avatar' in args) {
        if (args.avatar !== '' && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(args.avatar)) fail(ReturnCode.INVALID_ARGS);
        if (args.avatar.length > MAX_AVATAR_BYTES) fail(ReturnCode.PAYLOAD_TOO_LARGE);
        fields.avatar = args.avatar;
      }
      if ('avatarAnimated' in args) {
        if (args.avatarAnimated !== '' && !/^data:image\/gif;base64,[A-Za-z0-9+/=]+$/.test(args.avatarAnimated)) fail(ReturnCode.INVALID_ARGS);
        if (args.avatarAnimated.length > MAX_PROFILE_MEDIA_BYTES) fail(ReturnCode.PAYLOAD_TOO_LARGE);
        fields.avatarAnimated = args.avatarAnimated;
      }
      if ('banner' in args) {
        if (args.banner !== '' && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(args.banner)) fail(ReturnCode.INVALID_ARGS);
        if (args.banner.length > MAX_PROFILE_MEDIA_BYTES) fail(ReturnCode.PAYLOAD_TOO_LARGE);
        fields.banner = args.banner;
      }
      this.profiles.update(client.profile, fields);
      // O mesmo perfil pode estar em mais de um dispositivo.
      for (const c of this.clients.values()) {
        if (c.loggedIn && c.profile === client.profile)
          this.#broadcast({ cmd: 'notifyclientupdated', args: { client: this.#publicClient(c) } });
      }
      return {};
    },

    // A mídia pesada não vai em publicClient: quem abre um card pede só a daquele perfil.
    profilemedia(client, args) {
      if (!this.profiles) fail(ReturnCode.MODE_NOT_SUPPORTED);
      const target = [...this.clients.values()].find(c => c.loggedIn && c.clid === Number(args.clid));
      if (!target) fail(ReturnCode.INVALID_ARGS);
      const profile = this.#profileOf(target);
      return { mediaTag: profile?.mediaTag ?? '', banner: profile?.banner ?? '', avatarAnimated: profile?.avatarAnimated ?? '' };
    },

    setupstream(client, args) {
      const isYouTube = Number(args.type) === StreamType.YOUTUBE;
      const mode = isYouTube ? StreamMode.NONE : Number(args.mode ?? StreamMode.P2P);
      if (!isYouTube && mode !== StreamMode.P2P) fail(ReturnCode.MODE_NOT_SUPPORTED, 'o servidor só suporta STREAM_P2P');
      const owned = [...this.streams.values()].filter(s => s.ownerClid === client.clid);
      if (owned.length >= MAX_STREAMS_PER_CLIENT) fail(ReturnCode.STREAM_LIMIT);
      if (isYouTube && (!isYouTubeVideoId(args.videoId) || !isYouTubePosition(args.position))) fail(ReturnCode.INVALID_ARGS);
      const stream = {
        streamIdentifier: `${this.idPrefix}s${this.nextStreamId++}`,
        ownerClid: client.clid,
        cid: client.cid,
        mode,
        created: Date.now(),
        paused: isYouTube || args.paused === true,
        ...(isYouTube ? { youtube: { videoId: args.videoId, position: args.position, playing: false, rate: 1, updatedAt: Date.now() } } : {}),
        thumbnail: null,
        viewers: new Set(),
        pending: new Map(), // clid -> { codecs, since }
        banned: new Set(), // uids
        ...this.#sanitizeStreamConfig(args, {
          name: `Stream de ${this.#shownName(client)}`, type: StreamType.SCREEN, access: StreamAccess.PUBLIC,
          bitrate: 3_000_000, viewerLimit: 0, audio: false, announce: true, app: '', quality: { width: 1280, height: 720, fps: 30 },
        }),
      };
      this.streams.set(stream.streamIdentifier, stream);
      this.#broadcast({ cmd: 'notifystreamstarted', args: { stream: this.#publicStream(stream) } });
      return { streamIdentifier: stream.streamIdentifier };
    },

    updatestream(client, args) {
      const stream = this.#ownStream(client, args.streamIdentifier);
      if ('type' in args && (Number(args.type) === StreamType.YOUTUBE) !== !!stream.youtube) fail(ReturnCode.INVALID_ARGS);
      const accessBefore = stream.access;
      Object.assign(stream, this.#sanitizeStreamConfig(args, stream));
      if (!stream.youtube && 'paused' in args) stream.paused = !!args.paused;
      if (stream.access !== StreamAccess.PUBLIC) stream.thumbnail = null;
      this.#broadcast({ cmd: 'notifystreamupdated', args: { stream: this.#publicStream(stream), accessChanged: accessBefore !== stream.access } });
      return {};
    },

    stopstream(client, args) {
      const stream = this.#ownStream(client, args.streamIdentifier);
      this.#stopStream(stream, LeaveReason.STREAM_STOPPED);
      return {};
    },

    streamthumbnail(client, args) {
      const stream = this.#ownStream(client, args.streamIdentifier);
      const thumbnail = typeof args.thumbnail === 'string' ? args.thumbnail : null;
      if (!thumbnail || !thumbnail.startsWith('data:image/')) fail(ReturnCode.INVALID_ARGS);
      if (thumbnail.length > MAX_THUMBNAIL_BYTES) fail(ReturnCode.PAYLOAD_TOO_LARGE);
      // Miniaturas só são publicadas para streams públicos (igual ao TS).
      if (stream.access !== StreamAccess.PUBLIC) return { published: false };
      stream.thumbnail = thumbnail;
      this.#broadcastToChannel(stream.cid, {
        cmd: 'notifystreamthumbnail', args: { streamIdentifier: stream.streamIdentifier, thumbnail },
      }, client.clid);
      return { published: true };
    },

    requeststreaminfo(client, args) {
      const stream = this.#stream(args.streamIdentifier);
      const info = this.#publicStream(stream);
      if (stream.ownerClid === client.clid) {
        info.viewers = [...stream.viewers];
        info.pending = [...stream.pending.keys()];
        info.banned = [...stream.banned];
      }
      this.send(client.clid, { type: 'notify', cmd: 'notifystreaminfo', args: { stream: info } });
      return { stream: info };
    },

    joinstreamrequest(client, args) {
      const stream = this.#stream(args.streamIdentifier);
      if (stream.youtube && args.youtube !== true) fail(ReturnCode.MODE_NOT_SUPPORTED);
      if (stream.ownerClid === client.clid) fail(ReturnCode.INVALID_ARGS, 'não é possível assistir ao próprio stream');
      if (stream.cid !== client.cid) fail(ReturnCode.NOT_IN_CHANNEL);
      if (stream.banned.has(client.uid)) fail(ReturnCode.BANNED);
      if (stream.viewers.has(client.clid)) fail(ReturnCode.ALREADY_JOINED);
      if (stream.viewerLimit > 0 && stream.viewers.size >= stream.viewerLimit) fail(ReturnCode.VIEWER_LIMIT);
      const codecs = Array.isArray(args.codecs) ? args.codecs.filter(c => typeof c === 'string').slice(0, 16) : [];
      stream.pending.set(client.clid, { codecs, since: Date.now() });
      this.send(stream.ownerClid, {
        type: 'notify', cmd: 'notifyjoinstreamrequest',
        args: {
          streamIdentifier: stream.streamIdentifier,
          clid: client.clid, nickname: this.#shownName(client), uid: client.uid, codecs,
        },
      });
      return { pending: true };
    },

    respondjoinstreamrequest(client, args) {
      const stream = this.#ownStream(client, args.streamIdentifier);
      const clid = Number(args.clid);
      const request = stream.pending.get(clid);
      if (!request) fail(ReturnCode.NO_PENDING_REQUEST);
      const viewer = this.clients.get(clid);
      if (!viewer || viewer.cid !== stream.cid) {
        stream.pending.delete(clid);
        fail(ReturnCode.CLIENT_NOT_FOUND);
      }
      if (args.accept) {
        if (stream.viewerLimit > 0 && stream.viewers.size >= stream.viewerLimit) fail(ReturnCode.VIEWER_LIMIT);
        stream.pending.delete(clid);
        stream.viewers.add(clid);
        this.send(clid, {
          type: 'notify', cmd: 'notifyrespondjoinstreamrequest',
          // peerClid: com quem o espectador negocia (aqui sempre o dono; o SFU só existe no servidor nativo).
          args: {
            streamIdentifier: stream.streamIdentifier, accepted: true, ownerClid: stream.ownerClid, peerClid: stream.ownerClid,
            ...(stream.youtube ? { youtube: currentYouTube(stream.youtube) } : {}),
          },
        });
        this.send(stream.ownerClid, {
          type: 'notify', cmd: 'notifystreamclientjoined',
          args: { streamIdentifier: stream.streamIdentifier, clid, codecs: request.codecs },
        });
        this.#notifyAttendees(stream);
      } else {
        stream.pending.delete(clid);
        const ban = !!args.ban;
        if (ban) this.#ban(stream, viewer.uid);
        this.send(clid, {
          type: 'notify', cmd: 'notifyrespondjoinstreamrequest',
          args: { streamIdentifier: stream.streamIdentifier, accepted: false, reason: ban ? LeaveReason.BANNED : LeaveReason.DENIED },
        });
      }
      return {};
    },

    removeclientfromstream(client, args) {
      const stream = this.#stream(args.streamIdentifier);
      const target = Number(args.clid ?? client.clid);
      const isOwner = stream.ownerClid === client.clid;
      if (!isOwner && target !== client.clid) fail(ReturnCode.PERMISSION_DENIED);
      let reason = isOwner && target !== client.clid ? Number(args.reason ?? LeaveReason.KICKED) : LeaveReason.LEFT;
      if (![LeaveReason.LEFT, LeaveReason.KICKED, LeaveReason.BANNED, LeaveReason.FAILED].includes(reason)) reason = LeaveReason.KICKED;
      if (reason === LeaveReason.BANNED) {
        const uid = this.clients.get(target)?.uid;
        if (uid) this.#ban(stream, uid);
      }
      this.#removeViewer(stream, target, reason);
      return {};
    },

    streamunban(client, args) {
      const stream = this.#ownStream(client, args.streamIdentifier);
      const uid = cleanString(args.uid, 64);
      if (stream.banned.delete(uid)) {
        this.send(client.clid, { type: 'notify', cmd: 'notifystreambanremoved', args: { streamIdentifier: stream.streamIdentifier, uid } });
      }
      return {};
    },

    streamyoutube(client, args) {
      const stream = this.#ownStream(client, args.streamIdentifier);
      const { position, playing, rate } = args;
      if (!stream.youtube || !isYouTubePosition(position) || typeof playing !== 'boolean'
        || !Number.isFinite(rate) || rate < 0.25 || rate > 4) fail(ReturnCode.INVALID_ARGS);
      Object.assign(stream.youtube, { position, playing, rate, updatedAt: Date.now() });
      stream.paused = !playing;
      const message = {
        type: 'notify', cmd: 'notifystreamyoutube',
        args: { streamIdentifier: stream.streamIdentifier, youtube: currentYouTube(stream.youtube) },
      };
      for (const clid of stream.viewers) this.send(clid, message);
      return {};
    },

    getstreamyoutube(client, args) {
      const stream = this.#stream(args.streamIdentifier);
      if (!stream.youtube || !stream.viewers.has(client.clid)) fail(ReturnCode.PERMISSION_DENIED);
      return { youtube: currentYouTube(stream.youtube) };
    },

    streamannotation(client, args) {
      if (!this.streamAnnotations) fail(ReturnCode.UNKNOWN_COMMAND);
      const stream = this.#stream(args.streamIdentifier);
      if (stream.youtube) fail(ReturnCode.MODE_NOT_SUPPORTED);
      if (client.cid !== stream.cid || (client.clid !== stream.ownerClid && !stream.viewers.has(client.clid))) {
        fail(ReturnCode.PERMISSION_DENIED);
      }
      const { strokeId, points } = args;
      if (typeof strokeId !== 'string' || !/^[a-z0-9-]{1,48}$/i.test(strokeId)
        || !Array.isArray(points) || !points.length || points.length > MAX_ANNOTATION_POINTS
        || points.some(point => !Array.isArray(point) || point.length !== 2
          || point.some(value => !Number.isInteger(value) || value < 0 || value > ANNOTATION_SCALE))) {
        fail(ReturnCode.INVALID_ARGS);
      }
      const second = Math.floor(Date.now() / 1000);
      if (client.annotationSecond !== second) {
        client.annotationSecond = second;
        client.annotationBatches = 0;
      }
      if (client.annotationBatches >= MAX_ANNOTATION_BATCHES_PER_SECOND) return {};
      client.annotationBatches++;
      const message = {
        type: 'notify', cmd: 'notifystreamannotation',
        args: { streamIdentifier: stream.streamIdentifier, clid: client.clid, name: this.#shownName(client), strokeId, points },
      };
      for (const clid of [stream.ownerClid, ...stream.viewers]) {
        if (clid !== client.clid) this.send(clid, message);
      }
      return {};
    },

    streamsignaling(client, args) {
      const stream = this.#stream(args.streamIdentifier);
      if (stream.youtube) fail(ReturnCode.MODE_NOT_SUPPORTED);
      const target = Number(args.clid);
      const payload = args.payload;
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') fail(ReturnCode.INVALID_ARGS);
      if (JSON.stringify(payload).length > MAX_SIGNALING_BYTES) fail(ReturnCode.PAYLOAD_TOO_LARGE);
      // Só pares legítimos conversam: dono <-> espectador aceito.
      const ownerToViewer = stream.ownerClid === client.clid && stream.viewers.has(target);
      const viewerToOwner = stream.ownerClid === target && stream.viewers.has(client.clid);
      if (!ownerToViewer && !viewerToOwner) fail(ReturnCode.PERMISSION_DENIED);
      this.send(target, {
        type: 'notify', cmd: 'notifystreamsignaling',
        args: { streamIdentifier: stream.streamIdentifier, clid: client.clid, payload },
      });
      return {};
    },
  };

  // ------------------------------------------------------------- auxiliares

  #capabilities() {
    const caps = [...CAPABILITIES, CAP_STREAM_YOUTUBE];
    if (this.streamAnnotations) caps.push(CAP_STREAM_ANNOTATIONS);
    if (this.profiles) caps.push(CAP_PROFILES, CAP_PROFILE_MEDIA);
    return caps;
  }

  #checkProfilePassword(key, password) {
    if (typeof password !== 'string' || !password) fail(ReturnCode.PROFILE_PASSWORD, 'Este apelido é um perfil: informe a senha.');
    const result = this.profiles.verify(key, password);
    if (result === 'locked') fail(ReturnCode.PROFILE_LOCKED, 'Muitas tentativas. Aguarde um minuto.');
    if (result !== 'ok') fail(ReturnCode.PROFILE_PASSWORD, 'Senha do perfil incorreta.');
  }

  #profileOf(client) {
    return client?.profile ? this.profiles?.get(client.profile) ?? null : null;
  }

  /** Nome que a sala mostra: o de exibição do perfil ou o apelido. */
  #shownName(client) {
    return this.#profileOf(client)?.displayName || client?.nickname || '';
  }

  #sanitizeStreamConfig(args, base) {
    const out = {};
    out.name = 'name' in args ? (cleanString(args.name, 64) || base.name) : base.name;
    out.type = 'type' in args && Object.values(StreamType).includes(Number(args.type)) ? Number(args.type) : base.type;
    out.access = 'access' in args && [StreamAccess.PUBLIC, StreamAccess.CONTACTS_ONLY, StreamAccess.PRIVATE].includes(Number(args.access))
      ? Number(args.access) : base.access;
    out.bitrate = 'bitrate' in args ? clampInt(args.bitrate, 100_000, 50_000_000, base.bitrate) : base.bitrate;
    out.viewerLimit = 'viewerLimit' in args ? clampInt(args.viewerLimit, 0, 1000, base.viewerLimit) : base.viewerLimit;
    out.audio = 'audio' in args ? !!args.audio : base.audio;
    // Estado antigo (Redis) não tem o campo: anunciar é o padrão.
    out.app = 'app' in args ? cleanString(args.app, 64) : (base.app ?? '');
    out.announce = 'announce' in args ? args.announce !== false : base.announce !== false;
    if (args.quality && typeof args.quality === 'object') {
      out.quality = {
        width: clampInt(args.quality.width, -1, 7680, base.quality.width),
        height: clampInt(args.quality.height, -1, 4320, base.quality.height),
        fps: clampInt(args.quality.fps, 1, 144, base.quality.fps),
      };
    } else {
      out.quality = base.quality;
    }
    return out;
  }

  #stream(streamIdentifier) {
    const stream = this.streams.get(String(streamIdentifier));
    if (!stream) fail(ReturnCode.STREAM_NOT_FOUND);
    return stream;
  }

  #ownStream(client, streamIdentifier) {
    const stream = this.#stream(streamIdentifier);
    if (stream.ownerClid !== client.clid) fail(ReturnCode.PERMISSION_DENIED);
    return stream;
  }

  #ban(stream, uid) {
    if (!uid || stream.banned.has(uid)) return;
    stream.banned.add(uid);
    this.send(stream.ownerClid, { type: 'notify', cmd: 'notifystreambanadded', args: { streamIdentifier: stream.streamIdentifier, uid } });
  }

  #removeViewer(stream, clid, reason) {
    const wasViewer = stream.viewers.delete(clid);
    const wasPending = stream.pending.delete(clid);
    if (!wasViewer && !wasPending) return;
    const message = {
      type: 'notify', cmd: 'notifystreamclientleft',
      args: { streamIdentifier: stream.streamIdentifier, clid, reason, wasPending },
    };
    this.send(stream.ownerClid, message);
    if (clid !== stream.ownerClid && this.clients.has(clid)) this.send(clid, message);
    if (wasViewer) this.#notifyAttendees(stream);
  }

  #stopStream(stream, reason) {
    this.streams.delete(stream.streamIdentifier);
    this.#broadcast({ cmd: 'notifystreamstopped', args: { streamIdentifier: stream.streamIdentifier, reason } });
  }

  #detachFromStreams(client, reason) {
    for (const stream of [...this.streams.values()]) {
      if (stream.ownerClid === client.clid) this.#stopStream(stream, LeaveReason.STREAM_STOPPED);
      else this.#removeViewer(stream, client.clid, reason);
    }
  }

  #notifyAttendees(stream) {
    const args = { streamIdentifier: stream.streamIdentifier, viewers: [...stream.viewers] };
    this.send(stream.ownerClid, { type: 'notify', cmd: 'notifystreamattendees', args });
    for (const clid of stream.viewers) this.send(clid, { type: 'notify', cmd: 'notifystreamattendees', args });
    // Contagem de espectadores é pública (aparece na árvore de canais).
    this.#broadcast({ cmd: 'notifystreamupdated', args: { stream: this.#publicStream(stream) } });
  }

  #publicClient(c) {
    const profile = this.#profileOf(c);
    return { clid: c.clid, nickname: c.nickname, uid: c.uid, cid: c.cid, inputMuted: c.inputMuted, outputMuted: c.outputMuted,
      pingMs: c.pingMs ?? null, pingUpdatedAt: c.pingUpdatedAt ?? 0, hasProfile: !!profile,
      displayName: profile?.displayName ?? '', color: profile?.color ?? '',
      description: profile?.description ?? '', avatar: profile?.avatar ?? '', mediaTag: profile?.mediaTag ?? '' };
  }

  #publicStream(s) {
    return {
      streamIdentifier: s.streamIdentifier,
      ownerClid: s.ownerClid,
      cid: s.cid,
      name: s.name,
      type: s.type,
      access: s.access,
      mode: s.mode,
      bitrate: s.bitrate,
      viewerLimit: s.viewerLimit,
      audio: s.audio,
      announce: s.announce !== false,
      app: s.app ?? '',
      quality: s.quality,
      paused: s.paused,
      created: s.created,
      viewerCount: s.viewers.size,
      thumbnail: s.access === StreamAccess.PUBLIC ? s.thumbnail : null,
    };
  }

  #broadcast({ cmd, args }, exceptClid = 0) {
    for (const c of this.clients.values()) {
      if (c.loggedIn && c.clid !== exceptClid) this.send(c.clid, { type: 'notify', cmd, args });
    }
    // Todo começo/mudança/fim de stream e troca de apelido passa por aqui.
    if (this.onLiveChanged && LIVE_COMMANDS.has(cmd)) this.onLiveChanged();
  }

  #broadcastToChannel(cid, { cmd, args }, exceptClid = 0) {
    for (const c of this.clients.values()) {
      if (c.loggedIn && c.cid === cid && c.clid !== exceptClid) this.send(c.clid, { type: 'notify', cmd, args });
    }
  }
}

export { CommandError };
