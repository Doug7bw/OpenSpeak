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
  assert.deepEqual(parseGatewayAnswer('{"tipo":"counter","heroi":"Billy","rank":"alto"}'), { kind: 'counter', heroName: 'Billy', rank: 'alto' });
  assert.deepEqual(parseGatewayAnswer('Claro! {"tipo":"outro","heroi":null,"rank":"xyz"}'), { kind: null, heroName: null, rank: 'todos' });
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
  assert.deepEqual(r, { kind: 'build', heroName: 'Seven', rank: 'todos' });
  assert.equal(pedidos[0].url, 'http://127.0.0.1:8092/v1/chat');
  assert.equal(pedidos[0].auth, 'Bearer iag_x');
  assert.equal(pedidos[0].body.tarefa, 'frisquila');
  assert.deepEqual(pedidos[1].body.excluir, ['groq']);
  assert.equal(pedidos[1].body.rejeitado.provedor, 'groq');
  await assert.rejects(askGateway({ url: 'http://x', token: 't', fetchImpl: async () => ({ ok: false, status: 503 }) }, []));
});
