// Decide quem recebe a versão mobile do site, que só assiste às transmissões.

/**
 * `?mobile=1` e `?mobile=0` forçam a escolha; sem eles, vale o aparelho.
 * @param {{ userAgent?:string, platform?:string, maxTouchPoints?:number, userAgentData?:{mobile?:boolean} }} nav
 * @param {string} search  query string da página
 */
export function isMobileClient(nav, search = '') {
  const forced = new URLSearchParams(search).get('mobile');
  if (forced === '1') return true;
  if (forced === '0') return false;
  if (nav.userAgentData?.mobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? '')) return true;
  // O Safari do iPad se apresenta como Mac; só o toque o denuncia.
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}
