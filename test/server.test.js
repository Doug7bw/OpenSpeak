import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualServer } from '../server/virtualServer.js';
import { StreamAccess, StreamType, LeaveReason } from '../server/protocol.js';
import { parseYouTubeLink } from '../public/js/video/youtube.js';
import { ProfileStore, hashPassword, checkPassword } from '../server/profileStore.js';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function setup(options = {}) {
  const inbox = new Map();
  const server = new VirtualServer({ send: (clid, msg) => inbox.get(clid)?.push(msg), ...options });
  const login = nickname => {
    const clid = server.connect();
    inbox.set(clid, []);
    server.handle(clid, 'login', { nickname, uid: `uid-${nickname}` });
    return clid;
  };
  const notes = (clid, cmd) => inbox.get(clid).filter(m => m.cmd === cmd);
  const clear = () => inbox.forEach(list => { list.length = 0; });
  return { server, login, notes, clear };
}

test('server broadcasts measured client ping and includes it in new login views', () => {
  const { server, login, notes } = setup();
  const a = login('a'), b = login('b');
  server.setClientLatency(a, 42);
  const sample = notes(b, 'notifyclientlatency').at(-1).args;
  assert.equal(sample.clid, a);
  assert.equal(sample.pingMs, 42);
  assert.ok(sample.pingUpdatedAt > 0);
  assert.equal(sample.ip, undefined);
  assert.equal(server.view(b).clients.find(c => c.clid === a).pingMs, 42);
  server.setClientLatency(a, -1);
  assert.equal(notes(b, 'notifyclientlatency').at(-1).args.pingMs, null);
  assert.throws(() => server.handle(a, 'setClientLatency', {pingMs:0}));
});

test('fluxo completo: setup, pedido, aceite, sinalização e saída', () => {
  const { server, login, notes } = setup();
  const host = login('host');
  const viewer = login('viewer');

  const { streamIdentifier } = server.handle(host, 'setupstream', { name: 'Tela', access: StreamAccess.PRIVATE });
  assert.equal(notes(viewer, 'notifystreamstarted').length, 1);

  server.handle(viewer, 'joinstreamrequest', { streamIdentifier, codecs: ['video/VP9'] });
  const [req] = notes(host, 'notifyjoinstreamrequest');
  assert.equal(req.args.clid, viewer);
  assert.deepEqual(req.args.codecs, ['video/VP9']);

  // antes de aceitar, a sinalização é recusada
  assert.throws(() => server.handle(host, 'streamsignaling', { streamIdentifier, clid: viewer, payload: { type: 'offer', sdp: 'x' } }),
    { code: 'permission_denied' });

  server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid: viewer, accept: true });
  assert.equal(notes(viewer, 'notifyrespondjoinstreamrequest')[0].args.accepted, true);
  assert.equal(notes(host, 'notifystreamclientjoined')[0].args.clid, viewer);

  server.handle(host, 'streamsignaling', { streamIdentifier, clid: viewer, payload: { type: 'offer', sdp: 'v=0' } });
  const [sig] = notes(viewer, 'notifystreamsignaling');
  assert.equal(sig.args.clid, host);
  assert.equal(sig.args.payload.type, 'offer');

  server.handle(viewer, 'streamsignaling', { streamIdentifier, clid: host, payload: { type: 'answer', sdp: 'v=0' } });
  assert.equal(notes(host, 'notifystreamsignaling')[0].args.payload.type, 'answer');

  server.handle(viewer, 'removeclientfromstream', { streamIdentifier });
  assert.equal(notes(host, 'notifystreamclientleft')[0].args.reason, LeaveReason.LEFT);
});

