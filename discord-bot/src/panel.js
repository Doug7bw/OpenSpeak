// Painéis do bot (embeds + botões + menus). Só monta a mensagem a partir de um
// "retrato" da configuração; quem salva e aplica as mudanças é o bot.js.
//
// customId dos componentes: "os:<ação>[:<arg>]". Página atual vai junto quando a
// ação precisa redesenhar a mesma página.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder,
  RoleSelectMenuBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { LINK_SERVICES } from './xlinks.js';

export const BRAND = 0x1fa2ff;
const OFF = 0x4f545c;

export const PAGES = {
  inicio: { label: 'Visão geral', emoji: '🏠', description: 'Tudo o que o bot faz neste servidor' },
  chat: { label: 'Avisos no chat', emoji: '💬', description: 'Mensagem quando alguém começa a transmitir' },
  voz: { label: 'Status do canal de voz', emoji: '🔊', description: 'Quem está ao vivo, embaixo do nome da call' },
  links: { label: 'Links do X/Twitter', emoji: '🔗', description: 'Troca por fxtwitter para a prévia funcionar' },
  status: { label: 'Status do bot', emoji: '🤖', description: 'O status do bot na lista de membros (global)' },
};

export const LINK_MODES_INFO = {
  responder: { label: 'Responder', emoji: '↩️', description: 'Tira a prévia quebrada e responde com o link corrigido' },
  substituir: { label: 'Substituir', emoji: '🔁', description: 'Apaga e reenvia a mensagem como o autor (webhook)' },
};

export const LINK_SCOPES_INFO = {
  usuarios: { label: 'Só quem ativar', emoji: '🙋', description: 'Cada pessoa ativa para si com /links' },
  todos: { label: 'Todos', emoji: '👥', description: 'De todo mundo; quem não quiser desativa com /links' },
};

const MENTIONS = {
  ninguem: { label: 'Não mencionar ninguém', emoji: '🔕' },
  '@here': { label: '@here', emoji: '📣', description: 'Quem está online no canal' },
  '@everyone': { label: '@everyone', emoji: '📢', description: 'Todo mundo do servidor' },
  cargo: { label: 'Um cargo', emoji: '🏷️', description: 'Escolha o cargo no menu de baixo' },
};

const onOff = on => (on ? '🟢 **Ligado**' : '⚪ **Desligado**');
const row = (...components) => new ActionRowBuilder().addComponents(...components);

/** Valor da menção salvo ('', '@here', '@everyone' ou '<@&id>') -> opção do menu. */
export function mentionChoice(mention) {
  if (!mention) return 'ninguem';
  if (mention === '@here' || mention === '@everyone') return mention;
  return /^<@&\d+>$/.test(mention) ? 'cargo' : 'ninguem';
}

const roleId = mention => /^<@&(\d+)>$/.exec(mention ?? '')?.[1] ?? null;

function mentionText(mention) {
  if (!mention) return 'ninguém';
  return mention;
}

function pageSelect(page) {
  return new StringSelectMenuBuilder().setCustomId('os:page').setPlaceholder('Escolha uma seção…').addOptions(
    Object.entries(PAGES).map(([value, p]) => ({ value, label: p.label, emoji: p.emoji, description: p.description, default: value === page })),
  );
}

function toggleButton(id, on, { label, disabled = false, page }) {
  return new ButtonBuilder()
    .setCustomId(`os:t:${id}:${page}`)
    .setLabel(on ? `${label}: ligado` : `${label}: desligado`)
    .setEmoji(on ? '✅' : '⭕')
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(disabled);
}

