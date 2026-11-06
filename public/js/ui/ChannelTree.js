// Árvore de canais com clientes e indicadores de stream (ao vivo / espectadores).

import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { viewerCount } from './viewerCount.js';
import { StreamType } from '../core/protocol.js';

const TYPE_ICON = { [StreamType.CAMERA]: 'camera', [StreamType.SCREEN]: 'screen', [StreamType.WINDOW]: 'window' };

export class ChannelTree {
  constructor({ handler, manager, contacts, onError, onStreamClick }) {
    this.handler = handler;
    this.manager = manager;
    this.contacts = contacts;
    this.onError = onError;
    this.onStreamClick = onStreamClick;
    this.el = h('nav.channel-tree');
    this.menu = null;
    document.addEventListener('click', () => this.#closeMenu());
  }

  render() {
    const hd = this.handler;
    const channels = [...hd.channels.values()].sort((a, b) => a.order - b.order);
    const ownCid = hd.ownClient?.cid;
    replaceChildren(this.el,
      h('div.tree-server', icon('server'), h('span.ellipsis', hd.serverName),
        hd.hasStreamingSFU ? h('span.tag', { title: t('app.server.mode.sfu') }, 'SFU') : null),
      channels.map(ch => {
        const clients = [...hd.clients.values()].filter(c => c.cid === ch.cid).sort((a, b) => hd.clientName(a.clid).localeCompare(hd.clientName(b.clid)));
        const streams = hd.streamsInChannel(ch.cid);
        return h('div.tree-channel', { class: { current: ch.cid === ownCid } },
          h('div.tree-row.channel-row', {
            title: `${ch.description}\n(${t('app.channel.join')}: duplo clique)`,
            on: { dblclick: () => hd.moveTo(ch.cid).catch(this.onError) },
          }, icon('channel'), h('span.ellipsis', ch.name),
            streams.length ? h('span.channel-live', icon('stream'), String(streams.length)) : null),
          clients.map(c => this.#clientRow(c, streams.filter(s => s.ownerClid === c.clid), ch.cid === ownCid)));
      }));
  }

  #clientRow(client, streams, inMyChannel) {
    const isMe = client.clid === this.handler.ownClid;
    const isContact = this.contacts.has(client.uid);
    return h('div.tree-client',
      h('div.tree-row.client-row', {
        class: { me: isMe },
        on: {
          click: ev => { ev.stopPropagation(); this.#openCard(ev, client); },
          contextmenu: ev => { if (!isMe) { ev.preventDefault(); this.#openMenu(ev, client); } },
        },
      },
        client.avatar ? h('img.client-avatar', { src: client.avatar, alt: '' }) : h('span.talk-dot'),
        h('span.ellipsis', {
          style: client.color ? { color: client.color } : null,
        }, this.handler.clientName(client.clid)),
        isMe ? h('span.muted', `(${t('app.you')})`) : null,
        isContact ? h('span.contact-star', { title: t('app.contacts') }, icon('star')) : null,
        h('span.client-ping', { title: 'Ping desta pessoa até o servidor (RTT)' },
          Number.isFinite(client.pingMs) && client.pingMs >= 0 ? `${Math.round(client.pingMs)} ms` : '—')),
      streams.map(s => {
        const watching = this.manager.inbound.has(s.streamIdentifier);
        return h('div.tree-row.stream-row', {
          class: { watching, clickable: inMyChannel && !isMe },
          title: s.name,
          on: { click: () => inMyChannel && this.onStreamClick(s.streamIdentifier) },
        }, icon(TYPE_ICON[s.type] ?? 'stream'), h('span.ellipsis', s.name),
          h('span.live-badge', t('video.stream.live')),
          viewerCount(s.viewerCount, () => this.manager.viewerNames(s.streamIdentifier)));
      }));
  }

  #openMenu(ev, client) {
    this.#closeMenu();
    const isContact = this.contacts.has(client.uid);
    this.menu = h('div.context-menu', { style: { left: `${ev.clientX}px`, top: `${ev.clientY}px` } },
      h('button', { on: { click: () => { this.contacts.toggle(client.uid); this.render(); } } },
        icon('star'), t(isContact ? 'app.contacts.remove' : 'app.contacts.add')));
    document.body.append(this.menu);
  }

  /** Card de perfil ao clicar em alguém na lista, como no Discord. */
  #openCard(ev, client) {
    this.#closeMenu();
    const name = this.handler.clientName(client.clid);
    const isMe = client.clid === this.handler.ownClid;
    const row = ev.currentTarget.getBoundingClientRect();
    const banner = h('div.profile-card-banner', { hidden: true });
    const avatar = client.avatar ? h('img.profile-card-avatar', { src: client.avatar, alt: '' }) : h('div.avatar', name.trim().slice(0, 1).toUpperCase());
    this.menu = h('div.popover.profile-card', { on: { click: e => e.stopPropagation() } },
      banner,
      avatar,
      h('strong.profile-card-name', { style: client.color ? { color: client.color } : null }, name, isMe ? ` (${t('app.you')})` : ''),
      client.displayName ? h('div.muted', `@${client.nickname}`) : null,
      client.description ? h('section.profile-card-about',
        h('h4', t('app.profile.description')), h('p', client.description)) : null,
      isMe ? null : h('button.btn', { type: 'button', on: { click: () => {
        this.contacts.toggle(client.uid);
        this.#closeMenu();
        this.render();
      } } }, icon('star'), t(this.contacts.has(client.uid) ? 'app.contacts.remove' : 'app.contacts.add')));
    document.body.append(this.menu);
    const card = this.menu;
    const place = () => Object.assign(card.style, {
      left: `${Math.min(row.right + 6, window.innerWidth - card.offsetWidth - 8)}px`,
      top: `${Math.max(8, Math.min(row.top, window.innerHeight - card.offsetHeight - 8))}px`,
    });
    place();
    this.handler.profileMedia(client).then(media => {
      if (!card.isConnected) return;
      if (media.avatarAnimated) avatar.src = media.avatarAnimated;
      if (!media.banner) return;
      banner.replaceChildren(h('img', { src: media.banner, alt: '' }));
      banner.hidden = false;
      card.classList.add('has-banner');
      place();
    }, this.onError);
  }

  #closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }
}