test('transmissão de arquivo pode ser anunciada pausada e retomada pelo anfitrião', () => {
  const { server, login, notes } = setup();
  const host = login('host');
  const viewer = login('viewer');
  const { streamIdentifier } = server.handle(host, 'setupstream', { type: StreamType.FILE, paused: true });
  const { stream } = notes(viewer, 'notifystreamstarted')[0].args;
  assert.equal(stream.type, StreamType.FILE);
  assert.equal(stream.paused, true);

  server.handle(host, 'updatestream', { streamIdentifier, paused: false });
  assert.equal(notes(viewer, 'notifystreamupdated')[0].args.stream.paused, false);
});

test('desenhos chegam só aos participantes aceitos e usam o nome do autor', () => {
  const { server, login, notes, clear } = setup();
  const host = login('Anfitrião');
  const author = login('Autora');
  const viewer = login('Espectador');
  const outsider = login('Na sala');
  const { streamIdentifier } = server.handle(host, 'setupstream', {});
  for (const clid of [author, viewer]) {
    server.handle(clid, 'joinstreamrequest', { streamIdentifier });
    server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid, accept: true });
  }
  server.handle(outsider, 'joinstreamrequest', { streamIdentifier });
  clear();

  const args = { streamIdentifier, clid: host, name: 'Falso', strokeId: 'traco-1', points: [[0, 10000], [4000, 2000]] };
  assert.ok(server.view(author).server.capabilityExtensions.includes('STREAM_ANNOTATIONS'));
  assert.throws(() => server.handle(outsider, 'streamannotation', args), { code: 'permission_denied' });
  assert.throws(() => server.handle(author, 'streamannotation', { ...args, points: [[10001, 0]] }), { code: 'invalid_args' });
  server.handle(author, 'streamannotation', args);
  for (const clid of [host, viewer]) {
    const [note] = notes(clid, 'notifystreamannotation');
    assert.deepEqual(note.args, { ...args, clid: author, name: 'Autora' });
  }
  assert.equal(notes(author, 'notifystreamannotation').length, 0);
  assert.equal(notes(outsider, 'notifystreamannotation').length, 0);
});

test('desenhos ficam desabilitados no servidor com sinalização limitada', () => {
  const { server, login } = setup({ streamAnnotations: false });
  const host = login('host');
  assert.ok(!server.view(host).server.capabilityExtensions.includes('STREAM_ANNOTATIONS'));
  assert.throws(() => server.handle(host, 'streamannotation', {}), { code: 'unknown_command' });
});

test('links do YouTube aceitam formatos oficiais e rejeitam hosts parecidos', () => {
  const id = 'M7lc1UVf-VE';
  assert.deepEqual(parseYouTubeLink('https://www.youtube.com/watch?v=' + id + '&t=1m30s'), { videoId: id, position: 90 });
  assert.deepEqual(parseYouTubeLink('https://youtu.be/' + id + '?t=42'), { videoId: id, position: 42 });
  assert.deepEqual(parseYouTubeLink('https://www.youtube.com/shorts/' + id), { videoId: id, position: 0 });
  assert.equal(parseYouTubeLink('https://www.youtube.com.evil.test/watch?v=' + id), null);
  assert.equal(parseYouTubeLink('https://www.youtube.com/playlist?list=abc'), null);
  assert.equal(parseYouTubeLink('https://www.youtube.com/watch?v=inválido'), null);
});

