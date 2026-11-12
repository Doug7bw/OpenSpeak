import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubIssues, OPENSPEAK_FACTS, duplicateComment, fallbackDraft, issueBody, issueMessages, latestChanges, mentionsOpenSpeak,
  openspeakMessages, parseIssueDraft, parseOpenSpeakQuestion, renderIssueDraft, resetChangelogCache, summarizeChangelog, takeIssueQuota,
} from '../src/openspeak.js';
import { KINDS, answerMessages, parseGatewayAnswer } from '../src/ask.js';

test('reconhece o OpenSpeak escrito de vários jeitos', () => {
  assert.ok(mentionsOpenSpeak('como baixo o OpenSpeak?'));
  assert.ok(mentionsOpenSpeak('o open speak tá travando'));
  assert.ok(!mentionsOpenSpeak('melhor build pra seven'));
});

test('pergunta, relato ou deixa para a IA', () => {
  assert.equal(parseOpenSpeakQuestion('como baixo o openspeak?'), 'openspeak');
  assert.equal(parseOpenSpeakQuestion('onde fica a captura alternativa do openspeak'), 'openspeak');
  assert.equal(parseOpenSpeakQuestion('o openspeak podia ter atalho pra pausar'), 'issue');
  assert.equal(parseOpenSpeakQuestion('bug: o áudio some quando troco de janela'), 'issue');
  assert.equal(parseOpenSpeakQuestion('Sugestão: tema claro'), 'issue');
  assert.equal(parseOpenSpeakQuestion('o openspeak tá travando?'), null); // pergunta + relato: a IA decide
  assert.equal(parseOpenSpeakQuestion('quem countera o billy?'), null);
});

test('o classificador aceita os tipos novos', () => {
  assert.ok(KINDS.includes('openspeak') && KINDS.includes('issue'));
  assert.equal(parseGatewayAnswer('{"tipo":"issue","heroi":null,"item":null,"rank":"todos"}').kind, 'issue');
  assert.equal(parseGatewayAnswer('{"tipo":"openspeak"}').kind, 'openspeak');
});

test('a base tem o link de download e não fala de senha', () => {
  assert.match(OPENSPEAK_FACTS, /releases\/latest\/download\/OpenSpeak-Setup\.exe/);
  const [system] = openspeakMessages('qual a senha?', 'ÚLTIMAS VERSÕES');
  assert.match(system.content, /Nunca informe senha/);
  assert.match(system.content, /CHANGELOG:\nÚLTIMAS VERSÕES/);
});

test('resumo do CHANGELOG: índice e as últimas entradas', () => {
  const md = '# OpenSpeak 1.0.3 — c\n\n- três\n\n# OpenSpeak 1.0.2 — b\n\n- dois\n\n# OpenSpeak 1.0.1 — a\n\n- um\n';
  const s = summarizeChangelog(md, 2);
  assert.match(s, /- três/);
  assert.match(s, /- dois/);
  assert.doesNotMatch(s, /- um/);
  assert.match(s, /TODAS AS VERSÕES:\nOpenSpeak 1.0.3 — c\nOpenSpeak 1.0.2 — b\nOpenSpeak 1.0.1 — a/);
  assert.equal(summarizeChangelog(''), '');
});

test('CHANGELOG em cache e falha silenciosa', async () => {
  resetChangelogCache();
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, text: async () => '# OpenSpeak 1.0.9 — x\n- y' }; };
  assert.match(await latestChanges({ fetchImpl: ok, now: 1000 }), /1\.0\.9/);
  await latestChanges({ fetchImpl: ok, now: 2000 });
  assert.equal(calls, 1);
  resetChangelogCache();
  assert.equal(await latestChanges({ fetchImpl: async () => { throw new Error('rede'); }, now: 1000 }), '');
});

