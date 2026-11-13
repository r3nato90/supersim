// Rastreamento avançado do TOPO do funil (páginas de entrada).
// Faz Advanced Matching MAXIMIZADO em toda página + expõe fbTrack() com dedup browser↔CAPI.
// (Nos upsells quem cuida disso é o checkout-shared.js — este script é p/ as páginas iniciais.)

// UTMify Pixel (conta 6a98f2740b880c87935666eb) — loader idempotente.
(function () {
  try {
    if (window.pixelId === '6a98f2740b880c87935666eb' && document.querySelector('script[src*="cdn.utmify.com.br/scripts/pixel/pixel.js"]')) return;
    window.pixelId = '6a98f2740b880c87935666eb';
    var s = document.createElement('script');
    s.src = 'https://cdn.utmify.com.br/scripts/pixel/pixel.js';
    s.async = true; s.defer = true;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();

// captura fbclid p/ montar fbc depois (in-app browser do Instagram não passa cookie)
(function () {
  try {
    var c = new URLSearchParams(location.search).get('fbclid');
    if (c) { sessionStorage.setItem('_fbclid', c); localStorage.setItem('fbclid', c); }
  } catch (e) {}
})();

// captura UTMs no PRIMEIRO toque (landing) e guarda no localStorage — sobrevive até os upsells
(function () {
  try {
    var p = new URLSearchParams(location.search);
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'src', 'sck'];
    var fresh = {};
    keys.forEach(function (k) { var v = p.get(k); if (v) fresh[k] = v; });
    if (Object.keys(fresh).length) {
      try { sessionStorage.setItem('_utms', JSON.stringify(fresh)); } catch (e) {}
      var prev = {};
      try { prev = JSON.parse(localStorage.getItem('_utms') || '{}'); } catch (e) {}
      localStorage.setItem('_utms', JSON.stringify(Object.assign(prev, fresh)));
    }
  } catch (e) {}
})();

function _tkWaitFbq(cb, t) { t = t || 0; if (typeof fbq === 'function') { cb(); return; } if (t > 40) return; setTimeout(function () { _tkWaitFbq(cb, t + 1); }, 250); }
function _tkSha(s) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode((s || '').toLowerCase().trim())).then(function (b) { return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }); }
function _tkPhoneBR(p) { var d = (p || '').replace(/\D/g, ''); if (!d) return ''; if (d.length <= 11 && d.indexOf('55') !== 0) d = '55' + d; return d; }
function _tkGenId(p) { return p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
// external_id persistente — costura a jornada anônima (topo, antes do CPF) com a identificada
function _tkEid() {
  try {
    var v = localStorage.getItem('_extid');
    if (!v) { v = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); localStorage.setItem('_extid', v); }
    return v;
  } catch (e) { return ''; }
}
function _tkCookie(n) { var m = document.cookie.match('(^|;)\\s*' + n + '\\s*=\\s*([^;]+)'); return m ? m.pop() : null; }
function _tkFb() { var fbp = _tkCookie('_fbp'); var fbc = _tkCookie('_fbc'); if (!fbc) { var cl = sessionStorage.getItem('_fbclid'); if (cl) fbc = 'fb.1.' + Date.now() + '.' + cl; } return { fbp: fbp, fbc: fbc }; }

// Advanced Matching MAXIMIZADO — reinit fbq com email+telefone+nome+sobrenome+cpf hasheados
(function () {
  var nome  = localStorage.getItem('nome') || '';
  var cpf   = (localStorage.getItem('cpf') || '').replace(/\D/g, '');
  var email = (localStorage.getItem('email') || '').trim();
  var phone = _tkPhoneBR(localStorage.getItem('telefone') || localStorage.getItem('telephone') || '');
  var eid = _tkEid();
  if (!window.crypto || !crypto.subtle) return;
  _tkWaitFbq(function () {
    (async function () {
      try {
        var parts = nome.trim().split(' ');
        var ud = {};
        if (email) ud.em = await _tkSha(email);
        if (phone) ud.ph = await _tkSha(phone);
        // external_id como array: CPF (quando houver) + id persistente → costura a jornada inteira
        var ext = [];
        if (cpf) ext.push(await _tkSha(cpf));
        if (eid) ext.push(await _tkSha(eid));
        if (ext.length) ud.external_id = ext;
        if (parts[0]) ud.fn = await _tkSha(parts[0]);
        if (parts.length > 1) ud.ln = await _tkSha(parts[parts.length - 1]);
        fbq('init', '1497048498925446', ud);
      } catch (e) {}
    })();
  });
})();

// fbTrack(nome, customData): dispara no navegador (com eventID) + espelha na CAPI com o MESMO id → dedup.
window.fbTrack = function (name, customData) {
  _tkSend(name, customData, false);
};

// fbTrackCustom(nome, customData): igual ao fbTrack mas p/ eventos customizados
// (trackCustom no navegador) + espelho na CAPI com o MESMO id → dedup.
window.fbTrackCustom = function (name, customData) {
  _tkSend(name, customData, true);
};

function _tkSend(name, customData, custom) {
  customData = customData || {};
  var eid = _tkGenId(String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  _tkWaitFbq(function () {
    if (custom) fbq('trackCustom', name, customData, { eventID: eid });
    else fbq('track', name, customData, { eventID: eid });
  });
  var fb = _tkFb();
  // event_source_url sem query: a URL do funil carrega PII (cpf/email/nome) e
  // estoura limite — a Meta só precisa de origem+path.
  var srcUrl = '';
  try { srcUrl = location.origin + location.pathname; } catch (e) { srcUrl = ''; }
  var body = {
    eventName: name,
    eventId: eid,
    value: customData.value,
    email: localStorage.getItem('email') || '',
    phone: localStorage.getItem('telefone') || localStorage.getItem('telephone') || '',
    nome: localStorage.getItem('nome') || '',
    cpf: localStorage.getItem('cpf') || '',
    eid: _tkEid(),
    fbp: fb.fbp,
    fbc: fb.fbc,
    eventSourceUrl: srcUrl,
  };
  try {
    fetch('/api/public/sup-track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(function () {});
  } catch (e) {}
};
