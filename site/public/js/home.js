'use strict';
/* ================================================================== */
/* Accueil (provisoire) et démarrage                                   */
/* ================================================================== */
// Un visiteur voit la vitrine (et les raids qui recrutent en ce moment) ; un compte connecté, son
// tableau de bord : ce qui lui manque pour participer, son prochain raid, ses candidatures, les
// raids qui recrutent et la recherche d'un joueur. Page à refaire (calendrier…).
const home = { listings: null, mine: null, accountId: undefined, request: 0 };
const HOME_RAIDS = 3;

async function loadHome() {
  if (currentView !== 'home') return;
  const a = state.status?.account || null;
  if ((a?.id ?? null) !== home.accountId) { home.mine = null; home.accountId = a?.id ?? null; }
  const id = ++home.request;
  loadSeasonArt();
  if (!state.raids.length) loadRaids();
  if (a) await lfLoadChars();
  try {
    const [l, m] = await Promise.all([
      api('/api/groups'),
      a ? api('/api/groups/mine').catch(() => null) : Promise.resolve(null),
    ]);
    if (id !== home.request) return;
    home.listings = l.listings || [];
    home.mine = m;
  } catch {
    if (id !== home.request) return;
    home.listings = home.listings || [];
  }
  renderHome();
}

// Les raids qui recrutent, les plus proches d'abord, sans ceux déjà terminés
function homeListings() {
  return (home.listings || []).filter((x) => x.phase !== 'ended').slice(0, HOME_RAIDS);
}

// Cartes des raids : celles de la recherche de groupe ; « Postuler » mène à la page du raid
function homeCards() {
  const list = homeListings();
  if (!home.listings) return '<div class="lf-loading"><span class="spinner" aria-hidden="true"></span></div>';
  if (!list.length) {
    return `<div class="card lf-empty"><b>Aucun raid ne recrute pour l'instant</b><p>Poste le tien : les joueurs qui cherchent un raid à cette heure-là le verront.</p>
      <p><a class="btn primary small" href="/groups/new" data-lf-go="/groups/new">Poster une annonce</a></p></div>`;
  }
  return `<div class="lf-grid home-grid">${list.map(lfCard).join('')}</div>`;
}

function renderHome() {
  const a = state.status?.account || null;
  setHtml($('#homeRaids'), a ? '' : homeCards());
  if (!a) return;
  $('#dashTitle').textContent = tr('Salut {name}', { name: a.name });
  $('#dashLead').textContent = 'Trouve un raid pour ce soir, ou monte le tien.';
  const own = home.mine?.listing;
  const post = $('#dashPost');
  post.textContent = own ? 'Mon annonce' : 'Poster une annonce';
  post.setAttribute('href', own ? `/groups/${own.code}` : '/groups/new');
  post.dataset.lfGo = own ? `/groups/${own.code}` : '/groups/new';
  const gate = lfGate('post');
  setHtml($('#dashGate'), gate ? `<div class="card lf-empty home-gate">${lfGateHtml(gate)}</div>` : '');
  renderDashLfg();
  setHtml($('#dashRaids'), homeCards());
}