function baseEmbed(v, title, on = true) {
  const embed = new EmbedBuilder().setColor(on ? BRAND : OFF).setTitle(title);
  if (v.guild?.name) embed.setAuthor({ name: v.guild.name, iconURL: v.guild.iconURL || undefined });
  if (v.botAvatar) embed.setThumbnail(v.botAvatar);
  const live = v.live > 0 ? `🔴 ${v.live} ao vivo` : 'Ninguém ao vivo';
  embed.setFooter({ text: `OpenSpeak · ${live} · ${v.stats.usuarios} online`, iconURL: v.botAvatar || undefined });
  return embed;
}

/** Descrição com o aviso da última ação em cima (✅ ok / ⚠️ problema). */
function describe(v, text) {
  return [v.notice, text].filter(Boolean).join('\n\n');
}

function chatSummary(c) {
  if (!c.enabled) return '⚪ Desligado';
  const where = c.channelId ? `<#${c.channelId}>` : '⚠️ escolha o canal';
  return `🟢 Ligado\n${where}${c.mention ? `\nMenciona ${c.mention}` : ''}`;
}

function voiceSummary(c) {
  if (!c.enabled) return '⚪ Desligado';
  return `🟢 Ligado\n${c.channelId ? `<#${c.channelId}>` : 'Calls com gente'}`;
}

function linksSummary(l) {
  if (!l.enabled) return '⚪ Desligado';
  return `🟢 ${LINK_MODES_INFO[l.mode].label}\n${l.service}\n${LINK_SCOPES_INFO[l.scope].label}`;
}

const spacer = { name: '​', value: '​', inline: true };

