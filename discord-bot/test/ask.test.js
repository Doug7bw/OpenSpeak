import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askGateway, findHeroInText, gatewayMessages, parseGatewayAnswer, parseQuestion } from '../src/ask.js';
import { normalize } from '../src/deadlock.js';

const hero = (id, name, namePt = name, cls = name) => ({ id, name, namePt, keys: [normalize(name), normalize(namePt), normalize(cls)] });
const HEROES = [hero(2, 'Seven', 'Sete', 'gigawatt'), hero(13, 'Haze', 'Bruma'), hero(72, 'Billy'), hero(4, 'Lady Geist'),
  hero(18, 'Mo & Krill', 'Mo e Krill', 'krill'), hero(69, 'The Doorman', 'Porteiro', 'doorman')];

test('acha o herói citado, inclusive nome composto, português e apelido', () => {
  assert.equal(findHeroInText('<@123> melhor build pra seven', HEROES).name, 'Seven');
  assert.equal(findHeroInText('build da sete', HEROES).name, 'Seven');
  assert.equal(findHeroInText('como jogar de lady geist?', HEROES).name, 'Lady Geist');
  assert.equal(findHeroInText('quem countera o mo?', HEROES).name, 'Mo & Krill');
  assert.equal(findHeroInText('build pra seven contra haze', HEROES).name, 'Seven'); // o primeiro citado
  assert.equal(findHeroInText('bom dia pessoal', HEROES), null);
});

test('entende sozinho o tipo e o rank quando a pergunta é clara', () => {
  assert.deepEqual(pick(parseQuestion('melhor build pra seven', HEROES)), ['build', 'Seven', 'todos']);
  assert.deepEqual(pick(parseQuestion('quem countera o billy?', HEROES)), ['counter', 'Billy', 'todos']);
  assert.deepEqual(pick(parseQuestion('quem ganha do billy em oracle', HEROES)), ['counter', 'Billy', 'alto']);
  assert.deepEqual(pick(parseQuestion('haze tá forte em eternus?', HEROES)), ['heroi', 'Haze', 'topo']);
  assert.deepEqual(pick(parseQuestion('que itens comprar de bruma', HEROES)), ['build', 'Haze', 'todos']);
  assert.deepEqual(pick(parseQuestion('build pra seven contra haze', HEROES)), ['build', 'Seven', 'todos']);
  // Sem herói ou sem palavra-chave: deixa para a IA.
  assert.equal(parseQuestion('qual o melhor herói pra iniciante?', HEROES), null);
  assert.equal(parseQuestion('seven', HEROES), null);
});

function pick(q) {
  return q && [q.kind, q.hero.name, q.rank];
}

test('resposta da IA: JSON (mesmo com texto em volta) vira tipo, herói e rank válidos', () => {
  assert.deepEqual(parseGatewayAnswer('{"tipo":"counter","heroi":"Billy","rank":"alto"}'), { kind: 'counter', heroName: 'Billy', itemName: null, rank: 'alto' });
  assert.deepEqual(parseGatewayAnswer('Claro! {"tipo":"outro","heroi":null,"rank":"xyz"}'), { kind: null, heroName: null, itemName: null, rank: 'todos' });
  assert.throws(() => parseGatewayAnswer('não sei'));
  const msgs = gatewayMessages('qual o melhor herói?', HEROES);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /Seven \(Sete\)/);
});

