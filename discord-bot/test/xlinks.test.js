import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CONTENT, chooseLinkAction, linkSettings, rewriteXLinks, webhookName } from '../src/xlinks.js';

test('troca x.com e twitter.com (com www/mobile) por fxtwitter e tira o rastreio', () => {
  const cases = [
    ['https://x.com/jack/status/20', 'https://fxtwitter.com/jack/status/20'],
    ['https://twitter.com/jack/status/20?s=20&t=abc', 'https://fxtwitter.com/jack/status/20'],
    ['http://www.x.com/Some_User/status/123456789012345678?t=xyz#m', 'https://fxtwitter.com/Some_User/status/123456789012345678'],
    ['https://mobile.twitter.com/jack/statuses/20', 'https://fxtwitter.com/jack/status/20'],
    ['https://x.com/jack/status/20/photo/1', 'https://fxtwitter.com/jack/status/20/photo/1'],
    ['https://x.com/i/web/status/20', 'https://fxtwitter.com/i/web/status/20'],
    ['https://X.COM/jack/status/20/', 'https://fxtwitter.com/jack/status/20'],
  ];
  for (const [input, expected] of cases) assert.equal(rewriteXLinks(input).content, expected, input);
});

test('mantém o resto do texto e não repete links', () => {
  const { content, links } = rewriteXLinks('olha isso https://x.com/a/status/1?s=20 e (https://twitter.com/a/status/1) kkk');
  assert.equal(content, 'olha isso https://fxtwitter.com/a/status/1 e (https://fxtwitter.com/a/status/1) kkk');
  assert.deepEqual(links, ['https://fxtwitter.com/a/status/1']);
});

test('ignora links que não são post, outros domínios e links sem prévia (< >)', () => {
  for (const text of ['https://x.com/jack', 'https://notx.com/a/status/1', 'https://fxtwitter.com/a/status/1',
    '<https://x.com/a/status/1>', 'sem link nenhum', '']) {
    assert.deepEqual(rewriteXLinks(text).links, [], text);
  }
});

test('usa o serviço escolhido', () => {
  assert.equal(rewriteXLinks('https://x.com/a/status/1', 'fixupx.com').content, 'https://fixupx.com/a/status/1');
});

test('config por servidor: desligada e no modo responder por padrão', () => {
  assert.deepEqual(linkSettings(undefined), { enabled: false, mode: 'responder', service: 'fxtwitter.com', scope: 'usuarios' });
  assert.deepEqual(linkSettings({ enabled: true, mode: 'substituir', service: 'vxtwitter.com', scope: 'usuarios' }),
    { enabled: true, mode: 'substituir', service: 'vxtwitter.com', scope: 'usuarios' });
  assert.deepEqual(linkSettings({ enabled: 'sim', mode: 'xyz', service: 'evil.com', scope: 'x' }),
    { enabled: false, mode: 'responder', service: 'fxtwitter.com', scope: 'usuarios' });
});

test('escolhe entre webhook e resposta', () => {
  const ok = { mode: 'substituir', isReply: false, hasExtras: false, contentLength: 50, canWebhook: true, canDelete: true, canSend: true };
  assert.equal(chooseLinkAction(ok), 'webhook');
  assert.equal(chooseLinkAction({ ...ok, mode: 'responder' }), 'reply');
  assert.equal(chooseLinkAction({ ...ok, isReply: true }), 'reply');
  assert.equal(chooseLinkAction({ ...ok, hasExtras: true }), 'reply');
  assert.equal(chooseLinkAction({ ...ok, contentLength: MAX_CONTENT + 1 }), 'reply');
  assert.equal(chooseLinkAction({ ...ok, canWebhook: false }), 'reply');
  assert.equal(chooseLinkAction({ ...ok, canDelete: false }), 'reply');
  assert.equal(chooseLinkAction({ ...ok, mode: 'responder', canSend: false }), null);
});

test('nome do webhook aceito pelo Discord', () => {
  assert.equal(webhookName('  '), 'Alguém');
  assert.equal(webhookName('x'.repeat(100)).length, 80);
  assert.doesNotMatch(webhookName('Discord Fan'), /discord/i);
  assert.doesNotMatch(webhookName('clyde'), /clyde/i);
});