test('YouTube sincroniza só espectadores aceitos e só o anfitrião altera o estado', () => {
  const { server, login, notes } = setup();
  const host = login('Anfitrião');
  const viewer = login('Espectador');
  const late = login('Entrou depois');
  const id = 'M7lc1UVf-VE';
  const { streamIdentifier } = server.handle(host, 'setupstream', { type: StreamType.YOUTUBE, videoId: id, position: 30 });
  const join = clid => {
    server.handle(clid, 'joinstreamrequest', { streamIdentifier, youtube: true });
    server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid, accept: true });
    return notes(clid, 'notifyrespondjoinstreamrequest').at(-1).args.youtube;
  };

  assert.equal(server.view(late).streams[0].youtube, undefined);
  assert.throws(() => server.handle(late, 'joinstreamrequest', { streamIdentifier }), { code: 'mode_not_supported' });
  assert.deepEqual(join(viewer), { videoId: id, position: 30, rate: 1, playing: false });
  const play = { streamIdentifier, position: 51, rate: 1, playing: true };
  assert.throws(() => server.handle(viewer, 'streamyoutube', play), { code: 'permission_denied' });
  assert.throws(() => server.handle(late, 'getstreamyoutube', { streamIdentifier }), { code: 'permission_denied' });
  server.handle(host, 'streamyoutube', play);
  assert.ok(notes(viewer, 'notifystreamyoutube').at(-1).args.youtube.position >= 51);
  assert.equal(notes(late, 'notifystreamyoutube').length, 0);
  const lateState = join(late);
  assert.equal(lateState.videoId, id);
  assert.equal(lateState.playing, true);
  assert.ok(lateState.position >= 51);

  server.handle(host, 'streamyoutube', { ...play, position: 85, playing: false });
  assert.deepEqual(server.handle(viewer, 'getstreamyoutube', { streamIdentifier }).youtube,
    { videoId: id, position: 85, rate: 1, playing: false });
});

test('ban impede novo pedido e pode ser desfeito', () => {
  const { server, login, notes } = setup();
  const host = login('host');
  const viewer = login('viewer');
  const { streamIdentifier } = server.handle(host, 'setupstream', {});
  server.handle(viewer, 'joinstreamrequest', { streamIdentifier });
  server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid: viewer, accept: false, ban: true });
  assert.equal(notes(viewer, 'notifyrespondjoinstreamrequest')[0].args.reason, LeaveReason.BANNED);
  assert.throws(() => server.handle(viewer, 'joinstreamrequest', { streamIdentifier }), { code: 'banned' });
  server.handle(host, 'streamunban', { streamIdentifier, uid: 'uid-viewer' });
  assert.doesNotThrow(() => server.handle(viewer, 'joinstreamrequest', { streamIdentifier }));
});

test('kick com ban remove espectador e notifica os dois lados', () => {
  const { server, login, notes } = setup();
  const host = login('host');
  const viewer = login('viewer');
  const { streamIdentifier } = server.handle(host, 'setupstream', {});
  server.handle(viewer, 'joinstreamrequest', { streamIdentifier });
  server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid: viewer, accept: true });
  server.handle(host, 'removeclientfromstream', { streamIdentifier, clid: viewer, reason: LeaveReason.BANNED });
  assert.equal(notes(viewer, 'notifystreamclientleft')[0].args.reason, LeaveReason.BANNED);
  assert.equal(notes(host, 'notifystreambanadded').length, 1);
  assert.throws(() => server.handle(viewer, 'joinstreamrequest', { streamIdentifier }), { code: 'banned' });
});

test('espectador não pode remover outros', () => {
  const { server, login } = setup();
  const host = login('host');
  const a = login('a');
  const b = login('b');
  const { streamIdentifier } = server.handle(host, 'setupstream', {});
  for (const c of [a, b]) {
    server.handle(c, 'joinstreamrequest', { streamIdentifier });
    server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid: c, accept: true });
  }
  assert.throws(() => server.handle(a, 'removeclientfromstream', { streamIdentifier, clid: b }), { code: 'permission_denied' });
  // espectador também não conversa com outro espectador
  assert.throws(() => server.handle(a, 'streamsignaling', { streamIdentifier, clid: b, payload: { type: 'ice' } }), { code: 'permission_denied' });
});

test('limite de espectadores', () => {
  const { server, login } = setup();
  const host = login('host');
  const a = login('a');
  const b = login('b');
  const { streamIdentifier } = server.handle(host, 'setupstream', { viewerLimit: 1 });
  server.handle(a, 'joinstreamrequest', { streamIdentifier });
  server.handle(b, 'joinstreamrequest', { streamIdentifier });
  server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid: a, accept: true });
  assert.throws(() => server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid: b, accept: true }), { code: 'viewer_limit' });
});

