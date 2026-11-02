// Inicialização do cliente: tela de conexão, layout principal e ligações.

import { h, replaceChildren } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { t } from './ui/i18n.js';
import { settings, contacts } from './ui/settings.js';
import { ConnectionHandler } from './core/ConnectionHandler.js';
import { ScreenshareManager } from './video/ScreenshareManager.js';
import { StreamArea } from './ui/StreamArea.js';
import { ChannelTree } from './ui/ChannelTree.js';
import { MobileApp } from './ui/MobileApp.js';
import { isMobileClient } from './ui/mobile.js';
import { SetupStreamDialog } from './ui/SetupStreamDialog.js';
import { ViewersPanel } from './ui/ViewersPanel.js';
import { StatsPanel } from './ui/StatsPanel.js';
import { Toasts } from './ui/Toasts.js';
import { adjustAvatar, animatedAvatarFromFile, bannerFromFile } from './ui/avatarCrop.js';
import { SoundEffects, SOUND_THEMES, previewSound, previewRandomSound } from './ui/sounds.js';
import { isTailnetServer, isTailnetAddress, privateEntryUrl } from './core/tailnet.js';
import { detectTailnetAddress } from './core/detectTailnet.js';

const deployment = window.OpenSpeakConfig || {};
deployment.tailscaleOnly ||= location.hostname.endsWith('.ts.net');
window.OpenSpeakConfig = deployment;
const entryParams = new URLSearchParams(location.search);
const mobile = isMobileClient(navigator, location.search);
document.body.classList.toggle('mobile', mobile);
const INSTALLER_URL = 'https://github.com/JonasHenriqueDev/OpenSpeak/releases/latest/download/OpenSpeak-Setup.exe';
function installerLink(compact = false) {
  return h('a.desktop-download', { href: INSTALLER_URL, title: 'Baixar o instalador Windows da última versão estável',
    'aria-label': 'Download App — OpenSpeak para Windows, última versão estável', class: compact ? 'compact' : '' },
    'Download App');
}
const REPO_URL = 'https://github.com/JonasHenriqueDev/OpenSpeak';
function repoLink() {
  return h('a.repo-link', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer',
    title: 'Código-fonte no GitHub', 'aria-label': 'Repositório do OpenSpeak no GitHub' }, icon('github'));
}

const root = document.getElementById('app');
const toasts = new Toasts();
document.body.append(toasts.el);

function errorText(err) {
  const code = err?.returnCode ?? err?.message;
  const key = `error.${code}`;
  const translated = t(key);
  return translated !== key ? translated : (err?.message || String(err));
}

function showError(err) {
  console.error('[openspeak]', err);
  toasts.show({ kind: 'error', text: errorText(err) });
}

const profilePasswordKey = (url, nickname) => `${url}|${nickname.trim().toLowerCase()}`;

function savedProfilePassword(url, nickname) {
  return settings.get('profilePasswords')[profilePasswordKey(url, nickname)] ?? '';
}

function saveProfilePassword(url, nickname, password) {
  settings.set('profilePasswords', { ...settings.get('profilePasswords'), [profilePasswordKey(url, nickname)]: password });
}

/** Campo de senha com botão para mostrar o que foi digitado. */
function revealable(input) {
  const toggle = h('button.icon-btn', { type: 'button', title: t('app.password.show'), on: { click: () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    toggle.title = t(hidden ? 'app.password.hide' : 'app.password.show');
    toggle.replaceChildren(icon(hidden ? 'eyeOff' : 'eye'));
  } } }, icon('eye'));
  return h('span.password-field', input, toggle);
}

