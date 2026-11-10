import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig, guildNotices, migrateMessages, migrateSettings } from '../src/live.js';

const base = () => {
  const c = { openspeakUrl: 'https://x.y' };
  checkConfig(c);
  return c;
};

test('cada servidor tem os próprios avisos, com o config.json de padrão', () => {
  const c = base();
  c.chat.mention = '@here';
  const guilds = {
    g1: { chat: { enabled: true, channelId: '111', mention: '' }, voiceStatus: { enabled: true, channelId: '222' } },
    g2: { voiceStatus: { enabled: true } },
  };
  assert.deepEqual(guildNotices(c, guilds.g1, 'g1'), {
    allowed: true,
    chat: { enabled: true, channelId: '111', mention: '' },
    voiceStatus: { enabled: true, channelId: '222' },
  });
  const g2 = guildNotices(c, guilds.g2, 'g2');
  assert.deepEqual(g2.chat, { enabled: false, channelId: '', mention: '@here' });
  assert.deepEqual(g2.voiceStatus, { enabled: true, channelId: '' });
  assert.equal(guildNotices(c, undefined, 'g3').voiceStatus.enabled, false);
});

test('guildId na config: avisos só naquele servidor', () => {
  const c = { ...base(), guildId: '123456789012345678' };
  const on = { chat: { enabled: true, channelId: '1' }, voiceStatus: { enabled: true } };
  assert.equal(guildNotices(c, on, '123456789012345678').chat.enabled, true);
  const other = guildNotices(c, on, '999999999999999999');
  assert.equal(other.allowed, false);
  assert.equal(other.chat.enabled, false);
  assert.equal(other.voiceStatus.enabled, false);
});

test('mensagens publicadas no formato antigo viram posts por servidor', () => {
  const old = { 's1@1': { channelId: 'c1', messageId: 'm1', stream: { id: 's1' }, watchers: ['Ana'] } };
  assert.deepEqual(migrateMessages(old, id => (id === 'c1' ? 'g1' : undefined)), {
    's1@1': { stream: { id: 's1' }, watchers: ['Ana'], posts: { g1: { channelId: 'c1', messageId: 'm1' } } },
  });
  // Sem saber o servidor: a chave vira o canal. Formato novo passa direto.
  assert.deepEqual(Object.keys(migrateMessages(old)['s1@1'].posts), ['c1']);
  const current = { k: { stream: {}, watchers: [], posts: { g: { channelId: 'c', messageId: 'm' } } } };
  assert.deepEqual(migrateMessages(current), current);
});

test('escolhas antigas do /openspeak vão para o servidor certo', () => {
  const settings = { chat: { enabled: true, channelId: 'c1' }, voiceStatus: { enabled: true }, presence: { enabled: true } };
  const out = migrateSettings(settings, {}, { chatGuild: 'g1', guildIds: ['g1', 'g2'] });
  assert.deepEqual(out.settings, { presence: { enabled: true } }); // status do bot continua global
  assert.deepEqual(out.guilds, {
    g1: { chat: { enabled: true, channelId: 'c1' }, voiceStatus: { enabled: true } },
    g2: { voiceStatus: { enabled: true } }, // o automático valia em todos
  });
  // Servidor principal da config (guildId) recebe tudo; o que já é por servidor não é sobrescrito.
  const home = migrateSettings(settings, { g1: { chat: { channelId: 'novo' } } }, { guildIds: ['g1', 'g2'], homeGuild: 'g1' });
  assert.deepEqual(home.guilds, { g1: { chat: { enabled: true, channelId: 'novo' }, voiceStatus: { enabled: true } } });
});
