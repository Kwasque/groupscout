/*
 * GroupScout — mesure d'audience, côté navigateur (voir analytics.js côté serveur)
 *
 * Envoie, par petits paquets (sendBeacon), les pages vues, les clics sur les boutons et les
 * liens, le temps ACTIF passé sur chaque page (onglet visible et une interaction dans la
 * dernière minute), la profondeur de défilement de l'accueil, le temps de chargement et
 * les erreurs JavaScript. Rien sur les joueurs affichés : un clic dans une liste de joueurs
 * est enregistré sous le nom de l'action (« select »), jamais sous le pseudo.
 *
 * Seule chose stockée dans le navigateur : la date de première venue
 * (`groupscout.seen.v1`, oubliée après 13 mois), pour distinguer nouveaux et revenants.
 * Refus : `groupscout.nostats.v1` = 1 (fenêtre « Confidentialité »), ou le signal
 * Global Privacy Control du navigateur. La page /admin n'est jamais mesurée.
 *
 * Expose window.GSStats = { optedOut, setOptOut, event }.
 */
(() => {
  'use strict';
  const OPT_KEY = 'groupscout.nostats.v1';
  const SEEN_KEY = 'groupscout.seen.v1';
  const SEEN_TTL = 395 * 864e5;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
  };
  const gpc = navigator.globalPrivacyControl === true;
  const optedOut = () => gpc || store.get(OPT_KEY) === '1';

  // Identifiant de CETTE visite, en mémoire seulement : il meurt avec l'onglet
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const visit = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Nouveau ou revenant : venu avant aujourd'hui
  const today = new Date().toDateString();
  let returning = false;
  if (!optedOut()) {
    const seen = Number(store.get(SEEN_KEY));
    if (seen && Date.now() - seen < SEEN_TTL) returning = new Date(seen).toDateString() !== today;
    else store.set(SEEN_KEY, String(Date.now()));
  }

  let refHost = '';
  try { refHost = document.referrer ? new URL(document.referrer).host : ''; } catch { /* rien */ }
  if (refHost === location.host) refHost = '';
  const qs = new URLSearchParams(location.search);
  const start = {
    ref: refHost,
    src: qs.get('utm_source') || qs.get('ref') || '',
    w: window.screen?.width || window.innerWidth,
    lang: (navigator.language || '').slice(0, 12),
    tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })(),
    ret: returning,
    load: 0,
  };

  /* --- Page courante --------------------------------------------- */
  // Adresse -> { view, path } sans rien de personnel : ni code de session, ni pseudo, ni
  // code de run. null = page non mesurée (/admin).
  function where() {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    const low = p.toLowerCase();
    if (low === '/admin') return null;
    if (p === '/') return { view: 'home', path: '/' };
    if (low === '/login' || low === '/reset-password') {
      const sp = new URLSearchParams(location.search);
      return { view: 'login', path: low === '/reset-password' ? '/reset-password' : sp.get('signup') ? '/signup' : '/login' };
    }
    if (low === '/account') return { view: 'account', path: '/account' };
    if (low === '/privacy' || low === '/terms') return { view: 'legal', path: low };
    if (low === '/contact') return { view: 'contact', path: low };
    // Recherche de groupe : jamais le code d'une annonce
    if (low === '/groups' || /^\/groups\/(players|new|search)$/.test(low)) return { view: 'groups', path: low };
    if (/^\/groups\/[a-z]{6}\/edit$/.test(low)) return { view: 'groups', path: '/groups/edit' };
    if (/^\/groups\/[a-z]{6}$/.test(low)) return { view: 'groups', path: '/groups/raid' };
    if (low === '/player') return { view: 'player', path: '/player' };
    if (/^\/player\/[^/]+\/[^/]+$/i.test(p)) return { view: 'player', path: '/player/fiche' };
    return { view: 'home', path: '/' };
  }

  let queue = [];
  let page = null;          // { view, path } ou null (page non mesurée)
  let active = 0;           // ms actives sur la page courante, pas encore envoyées
  let maxScroll = 0;        // accueil : défilement max, en %
  let sentScroll = 0;
  let lastInput = Date.now();
  let errors = 0;

  // Envoi 2 s après le premier événement en attente : le backoffice suit presque en direct
  let soon = null;
  function push(ev) {
    if (optedOut()) return;
    queue.push(ev);
    if (queue.length >= 40) flush();
    else if (!soon) soon = setTimeout(() => { soon = null; flush(); }, 2000);
  }

  // Temps et défilement accumulés sur la page courante → en file
  function closeChunk() {
    if (!page) return;
    if (active >= 1000) push({ k: 'time', view: page.view, path: page.path, ms: Math.round(active) });
    active = 0;
    if (page.path === '/' && maxScroll > sentScroll) { push({ k: 'scroll', view: 'home', path: '/', pct: maxScroll }); sentScroll = maxScroll; }
  }

  function onRoute() {
    const next = where();
    if (next && page && next.path === page.path) return;   // même page (replaceState, ancre)
    closeChunk();
    page = next;
    maxScroll = 0;
    sentScroll = 0;
    if (page) push({ k: 'page', view: page.view, path: page.path });
    measureScroll();
  }

  /* --- Envoi ------------------------------------------------------- */
  // bye : la page se ferme (ou on quitte le site) — le serveur la retire aussitôt de « en ce moment »
  function flush(final = false, bye = false) {
    if (final) closeChunk();
    if (optedOut()) { queue = []; return; }
    if (!queue.length && !bye && !(page && document.visibilityState === 'visible')) return;
    const body = JSON.stringify({ v: visit, s: start, e: queue.splice(0, 60), ...(bye && !queue.length ? { bye: true } : {}) });
    try {
      const ok = navigator.sendBeacon && navigator.sendBeacon('/api/stats', new Blob([body], { type: 'text/plain' }));
      if (!ok) fetch('/api/stats', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    } catch { /* tant pis : une statistique perdue */ }
    if (queue.length) flush(final, bye);
  }

  // Toutes les 5 s : temps actif si l'onglet est visible et qu'on a bougé dans la minute
  setInterval(() => {
    if (page && document.visibilityState === 'visible' && Date.now() - lastInput < 60e3) active += 5000;
  }, 5000);
  // Toutes les 15 s : le temps accumulé part, et le serveur sait qu'on est encore là (« en ce moment »)
  setInterval(() => { if (document.visibilityState === 'visible') { closeChunk(); flush(); } }, 15e3);

  for (const type of ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart', 'mousemove']) {
    window.addEventListener(type, () => { lastInput = Date.now(); }, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
    else lastInput = Date.now();
  });
  window.addEventListener('pagehide', () => flush(true, true));

  function measureScroll() {
    if (!page || page.path !== '/') return;
    const h = document.documentElement.scrollHeight;
    if (!h) return;
    const pct = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / h) * 100));
    if (pct > maxScroll) maxScroll = pct;
  }
  window.addEventListener('scroll', measureScroll, { passive: true });

  /* --- Changements d'adresse (le site ne recharge jamais la page) --- */
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      queueMicrotask(onRoute);
      return r;
    };
  }
  window.addEventListener('popstate', () => queueMicrotask(onRoute));

  /* --- Clics -------------------------------------------------------- */
  // Nom d'un élément cliqué : un attribut d'action d'abord, puis l'id, puis le texte —
  // le texte seulement dans les parties fixes du site (accueil, barre, connexion,
  // fenêtres), jamais dans une liste de joueurs, une fiche ou des suggestions.
  const ATTRS = ['track', 'action', 'nav', 'view', 'modal', 'roleFilter', 'confirm', 'playerMetric', 'playerBoss', 'playerLevel', 'detailDiff', 'demoHonor', 'honor', 'setStatus'];
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  function labelOf(el) {
    for (const a of ATTRS) {
      const v = el.dataset?.[a];
      if (v != null) {
        const name = a.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        return /^[\w-]{1,30}$/.test(v) && a !== 'action' ? `${name}:${v}` : a === 'action' ? v : name;
      }
    }
    if (el.dataset?.playerLink != null) return 'lien fiche joueur';
    if (el.dataset?.sessionLink != null) return 'lien session';
    if (el.id) return `#${el.id}`;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (/^https?:/i.test(href)) { try { return `sortie ${new URL(href).host}`; } catch { return 'lien sortant'; } }
      if (href.startsWith('#')) return `ancre ${href}`;
    }
    const safe = el.closest('#home, .nav, #login, .footer, #modal, .auth-card, .bo-tabs') && !el.closest('[data-key], .suggest, .live-sessions, #liveSessions');
    // Le texte français d'origine, quelle que soit la langue de la page : un même bouton porte
    // le même nom dans le rapport, qu'on l'ait cliqué en anglais ou en allemand
    const fr = (s) => s;
    const text = fr(clean(el.getAttribute('aria-label') || el.textContent));
    if (safe && text && text.length <= 40) return `« ${text} »`;
    if (el.getAttribute('title') && safe) return `« ${fr(clean(el.getAttribute('title'))).slice(0, 40)} »`;
    return el.tagName === 'A' ? 'lien' : 'bouton';
  }
  function zoneOf(el) {
    const z = el.parentElement?.closest('[id]');
    return z && z.id !== 'main' ? z.id : '';
  }
  document.addEventListener('click', (ev) => {
    if (!page) return;
    const el = ev.target.closest?.('a, button, summary, [role="button"], [data-action], label.seg-btn, .kselect-button');
    if (!el || el.closest('#admin')) return;
    const zone = zoneOf(el);
    push({ k: 'click', view: page.view, name: `${zone ? `${zone} › ` : ''}${labelOf(el)}`.slice(0, 80) });
  }, { capture: true });

  /* --- Erreurs et chargement --------------------------------------- */
  const onError = (msg) => {
    if (!page || errors >= 10) return;
    errors++;
    push({ k: 'error', view: page.view, name: clean(msg).slice(0, 160) || 'erreur inconnue' });
  };
  window.addEventListener('error', (ev) => onError(ev.message ? `${ev.message}${ev.filename ? ` (${ev.filename.split('/').pop()}:${ev.lineno})` : ''}` : 'ressource introuvable'));
  window.addEventListener('unhandledrejection', (ev) => onError(`promesse : ${ev.reason?.message || ev.reason || ''}`));

  window.addEventListener('load', () => {
    setTimeout(() => {
      const nav = performance.getEntriesByType?.('navigation')?.[0];
      if (nav && nav.loadEventEnd > 0) start.load = Math.round(nav.loadEventEnd - nav.startTime);
    }, 0);
  });

  window.GSStats = {
    optedOut,
    gpc,
    // Refuser ou accepter d'être compté. Refuser efface aussi la date de première venue.
    setOptOut(off) {
      if (off) { queue = []; store.set(OPT_KEY, '1'); store.del(SEEN_KEY); } else { store.del(OPT_KEY); store.set(SEEN_KEY, String(Date.now())); }
    },
    event(kind, name) { if (page) push({ k: kind, view: page.view, name }); },
  };

  onRoute();
  // Premier envoi rapide : une visite de quelques secondes doit compter
  setTimeout(() => flush(), 3000);
})();
