// Trava da correção de links: cada mensagem recebe no máximo uma resposta do bot, e a
// prévia que o bot tirou fica tirada mesmo quando o Discord a gera depois.
//
// Duas corridas que isso fecha:
// - evento repetido do Discord (reconexão) ou edição chegando enquanto a resposta ainda
//   sai: sem trava, o bot respondia de novo (link duplicado);
// - a prévia do Discord chega como "edição" logo depois de o bot tirá-la, muitas vezes
//   antes de a resposta terminar de sair: o bot ainda não sabia que a mensagem era dele
//   e a prévia ficava (card duplicado).

export const GUARD_MAX = 2000;
/** Quanto tempo vigiar a prévia de uma mensagem corrigida. */
export const SUPPRESS_WATCH_MS = 5 * 60_000;
/** Reconferências da prévia sem esperar evento do Discord. */
export const SUPPRESS_RECHECK_MS = [3000, 10_000];

export class LinkGuard {
  constructor({ max = GUARD_MAX, watchMs = SUPPRESS_WATCH_MS, now = () => Date.now() } = {}) {
    this.max = max;
    this.watchMs = watchMs;
    this.now = now;
    this.handled = new Set(); // mensagens já tratadas (ou em andamento)
    this.watch = new Map(); // mensagem -> até quando tirar a prévia
  }

  /** Reserva a mensagem para responder. false se já foi tratada: não responda de novo. */
  claim(id) {
    if (this.handled.has(id)) return false;
    this.handled.add(id);
    while (this.handled.size > this.max) this.handled.delete(this.handled.values().next().value);
    return true;
  }

  isHandled(id) {
    return this.handled.has(id);
  }

  /** Marca para tirar a prévia (antes de qualquer espera). */
  watchPreview(id) {
    this.watch.set(id, this.now() + this.watchMs);
    while (this.watch.size > this.max) this.watch.delete(this.watch.keys().next().value);
  }

  /** A mensagem (com embeds/flags atuais) precisa ter a prévia tirada agora? */
  needsSuppress(id, { embeds = 0, suppressed = false } = {}) {
    const until = this.watch.get(id);
    if (!until) return false;
    if (this.now() > until) {
      this.watch.delete(id);
      return false;
    }
    return embeds > 0 && !suppressed;
  }

  stopWatching(id) {
    this.watch.delete(id);
  }

  /** Os links saíram da mensagem (resposta apagada): se voltarem, corrige de novo, uma vez. */
  release(id) {
    this.handled.delete(id);
    this.watch.delete(id);
  }
}