test('rascunho da IA: só duplicada que existe', () => {
  const open = [{ number: 7, title: 'Áudio some', url: 'https://github.com/x/7' }];
  const d = parseIssueDraft('ok {"titulo":"Áudio some ao trocar de janela","corpo":"Detalhes","tipo":"bug","duplicada":7}', open);
  assert.equal(d.kind, 'bug');
  assert.equal(d.duplicate.number, 7);
  assert.equal(parseIssueDraft('{"titulo":"x","tipo":"??","duplicada":99}', open).duplicate, null);
  assert.equal(parseIssueDraft('{"titulo":"x","tipo":"??"}').kind, 'outro');
  assert.throws(() => parseIssueDraft('{"titulo":""}'));
  assert.throws(() => parseIssueDraft('nada'));
  assert.match(issueMessages('relato', open)[0].content, /#7: Áudio some/);
});

test('rascunho sem IA usa o próprio relato', () => {
  const d = fallbackDraft('bug: o openspeak não funciona com dois monitores');
  assert.equal(d.kind, 'bug');
  assert.equal(d.title, 'o openspeak não funciona com dois monitores');
  assert.equal(fallbackDraft('sugestão: podia ter tema claro').kind, 'sugestao');
});

test('corpo e comentário citam o relato e o nome, sem IDs', () => {
  const body = issueBody({ body: 'Resumo' }, { text: 'linha 1\nlinha 2', author: 'Fulano' });
  assert.match(body, /^Resumo/);
  assert.match(body, /por Fulano\):\n> linha 1\n> linha 2/);
  assert.doesNotMatch(body, /\d{17,}/);
  assert.match(duplicateComment({ text: 'oi', author: 'Ciclano' }), /\(Ciclano\):\n> oi/);
});

test('limite de relatos por dia', () => {
  const day = 24 * 3600_000;
  assert.deepEqual(takeIssueQuota(undefined, 10), [10]);
  assert.equal(takeIssueQuota([1, 2, 3], 10), null);
  assert.deepEqual(takeIssueQuota([1, 2, 3], day + 2), [3, day + 2]);
});

test('prévia: botões de abrir, somar à duplicada e cancelar', () => {
  const plain = renderIssueDraft({ id: 'abc', draft: { title: 'T', body: '', kind: 'bug', duplicate: null }, text: 'relato' });
  assert.deepEqual(plain.components[0].components.map(b => b.data.custom_id), ['is:open:abc', 'is:cancel:abc']);
  const dup = renderIssueDraft({ id: 'abc', draft: { title: 'T', body: 'b', kind: 'sugestao', duplicate: { number: 4, title: 'X', url: 'https://g/4' } }, text: 'r' });
  assert.deepEqual(dup.components[0].components.map(b => b.data.custom_id), ['is:add:abc', 'is:open:abc', 'is:cancel:abc']);
});

test('GitHub: lista sem PRs, cria label só uma vez e abre a issue', async () => {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, opts) => {
    calls.push(`${opts.method} ${url.replace('https://api.github.com/repos/o/r', '')}`);
    assert.match(opts.headers.authorization, /^Bearer tok$/);
    if (opts.method === 'GET') return reply(200, [{ number: 1, title: 'a', html_url: 'u1' }, { number: 2, title: 'pr', pull_request: {} }]);
    if (url.endsWith('/labels')) return reply(422, { message: 'already_exists' });
    if (url.endsWith('/issues')) {
      assert.deepEqual(JSON.parse(opts.body).labels, ['frisquila', 'bug']);
      return reply(201, { number: 3, html_url: 'u3', title: 't' });
    }
    return reply(201, { html_url: 'c' });
  };
  const gh = new GitHubIssues({ token: 'tok', repo: 'o/r', fetchImpl });
  assert.deepEqual(await gh.listOpen(), [{ number: 1, title: 'a', url: 'u1' }]);
  await gh.listOpen(); // cache
  assert.deepEqual(await gh.create({ title: 't', body: 'b', labels: ['bug'] }), { number: 3, url: 'u3', title: 't' });
  await gh.create({ title: 't', body: 'b', labels: ['bug'] });
  await gh.comment(1, 'oi');
  assert.deepEqual(calls, ['GET /issues?state=open&labels=frisquila&per_page=50', 'POST /labels', 'POST /issues', 'POST /issues', 'POST /issues/1/comments']);
});

test('GitHub: erro vira exceção com o status', async () => {
  const gh = new GitHubIssues({ token: 't', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) }) });
  await assert.rejects(gh.listOpen(), err => err.status === 401 && /Bad credentials/.test(err.message));
});

test('Deadlock: curiosidade sem resposta vira piada, pergunta séria manda para a wiki', () => {
  const [system] = answerMessages('o viscous é casado?', '');
  assert.match(system.content, /piada curta/);
  assert.match(system.content, /sem afirmar nada como fato/);
  assert.match(system.content, /deadlock\.wiki/);
});