// O servidor padrão só tem o "Geral"; estes testes precisam de outros canais.
const THREE_CHANNELS = { channels: [{ name: 'Geral' }, { name: 'B' }, { name: 'C' }] };

test('servidor padrão tem só o canal Geral', () => {
  const { server } = setup();
  assert.deepEqual([...server.channels.values()].map(c => c.name), ['Geral']);
});

test('sair do canal encerra os próprios streams; desconectar idem', () => {
  const { server, login, notes } = setup(THREE_CHANNELS);
  const host = login('host');
  const viewer = login('viewer');
  const s1 = server.handle(host, 'setupstream', {}).streamIdentifier;
  server.handle(host, 'clientmove', { cid: 2 });
  assert.equal(notes(viewer, 'notifystreamstopped')[0].args.streamIdentifier, s1);
  const s2 = server.handle(host, 'setupstream', {}).streamIdentifier;
  server.disconnect(host);
  assert.equal(notes(viewer, 'notifystreamstopped')[1].args.streamIdentifier, s2);
  assert.equal(server.streams.size, 0);
});

test('pedido exige estar no mesmo canal', () => {
  const { server, login } = setup(THREE_CHANNELS);
  const host = login('host');
  const viewer = login('viewer');
  const { streamIdentifier } = server.handle(host, 'setupstream', {});
  server.handle(viewer, 'clientmove', { cid: 3 });
  assert.throws(() => server.handle(viewer, 'joinstreamrequest', { streamIdentifier }), { code: 'not_in_channel' });
});

test('miniatura só é publicada em stream público', () => {
  const { server, login, notes } = setup();
  const host = login('host');
  const viewer = login('viewer');
  const { streamIdentifier } = server.handle(host, 'setupstream', { access: StreamAccess.PRIVATE });
  const thumb = 'data:image/jpeg;base64,AAAA';
  assert.deepEqual(server.handle(host, 'streamthumbnail', { streamIdentifier, thumbnail: thumb }), { published: false });
  server.handle(host, 'updatestream', { streamIdentifier, access: StreamAccess.PUBLIC });
  assert.deepEqual(server.handle(host, 'streamthumbnail', { streamIdentifier, thumbnail: thumb }), { published: true });
  assert.equal(notes(viewer, 'notifystreamthumbnail')[0].args.thumbnail, thumb);
});

test('modo SFU é recusado pelo servidor P2P', () => {
  const { server, login } = setup();
  const host = login('host');
  assert.throws(() => server.handle(host, 'setupstream', { mode: 2 }), { code: 'mode_not_supported' });
  // O relay de mídia só existe no servidor nativo: aqui STREAM_SFU nunca é anunciado.
  const other = server.connect();
  const view = server.handle(other, 'login', { nickname: 'x', uid: 'uid-x' });
  assert.ok(view.server.capabilityExtensions.includes('STREAM_P2P'));
  assert.ok(!view.server.capabilityExtensions.includes('STREAM_SFU'));
});

test('aceite informa peerClid (P2P: o próprio dono)', () => {
  const { server, login, notes } = setup();
  const host = login('host');
  const viewer = login('viewer');
  const { streamIdentifier } = server.handle(host, 'setupstream', {});
  server.handle(viewer, 'joinstreamrequest', { streamIdentifier });
  server.handle(host, 'respondjoinstreamrequest', { streamIdentifier, clid: viewer, accept: true });
  const [resp] = notes(viewer, 'notifyrespondjoinstreamrequest');
  assert.equal(resp.args.peerClid, host);
  assert.equal(resp.args.ownerClid, host);
});