/** Painel do /openspeak: `page` é uma das chaves de PAGES; `v` vem do bot (panelView). */
export function renderPanel(page, v) {
  if (!PAGES[page]) page = 'inicio';
  const nav = row(pageSelect(page));
  const blocked = v.allowed ? null : '🔒 Os avisos de transmissão deste bot estão configurados só para outro servidor.';

  if (page === 'chat') {
    const c = v.chat;
    const embed = baseEmbed(v, '💬 Avisos no chat', c.enabled)
      .setDescription(describe(v, blocked ?? 'Quando alguém começa a transmitir no OpenSpeak, o bot posta um aviso no canal escolhido. '
        + 'Quando a transmissão termina, o aviso é atualizado com a duração e quem assistiu.'))
      .addFields(
        { name: 'Situação', value: onOff(c.enabled), inline: true },
        { name: 'Canal', value: c.channelId ? `<#${c.channelId}>` : '—', inline: true },
        { name: 'Menção', value: mentionText(c.mention), inline: true },
      );
    if (v.warnings.chat.length) embed.addFields({ name: '⚠️ Atenção', value: v.warnings.chat.join('\n') });
    const channel = new ChannelSelectMenuBuilder().setCustomId('os:chatchan').setPlaceholder('Escolher o canal dos avisos…')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setDisabled(!v.allowed);
    if (c.channelId) channel.setDefaultChannels(c.channelId);
    const choice = mentionChoice(c.mention);
    const mention = new StringSelectMenuBuilder().setCustomId('os:mention').setPlaceholder('Quem mencionar no aviso…').setDisabled(!v.allowed)
      .addOptions(Object.entries(MENTIONS).map(([value, m]) => ({ value, ...m, default: value === choice })));
    const role = new RoleSelectMenuBuilder().setCustomId('os:role').setPlaceholder('Cargo para mencionar…').setDisabled(!v.allowed);
    if (roleId(c.mention)) role.setDefaultRoles(roleId(c.mention));
    return {
      embeds: [embed],
      components: [nav, row(toggleButton('chat', c.enabled, { label: 'Avisos no chat', disabled: !v.allowed, page })),
        row(channel), row(mention), row(role)],
    };
  }

  if (page === 'voz') {
    const c = v.voice;
    const embed = baseEmbed(v, '🔊 Status do canal de voz', c.enabled)
      .setDescription(describe(v, blocked ?? 'Mostra quem está ao vivo no OpenSpeak embaixo do nome da call (o "status" do canal de voz). '
        + 'No automático, aparece em toda call com alguém conectado e some quando ela esvazia.'))
      .addFields(
        { name: 'Situação', value: onOff(c.enabled), inline: true },
        { name: 'Onde', value: c.channelId ? `<#${c.channelId}>` : 'Calls com alguém conectado', inline: true },
      );
    if (v.warnings.voice.length) embed.addFields({ name: '⚠️ Atenção', value: v.warnings.voice.join('\n') });
    const channel = new ChannelSelectMenuBuilder().setCustomId('os:voicechan').setPlaceholder('Fixar num canal de voz… (vazio = automático)')
      .setChannelTypes(ChannelType.GuildVoice).setMinValues(0).setMaxValues(1).setDisabled(!v.allowed);
    if (c.channelId) channel.setDefaultChannels(c.channelId);
    const auto = new ButtonBuilder().setCustomId('os:voiceauto').setLabel('Automático (calls com gente)').setEmoji('✨')
      .setStyle(ButtonStyle.Primary).setDisabled(!v.allowed || (c.enabled && !c.channelId));
    return {
      embeds: [embed],
      components: [nav, row(toggleButton('voz', c.enabled, { label: 'Status de voz', disabled: !v.allowed, page }), auto), row(channel)],
    };
  }

  if (page === 'links') {
    const l = v.links;
    const embed = baseEmbed(v, '🔗 Links do X/Twitter', l.enabled)
      .setDescription(describe(v, 'O Discord costuma mostrar a prévia de posts do X quebrada. O bot troca o link por um serviço que mostra '
        + 'a prévia certa (texto, fotos e vídeo) e tira o rastreio (`?s=20`). '
        + 'Com o alcance **Só quem ativar**, cada pessoa liga para si com `/links`.'))
      .addFields(
        { name: 'Situação', value: onOff(l.enabled), inline: true },
        { name: 'Modo', value: `${LINK_MODES_INFO[l.mode].emoji} ${LINK_MODES_INFO[l.mode].label}`, inline: true },
        { name: 'Alcance', value: `${LINK_SCOPES_INFO[l.scope].emoji} ${LINK_SCOPES_INFO[l.scope].label}`, inline: true },
        { name: 'Serviço', value: `🌐 ${l.service}`, inline: true },
      );
    if (v.warnings.links.length) embed.addFields({ name: '⚠️ Atenção', value: v.warnings.links.join('\n') });
    const mode = new StringSelectMenuBuilder().setCustomId('os:linkmode').setPlaceholder('Modo…')
      .addOptions(Object.entries(LINK_MODES_INFO).map(([value, m]) => ({ value, ...m, default: value === l.mode })));
    const scope = new StringSelectMenuBuilder().setCustomId('os:linkscope').setPlaceholder('Alcance…')
      .addOptions(Object.entries(LINK_SCOPES_INFO).map(([value, m]) => ({ value, ...m, default: value === l.scope })));
    const service = new StringSelectMenuBuilder().setCustomId('os:linkservice').setPlaceholder('Serviço…')
      .addOptions(LINK_SERVICES.map(s => ({ value: s, label: s, emoji: '🌐', default: s === l.service })));
    return {
      embeds: [embed],
      components: [nav, row(toggleButton('links', l.enabled, { label: 'Links do X', page })), row(mode), row(scope), row(service)],
    };
  }

  if (page === 'status') {
    const p = v.presence;
    const embed = baseEmbed(v, '🤖 Status do bot', p.enabled)
      .setDescription(describe(v, 'O status personalizado do bot na lista de membros: quem está transmitindo e a carga do servidor, '
        + 'alternando. Ele é **um só** e aparece em todos os servidores, por isso só o dono do bot liga ou desliga.'))
      .addFields(
        { name: 'Situação', value: onOff(p.enabled), inline: true },
        { name: 'Mostrando agora', value: p.text || '—', inline: true },
      );
    if (!p.canChange) embed.addFields({ name: '🔒 Só o dono do bot', value: 'Você pode ver, mas não mudar.' });
    return { embeds: [embed], components: [nav, row(toggleButton('status', p.enabled, { label: 'Status do bot', disabled: !p.canChange, page }))] };
  }

  // Visão geral: um resumo por aviso e um botão de liga/desliga para cada.
  const embed = baseEmbed(v, 'Painel do OpenSpeak')
    .setDescription(describe(v, [blocked,
      'Ligue e desligue cada recurso nos botões. Para escolher canal, menção, modo e outros detalhes, use o menu de seções.'].filter(Boolean).join('\n\n')))
    .addFields(
      { name: '💬 Avisos no chat', value: chatSummary(v.chat), inline: true },
      { name: '🔊 Status de voz', value: voiceSummary(v.voice), inline: true },
      spacer,
      { name: '🔗 Links do X', value: linksSummary(v.links), inline: true },
      { name: '🤖 Status do bot', value: v.presence.enabled ? '🟢 Ligado\nEm todos os servidores' : '⚪ Desligado', inline: true },
      spacer,
    );
  const warnings = [...v.warnings.chat, ...v.warnings.voice, ...v.warnings.links];
  if (warnings.length) embed.addFields({ name: '⚠️ Atenção', value: warnings.join('\n') });
  const toggles = row(
    toggleButton('chat', v.chat.enabled, { label: 'Chat', disabled: !v.allowed, page }),
    toggleButton('voz', v.voice.enabled, { label: 'Voz', disabled: !v.allowed, page }),
    toggleButton('links', v.links.enabled, { label: 'Links', page }),
    toggleButton('status', v.presence.enabled, { label: 'Status', disabled: !v.presence.canChange, page }),
  );
  const extra = row(
    new ButtonBuilder().setCustomId('os:refresh:inicio').setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('Abrir OpenSpeak').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(v.openspeakUrl),
  );
  return { embeds: [embed], components: [nav, toggles, extra] };
}