/* ---------------- Ton raid, tes candidatures ------------------------ */
function renderDashLfg() {
  const el = $('#dashLfg');
  if (!el) return;
  const d = home.mine;
  if (!d) { setHtml(el, ''); return; }
  const next = [
    ...(d.listing ? [{ ...d.listing, own: true }] : []),
    ...d.tags.filter((t) => t.status === 'accepted'),
  ].sort((x, y) => x.startsAt - y.startsAt)[0];
  const others = d.tags.filter((t) => t !== next && ['pending', 'invited'].includes(t.status));
  if (!next && !others.length && !d.search) { setHtml(el, ''); return; }
  let raid = '';
  if (next) {
    const art = lfRaidArt(next.raid);
    const left = next.startsAt - Date.now();
    raid = `<a class="card glow lf-tonight" href="/groups/${esc(next.code)}" data-lf-go="/groups/${esc(next.code)}" data-track="accueil › mon raid">
      <span class="lf-kicker">${next.own ? 'Ton annonce' : 'Ton prochain raid'}</span>
      <span class="lf-tn-top"><span class="lf-tn-art" style="--art:${lfArtUrl(art?.image)}"></span>
        <span class="lf-tn-t"><b>${esc(lfTitle(next))}</b>${lfSub(next)}<small>${lfWhen(next)}</small></span>
        <span class="lf-tn-cd">${left > 0 ? `<b>${esc(lfSpan(left))}</b><small>avant le début</small>` : '<b>En cours</b>'}</span></span>
      ${next.own ? `<span class="lf-small lf-muted">${lfComp(next)}</span>` : `<span class="lf-small lf-muted">${tr('Tu y vas en {role} avec {name}', { role: `<b>${esc(LF_ROLE_LABEL[next.role].toLocaleLowerCase(I18N.locale))}</b>`, name: `<b class="lf-cname" style="--cls:${CLASS_COLORS[next.char.className] || 'var(--text)'}">${esc(next.char.name)}</b>` })}</span>`}
    </a>`;
  }
  const rows = others.map((t) => `<a class="lf-mt" href="/groups/${esc(t.code)}" data-lf-go="/groups/${esc(t.code)}">${specIconSpan(t.char.className, null, 'lf-ico-s')}<span class="lf-mt-t">${esc(lfTitle(t))}<small>${esc(lfDay(t.startsAt))} ${esc(lfClock(t.startsAt))}</small></span>${lfStatusPill(t.status)}</a>`).join('');
  const search = d.search ? `<a class="lf-mt is-search" href="/groups/search" data-lf-go="/groups/search">${specIconSpan(d.search.char.className, null, 'lf-ico-s')}<span class="lf-mt-t">Ta recherche<small>${esc(lfDay(d.search.startsAt))} ${esc(lfClock(d.search.startsAt))} → ${esc(lfClock(d.search.endsAt))}</small></span><span class="lf-pill is-rec">En ligne</span></a>` : '';
  const list = rows || search ? `<section class="card lf-mytags"><h2 class="dash-h">Tes candidatures</h2><div class="lf-mt-list">${rows}${search}</div><a class="lf-small" href="/groups" data-lf-go="/groups">Voir les raids qui recrutent</a></section>` : '';
  setHtml(el, `<div class="lf-dash${raid && list ? '' : ' is-single'}">${raid}${list}</div>`);
}

function bindHome() {
  const root = $('#home');
  // « Postuler » d'une carte : la page du raid, où tout se passe
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lf="tag-open"]');
    if (!b) return;
    ev.preventDefault();
    goTo(`/groups/${b.dataset.code}`);
  });
  // Champ « Rechercher un joueur » : une porte vers la palette. Clic, Entrée, Espace, flèche bas ou
  // une lettre tapée l'ouvrent, la lettre y étant reprise.
  const homeInput = $('#homeSearchQuery');
  homeInput.addEventListener('click', () => openPalette());
  homeInput.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
    const typed = ev.key.length === 1 && ev.key !== ' ';
    if (!typed && !['Enter', ' ', 'ArrowDown'].includes(ev.key)) return;
    ev.preventDefault();
    openPalette(typed ? ev.key : '');
  });
  $('#homeSearch').addEventListener('submit', (ev) => {
    ev.preventDefault();
    openPalette();
  });
}

// Les annonces bougent : l'accueil se relit toutes les 60 s quand il est affiché
setInterval(() => { if (!document.hidden && currentView === 'home') loadHome(); }, 60e3);

/* ================================================================== */
/* Démarrage                                                           */
/* ================================================================== */
bindModal();
bindDevDock();
bindNavMenu();
bindNotifications();
bindAuth();
bindVerify();
bindAccountPages();
bindContact();
bindLegal();
bindGear();
bindPlayerPage();
bindGroups();
bindAdmin();
bindHome();
// Listes déroulantes personnalisées (public/select.js)
document.querySelectorAll('select').forEach(enhanceSelect);
watchNavWidth();
// Seul le fragment a changé (lien de la barre sur l'accueil) : rien à refaire
window.addEventListener('popstate', () => { if (currentPath() !== routedPath) route(); });
route();
// Filet si rien ne répond : la page apparaît quand même
setTimeout(() => document.body.classList.remove('booting'), 5000);
loadStatus();
loadRaids();
loadDungeons();