test('bot do Discord: liveSnapshot só lista streams com announce, com quem e qual app', () => {
  const { server, login, notes } = setup();
  const host = login('host');
  const other = login('other');
  const { streamIdentifier: shown } = server.handle(host, 'setupstream', { name: 'Ranked', app: 'Counter-Strike 2', type: 3 });
  server.handle(other, 'setupstream', { name: 'Segredo', announce: false });

  assert.equal(notes(other, 'notifystreamstarted')[0].args.stream.announce, true);
  let live = server.liveSnapshot();
  assert.equal(live.streams.length, 1);
  assert.equal(live.streams[0].id, shown);
  assert.equal(live.streams[0].owner, 'host');
  assert.equal(live.streams[0].app, 'Counter-Strike 2');
  assert.equal(live.streams[0].channel, 'Geral');
  assert.equal(live.streams[0].uid, undefined);
  assert.equal(live.streams[0].thumbnail, undefined);
  // Contagens contam também streams sem anúncio, mas sem dizer de quem.
  assert.deepEqual(live.stats, { clients: 2, streams: 2, viewers: 0, mbps: null });
  assert.deepEqual(live.streams[0].viewerNames, []);

  // Quem assiste aparece pelo apelido (o bot lista no fim da transmissão).
  server.handle(other, 'joinstreamrequest', { streamIdentifier: shown });
  server.handle(host, 'respondjoinstreamrequest', { streamIdentifier: shown, clid: other, accept: true });
  assert.deepEqual(server.liveSnapshot().streams[0].viewerNames, ['other']);

  server.handle(host, 'updatestream', { streamIdentifier: shown, announce: false });
  assert.equal(server.liveSnapshot().streams.length, 0);
  server.handle(host, 'updatestream', { streamIdentifier: shown, announce: true, app: 'Chrome' });
  live = server.liveSnapshot();
  assert.equal(live.streams[0].app, 'Chrome');
});

test('webhook do bot: onLiveChanged dispara no ciclo de vida do stream, troca de apelido e entrada/saída', () => {
  let calls = 0;
  const server = new VirtualServer({ send: () => {}, onLiveChanged: () => { calls++; } });
  const host = server.connect();
  server.handle(host, 'login', { nickname: 'host', uid: 'uid-host' });
  assert.equal(calls, 1); // login muda o contador "online"
  server.disconnect(server.connect());
  assert.equal(calls, 1); // quem nem fez login não conta
  const { streamIdentifier } = server.handle(host, 'setupstream', {});
  assert.equal(calls, 2);
  server.handle(host, 'updatestream', { streamIdentifier, app: 'Chrome' });
  assert.equal(calls, 3);
  server.handle(host, 'clientupdate', { nickname: 'novo' });
  assert.equal(calls, 4);
  server.disconnect(host);
  assert.ok(calls >= 5); // fim do stream e saída do usuário
});

function profileSetup(file = null, now = Date.now) {
  return setup({ profiles: new ProfileStore(file, now) });
}

test('perfil: senha reclama o apelido e o login passa a exigi-la', () => {
  const { server, login, notes } = profileSetup();
  const jonas = login('Jonas');
  const other = login('other');
  assert.ok(server.view(jonas).server.capabilityExtensions.includes('PROFILES'));
  assert.throws(() => server.handle(jonas, 'updateprofile', { color: '#ff0000' }), { code: 'profile_required' });
  assert.throws(() => server.handle(jonas, 'setprofilepassword', { password: 'x' }), { code: 'invalid_args' });

  server.handle(jonas, 'setprofilepassword', { password: 'segredo' });
  assert.equal(notes(other, 'notifyclientupdated').at(-1).args.client.hasProfile, true);

  server.disconnect(jonas);
  const again = server.connect();
  assert.throws(() => server.handle(again, 'login', { nickname: 'jonas', uid: 'u2' }), { code: 'profile_password' });
  assert.throws(() => server.handle(again, 'login', { nickname: 'jonas', uid: 'u2', profilePassword: 'errada' }), { code: 'profile_password' });
  server.handle(again, 'login', { nickname: 'jonas', uid: 'u2', profilePassword: 'segredo' });
  // o apelido é o da reivindicação, sem variar a caixa
  assert.equal(server.view(again).clients.find(c => c.clid === again).nickname, 'Jonas');
});

