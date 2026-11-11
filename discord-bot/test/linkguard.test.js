import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkGuard } from '../src/linkguard.js';

test('cada mensagem é tratada uma vez só (evento repetido ou edição durante a resposta)', () => {
  const g = new LinkGuard();
  assert.equal(g.claim('m1'), true);
  assert.equal(g.claim('m1'), false); // MESSAGE_CREATE repetido
  assert.equal(g.isHandled('m1'), true); // edição chegando enquanto a resposta sai: não corrige de novo
  assert.equal(g.claim('m2'), true);
});

test('links tirados e postos de volta: corrige de novo, uma vez', () => {
  const g = new LinkGuard();
  g.claim('m1');
  g.release('m1');
  assert.equal(g.claim('m1'), true);
  assert.equal(g.claim('m1'), false);
});

test('prévia que chega depois de o bot tirar (antes de a resposta sair) é tirada de novo', () => {
  let t = 0;
  const g = new LinkGuard({ watchMs: 1000, now: () => t });
  assert.equal(g.needsSuppress('m1', { embeds: 1 }), false); // não marcada: não mexe
  g.watchPreview('m1');
  assert.equal(g.needsSuppress('m1', { embeds: 0 }), false); // ainda sem prévia
  assert.equal(g.needsSuppress('m1', { embeds: 1 }), true); // prévia chegou
  assert.equal(g.needsSuppress('m1', { embeds: 1, suppressed: true }), false); // já tirada
  t = 2000;
  assert.equal(g.needsSuppress('m1', { embeds: 1 }), false); // passou o tempo de vigiar
  g.watchPreview('m2');
  g.stopWatching('m2'); // apagada
  assert.equal(g.needsSuppress('m2', { embeds: 1 }), false);
});

test('memória limitada', () => {
  const g = new LinkGuard({ max: 3 });
  for (const id of ['a', 'b', 'c', 'd']) { g.claim(id); g.watchPreview(id); }
  assert.equal(g.handled.size, 3);
  assert.equal(g.watch.size, 3);
  assert.equal(g.isHandled('a'), false); // a mais antiga saiu
});
