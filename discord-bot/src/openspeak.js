// Perguntas sobre o OpenSpeak ("@Frisquila como baixo o openspeak?") e relatos que viram issue
// no GitHub ("@Frisquila sugestão: o openspeak podia ter atalho pra pausar").
//
// A resposta da IA se apoia só em OPENSPEAK_FACTS (escrito à mão a partir do README, docs/ e
// native/CHANGELOG.md) e nas últimas entradas do CHANGELOG, buscadas no GitHub em tempo real
// (o bot na VM só tem a pasta src/, por isso a base fica aqui).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

export const REPO = 'JonasHenriqueDev/OpenSpeak';
export const DOWNLOAD_URL = `https://github.com/${REPO}/releases/latest/download/OpenSpeak-Setup.exe`;
const CHANGELOG_URL = `https://raw.githubusercontent.com/${REPO}/main/native/CHANGELOG.md`;
const CHANGELOG_TTL_MS = 60 * 60_000;

/** O que o bot sabe do OpenSpeak (conferido nos docs do repositório). */
export const OPENSPEAK_FACTS = [
  'O OpenSpeak é um app livre (licença AGPL-3.0) para transmitir a tela inteira, uma janela ou a câmera, com áudio, '
    + 'para os amigos, com baixa latência. Foi feito pelo dono deste servidor do Discord e se inspira no streaming do TeamSpeak 6. '
    + `Código e releases: https://github.com/${REPO}.`,
  `App para Windows (recomendado): baixar o instalador em ${DOWNLOAD_URL}. Instala só para o usuário, sem pedir administrador `
    + '(pasta %LOCALAPPDATA%\\Programs\\OpenSpeak). Ao entrar, informe seu nome, o endereço do servidor (wss://<host>/ws) e a '
    + 'senha, se o servidor for privado; o app lembra os dois. Captura e codifica na placa de vídeo (NVENC da NVIDIA, AMF da AMD, Quick Sync da Intel).',
  'Não existe app para Mac, Linux nem celular. Pelo navegador há o cliente web (o site do servidor), que transmite e assiste. '
    + 'No celular e no tablet o site abre numa versão só para assistir.',
  'Atividade do Discord: dá para assistir às transmissões dentro de um canal de voz do Discord, pelo lançador de atividades. '
    + 'Ela só assiste (não transmite). Lá o botão de tela cheia não aparece (o Discord bloqueia); o botão Preencher ou um duplo '
    + 'clique no vídeo corta as bordas.',
  'Servidor oficial da comunidade: wss://openspeak.duckdns.org/ws (site: https://openspeak.duckdns.org). Ele é privado, com senha: '
    + 'a senha quem passa é o administrador do servidor (o bot não sabe nem informa senha).',
  'Atualização automática: ao abrir, o app procura versão nova no GitHub, baixa, confere o SHA-256 e instala sozinho. '
    + 'Em Preferências › Atualizações: verificar a cada 6 horas (ligado), receber pré-releases (desligado), Verificar agora, '
    + 'Baixar atualização e Aplicar e reiniciar. Versões anteriores à 1.0.0 precisam instalar a 1.0.0 à mão. A versão portátil não se atualiza sozinha.',
  'Edições: Lite (padrão, OpenSpeak-Setup.exe), só o cliente do servidor; Completa/Full (OpenSpeak-Full-Setup.exe), que tem também '
    + 'o modo Tailnet (sem servidor, pela rede Tailscale), a sala web e o servidor dedicado. Para trocar, instale o instalador da outra '
    + 'edição; as configurações continuam.',
  'Desde a 1.0.36 toda transmissão passa pelo servidor (SFU): o IP de quem transmite não aparece para quem assiste e o upload '
    + 'não cresce a cada espectador. O modo P2P saiu. Versões antigas do app precisam atualizar para transmitir.',
  'Qualidade por espectador (simulcast, 1.0.35): quem transmite pelo app manda também uma versão leve (até 480p) e cada um recebe '
    + 'a que a conexão aguenta. No vídeo há o botão de qualidade: Automática, Alta ou Baixa; o ícone fica amarelo na qualidade baixa. '
    + 'Transmissões pelo site, de versão antiga ou abaixo de 540p / 1,2 Mbps têm uma qualidade só.',
  'Janela transmitindo preta: use a Captura alternativa (opções avançadas da transmissão de janela, dá para ligar com a transmissão '
    + 'no ar; aparece com uma borda amarela). O app sugere isso depois de 10 segundos de tela preta.',
  'Áudio: vem ligado em toda transmissão nova (desligar vale só para aquela). Na janela, vai o som do próprio programa, inclusive '
    + 'apps da Microsoft Store. O áudio do Discord nunca vai junto. Volume de quem você assiste vai até 500%, e dá para mudar com a roda do mouse.',
  'Quedas de internet curtas pausam a transmissão em vez de desconectar (o servidor espera até 90 s para retomar).',
  'Perfis (1.0.22+): defina uma senha em Preferências › Perfil para reservar seu apelido; depois o login pede essa senha. '
    + 'O perfil tem nome de exibição, cor, descrição, foto (pode ser GIF de até 320 KB) e banner (imagem ou GIF), mostrados num card.',
  'Interface: previews livres (arrastar e redimensionar), botão Organizar (alinha; um segundo clique deixa todos do mesmo tamanho), '
    + 'tamanho dos previews em Exibição, picture-in-picture, tela cheia no monitor certo, bandeja do sistema, lista de quem está assistindo, '
    + 'temas de cores (Meia-noite, Grafite, Preto OLED, Ameixa, Floresta…) e temas de sons (Cristal, Retrô, Kalimba, Espacial, Discreto, Nostalgia…).',
  'Privacidade de cada transmissão: Pública, Contatos ou Privada (pergunta antes de deixar entrar). Nas configurações avançadas há '
    + '"Mostrar ao vivo no bot do Discord" (ligado por padrão), que faz o Frisquila avisar a transmissão.',
  'No Discord: /aovivo mostra quem está transmitindo agora e /servidor mostra usuários online, transmissões e tráfego.',
  'Bugs e sugestões: é só mandar para o Frisquila (ex.: "@Frisquila bug: o áudio some quando…" ou "@Frisquila sugestão: …"); '
    + 'ele abre uma issue no GitHub para o desenvolvedor ver.',
].join('\n');