function defaultServerUrl() {
  if (deployment.serverUrl) return deployment.serverUrl;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

// ================================================================ login

let serverAddress = ''; // servidor da sessão atual (chave da senha do perfil)

function renderLogin(message = '') {
  const nick = h('input.input', { value: entryParams.get('nickname')?.slice(0, 32) || settings.get('nickname'), placeholder: 'Ex.: Jonas', maxLength: 32, required: true });
  const server = h('input.input', { value: deployment.cloudSignaling ? defaultServerUrl() : settings.get('serverUrl') || defaultServerUrl() });
  // O campo do servidor só aparece a pedido, ou se já há outro servidor salvo (Tailscale sempre pede o endereço).
  const serverField = h('label.field', h('span.field-label', t('app.server')), server);
  const changeServer = h('button.btn.ghost', {
    type: 'button',
    on: { click: () => { serverField.hidden = false; changeServer.hidden = true; server.focus(); } },
  }, t('app.server.change'));
  serverField.hidden = !deployment.tailscaleOnly && server.value === defaultServerUrl();
  changeServer.hidden = !serverField.hidden;
  const password = h('input.input', { type: 'password', value: settings.get('serverPassword'), placeholder: 'Deixe vazio se o servidor não tiver senha', autocomplete: 'current-password' });
  // Só aparece quando o apelido é um perfil e a senha lembrada não serviu.
  const profilePassword = h('input.input', { type: 'password', autocomplete: 'current-password' });
  const profilePasswordField = h('label.field', { hidden: true }, h('span.field-label', t('app.profile.password')), revealable(profilePassword));
  const tailnetIp = h('input.input', { value: settings.get('tailnetIp') || '', placeholder: '100.x.x.x deste PC', required: !!deployment.cloudSignaling });
  const ipHint = h('small.muted', 'Tentando detectar o IP Tailscale…');
  let detecting = false;
  const detectIp = async () => {
    if (detecting) return;
    detecting = true;
    const initial = tailnetIp.value;
    ipHint.textContent = 'Tentando detectar o IP Tailscale…';
    const detected = await detectTailnetAddress();
    detecting = false;
    if (!document.contains(tailnetIp)) return;
    if (detected && tailnetIp.value === initial) tailnetIp.value = detected;
    ipHint.textContent = detected ? 'IP Tailscale detectado pelo navegador.' : 'O navegador não revelou o IP. Copie o endereço deste PC no Tailscale.';
  };
  const status = h('div.login-status', message);
  const submit = h('button.btn.primary.wide', { type: 'submit' }, t('app.connect'));
  const form = h('form.login-card', {
    on: {
      submit: async ev => {
        ev.preventDefault();
        const nickname = nick.value.trim();
        if (!nickname) return;
        if (deployment.cloudSignaling) {
          if (!isTailnetAddress(tailnetIp.value.trim())) { status.textContent = 'Informe o IP deste PC mostrado no Tailscale.'; return; }
          deployment.tailnetIp = tailnetIp.value.trim();
          settings.set('tailnetIp', deployment.tailnetIp);
        }
        if (deployment.tailscaleOnly && !deployment.cloudSignaling && !isTailnetServer(server.value.trim())) {
          status.textContent = 'Conecte o Tailscale e informe o endereço wss://…ts.net/ws da sua rede.';
          return;
        }
        settings.set('nickname', nickname);
        settings.set('serverUrl', server.value.trim());
        settings.set('serverPassword', password.value);
        if (!profilePasswordField.hidden) saveProfilePassword(server.value.trim(), nickname, profilePassword.value);
        if (deployment.tailscaleOnly && !deployment.cloudSignaling && new URL(server.value.trim()).hostname !== location.hostname) {
          location.assign(privateEntryUrl(server.value.trim(), nickname, entryParams.get('profile')));
          return;
        }
        submit.disabled = true;
        status.textContent = t('app.connecting');
        try {
          await startSession(server.value.trim(), nickname);
        } catch (err) {
          submit.disabled = false;
          status.textContent = errorText(err);
          if (['profile_password', 'profile_locked'].includes(err?.returnCode)) {
            profilePasswordField.hidden = false;
            profilePassword.focus();
          }
        }
      },
    },
  },
  h('div.login-logo', icon('logo', 'big'), h('h1', 'OpenSpeak')),
  deployment.tailscaleOnly ? h('p.login-status', deployment.cloudSignaling ? 'Tailscale obrigatório na mesma tailnet. O Vercel negocia as conexões; vídeo e áudio usam a rede P2P.' : 'Tailscale obrigatório: conecte este PC à mesma tailnet do servidor. A sessão abre no endereço privado da rede.') : null,
  h('label.field', h('span.field-label', t('app.nickname')), nick),
  deployment.cloudSignaling ? null : serverField,
  deployment.cloudSignaling ? null : h('label.field', h('span.field-label', 'Senha do servidor'), revealable(password)),
  profilePasswordField,
  deployment.cloudSignaling ? h('label.field', h('span.field-label', 'IP Tailscale deste PC'), tailnetIp, ipHint) : null,
  deployment.cloudSignaling ? h('button.btn.ghost', { type: 'button', on: { click: detectIp } }, 'Detectar IP automaticamente') : null,
  submit,
  deployment.cloudSignaling ? null : changeServer,
  status,
  mobile ? null : installerLink(),
  repoLink());
  replaceChildren(root, h('div.login', form));
  nick.focus();
  if (deployment.cloudSignaling) void detectIp();
  if (!message && entryParams.get('autoconnect') === '1' && location.hostname.endsWith('.ts.net') && nick.value.trim())
    queueMicrotask(() => form.requestSubmit());
}

// ============================================================== sessão

async function startSession(url, nickname) {
  const handler = new ConnectionHandler();
  await handler.connect(url, { nickname, uid: settings.get('uid'), password: deployment.cloudSignaling ? '' : settings.get('serverPassword'),
    profilePassword: savedProfilePassword(url, nickname) });
  serverAddress = url;
  if (deployment.tailscaleOnly) handler.iceServers = [];
  const manager = new ScreenshareManager(handler, { contacts, settings });
  window.addEventListener('pagehide', () => handler.disconnect(), { once: true });
  if (mobile) {
    new MobileApp({ root, handler, manager, onError: showError, onDisconnected: () => renderLogin(t('app.disconnected')) }).mount();
    return;
  }
  new SoundEffects(handler, settings, manager);
  new App(handler, manager).mount();
}

class App {
  constructor(handler, manager) {
    this.handler = handler;
    this.manager = manager;
    this.panel = null; // { kind, streamIdentifier, view }
    this.popover = null;

    this.tree = new ChannelTree({
      handler, manager, contacts, onError: showError,
      onStreamClick: id => this.#onTreeStream(id),
    });
    this.area = new StreamArea({
      handler, manager, settings,
      actions: {
        startStream: () => this.openSetup(),
        editStream: id => this.openSetup({ edit: manager.ownStreams.get(id) }),
        changeSource: id => this.openSetup({ edit: manager.ownStreams.get(id), sourceOnly: true }),
        manageViewers: id => this.openPanel('viewers', id),
        showStats: id => this.openPanel('stats', id),
        manageHidden: anchor => this.#hiddenPopover(anchor),
        viewSettings: anchor => this.#viewSettingsPopover(anchor),
        error: showError,
      },
    });
    this.sidePanel = h('aside.side-panel');
    this.statusBar = h('div.status-bar');
  }

  mount() {
    const hd = this.handler;
    replaceChildren(root,
      h('div.app',
        h('header.titlebar',
          icon('logo'), h('span.brand', 'OpenSpeak'),
          h('span.sep'),
          h('span.server-name', icon('server'), hd.serverName),
          h('span.spacer'),
          this.statusBar,
          installerLink(true),
          repoLink(),
          h('button.btn.ghost.small', { title: t('app.profile'), on: { click: ev => this.#profilePopover(ev.currentTarget) } }, icon('user')),
          h('button.btn.ghost.small', { title: t('app.settings'), on: { click: ev => this.#settingsPopover(ev.currentTarget) } }, icon('settings')),
          h('button.btn.ghost.small', { title: t('app.disconnect'), 'aria-label': t('app.disconnect'), on: { click: () => hd.disconnect() } }, icon('power'))),
        h('div.app-body',
          h('div.sidebar', this.tree.el),
          h('main.content', this.area.el),
          this.sidePanel)));

    hd.on('changed', () => this.render());
    hd.on('reconnecting', () => { this.statusBar.textContent = 'Reconectando…'; });
    hd.on('resumed', () => this.render());
    hd.on('streamupdated', () => this.area.render());
    hd.on('disconnected', () => {
      this.#closePopover();
      renderLogin(t('app.disconnected'));
    });
    this.manager.on('changed', () => this.render());
    this.manager.on('stats', id => {
      this.area.refreshStats(id);
      if (this.panel?.kind === 'stats' && this.panel.streamIdentifier === id) this.panel.view.refresh();
    });
    this.manager.on('joinrequest', (own, req) => this.#joinRequestToast(own, req));
    this.manager.on('error', key => toasts.show({ kind: 'error', text: t(key) }));
    this.manager.on('ownstreamstopped', own => {
      if (this.panel?.streamIdentifier === own.streamIdentifier) this.closePanel();
    });
    window.addEventListener('beforeunload', () => hd.disconnect());
    this.render();
  }

  render() {
    this.tree.render();
    this.area.render();
    if (this.panel?.kind === 'viewers') this.panel.view.render();
    const own = this.handler.ownClient;
    const ch = own ? this.handler.channels.get(own.cid) : null;
    if (this.handler.reconnecting) { this.statusBar.textContent = 'Reconectando…'; return; }
    replaceChildren(this.statusBar,
      h('span.online-dot'), own ? this.handler.clientName(own.clid) : '', ch ? h('span.muted', ` — ${ch.name}`) : null,
      h('span.server-ping', { title: 'Seu ping até o servidor (RTT)' },
        Number.isFinite(this.handler.serverPingMs) && this.handler.serverPingMs >= 0 ? `Ping: ${Math.round(this.handler.serverPingMs)} ms` : 'Ping: —'));
  }

  // ------------------------------------------------------------- ações

  openSetup({ edit = null, sourceOnly = false } = {}) {
    if (!this.manager.isSupported) {
      showError(new Error(t('video.error.streaming_not_supported_on_os')));
      return;
    }
    new SetupStreamDialog({
      manager: this.manager, handler: this.handler, settings, edit, sourceOnly, onError: showError,
    }).open();
  }

  openPanel(kind, streamIdentifier) {
    if (!streamIdentifier) return;
    if (this.panel?.kind === kind && this.panel.streamIdentifier === streamIdentifier) {
      this.closePanel();
      return;
    }
    const View = kind === 'viewers' ? ViewersPanel : StatsPanel;
    const view = new View({ handler: this.handler, manager: this.manager, streamIdentifier, onError: showError });
    this.panel = { kind, streamIdentifier, view };
    const name = this.handler.streams.get(streamIdentifier)?.name ?? '';
    replaceChildren(this.sidePanel,
      h('header.panel-header',
        h('div', h('h3', view.title), h('div.muted.ellipsis', name)),
        h('span.spacer'),
        h('button.icon-btn', { title: t('app.close'), on: { click: () => this.closePanel() } }, icon('close'))),
      view.el);
    this.sidePanel.classList.add('open');
    view.render();
  }

  closePanel() {
    this.panel = null;
    this.sidePanel.classList.remove('open');
    replaceChildren(this.sidePanel);
  }

  #onTreeStream(streamIdentifier) {
    if (this.manager.ownStreams.has(streamIdentifier)) return;
    const hidden = settings.get('hiddenStreams');
    if (hidden.includes(streamIdentifier)) settings.set('hiddenStreams', hidden.filter(id => id !== streamIdentifier));
    if (!this.manager.inbound.has(streamIdentifier)) this.manager.joinStream(streamIdentifier).catch(showError);
    this.area.focusId = streamIdentifier;
    this.area.render();
  }

  #joinRequestToast(own, req) {
    const key = `join:${own.streamIdentifier}:${req.clid}`;
    const respond = opts => this.manager.respondJoinRequest(own.streamIdentifier, req.clid, opts).catch(err => {
      showError(err.message === 'viewer_limit_reached' ? new Error(t('video.join.request.viewer_limit_reached')) : err);
    });
    toasts.show({
      key, kind: 'request', icon: 'users', timeout: 30_000,
      text: t('video.join.request.notification', { user: req.nickname }),
      actions: [
        { label: t('video.join.request.accept'), cls: 'primary', onClick: () => respond({ accept: true }) },
        { label: t('video.join.request.deny'), onClick: () => respond({ accept: false }) },
        { label: t('video.join.request.block'), cls: 'danger', title: t('video.join.request.block.tooltip'), onClick: () => respond({ accept: false, ban: true }) },
      ],
    });
    // some quando o pedido é resolvido por outro caminho (painel, cancelamento)
    const off = this.manager.on('changed', () => {
      if (!own.joinRequests.has(req.clid)) {
        toasts.dismiss(key);
        off();
      }
    });
  }

  // ---------------------------------------------------------- popovers

  #popover(anchor, content) {
    this.#closePopover();
    const rect = anchor.getBoundingClientRect();
    const pop = h('div.popover', content);
    document.body.append(pop);
    const top = rect.top - pop.offsetHeight - 6 > 8 ? rect.top - pop.offsetHeight - 6 : rect.bottom + 6;
    Object.assign(pop.style, {
      left: `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, rect.right - pop.offsetWidth))}px`,
      top: `${top}px`,
    });
    const onDown = ev => { if (!pop.contains(ev.target) && ev.target !== anchor) this.#closePopover(); };
    setTimeout(() => document.addEventListener('mousedown', onDown));
    this.popover = { el: pop, onDown };
  }

  #closePopover() {
    if (!this.popover) return;
    document.removeEventListener('mousedown', this.popover.onDown);
    this.popover.el.remove();
    this.popover = null;
  }

  #toggleRow(key, label) {
    return h('label.toggle',
      h('input', { type: 'checkbox', checked: settings.get(key), on: { change: ev => { settings.set(key, ev.target.checked); this.area.render(); } } }),
      h('span.toggle-ui'), h('span', label));
  }

  #viewSettingsPopover(anchor) {
    this.#popover(anchor, [
      h('h4', t('video.view_settings')),
      this.#toggleRow('showOwnStreams', t('video.view_settings.show_own_streams')),
      this.#toggleRow('showInactiveStreams', t('video.view_settings.show_inactive_streams')),
    ]);
  }

  #hiddenPopover(anchor) {
    const ids = settings.get('hiddenStreams').filter(id => this.handler.streams.has(id));
    this.#popover(anchor, [
      h('h4', t('video.stream.manage_hidden_streams')),
      ids.map(id => {
        const s = this.handler.streams.get(id);
        return h('div.viewer-row', icon('eyeOff'), h('span.ellipsis', `${s.name} — ${this.handler.clientName(s.ownerClid)}`),
          h('span.spacer'),
          h('button.btn.ghost.small', {
            on: { click: () => {
              settings.set('hiddenStreams', settings.get('hiddenStreams').filter(x => x !== id));
              this.#closePopover();
              this.area.render();
            } },
          }, icon('eye'), t('video.stream.show_stream')));
      }),
    ]);
  }

  #profilePopover(anchor) {
    const hd = this.handler;
    const own = hd.ownClient;
    const reopen = () => this.#profilePopover(anchor);
    const current = h('input.input', { type: 'password', autocomplete: 'current-password', placeholder: t('app.profile.password.current') });
    const next = h('input.input', { type: 'password', autocomplete: 'new-password', maxLength: 128, placeholder: t('app.profile.password.new') });
    const setPassword = async () => {
      try {
        await hd.setProfilePassword(next.value, current.value);
        saveProfilePassword(serverAddress, own.nickname, next.value);
        reopen();
      } catch (err) { showError(err); }
    };
    const saveFields = fields => hd.updateProfile(fields).then(reopen, showError);
    const profileFields = this.#profileFields(own, saveFields);
    this.#popover(anchor, [
      h('h4', t('app.profile')),
      !hd.hasProfiles ? h('p.muted', t('app.profile.unavailable')) : [
        own?.hasProfile ? profileFields : h('div.profile-callout', icon('lock'),
          h('div', h('strong', t('app.profile.callout.title')), h('p.muted', t('app.profile.password.hint')))),
        own?.hasProfile ? h('h4', t('app.profile.password')) : null,
        own?.hasProfile ? revealable(current) : null,
        revealable(next),
        h('button.btn', { type: 'button', on: { click: setPassword } }, t(own?.hasProfile ? 'app.profile.password.change' : 'app.profile.password.set')),
      ],
    ]);
  }

  #profileFields(own, saveFields) {
    const displayName = h('input.input', { maxLength: 32, value: own?.displayName ?? '', placeholder: own?.nickname ?? '' });
    const description = h('textarea.input', { rows: 3, maxLength: 190, value: own?.description ?? '' });
    const color = h('input.profile-color', { type: 'color', value: own?.color || '#ffffff' });
    let colorPicked = !!own?.color;
    color.addEventListener('input', () => { colorPicked = true; });
    const photo = h('input', { type: 'file', accept: 'image/*', hidden: true, on: {
      change: async ev => {
        const [file] = ev.target.files;
        ev.target.value = ''; // escolher o mesmo arquivo de novo também reabre o ajuste
        if (!file) return;
        if (file.type === 'image/gif') {
          const fields = await animatedAvatarFromFile(file).catch(showError);
          if (fields) await saveFields(fields);
          return;
        }
        const avatar = await adjustAvatar(file).catch(showError);
        if (avatar) await saveFields({ avatar, avatarAnimated: '' });
      },
    } });
    const banner = h('input', { type: 'file', accept: 'image/*', hidden: true, on: {
      change: async ev => {
        const [file] = ev.target.files;
        ev.target.value = '';
        if (!file) return;
        const data = await bannerFromFile(file).catch(showError);
        if (data) await saveFields({ banner: data });
      },
    } });
    const bannerPreview = h('img.profile-banner-preview', { alt: '', hidden: true });
    const photoPreview = h('img.client-avatar', { src: own?.avatar ?? '', alt: '', hidden: !own?.avatar });
    this.handler.profileMedia(own).then(media => {
      if (media.banner) { bannerPreview.src = media.banner; bannerPreview.hidden = false; }
      if (media.avatarAnimated) photoPreview.src = media.avatarAnimated;
    }, showError);
    return [
      this.handler.hasProfileMedia ? h('div.field', h('span.field-label', t('app.profile.banner')),
        bannerPreview,
        h('p.muted', t('app.profile.banner.hint')),
        h('div.profile-photo',
          banner,
          h('button.btn.ghost.small', { type: 'button', on: { click: () => banner.click() } }, t('app.profile.banner.choose')),
          own?.mediaTag ? h('button.btn.ghost.small', { type: 'button', on: { click: () => saveFields({ banner: '' }) } }, t('app.profile.banner.remove')) : null)) : null,
      h('div.field', h('span.field-label', t('app.profile.photo')),
        h('p.muted', t('app.profile.photo.hint')),
        h('div.profile-photo',
          photoPreview,
          photo,
          h('button.btn.ghost.small', { type: 'button', on: { click: () => photo.click() } }, t('app.profile.photo.choose')),
          own?.avatar ? h('button.btn.ghost.small', { type: 'button', on: { click: () => saveFields({ avatar: '', avatarAnimated: '' }) } }, t('app.profile.photo.remove')) : null)),
      h('label.field', h('span.field-label', t('app.profile.display_name')), displayName),
      h('div.field', h('span.field-label', t('app.profile.color')),
        h('div.profile-photo', color,
          h('button.btn.ghost.small', { type: 'button', on: { click: () => { colorPicked = false; saveFields({ color: '' }); } } }, t('app.profile.color.default')))),
      h('label.field', h('span.field-label', t('app.profile.description')), description),
      h('button.btn.primary', { type: 'button', on: { click: () => saveFields({ displayName: displayName.value, description: description.value, color: colorPicked ? color.value : '' }) } }, t('app.profile.save')),
    ];
  }

  #settingsPopover(anchor) {
    const codecs = ['auto', 'video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
    this.#popover(anchor, [
      h('h4', t('app.settings')),
      h('label.field', h('span.field-label', t('app.codec')),
        h('select.input', { on: { change: ev => settings.set('preferredCodec', ev.target.value) } },
          codecs.map(c => h('option', { value: c, selected: settings.get('preferredCodec') === c },
            c === 'auto' ? t('app.codec.auto') : c.replace('video/', ''))))),
      h('h4', t('app.sounds')),
      h('label.toggle',
        h('input', { type: 'checkbox', checked: settings.get('soundEffects'), on: { change: ev => settings.set('soundEffects', ev.target.checked) } }),
        h('span.toggle-ui'), h('span', t('app.sounds.enabled'))),
      h('label.field', h('span.field-label', t('app.sounds.theme')),
        h('select.input', { on: { change: ev => { settings.set('soundTheme', ev.target.value); previewRandomSound(settings, ev.target.value); } } },
          SOUND_THEMES.map(theme => h('option', { value: theme, selected: settings.get('soundTheme') === theme }, t(`app.sounds.${theme}`))))),
      h('label.field', h('span.field-label', t('app.sounds.volume')),
        h('input.range', { type: 'range', min: 0, max: 100, step: 5, value: settings.get('soundVolume'), on: {
          input: ev => settings.set('soundVolume', Number(ev.target.value)),
          change: () => previewSound(settings, settings.get('soundTheme'), 'alguem_entrou'),
        } })),
    ]);
  }
}

renderLogin();
