'use strict';
/* ================================================================== */
/* Barre du haut : pages, compte, notifications                        */
/* ================================================================== */
// Trois morceaux redessinés à chaque statut et à chaque vue :
//   pages (renderNavLinks)    : Accueil et Trouver un groupe (connecté), ou les sections de
//                               l'accueil (visiteur) ; le bouton ☰ les remplace quand elles ne
//                               tiennent plus
//   action (renderNavCta)     : seulement ce qui bloque — créer un compte, confirmer son adresse
//   compte (renderNavAccount) : « Se connecter », ou la loupe, la cloche et le menu du compte

// Un admin peut se connecter « en tant que » quelqu'un depuis /admin : tant que ça dure, tout le
// site répond comme pour ce compte, et cette barre est le seul rappel visible.
function renderImpersonation() {
  const el = $('#impBar');
  if (!el) return;
  const by = state.status?.impersonatedBy || null;
  const who = state.status?.account || null;
  document.body.classList.toggle('impersonating', Boolean(by));
  renderDevDock();
  // En local, le module admin du même coin dit déjà en tant que qui on est connecté
  el.hidden = !by || devActive();
  if (el.hidden) return setHtml(el, '');
  setHtml(el, `
    <span class="imp-dot" aria-hidden="true"></span>
    <span class="imp-who">${tr('Connecté en tant que {name}', { name: `<b>${esc(who?.name || '?')}</b>` })}</span>
    <button class="btn glass small" type="button" data-action="stop-impersonation" title="${esc(tr('Revenir sur {email}', { email: by.email }))}">Revenir à mon compte</button>`);
}

function renderAccountNav() {
  const a = state.status?.account || null;
  document.body.classList.toggle('logged-in', Boolean(a));
  // Posée seulement une fois le statut connu : les boutons d'inscription ne clignotent pas pour
  // quelqu'un qui est en fait connecté
  document.body.classList.toggle('anon', !a);
  document.body.classList.toggle('account-admin', Boolean(a?.admin));
  renderNavParts();
}

function renderNavParts() {
  renderNavLinks();
  renderNavCta();
  renderNavAccount();
  if (navMenu.open) renderNavMenu();
}

