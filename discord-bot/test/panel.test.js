import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, mentionChoice, renderPanel, renderUserLinks } from '../src/panel.js';
import { linksApplyTo, linkSettings } from '../src/xlinks.js';

const view = (over = {}) => ({
  notice: null,
  guild: { name: 'Servidor de Jonas', iconURL: 'https://cdn.discordapp.com/icons/1/a.png' },
  botAvatar: 'https://cdn.discordapp.com/avatars/1/b.png',
  openspeakUrl: 'https://openspeak.duckdns.org',
  allowed: true,
  chat: { enabled: true, channelId: '123456789012345678', mention: '<@&223456789012345678>' },
  voice: { enabled: false, channelId: '' },
  links: linkSettings({ enabled: true }),
  presence: { enabled: true, canChange: false, text: 'Jonas transmitindo Chrome' },
  live: 1,
  stats: { usuarios: '3' },
  warnings: { chat: [], voice: [], links: ['Me falta **Gerenciar mensagens**.'] },
  ...over,
});

/** Gera o JSON (o discord.js valida os limites aqui) e confere as regras do Discord. */
function check(message) {
  const embeds = message.embeds.map(e => e.toJSON());
  const rows = message.components.map(r => r.toJSON());
  assert.ok(rows.length <= 5, 'no máximo 5 linhas');
  const ids = [];
  for (const r of rows) {
    assert.ok(r.components.length >= 1 && r.components.length <= 5);
    const selects = r.components.filter(c => c.type !== 2);
    if (selects.length) assert.equal(r.components.length, 1, 'menu ocupa a linha sozinho');
    for (const c of r.components) if (c.custom_id) ids.push(c.custom_id);
  }
  assert.equal(new Set(ids).size, ids.length, 'customIds únicos');
  for (const e of embeds) {
    assert.ok((e.description ?? '').length <= 4096);
    for (const f of e.fields ?? []) assert.ok(f.value.length > 0 && f.value.length <= 1024, f.name);
  }
  return { embeds, rows, ids };
}

test('todas as páginas do painel montam dentro dos limites do Discord', () => {
  for (const page of Object.keys(PAGES)) {
    check(renderPanel(page, view()));
    check(renderPanel(page, view({ allowed: false, notice: '✅ Salvo.', chat: { enabled: false, channelId: '', mention: '' } })));
  }
  check(renderPanel('inexistente', view())); // cai na visão geral
});

test('visão geral: um botão por recurso, verde quando ligado', () => {
  const { rows, ids } = check(renderPanel('inicio', view()));
  assert.ok(ids.includes('os:page'));
  const toggles = rows[1].components;
  assert.deepEqual(toggles.map(b => b.custom_id), ['os:t:chat:inicio', 'os:t:voz:inicio', 'os:t:links:inicio', 'os:t:status:inicio']);
  assert.equal(toggles[0].style, 3); // Success: chat ligado
  assert.equal(toggles[1].style, 2); // Secondary: voz desligada
  assert.equal(toggles[3].disabled, true); // status do bot: só o dono
  assert.ok(rows[2].components.some(b => b.url === 'https://openspeak.duckdns.org'));
});

test('página do chat traz canal, menção e cargo já selecionados', () => {
  const { rows } = check(renderPanel('chat', view()));
  const channel = rows.find(r => r.components[0].custom_id === 'os:chatchan').components[0];
  assert.deepEqual(channel.default_values, [{ id: '123456789012345678', type: 'channel' }]);
  const mention = rows.find(r => r.components[0].custom_id === 'os:mention').components[0];
  assert.equal(mention.options.find(o => o.default)?.value, 'cargo');
  const role = rows.find(r => r.components[0].custom_id === 'os:role').components[0];
  assert.deepEqual(role.default_values, [{ id: '223456789012345678', type: 'role' }]);
});

test('servidor bloqueado pelo guildId: chat e voz desabilitados, links não', () => {
  const { rows } = check(renderPanel('inicio', view({ allowed: false })));
  const [chat, voz, links] = rows[1].components;
  assert.equal(chat.disabled, true);
  assert.equal(voz.disabled, true);
  assert.equal(links.disabled, false);
});

test('mentionChoice', () => {
  assert.equal(mentionChoice(''), 'ninguem');
  assert.equal(mentionChoice('@here'), '@here');
  assert.equal(mentionChoice('<@&1>'), 'cargo');
  assert.equal(mentionChoice('lixo'), 'ninguem');
});

test('painel pessoal do /links', () => {
  const off = renderUserLinks({ choice: undefined, avatar: null, guild: { name: 'S', links: linkSettings({ enabled: true }), applies: false } });
  const { rows } = check(off);
  assert.deepEqual(rows[0].components.map(b => [b.custom_id, !!b.disabled]), [['os:me:on', false], ['os:me:off', false]]);
  const on = check(renderUserLinks({ choice: true, avatar: null }));
  assert.equal(on.rows[0].components[0].disabled, true);
});

test('quem tem os links corrigidos: opt-in por pessoa ou alcance "todos"', () => {
  const users = linkSettings({ enabled: true });
  const all = linkSettings({ enabled: true, scope: 'todos' });
  assert.equal(users.scope, 'usuarios'); // padrão
  assert.equal(linksApplyTo(users, undefined), false);
  assert.equal(linksApplyTo(users, true), true);
  assert.equal(linksApplyTo(all, undefined), true);
  assert.equal(linksApplyTo(all, false), false);
  assert.equal(linksApplyTo(linkSettings({ enabled: false, scope: 'todos' }), true), false);
});

test('página do Deadlock: botão alterna entre respostas públicas e só para quem pediu', () => {
  const pub = check(renderPanel('deadlock', view()));
  const button = pub.rows[1].components[0];
  assert.equal(button.custom_id, 'os:t:dl:deadlock');
  assert.equal(button.style, 2); // públicas (padrão): desligado
  assert.match(pub.embeds[0].fields[0].value, /Públicas/);
  const eph = check(renderPanel('deadlock', view({ deadlock: { ephemeral: true } })));
  assert.equal(eph.rows[1].components[0].style, 3);
  assert.match(eph.embeds[0].fields[0].value, /Só para quem pediu/);
});