test('perfil: apelido não muda nem pode ser assumido por clientupdate', () => {
  const { server, login } = profileSetup();
  const jonas = login('Jonas');
  const other = login('other');
  server.handle(jonas, 'setprofilepassword', { password: 'segredo' });
  assert.throws(() => server.handle(jonas, 'clientupdate', { nickname: 'novo' }), { code: 'permission_denied' });
  assert.throws(() => server.handle(other, 'clientupdate', { nickname: 'JONAS' }), { code: 'profile_password' });
});

test('perfil: troca de senha exige a atual', () => {
  const { server, login } = profileSetup();
  const jonas = login('Jonas');
  server.handle(jonas, 'setprofilepassword', { password: 'segredo' });
  assert.throws(() => server.handle(jonas, 'setprofilepassword', { password: 'nova1' }), { code: 'profile_password' });
  server.handle(jonas, 'setprofilepassword', { password: 'nova1', currentPassword: 'segredo' });
  server.disconnect(jonas);
  server.handle(server.connect(), 'login', { nickname: 'Jonas', uid: 'u', profilePassword: 'nova1' });
});

test('perfil: tentativas demais bloqueiam por um minuto', () => {
  let now = 1000;
  const { server, login } = profileSetup(null, () => now);
  const jonas = login('Jonas');
  server.handle(jonas, 'setprofilepassword', { password: 'segredo' });
  const attempt = password => server.handle(server.connect(), 'login', { nickname: 'Jonas', uid: 'u', profilePassword: password });
  for (let i = 0; i < 5; i++) assert.throws(() => attempt('errada'), { code: 'profile_password' });
  assert.throws(() => attempt('segredo'), { code: 'profile_locked' });
  now += 60_001;
  attempt('segredo');
});

test('perfil: dados validados, públicos e no nome mostrado pela sala', () => {
  const { server, login, notes } = profileSetup();
  const jonas = login('Jonas');
  const viewer = login('viewer');
  server.handle(jonas, 'setprofilepassword', { password: 'segredo' });
  assert.throws(() => server.handle(jonas, 'updateprofile', { color: 'red;x' }), { code: 'invalid_args' });
  assert.throws(() => server.handle(jonas, 'updateprofile', { avatar: 'data:image/svg+xml;base64,AAAA' }), { code: 'invalid_args' });
  assert.throws(() => server.handle(jonas, 'updateprofile', { avatar: `data:image/png;base64,${'A'.repeat(70_000)}` }), { code: 'payload_too_large' });
  server.handle(jonas, 'updateprofile', { displayName: ' Jonas H ', color: '#12ab9F', description: 'oi', avatar: 'data:image/png;base64,AAAA' });
  const { client } = notes(viewer, 'notifyclientupdated').at(-1).args;
  assert.deepEqual([client.nickname, client.displayName, client.color, client.description, client.avatar],
    ['Jonas', 'Jonas H', '#12ab9F', 'oi', 'data:image/png;base64,AAAA']);

  const { streamIdentifier } = server.handle(jonas, 'setupstream', {});
  assert.equal(server.streams.get(streamIdentifier).name, 'Stream de Jonas H');
  assert.equal(server.liveSnapshot().streams[0].owner, 'Jonas H');
  // o hash nunca sai do servidor
  assert.equal(JSON.stringify(server.view(viewer)).includes('pbkdf2'), false);
});