/** Palavras (normalizadas) que indicam relato para virar issue. */
const ISSUE_WORDS = ['bug', 'bugs', 'bugado', 'bugou', 'issue', 'sugestao', 'sugestoes', 'sugiro', 'reportar', 'reporta', 'relatar',
  'reclamacao', 'reclamar', 'podia ter', 'poderia ter', 'deveria ter', 'devia ter', 'seria bom', 'seria legal', 'queria que',
  'nao funciona', 'nao ta funcionando', 'parou de funcionar', 'crash', 'crashou', 'crasha', 'fecha sozinho', 'travando', 'trava'];
/** Palavras de pergunta. */
const QUESTION_WORDS = ['como', 'onde', 'qual', 'quais', 'quando', 'porque', 'por que', 'tem', 'da pra', 'consigo', 'pode', 'o que', 'oq', 'que'];

const words = text => ` ${String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/<@!?\d+>/g, ' ').split(/[^a-z0-9]+/).filter(Boolean).join(' ')} `;

export function mentionsOpenSpeak(text) {
  return / open ?speak /.test(words(text));
}

export function looksLikeReport(text) {
  const w = words(text);
  return ISSUE_WORDS.some(k => w.includes(` ${k} `));
}

/**
 * Sem IA: 'issue' para relato explícito ("bug:", "sugestão:"), 'openspeak' para pergunta que cita
 * o OpenSpeak. null quando não dá para ter certeza (aí o ia-gateway classifica).
 */
export function parseOpenSpeakQuestion(text) {
  const w = words(text);
  const report = looksLikeReport(text);
  if (/^ (bug|sugestao|sugiro|reportar|issue|reclamacao) /.test(w)) return 'issue';
  if (!mentionsOpenSpeak(text)) return null;
  const question = String(text).includes('?') || QUESTION_WORDS.some(k => w.startsWith(` ${k} `));
  if (report && !question) return 'issue';
  if (question && !report) return 'openspeak';
  return null;
}