test('cliente do gateway: resposta inválida pede de novo sem aquele provedor', async () => {
  const pedidos = [];
  const fetchImpl = async (url, opts) => {
    pedidos.push({ url, auth: opts.headers.authorization, body: JSON.parse(opts.body) });
    const texto = pedidos.length === 1 ? 'lixo' : '{"tipo":"build","heroi":"Seven","rank":"todos"}';
    return { ok: true, json: async () => ({ texto, provedor: pedidos.length === 1 ? 'groq' : 'gemini', modelo: 'm' }) };
  };
  const r = await askGateway({ url: 'http://127.0.0.1:8092/', token: 'iag_x', fetchImpl }, [{ role: 'user', content: 'oi' }]);
  assert.deepEqual(r, { kind: 'build', heroName: 'Seven', itemName: null, rank: 'todos' });
  assert.equal(pedidos[0].url, 'http://127.0.0.1:8092/v1/chat');
  assert.equal(pedidos[0].auth, 'Bearer iag_x');
  assert.equal(pedidos[0].body.tarefa, 'frisquila');
  assert.deepEqual(pedidos[1].body.excluir, ['groq']);
  assert.equal(pedidos[1].body.rejeitado.provedor, 'groq');
  await assert.rejects(askGateway({ url: 'http://x', token: 't', fetchImpl: async () => ({ ok: false, status: 503 }) }, []));
});

const ITEMS = [
  { id: 1, name: 'Toxic Bullets', namePt: 'Balas Tóxicas', shopable: true, slot: 'weapon', cost: 1600, desc: 'Sangramento.', keys: [normalize('Toxic Bullets'), normalize('Balas Tóxicas')] },
  { id: 2, name: 'Decay', namePt: 'Degeneração', shopable: true, slot: 'spirit', cost: 3200, desc: 'Anticura.', keys: [normalize('Decay'), normalize('Degeneração')] },
];

test('tipos novos: info, itens contra, ranking e item', () => {
  assert.deepEqual(pick(parseQuestion('que herói é o billy?', HEROES, ITEMS)), ['info', 'Billy', 'todos']);
  assert.deepEqual(pick(parseQuestion('qual a lore da lady geist', HEROES, ITEMS)), ['info', 'Lady Geist', 'todos']);
  assert.deepEqual(pick(parseQuestion('habilidades do seven', HEROES, ITEMS)), ['info', 'Seven', 'todos']);
  assert.deepEqual(pick(parseQuestion('ordem de habilidades do seven', HEROES, ITEMS)), ['build', 'Seven', 'todos']);
  assert.deepEqual(pick(parseQuestion('melhores itens pra counterar o haze', HEROES, ITEMS)), ['itens_contra', 'Haze', 'todos']);
  assert.deepEqual(pick(parseQuestion('que item comprar contra billy em eternus', HEROES, ITEMS)), ['itens_contra', 'Billy', 'topo']);
  const ranking = parseQuestion('melhores heróis agora em oracle', HEROES, ITEMS);
  assert.deepEqual([ranking.kind, ranking.rank], ['ranking', 'alto']);
  assert.equal(parseQuestion('tier list atual', HEROES, ITEMS).kind, 'ranking');
  const item = parseQuestion('o que faz o toxic bullets?', HEROES, ITEMS);
  assert.deepEqual([item.kind, item.item.name], ['item', 'Toxic Bullets']);
  assert.equal(parseQuestion('balas tóxicas', HEROES, ITEMS).item.name, 'Toxic Bullets');
  assert.equal(parseQuestion('como funciona a urna?', HEROES, ITEMS), null); // aberta: vai para a IA
});

test('contexto oficial para a IA: lore, habilidades e item citados', async () => {
  const { officialContext, answerMessages } = await import('../src/ask.js');
  const billy = { ...HEROES.find(h => h.name === 'Billy'), lore: 'Bodeficação da raiva.', role: 'brawler', tags: ['Punk'],
    abilities: new Map([[9, { slot: 1, name: 'Bashdown', namePt: 'Tacada', desc: 'Bate o taco.' }]]) };
  const ctx = officialContext('o decay é bom contra o billy?', [billy, ...HEROES.filter(h => h.name !== 'Billy')], ITEMS);
  assert.match(ctx, /Bodeficação/);
  assert.match(ctx, /Tacada \(Bashdown\): Bate o taco/);
  assert.match(ctx, /ITEM Decay \(Degeneração\).*Anticura/);
  const msgs = answerMessages('pergunta?', ctx);
  assert.match(msgs[1].content, /^CONTEXTO:/);
  assert.match(msgs[0].content, /nunca invente/);
  assert.match(msgs[0].content, /FATOS:\n.*Valve/);
});