const NM_ICONS = {
  home: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.2 8 2.6l5.5 4.6v6a.8.8 0 0 1-.8.8H9.6V10H6.4v4H3.3a.8.8 0 0 1-.8-.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  account: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.8 13.6c.7-2.4 2.8-3.7 5.2-3.7s4.5 1.3 5.2 3.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  groups: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.8 13.2c.5-2 2.2-3.2 4.2-3.2s3.7 1.2 4.2 3.2M10.6 3.4a2.3 2.3 0 0 1 0 4.4M12 10.2c1.1.4 1.9 1.4 2.2 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  logout: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.5H3.4A.9.9 0 0 0 2.5 3.4v9.2a.9.9 0 0 0 .9.9h3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10.5 5 13.5 8l-3 3M13 8H6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  caret: '<svg class="nl-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.5 10.5 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  admin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 13 3.4v4c0 3.1-2.1 5.6-5 6.9-2.9-1.3-5-3.8-5-6.9v-4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m5.8 8 1.6 1.6 3-3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// Visiteur : les sections de l'accueil (le logo ramène déjà à l'accueil)
const NAV_ANCHORS = [
  { href: '/#how', label: 'Comment ça marche' },
  { href: '/#faq', label: 'Questions' },
];

const navHere = (view) => (currentView === view ? ' is-current" aria-current="page' : '');

function renderNavLinks() {
  const el = $('#navLinks');
  if (!el) return;
  const a = statusKnown ? state.status?.account : undefined;
  let html = '';
  if (a) {
    html = `<a class="nav-link${navHere('home')}" href="/" data-view="home" data-track="barre › accueil">Accueil</a>
      <a class="nav-link${navHere('groups')}" href="/groups" data-lf-go="/groups" data-track="barre › trouver un groupe">Trouver un groupe</a>`;
  } else if (a === null) {
    html = NAV_ANCHORS.map((x) => `<a class="nav-link" href="${x.href}" data-view="home" data-track="barre › ${esc(x.label)}">${esc(x.label)}</a>`).join('')
      + `<a class="nav-link${navHere('groups')}" href="/groups" data-lf-go="/groups" data-track="barre › trouver un groupe">Trouver un groupe</a>`;
  }
  setHtml(el, html);
  const burger = $('#navBurger');
  if (burger) {
    burger.hidden = !html;
    burger.setAttribute('aria-expanded', String(navMenu.open && navMenu.mode === 'pages'));
  }
}

function renderNavCta() {
  const el = $('#navCta');
  if (!el) return;
  const a = statusKnown ? state.status?.account : undefined;
  let html = '';
  if (a === null) {
    // Visiteur : sauf sur la page de connexion, qui a déjà son propre bouton
    if (currentView !== 'login') html = '<a class="btn primary nav-cta" href="/login?signup=1" data-view="login">Créer un compte</a>';
  } else if (a && !a.verified) {
    html = '<button class="btn primary nav-cta" type="button" data-action="verify-code">Confirmer mon adresse</button>';
  }
  setHtml(el, html);
}

// Initiale de l'avatar : la première lettre du pseudo
const navInitial = (a) => (Array.from(String(a?.name || a?.email || '?').trim())[0] || '?').toUpperCase();

// Compte connecté : la loupe (« Rechercher un joueur »), la cloche, puis l'avatar et le pseudo
// qui ouvrent le menu du compte (Mon compte, Admin, Déconnexion)
function renderNavAccount() {
  const el = $('#navAccount');
  if (!el) return;
  if (!statusKnown) { setHtml(el, ''); return; }
  const a = state.status?.account || null;
  if (!a) {
    setHtml(el, currentView === 'login' ? '' : '<a class="btn glass small" href="/login" data-view="login">Se connecter</a>');
    return;
  }
  const open = navMenu.open && navMenu.mode === 'account';
  setHtml(el, `<a class="btn glass small nav-icon nav-search${currentView === 'player' ? ' is-current' : ''}" href="/player" data-pal-open title="Rechercher un joueur" aria-label="Rechercher un joueur" data-track="barre › recherche">${NM_ICONS.search}</a>
    ${navBellHtml()}
    <button class="nav-me${currentView === 'account' || currentView === 'admin' ? ' is-current' : ''}" type="button" data-nav-menu="account" aria-haspopup="menu" aria-controls="navMenu" aria-expanded="${open}" title="${esc(a.name)} · ${esc(a.email)}" aria-label="Ton compte · ${esc(a.name)}" data-track="barre › compte">
      <span class="nav-avatar" aria-hidden="true">${esc(navInitial(a))}</span><span class="nav-me-name">${esc(a.name)}</span>${NM_ICONS.caret}
    </button>`);
  renderNavBell();
}

/* ---------------- Menus de la barre du haut ------------------------ */
// Deux menus qui partagent le même élément #navMenu, posé hors de .nav (fitNav ne doit pas le
// mesurer) et placé sous le bouton qui l'ouvre : `account` (l'avatar) et `pages` (le bouton ☰).
const navMenu = { open: false, mode: null, anchor: null };

function navMenuItem({ act, href = '#', icon, label, sub = '', cur = false, extra = '', track, cls = '' }) {
  return `<a class="nm-item${cls}${cur ? ' is-current' : ''}" href="${href}" role="menuitem" tabindex="-1" data-nm="${act}"${extra} data-track="menu › ${track}"${cur ? ' aria-current="page"' : ''}>
    <span class="nm-ico">${icon}</span>
    <span class="nm-text"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
  </a>`;
}

// Admins seulement : requêtes à l'API Blizzard cette heure, avec la clé du site, tous les comptes
// confondus, et la jauge ; le détail dans l'info-bulle
function blizzGauge(u) {
  if (!u || !(u.limit > 0)) return '';
  const used = Math.max(0, Math.round(u.used || 0));
  const ratio = Math.max(0, Math.min(100, (used / u.limit) * 100));
  const tone = ratio >= 90 ? 'high' : ratio >= 70 ? 'mid' : 'low';
  const fr = (n) => n.toLocaleString('fr-FR');
  const title = `Requêtes à l'API Blizzard sur les 60 dernières minutes (clé du site, tous les comptes) : ${fr(used)} sur ${fr(u.limit)}. `
    + `En ce moment : ${u.perSecond}/s (limite ${u.perSecondLimit}/s). Profils en cache : ${fr(u.cached || 0)}.`
    + (u.limited ? ` Refusées pour limite depuis le démarrage : ${fr(u.limited)}.` : '');
  const stats = `${fr(Math.max(0, u.limit - used))} restantes · ${u.perSecond}/s · ${fr(u.cached || 0)} en cache`;
  const refused = u.limited
    ? `<small class="nm-credit-note nm-credit-bad">${fr(u.limited)} refusée${u.limited > 1 ? 's' : ''} pour limite${u.lastLimitedAt ? `, la dernière ${esc(timeAgo(u.lastLimitedAt))}` : ''}</small>`
    : '';
  return `<span class="dash-src-meta" title="${esc(title)}">${fr(used)} / ${fr(u.limit)}</span>
    <span class="wcl-bar ${tone}" title="${esc(title)}" aria-hidden="true"><i style="width: ${ratio.toFixed(1)}%"></i></span>
    <small class="nm-credit-note nm-credit-info">${stats}</small>${refused}`;
}

function navCredits() {
  const a = state.status?.account;
  if (!a?.admin) return '';
  const blizz = blizzGauge(state.blizzUsage);
  return blizz ? `<div class="nm-credit"><b>Blizzard</b>${blizz}</div>` : '';
}

function renderNavCredits() {
  const el = $('#nmCredits');
  if (el) setHtml(el, navCredits());
}

// Admins : le compteur des requêtes Blizzard est relu à l'ouverture du menu du compte, puis toutes
// les 30 s tant qu'il reste ouvert
async function loadBlizzUsage() {
  if (!state.status?.account?.admin) { state.blizzUsage = null; return; }
  try { state.blizzUsage = await api('/api/admin/blizzard'); } catch { return; }
  renderNavCredits();
}
setInterval(() => {
  if (!document.hidden && state.status?.account?.admin && navMenu.open && navMenu.mode === 'account') loadBlizzUsage();
}, 30e3);

function renderNavMenu() {
  const a = state.status?.account;
  const el = $('#navMenu');
  if (!el || !navMenu.open) return;
  let html = '';
  if (navMenu.mode === 'account' && a) {
    const end = [navMenuItem({ act: 'go', href: '/account', icon: NM_ICONS.account, label: 'Mon compte', cur: currentView === 'account', track: 'compte' })];
    if (a.admin) end.push(navMenuItem({ act: 'go', href: '/admin', icon: NM_ICONS.admin, label: 'Admin', cur: currentView === 'admin', track: 'admin' }));
    const credits = navCredits();
    html = `<div class="nm-who"><span class="nav-avatar" aria-hidden="true">${esc(navInitial(a))}</span><span><b>${esc(a.name)}</b><small>${esc(a.email)}</small></span></div>
      ${credits ? `<div class="nm-credits" id="nmCredits">${credits}</div>` : '<div id="nmCredits"></div>'}
      <div class="nm-sep"></div>
      <div class="nm-group">${end.join('')}</div>
      <div class="nm-sep"></div>
      <div class="nm-group">${navMenuItem({ act: 'logout', icon: NM_ICONS.logout, label: 'Déconnexion', track: 'déconnexion', cls: ' nm-danger' })}</div>`;
  } else if (navMenu.mode === 'pages') {
    if (a) {
      html = `<div class="nm-group">
        ${navMenuItem({ act: 'go', href: '/', icon: NM_ICONS.home, label: 'Accueil', cur: currentView === 'home', track: 'accueil' })}
        ${navMenuItem({ act: 'go', href: '/groups', icon: NM_ICONS.groups, label: 'Trouver un groupe', sub: 'Raids qui recrutent', cur: currentView === 'groups', track: 'trouver un groupe' })}
      </div>`;
    } else {
      html = `<div class="nm-group">${NAV_ANCHORS.map((x) => navMenuItem({ act: 'go', href: x.href, icon: NM_ICONS.home, label: x.label, track: x.label })).join('')}
        ${navMenuItem({ act: 'go', href: '/groups', icon: NM_ICONS.groups, label: 'Trouver un groupe', sub: 'Raids qui recrutent', cur: currentView === 'groups', track: 'trouver un groupe' })}</div>`;
    }
  }
  setHtml(el, html);
}

// Sous la barre, calé à droite du bouton qui l'ouvre ; jamais hors de l'écran
function placeNavMenu() {
  const el = $('#navMenu');
  const anchor = navMenu.anchor;
  if (!el || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const width = Math.min(300, vw - 16);
  el.style.width = `${width}px`;
  el.style.left = `${Math.max(8, Math.min(r.right - width, vw - width - 8))}px`;
  el.style.top = `${$('.nav').getBoundingClientRect().bottom + 6}px`;
}

const navMenuItems = () => [...$('#navMenu').querySelectorAll('.nm-item')];

function openNavMenu(mode, anchor, { focus = true } = {}) {
  closeNotifPanel({ focus: false });
  if (navMenu.open) closeNavMenu({ focus: false });
  if (mode !== 'pages' && !state.status?.account) return;
  Object.assign(navMenu, { open: true, mode, anchor });
  renderNavMenu();
  if (mode === 'account') loadBlizzUsage();
  const el = $('#navMenu');
  el.hidden = false;
  placeNavMenu();
  void el.offsetWidth;          // départ de l'animation enregistré avant d'ajouter .open
  el.classList.add('open');
  anchor.setAttribute('aria-expanded', 'true');
  if (focus) (navMenuItems().find((x) => x.classList.contains('is-current')) || navMenuItems()[0])?.focus();
}

function closeNavMenu({ focus = true } = {}) {
  if (!navMenu.open) return;
  const anchor = navMenu.anchor;
  Object.assign(navMenu, { open: false, mode: null, anchor: null });
  const el = $('#navMenu');
  el.classList.remove('open');
  el.hidden = true;
  if (anchor?.isConnected) {
    anchor.setAttribute('aria-expanded', 'false');
    if (focus) anchor.focus();
  }
}

// Accueil, ou une section de l'accueil (/#faq) : l'ancre suit, depuis n'importe quelle page
function goHome(href = '/') {
  const hash = href.startsWith('/#') ? href.slice(1) : '';
  if (location.pathname + location.search + location.hash !== `/${hash}`) history.pushState({}, '', `/${hash}`);
  routedPath = currentPath();
  showView('home');
  const target = hash && document.getElementById(hash.slice(1));
  if (target) target.scrollIntoView({ block: 'start' });
  else window.scrollTo({ top: 0 });
}

function bindNavMenu() {
  // Boutons qui ouvrent un menu : l'avatar, ☰ (dessinés après coup, d'où la délégation)
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-nav-menu]');
    if (!btn) return;
    ev.preventDefault();
    const mode = btn.dataset.navMenu;
    if (navMenu.open && navMenu.mode === mode) closeNavMenu();
    else openNavMenu(mode, btn, { focus: ev.detail === 0 });   // au clavier, le focus entre dans le menu
  });
  document.addEventListener('keydown', (ev) => {
    const btn = document.activeElement?.closest?.('[data-nav-menu]');
    if (!btn) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); openNavMenu(btn.dataset.navMenu, btn); }
    else if (ev.key === 'Escape' && navMenu.open) { ev.preventDefault(); closeNavMenu(); }
  });
  const el = $('#navMenu');
  el.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-nm]');
    if (!item) return;
    const act = item.dataset.nm;
    if (act === 'logout') { ev.preventDefault(); closeNavMenu({ focus: false }); logout(); return; }
    // Ctrl+clic, clic du milieu : nouvel onglet, comme un lien ordinaire
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    closeNavMenu({ focus: false });
    const href = item.getAttribute('href');
    if (href === '/' || href.startsWith('/#')) goHome(href);
    else goTo(href);
  });
  // Clavier : flèches, Début / Fin, Échap rend la main au bouton, Tab referme
  el.addEventListener('keydown', (ev) => {
    const items = navMenuItems();
    const at = items.indexOf(document.activeElement);
    const go = (i) => { ev.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (ev.key === 'ArrowDown') go(at + 1);
    else if (ev.key === 'ArrowUp') go(at - 1);
    else if (ev.key === 'Home') go(0);
    else if (ev.key === 'End') go(items.length - 1);
    else if (ev.key === 'Escape') { ev.preventDefault(); closeNavMenu(); }
    else if (ev.key === 'Tab') closeNavMenu({ focus: false });
  });
  document.addEventListener('pointerdown', (ev) => {
    if (navMenu.open && !ev.target.closest('#navMenu, [data-nav-menu]')) closeNavMenu({ focus: false });
  });
  window.addEventListener('resize', () => { if (navMenu.open) placeNavMenu(); });
  // Liens vers l'accueil et ses sections (logo, pieds de page, barre d'un visiteur)
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-view="home"]');
    if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    goHome(a.getAttribute('href') || '/');
  });
}