/** Últimas entradas do CHANGELOG (o índice de todas as versões + as N mais novas por inteiro). */
export function summarizeChangelog(md, latest = 4) {
  const entries = String(md ?? '').split(/^(?=# )/m).map(s => s.trim()).filter(s => s.startsWith('# '));
  if (!entries.length) return '';
  const index = entries.map(e => e.split('\n')[0].replace(/^#\s*/, '')).join('\n');
  const recent = entries.slice(0, latest).join('\n\n');
  return `ÚLTIMAS VERSÕES (a primeira é a mais nova):\n${recent}\n\nTODAS AS VERSÕES:\n${index}`.slice(0, 7000);
}

let changelogCache = { at: 0, text: '' };

/** CHANGELOG resumido, buscado no GitHub (1 h de cache); '' se falhar. */
export async function latestChanges({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (changelogCache.text && now - changelogCache.at < CHANGELOG_TTL_MS) return changelogCache.text;
  try {
    const res = await fetchImpl(CHANGELOG_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    changelogCache = { at: now, text: summarizeChangelog(await res.text()) };
  } catch {
    changelogCache.at = now - CHANGELOG_TTL_MS + 5 * 60_000; // tenta de novo em 5 min
  }
  return changelogCache.text;
}

export function resetChangelogCache() {
  changelogCache = { at: 0, text: '' };
}

/** Mensagens para o ia-gateway responder uma pergunta sobre o OpenSpeak. */
export function openspeakMessages(text, changes = '') {
  return [
    {
      role: 'system',
      content: 'Você é o Frisquila, bot de um servidor de amigos no Discord, e conhece o OpenSpeak, o app de transmissão de tela '
        + 'do servidor. Responda em português do Brasil, direto e descontraído, em até 150 palavras, com Markdown do Discord se ajudar. '
        + 'REGRA PRINCIPAL: afirme só o que está na BASE ou no CHANGELOG abaixo; nunca invente recurso, botão, menu, versão ou data. '
        + 'Se não estiver lá, diga com sinceridade que não sabe e sugira mandar como sugestão ou bug para o Frisquila '
        + '(ex.: "@Frisquila sugestão: …"), que vira uma issue para o desenvolvedor. Nunca informe senha de servidor.\n\n'
        + `BASE:\n${OPENSPEAK_FACTS}${changes ? `\n\nCHANGELOG:\n${changes}` : ''}`,
    },
    { role: 'user', content: String(text).slice(0, 500) },
  ];
}

// ------------------------------------------------------------- issues

/** Mensagens para a IA transformar o relato numa issue (JSON), olhando as issues abertas. */
export function issueMessages(text, openIssues = []) {
  const list = openIssues.slice(0, 40).map(i => `#${i.number}: ${i.title}`).join('\n') || '(nenhuma)';
  return [
    {
      role: 'system',
      content: 'Você transforma relatos de usuários do OpenSpeak (app de transmissão de tela para Windows, com site e atividade do '
        + 'Discord) em issues do GitHub para o desenvolvedor. Escreva em português do Brasil, sem inventar nada além do relato. '
        + 'Responda SÓ um JSON: {"titulo": "<até 80 caracteres, objetivo>", "corpo": "<Markdown curto: o que acontece ou o que '
        + 'a pessoa quer; passos e detalhes só se estiverem no relato>", "tipo": "bug" | "sugestao" | "outro", '
        + '"duplicada": <número de uma issue aberta abaixo que trata EXATAMENTE do mesmo assunto, ou null>}.\n\n'
        + `ISSUES ABERTAS:\n${list}`,
    },
    { role: 'user', content: String(text).slice(0, 1500) },
  ];
}

const clean = (s, max) => String(s ?? '').replace(/\r/g, '').trim().slice(0, max);

/** Valida o rascunho da IA. Lança erro se não houver título. */
export function parseIssueDraft(texto, openIssues = []) {
  const m = /\{[\s\S]*\}/.exec(String(texto ?? ''));
  if (!m) throw new Error('sem JSON');
  const d = JSON.parse(m[0]);
  const title = clean(d.titulo, 100).replace(/\s+/g, ' ');
  if (!title) throw new Error('sem título');
  const kind = ['bug', 'sugestao'].includes(d.tipo) ? d.tipo : 'outro';
  const dup = Number(d.duplicada);
  const duplicate = openIssues.find(i => i.number === dup) ?? null;
  return { title, body: clean(d.corpo, 2500), kind, duplicate };
}

/** Rascunho sem IA: o próprio relato. */
export function fallbackDraft(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const kind = /\b(bug|erro|crash|trava|n[aã]o funciona)/i.test(t) ? 'bug' : /sugest|podia|poderia|seria|queria/i.test(t) ? 'sugestao' : 'outro';
  const title = t.replace(/^(bug|sugest[aã]o|issue|reportar|reclama[cç][aã]o)\s*[:-]?\s*/i, '');
  return { title: (title.length > 80 ? `${title.slice(0, 77)}…` : title) || 'Relato pelo Discord', body: '', kind, duplicate: null };
}

export const KIND_LABEL = { bug: 'bug', sugestao: 'enhancement' };
export const KIND_NAME = { bug: '🐞 Bug', sugestao: '💡 Sugestão', outro: '📝 Relato' };

const quote = text => String(text).trim().split('\n').map(l => `> ${l}`).join('\n');

/** Corpo final da issue: o texto da IA + o relato original com o nome de exibição (sem IDs). */
export function issueBody(draft, { text, author }) {
  return [
    draft.body,
    `---\n**Relato original** (Discord, por ${author}):\n${quote(text)}`,
    '_Aberta pelo Frisquila._',
  ].filter(Boolean).join('\n\n');
}

export function duplicateComment({ text, author }) {
  return `Mais um relato pelo Discord (${author}):\n${quote(text)}\n\n_Somado pelo Frisquila._`;
}

/** Até `max` issues por pessoa a cada 24 h. Devolve a lista nova ou null se estourou. */
export function takeIssueQuota(times = [], now = Date.now(), max = 3) {
  const recent = (Array.isArray(times) ? times : []).filter(t => now - t < 24 * 3600_000);
  if (recent.length >= max) return null;
  return [...recent, now];
}

/** Cliente mínimo da API do GitHub (issues com o label do Frisquila). */
export class GitHubIssues {
  constructor({ token, repo = REPO, fetchImpl = fetch, label = 'frisquila' }) {
    this.token = token;
    this.repo = repo;
    this.fetch = fetchImpl;
    this.label = label;
    this.openCache = { at: 0, list: null };
    this.labelReady = false;
  }

  async api(method, path, body) {
    const res = await this.fetch(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'user-agent': 'frisquila-bot',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`GitHub HTTP ${res.status}: ${data?.message ?? ''}`.trim());
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** Issues abertas do Frisquila (sem pull requests), com 5 min de cache. */
  async listOpen() {
    if (this.openCache.list && Date.now() - this.openCache.at < 5 * 60_000) return this.openCache.list;
    const data = await this.api('GET', `/issues?state=open&labels=${encodeURIComponent(this.label)}&per_page=50`);
    const list = (Array.isArray(data) ? data : []).filter(i => !i.pull_request)
      .map(i => ({ number: i.number, title: i.title, url: i.html_url }));
    this.openCache = { at: Date.now(), list };
    return list;
  }

  async ensureLabel() {
    if (this.labelReady) return;
    try {
      await this.api('POST', '/labels', { name: this.label, color: '5865f2', description: 'Relato vindo do Discord pelo bot Frisquila' });
    } catch (err) {
      if (err.status !== 422) throw err; // 422 = já existe
    }
    this.labelReady = true;
  }

  async create({ title, body, labels = [] }) {
    await this.ensureLabel();
    const data = await this.api('POST', '/issues', { title, body, labels: [this.label, ...labels] });
    this.openCache.at = 0;
    return { number: data.number, url: data.html_url, title: data.title };
  }

  async comment(number, body) {
    const data = await this.api('POST', `/issues/${number}/comments`, { body });
    return { url: data.html_url };
  }
}

// ------------------------------------------------------------- telas

const OS_COLOR = 0x5865f2;
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function renderOpenSpeakAnswer({ question, answer }) {
  const embed = new EmbedBuilder().setColor(OS_COLOR)
    .setAuthor({ name: `💬 ${cut(String(question).replace(/\s+/g, ' '), 200)}` })
    .setDescription(cut(answer, 3500))
    .setFooter({ text: 'Resposta da IA com o que o bot sabe do OpenSpeak · pode errar' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Baixar o OpenSpeak').setURL(DOWNLOAD_URL),
  );
  return { embeds: [embed], components: [row] };
}

/** Prévia da issue, com os botões de confirmar (customId "is:<ação>:<id>"). */
export function renderIssueDraft({ id, draft, text }) {
  const embed = new EmbedBuilder().setColor(OS_COLOR)
    .setTitle(cut(`${KIND_NAME[draft.kind]}: ${draft.title}`, 250))
    .setFooter({ text: 'Só quem relatou confirma · a issue fica pública no GitHub, com o seu nome de exibição do Discord' });
  if (draft.body) embed.setDescription(cut(draft.body, 3000));
  embed.addFields({ name: 'Seu relato', value: cut(String(text), 1000) });
  if (draft.duplicate) {
    embed.addFields({ name: 'Parece já estar aberta', value: cut(`[#${draft.duplicate.number}: ${draft.duplicate.title}](${draft.duplicate.url})`, 1000) });
  }
  const buttons = draft.duplicate
    ? [
      new ButtonBuilder().setCustomId(`is:add:${id}`).setStyle(ButtonStyle.Primary).setLabel(`Somar à #${draft.duplicate.number}`),
      new ButtonBuilder().setCustomId(`is:open:${id}`).setStyle(ButtonStyle.Secondary).setLabel('Abrir nova'),
    ]
    : [new ButtonBuilder().setCustomId(`is:open:${id}`).setStyle(ButtonStyle.Primary).setLabel('Abrir issue')];
  buttons.push(new ButtonBuilder().setCustomId(`is:cancel:${id}`).setStyle(ButtonStyle.Danger).setLabel('Cancelar'));
  return {
    content: 'Quer que eu mande isso para o desenvolvedor do OpenSpeak?',
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(...buttons)],
  };
}

export function renderIssueDone({ number, url, title, added }) {
  const embed = new EmbedBuilder().setColor(0x2ecc71)
    .setTitle(cut(`#${number}: ${title}`, 250)).setURL(url)
    .setDescription(added ? '✅ Somei o seu relato a esta issue. Valeu!' : '✅ Issue aberta. Valeu pelo relato!');
  return { content: '', embeds: [embed], components: [] };
}