/** Painel pessoal do /links. `v`: { user, choice, guild?: {name, links, applies} }. */
export function renderUserLinks(v) {
  const on = v.choice === true;
  const embed = new EmbedBuilder().setColor(on ? BRAND : OFF).setTitle('🔗 Seus links do X/Twitter')
    .setThumbnail(v.avatar || null)
    .setDescription([v.notice,
      'O bot pode trocar os links do X que **você** manda por fxtwitter, para o Discord mostrar a prévia certa. '
      + 'Vale em todos os servidores com o bot que permitem a correção.'].filter(Boolean).join('\n\n'))
    .addFields({
      name: 'Sua escolha',
      value: v.choice === true ? '🟢 **Ativado**' : v.choice === false ? '⚪ **Desativado**' : '⚪ **Não ativado** (padrão)',
      inline: true,
    });
  if (v.guild) {
    const l = v.guild.links;
    const here = !l.enabled ? 'Desligado pelos admins' : v.guild.applies ? '🟢 Corrigindo os seus' : '⚪ Não corrigindo os seus';
    const how = l.enabled && l.scope === 'todos' ? '\nAqui corrige de todos, menos de quem desativou.' : '';
    embed.addFields({ name: `Em ${v.guild.name}`, value: `${here}${how}`, inline: true });
  }
  const buttons = row(
    new ButtonBuilder().setCustomId('os:me:on').setLabel('Ativar para mim').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(on),
    new ButtonBuilder().setCustomId('os:me:off').setLabel('Desativar').setEmoji('⭕').setStyle(ButtonStyle.Secondary)
      .setDisabled(v.choice === false),
  );
  return { embeds: [embed], components: [buttons] };
}

/** Botão "Abrir OpenSpeak" para avisos e respostas públicas. */
export function openButtonRow(url, label = 'Abrir OpenSpeak') {
  return row(new ButtonBuilder().setLabel(label).setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(url));
}