/* ---------------- Notifications (cloche de la barre du haut) ------ */
// Tout arrive par le direct du compte (/api/notifications/events, un par onglet) : la liste au
// branchement, puis chaque notification, lecture ou effacement, dans tous les onglets.
const notifs = { account: undefined, source: null, items: [], unread: 0, known: false, open: false };
const NOTIF_ICONS = {
  bell: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.4H2.8zM6.6 13.8a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lfg_tag: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h5.2l5.8 5.8-4.2 4.2-5.8-5.8V3.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="5.4" cy="6.1" r="1" fill="currentColor"/></svg>',
  lfg_invite: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3.5" width="12" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m2.5 4.5 5.5 4.3 5.5-4.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  lfg_join: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.6" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.9 13.4c.5-2.1 2.1-3.2 4.1-3.2s3.6 1.1 4.1 3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="m10.5 7.5 1.4 1.4 2.6-2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lfg_removed: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.6" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.9 13.4c.5-2.1 2.1-3.2 4.1-3.2s3.6 1.1 4.1 3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="m11 6 3 3m0-3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  lfg_left: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10.5 5l3 3-3 3M13.3 8H6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lfg_deleted: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// « à l'instant » plutôt que « il y a 1 min » pour ce qui vient d'arriver
const notifAgo = (t) => (Date.now() - t < 45e3 ? "à l'instant" : timeAgo(t));
const notifPath = (n) => (n.kind === 'lfg_deleted' ? '/groups' : `/groups/${n.data.code}`);

function notifText(n) {
  const d = n.data || {};
  const raid = d.title || [LF_GOALS[d.goal], d.raid, d.difficulty ? lfDiff(d.difficulty).label : ''].filter(Boolean).join(' · ');
  const when = d.startsAt ? `${lfDay(d.startsAt)} ${lfClock(d.startsAt)}` : '';
  const where = [raid, when].filter(Boolean).join(' · ');
  const role = d.role && LF_ROLE_LABEL[d.role] ? LF_ROLE_LABEL[d.role].toLocaleLowerCase(I18N.locale) : '';
  if (n.kind === 'lfg_tag') return { title: tr('Nouvelle candidature de {name} dans ton raid', { name: d.name || '' }), text: [role, where].filter(Boolean).join(' · ') };
  if (n.kind === 'lfg_invite') return { title: d.offer ? 'Un raid te propose une place' : 'Le leader te propose une place', text: [role, where].filter(Boolean).join(' · ') };
  if (n.kind === 'lfg_join') return { title: tr('{name} a rejoint ton raid', { name: d.name || '' }), text: [role, where].filter(Boolean).join(' · ') };
  if (n.kind === 'lfg_removed') return { title: 'Le leader a retiré ton personnage de son raid', text: d.message ? `« ${d.message} » · ${where}` : where };
  if (n.kind === 'lfg_left') return { title: tr('{name} a quitté ton raid', { name: d.name || '' }), text: d.message ? `« ${d.message} » · ${where}` : where };
  if (n.kind === 'lfg_deleted') return { title: 'Un raid a été annulé', text: where };
  return { title: 'Notifications', text: '' };
}

// Appelée à chaque statut : le direct suit le compte connecté (rien pour un visiteur)
function syncNotifications() {
  const id = state.status?.account?.id ?? null;
  if (id === notifs.account) return;
  notifs.source?.close();
  Object.assign(notifs, { account: id, source: null, items: [], unread: 0, known: false });
  closeNotifPanel({ focus: false });
  renderNavBell();
  if (id != null) connectNotifications();
}

function connectNotifications() {
  const source = new EventSource('/api/notifications/events');
  notifs.source = source;
  const on = (name, fn) => source.addEventListener(name, (ev) => {
    if (notifs.source !== source) return;
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    fn(d);
    renderNotifs();
  });
  on('snapshot', (d) => { notifs.items = d.items || []; notifs.unread = d.unread || 0; notifs.known = true; });
  on('notification', ({ item, unread }) => {
    notifs.items = [item, ...notifs.items.filter((x) => x.id !== item.id)].slice(0, 30);
    notifs.unread = unread;
    if (currentView === 'home') loadHome();
  });
  on('read', ({ ids, unread }) => {
    for (const x of notifs.items) if (!ids || ids.includes(x.id)) x.read = true;
    notifs.unread = unread;
  });
  on('removed', ({ ids, unread }) => {
    notifs.items = ids ? notifs.items.filter((x) => !ids.includes(x.id)) : [];
    notifs.unread = unread;
  });
}

function renderNotifs() {
  renderNavBell();
  if (notifs.open) renderNotifPanel();
}

// La cloche est dans le bloc du compte (renderNavAccount) : on ne réécrit que son compteur
function renderNavBell() {
  const bell = $('#navBell');
  if (!bell) return;
  const n = notifs.unread;
  bell.classList.toggle('has-unread', n > 0);
  const label = n ? tr('Notifications, {n, plural, one {# non lue} other {# non lues}}', { n }) : 'Notifications';
  bell.setAttribute('aria-label', label);
  bell.title = label;
  const count = bell.querySelector('.nav-bell-count');
  const text = n ? (n > 9 ? '9+' : String(n)) : '';
  if (count.textContent !== text) count.textContent = text;
}

function navBellHtml() {
  return `<button class="btn glass small nav-icon nav-bell${notifs.open ? ' is-current' : ''}" id="navBell" type="button" aria-haspopup="true" aria-controls="notifPanel" aria-expanded="${notifs.open}" data-track="barre › notifications">
      ${NOTIF_ICONS.bell}<span class="nav-bell-count" aria-hidden="true"></span>
    </button>`;
}

// Une ligne : le lien de la notification, et à côté la croix qui l'efface seule
const NT_DEL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
function notifItemHtml(n) {
  const { title, text } = notifText(n);
  const over = n.kind !== 'lfg_deleted' && n.live === false;
  return `<div class="nt-row" data-row="${n.id}"><a class="nt-item${n.read ? '' : ' is-unread'}${over ? ' is-over' : ''}" href="${esc(notifPath(n))}" data-nt="open" data-id="${n.id}" data-track="notifications › ouvrir">
    <span class="nt-ico nt-${esc(n.kind)}">${NOTIF_ICONS[n.kind] || NOTIF_ICONS.bell}</span>
    <span class="nt-text"><b>${esc(title)}</b>${text ? `<small>${esc(text)}</small>` : ''}<time>${esc(notifAgo(n.createdAt))}${over ? ' · annonce terminée' : ''}</time></span>
    ${n.read ? '' : '<i class="nt-dot" title="Non lue"></i>'}
  </a><button class="nt-del" type="button" data-nt="remove" data-id="${n.id}" aria-label="Effacer cette notification" title="Effacer cette notification" data-track="notifications › effacer">${NT_DEL_ICON}</button></div>`;
}

function renderNotifPanel() {
  const el = $('#notifPanel');
  if (!el) return;
  const items = notifs.items;
  const list = !notifs.known
    ? '<div class="nt-empty"><span class="spinner" aria-hidden="true"></span></div>'
    : items.length
      ? `<div class="nt-list">${items.map(notifItemHtml).join('')}</div>`
      : `<div class="nt-empty"><span class="nt-empty-ico">${NOTIF_ICONS.bell}</span><b>Rien pour l'instant</b><small>Les candidatures à ton raid, les places qu'on te propose et les nouvelles de tes raids arriveront ici.</small></div>`;
  setHtml(el, `
    <div class="nt-head">
      <b>Notifications</b>
      ${notifs.unread ? '<button class="nt-link" type="button" data-nt="read-all" data-track="notifications › tout lire">Tout marquer comme lu</button>' : ''}
    </div>
    ${list}
    ${items.length ? '<div class="nt-foot"><button class="nt-link" type="button" data-nt="clear" data-track="notifications › tout effacer">Tout effacer</button></div>' : ''}`);
}

// Sous la barre, calé sur le bord droit de la cloche ; jamais hors de l'écran
function placeNotifPanel() {
  const el = $('#notifPanel');
  const bell = $('#navBell');
  if (!el || !bell) return;
  const r = bell.getBoundingClientRect();
  const nav = $('.nav').getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const width = Math.min(360, vw - 16);
  el.style.width = `${width}px`;
  el.style.left = `${Math.max(8, Math.min(r.right - width, vw - width - 8))}px`;
  el.style.top = `${nav.bottom + 8}px`;
}

const notifPanelItems = () => [...$('#notifPanel').querySelectorAll('.nt-item, .nt-del, .nt-link')];

function openNotifPanel() {
  if (!state.status?.account) return;
  closeNavMenu({ focus: false });
  notifs.open = true;
  renderNotifPanel();
  const el = $('#notifPanel');
  el.hidden = false;
  placeNotifPanel();
  void el.offsetWidth;
  el.classList.add('open');
  $('#navBell')?.setAttribute('aria-expanded', 'true');
  $('#navBell')?.classList.add('is-current');
  // Relue à l'ouverture : une annonce a pu disparaître depuis (« annonce terminée »)
  api('/api/notifications').then((d) => {
    notifs.items = d.items || [];
    notifs.unread = d.unread || 0;
    notifs.known = true;
    renderNotifs();
  }).catch(() => {});
}

function closeNotifPanel({ focus = true } = {}) {
  if (!notifs.open) return;
  notifs.open = false;
  const el = $('#notifPanel');
  el.classList.remove('open');
  el.hidden = true;
  $('#navBell')?.setAttribute('aria-expanded', 'false');
  $('#navBell')?.classList.remove('is-current');
  if (focus) $('#navBell')?.focus();
}

// Lire : l'onglet courant tout de suite, les autres par le direct
function markNotifsRead(ids) {
  const unread = notifs.items.filter((x) => !x.read && (!ids || ids.includes(x.id)));
  if (!unread.length && ids) return;
  for (const x of unread) x.read = true;
  notifs.unread = ids ? Math.max(0, notifs.unread - unread.length) : 0;
  renderNotifs();
  api('/api/notifications/read', { method: 'POST', body: ids ? { ids } : {} }).catch(() => {});
}

function openNotif(n) {
  markNotifsRead([n.id]);
  if (n.live === false && n.kind !== 'lfg_deleted') { toast("Cette annonce n'existe plus."); return; }
  goTo(notifPath(n));
}

function bindNotifications() {
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#navBell')) return;
    ev.preventDefault();
    if (notifs.open) closeNotifPanel();
    else openNotifPanel();
  });
  const el = $('#notifPanel');
  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-nt]');
    if (!btn) return;
    const act = btn.dataset.nt;
    if (act === 'read-all') { markNotifsRead(null); return; }
    if (act === 'clear') {
      notifs.items = [];
      notifs.unread = 0;
      renderNotifs();
      api('/api/notifications/clear', { method: 'POST', body: {} }).catch(() => {});
      return;
    }
    // Une seule : retirée tout de suite ici, dans les autres onglets par le direct
    if (act === 'remove') {
      const id = Number(btn.dataset.id);
      const at = notifs.items.findIndex((x) => x.id === id);
      if (at < 0) return;
      const keyboard = document.activeElement === btn;
      if (!notifs.items[at].read) notifs.unread = Math.max(0, notifs.unread - 1);
      notifs.items.splice(at, 1);
      renderNotifs();
      if (keyboard) {
        const dels = [...el.querySelectorAll('.nt-del')];
        (dels[Math.min(at, dels.length - 1)] || el.querySelector('.nt-link'))?.focus();
      }
      api('/api/notifications/clear', { method: 'POST', body: { ids: [id] } }).catch(() => {});
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    const n = notifs.items.find((x) => x.id === Number(btn.dataset.id));
    closeNotifPanel({ focus: false });
    if (n) openNotif(n);
  });
  // Clavier : flèches, Début / Fin, Échap rend la main à la cloche, Tab referme
  el.addEventListener('keydown', (ev) => {
    const items = notifPanelItems();
    const at = items.indexOf(document.activeElement);
    const go = (i) => { ev.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (ev.key === 'ArrowDown') go(at + 1);
    else if (ev.key === 'ArrowUp') go(at - 1);
    else if (ev.key === 'Home') go(0);
    else if (ev.key === 'End') go(items.length - 1);
    else if (ev.key === 'Escape') { ev.preventDefault(); closeNotifPanel(); }
    else if (ev.key === 'Tab') closeNotifPanel({ focus: false });
  });
  document.addEventListener('keydown', (ev) => {
    if (document.activeElement?.id !== 'navBell') return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!notifs.open) openNotifPanel();
      notifPanelItems()[0]?.focus();
    } else if (ev.key === 'Escape' && notifs.open) { ev.preventDefault(); closeNotifPanel(); }
  });
  document.addEventListener('pointerdown', (ev) => {
    if (notifs.open && !ev.target.closest('#notifPanel, #navBell')) closeNotifPanel({ focus: false });
  });
  window.addEventListener('resize', () => { if (notifs.open) placeNotifPanel(); });
}