test('perfil: banner fica fora da lista e é baixado sob demanda', () => {
  const { server, login } = profileSetup();
  const jonas = login('Jonas');
  const other = login('other');
  server.handle(jonas, 'setprofilepassword', { password: 'segredo' });
  assert.ok(server.view(jonas).server.capabilityExtensions.includes('PROFILE_MEDIA'));
  assert.throws(() => server.handle(jonas, 'updateprofile', { banner: 'data:image/svg+xml;base64,AAAA' }), { code: 'invalid_args' });
  assert.throws(() => server.handle(jonas, 'updateprofile', { banner: `data:image/gif;base64,${'A'.repeat(460_000)}` }), { code: 'payload_too_large' });
  server.handle(jonas, 'updateprofile', { banner: 'data:image/gif;base64,AAAA' });
  const listed = server.view(other).clients.find(c => c.nickname === 'Jonas');
  assert.equal('banner' in listed, false);
  assert.match(listed.mediaTag, /^[0-9a-f]{12}$/);
  assert.deepEqual(server.handle(other, 'profilemedia', { clid: jonas }),
    { mediaTag: listed.mediaTag, banner: 'data:image/gif;base64,AAAA', avatarAnimated: '' });
  assert.throws(() => server.handle(other, 'profilemedia', { clid: 999 }), { code: 'invalid_args' });
  server.handle(jonas, 'updateprofile', { banner: '' });
  assert.equal(server.view(other).clients.find(c => c.nickname === 'Jonas').mediaTag, '');
  assert.throws(() => server.handle(jonas, 'updateprofile', { avatarAnimated: 'data:image/png;base64,AAAA' }), { code: 'invalid_args' });
  server.handle(jonas, 'updateprofile', { avatar: 'data:image/jpeg;base64,AAAA', avatarAnimated: 'data:image/gif;base64,BBBB' });
  const animated = server.view(other).clients.find(c => c.nickname === 'Jonas');
  assert.equal(animated.avatar, 'data:image/jpeg;base64,AAAA');
  assert.equal('avatarAnimated' in animated, false);
  assert.equal(server.handle(other, 'profilemedia', { clid: jonas }).avatarAnimated, 'data:image/gif;base64,BBBB');
});

test('perfil: sobrevive a reiniciar o servidor', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'openspeak-')), 'sub', 'profiles.json');
  const first = profileSetup(file);
  const jonas = first.login('Jonas');
  first.server.handle(jonas, 'setprofilepassword', { password: 'segredo' });
  first.server.handle(jonas, 'updateprofile', { color: '#112233' });

  const second = profileSetup(file);
  const clid = second.server.connect();
  second.server.handle(clid, 'login', { nickname: 'Jonas', uid: 'u', profilePassword: 'segredo' });
  assert.equal(second.server.view(clid).clients[0].color, '#112233');
});

test('perfil: senha gerada pelo monitor vale sem reiniciar o servidor', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'openspeak-')), 'profiles.json');
  const { server, login } = profileSetup(file);
  server.handle(login('Jonas'), 'setprofilepassword', { password: 'segredo' });

  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.profiles.jonas.password = hashPassword('gerada');
  writeFileSync(file, JSON.stringify(data));
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);

  assert.throws(() => server.handle(server.connect(), 'login', { nickname: 'Jonas', uid: 'u', profilePassword: 'segredo' }), { code: 'profile_password' });
  server.handle(server.connect(), 'login', { nickname: 'Jonas', uid: 'u', profilePassword: 'gerada' });
});

test('perfil: sem ProfileStore o servidor não anuncia PROFILES', () => {
  const { server, login } = setup();
  const a = login('a');
  assert.equal(server.view(a).server.capabilityExtensions.includes('PROFILES'), false);
  assert.throws(() => server.handle(a, 'setprofilepassword', { password: 'segredo' }), { code: 'mode_not_supported' });
});

test('perfil: hash no formato compartilhado com o servidor nativo', () => {
  const stored = hashPassword('senha', Buffer.from('0123456789abcdef'), 1000);
  assert.equal(stored, 'pbkdf2-sha256$1000$MDEyMzQ1Njc4OWFiY2RlZg==$yNWjOB5+y96EHOKAn3xp3CM7YwtRLFxNMPHfhb8vN8c=');
  assert.equal(checkPassword('senha', stored), true);
  assert.equal(checkPassword('outra', stored), false);
});
