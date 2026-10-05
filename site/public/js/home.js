'use strict';
/* ================================================================== */
/* Accueil et démarrage                                                */
/* ================================================================== */
// Un visiteur voit la vitrine (et les raids qui recrutent en ce moment) ; un compte connecté, son
// tableau de bord : ce qui lui manque pour participer, le calendrier des 14 prochains jours et la
// recherche d'un joueur.
const home = { listings: null, mine: null, accountId: undefined, request: 0 };
const HOME_RAIDS = 3;

async function loadHome() {
  if (currentView !== 'home') return;
  const a = state.status?.account || null;
  if ((a?.id ?? null) !== home.accountId) {
    home.mine = null;
    home.accountId = a?.id ?? null;
    Object.assign(cal, { raids: null, day: null, dayFrom: null, sel: 0, slot: null });
  }
  const id = ++home.request;
  loadSeasonArt();
  if (!state.raids.length) loadRaids();
  if (a) await lfLoadChars();
  try {
    const [l, m, c] = await Promise.all([
      a ? null : api('/api/groups'),
      a ? api('/api/groups/mine').catch(() => null) : null,
      a ? api('/api/groups/calendar') : null,
    ]);
    if (id !== home.request) return;
    if (l) home.listings = l.listings || [];
    home.mine = m;
    if (c) cal.raids = c.raids || [];
  } catch {
    if (id !== home.request) return;
    home.listings = home.listings || [];
    cal.raids = cal.raids || [];
  }
  renderHome();
  if (a) loadCalDay();
}

// Les raids qui recrutent, les plus proches d'abord, sans ceux déjà terminés
function homeListings() {
  return (home.listings || []).filter((x) => x.phase !== 'ended').slice(0, HOME_RAIDS);
}

// Cartes des raids de la vitrine : celles de la recherche de groupe ; « Postuler » mène à la page du raid
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
  renderCal();
}

/* ---------------- Calendrier des 14 prochains jours ----------------- */
// Fait pour tenir avec des dizaines de raids par jour : chaque jour du ruban montre son nombre de
// raids et leur répartition par difficulté ; tes raids (annonce, place, candidature) gardent un
// cercle lavande. Le jour choisi détaille ses heures de début (barres cliquables), des filtres et
// 4 lignes au plus, tes raids d'abord ; le reste s'ouvre dans /groups, filtré sur ce jour.
// GET /api/groups/calendar donne [début, difficulté] de chaque annonce ; les annonces du jour
// choisi arrivent avec GET /api/groups?from=&to=.
const cal = { raids: null, sel: 0, day: null, dayFrom: null, diff: 0, slot: null, fits: false, request: 0 };
const CAL_DAYS = 14;
const CAL_ROWS = 4;
const CAL_BAR_H = 54;
// Tes raids : libellé, et cercle plein (tu y es) ou en pointillé (pas encore sûr)
const CAL_ME = {
  leader: [tr('Ton annonce'), true],
  accepted: [tr('Inscrit'), true],
  invited: [tr('Place proposée'), false],
  pending: [tr('Candidature'), false],
};
const calDayFrom = (i) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + i).getTime(); };
const calIndex = (t) => Math.round((lfDayStart(t) - calDayFrom(0)) / 864e5);
const calMinutes = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
const calWeekday = (t, style = 'short') => new Date(t).toLocaleDateString(I18N.locale, { weekday: style }).replace('.', '');
function calShort(t) {
  const i = calIndex(t);
  if (i <= 0) return lfDay(t);
  if (i === 1) return tr('Demain');
  return new Date(t).toLocaleDateString(I18N.locale, { weekday: 'short', day: 'numeric' });
}

// Tes raids à venir : ton annonce, tes places et tes candidatures en cours
function calMine() {
  const d = home.mine;
  if (!d) return [];
  const out = d.listing ? [{ ...d.listing, me: 'leader' }] : [];
  for (const t of d.tags || []) if (CAL_ME[t.status]) out.push({ ...t, me: t.status });
  return out.filter((x) => x.endsAt > Date.now()).sort((x, y) => x.startsAt - y.startsAt);
}
const calIsMine = (x) => Boolean(x.mine && (x.mine.leader || CAL_ME[x.mine.status]));
const calMeOf = (x) => (x.mine?.leader ? 'leader' : x.mine?.status);

async function loadCalDay() {
  const from = calDayFrom(cal.sel);
  const to = calDayFrom(cal.sel + 1);
  const id = ++cal.request;
  if (cal.dayFrom !== from) { cal.day = null; renderCal(); }
  let list = [];
  try { list = (await api(`/api/groups?from=${from}&to=${to}`)).listings || []; } catch { /* jour vide */ }
  if (id !== cal.request) return;
  cal.day = list.filter((x) => x.phase !== 'ended');
  cal.dayFrom = from;
  renderCal();
}

function renderCal() {
  const el = $('#dashCal');
  if (!el || !state.status?.account) return;
  // Le focus clavier reste sur le même bouton après un nouveau rendu
  const f = document.activeElement?.closest?.('#dashCal [data-cal]');
  const key = f ? `[data-cal="${f.dataset.cal}"][data-v="${f.dataset.v ?? ''}"]` : null;
  setHtml(el, `
    <div class="cal-head">
      <div><span class="cal-kicker">Calendrier</span><h2 class="cal-title" id="calTitle">Tes 14 prochains jours</h2></div>
      <div class="cal-legend" aria-hidden="true">
        ${DIFFICULTIES.map((d) => `<span><i class="cal-d${d.id}"></i>${esc(d.label)}</span>`).join('')}
        <span><i class="is-ring"></i>Tu y es</span>
        <span><i class="is-ring is-dash"></i>Candidature</span>
      </div>
    </div>
    ${calStrip()}
    <div class="cal-body">
      <div class="cal-detail">${calDetail()}</div>
      <aside class="cal-side" aria-label="Tes raids">${calSide()}</aside>
    </div>`);
  if (key) el.querySelector(key)?.focus();
}

function calStrip() {
  if (!cal.raids) return `<div class="cal-strip">${Array.from({ length: CAL_DAYS }, () => '<span class="cal-day skel"></span>').join('')}</div>`;
  const per = Array.from({ length: CAL_DAYS }, () => ({ n: 0, by: {} }));
  for (const [t, d] of cal.raids) {
    const i = calIndex(t);
    if (i < 0 || i >= CAL_DAYS) continue;
    per[i].n++;
    per[i].by[d] = (per[i].by[d] || 0) + 1;
  }
  // Un raid sûr (annonce, place) l'emporte sur une candidature le même jour
  const mine = Array.from({ length: CAL_DAYS }, () => null);
  for (const x of calMine()) {
    const i = calIndex(x.startsAt);
    if (i < 0 || i >= CAL_DAYS) continue;
    if (!mine[i] || (CAL_ME[x.me][1] && !CAL_ME[mine[i]][1])) mine[i] = x.me;
  }
  const days = per.map((p, i) => {
    const t = calDayFrom(i);
    const on = i === cal.sel;
    const me = mine[i];
    const mix = p.n ? DIFFICULTIES.map((d) => (p.by[d.id] ? `<i class="cal-d${d.id}" style="width:${((p.by[d.id] / p.n) * 100).toFixed(1)}%"></i>` : '')).join('') : '';
    const label = `${lfCap(calWeekday(t, 'long'))} ${new Date(t).getDate()}, ${tr('{n, plural, =0 {aucun raid} one {# raid} other {# raids}}', { n: p.n })}${me ? ` · ${CAL_ME[me][0]}` : ''}`;
    return `<button type="button" class="cal-day${on ? ' is-on' : ''}${i === 0 ? ' is-today' : ''}${p.n ? '' : ' is-empty'}" data-cal="day" data-v="${i}" aria-pressed="${on}" aria-label="${esc(label)}">
      <span class="cal-wd">${i === 0 ? 'AUJ.' : esc(calWeekday(t).toLocaleUpperCase(I18N.locale))}</span>
      <span class="cal-num${me ? (CAL_ME[me][1] ? ' is-mine' : ' is-maybe') : ''}">${new Date(t).getDate()}</span>
      <span class="cal-mix">${mix}</span>
      <span class="cal-n">${p.n}</span>
    </button>`;
  });
  return `<div class="cal-strip" role="group" aria-label="Jours">${days.join('')}</div>`;
}

// Raids du jour choisi : filtre « Je peux postuler » (avec le personnage de « Tu regardes avec »)
function calFitting() {
  const char = lfAsChar();
  return cal.fits && char ? cal.day.filter((x) => calIsMine(x) || !lfTagBlock(x, char)) : cal.day;
}

// Heures de début : par demi-heure de 18:00 à 23:30, élargi aux raids plus tôt ; par heure si le
// jour s'étale sur plus de 12 h
function calBins(list) {
  const starts = list.map((x) => calMinutes(x.startsAt));
  const lo = Math.min(18 * 60, ...starts);
  const hi = Math.max(23 * 60 + 30, ...starts);
  const step = hi - lo > 12 * 60 ? 60 : 30;
  const first = Math.floor(lo / step) * step;
  const bins = [];
  for (let m = first; m <= hi; m += step) bins.push({ from: m, list: [] });
  for (const x of list) bins[Math.floor((calMinutes(x.startsAt) - first) / step)]?.list.push(x);
  return { bins, step };
}

function calDetail() {
  const t = calDayFrom(cal.sel);
  const title = cal.sel === 0 ? tr("Aujourd'hui") : cal.sel === 1 ? tr('Demain') : lfCap(new Date(t).toLocaleDateString(I18N.locale, { weekday: 'long', day: 'numeric', month: 'long' }));
  if (!cal.day || cal.dayFrom !== t) return `<div class="cal-dh"><span class="cal-dt">${esc(title)}</span></div><div class="lf-loading"><span class="spinner" aria-hidden="true"></span></div>`;
  const all = cal.day;
  const fit = calFitting();
  const byDiff = cal.diff ? fit.filter((x) => x.difficulty === cal.diff) : fit;
  const { bins, step } = calBins(fit);
  const slot = bins.some((b) => b.from === cal.slot) ? cal.slot : null;
  const shown = slot == null ? byDiff : byDiff.filter((x) => { const m = calMinutes(x.startsAt); return m >= slot && m < slot + step; });

  const count = shown.length === all.length
    ? tr('{n, plural, =0 {aucun raid} one {# raid} other {# raids}}', { n: all.length })
    : tr('{n} sur {total}', { n: shown.length, total: all.length });
  const chip = (id, label, n) => `<button type="button" class="cal-chip${cal.diff === id ? ' is-on' : ''}" data-cal="diff" data-v="${id}" aria-pressed="${cal.diff === id}"${id ? ` title="${esc(lfDiff(id).label)}"` : ''}>${id ? `<i class="cal-d${id}"></i>` : ''}${esc(label)} <small>${n}</small></button>`;
  const char = lfAsChar();
  const chips = [chip(0, tr('Tous'), fit.length), ...DIFFICULTIES.map((d) => chip(d.id, d.letter, fit.filter((x) => x.difficulty === d.id).length))].join('')
    + (char ? `<button type="button" class="cal-chip${cal.fits ? ' is-on' : ''}" data-cal="fits" data-v="" aria-pressed="${cal.fits}" title="${esc(tr('Avec {name}', { name: char.name }))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>${tr('Je peux postuler')}</button>` : '');

  const max = Math.max(1, ...bins.map((b) => b.list.length));
  const bars = bins.map((b) => {
    const on = slot === b.from;
    const segs = DIFFICULTIES.map((d) => {
      const n = b.list.filter((x) => x.difficulty === d.id && (!cal.diff || cal.diff === d.id)).length;
      return n ? `<i class="cal-d${d.id}" style="height:${Math.max(2, Math.round((n / max) * CAL_BAR_H))}px"></i>` : '';
    }).join('');
    const label = b.from % (step === 30 ? 60 : 120) === 0 ? `${Math.floor(b.from / 60) % 24}h` : '';
    const aria = tr('{time}, {n, plural, =0 {aucun raid} one {# raid} other {# raids}}', { time: lfHhmm(b.from), n: b.list.length });
    return `<button type="button" class="cal-bar${on ? ' is-on' : ''}${slot != null && !on ? ' is-dim' : ''}${b.list.some(calIsMine) ? ' has-mine' : ''}" data-cal="slot" data-v="${b.from}" aria-pressed="${on}" aria-label="${esc(aria)}">
      <span class="cal-bar-mark"></span><span class="cal-bar-stack">${segs}</span><span class="cal-bar-l">${label}</span>
    </button>`;
  }).join('');

  const mine = shown.filter(calIsMine);
  const top = [...mine, ...shown.filter((x) => !calIsMine(x)).slice(0, Math.max(0, CAL_ROWS - mine.length))];
  // /groups montre tout le jour (difficulté et « Je peux postuler » compris, pas l'heure)
  const more = byDiff.length > top.length ? byDiff.length : 0;
  const own = home.mine?.listing;
  const empty = !all.length
    ? `<div class="cal-none"><span>Personne ne raide ce jour-là pour l'instant.</span>${own ? '' : '<a class="btn glass small" href="/groups/new" data-lf-go="/groups/new">Poster une annonce</a>'}</div>`
    : !shown.length ? '<div class="cal-none"><span>Aucun raid avec ces filtres.</span></div>' : '';
  const moreText = tr('Voir les {n} raids de ce jour dans Trouver un raid', { n: more });

  return `
    <div class="cal-dh">
      <span class="cal-dt">${esc(title)} <small>· ${esc(count)}</small></span>
      ${all.length ? `<div class="cal-chips">${chips}</div>` : ''}
    </div>
    ${all.length ? `<div class="cal-hist">
      <div class="cal-hist-h"><span>Heure de début</span><span>${slot == null ? 'Clique une barre pour filtrer' : esc(tr('Départ entre {a} et {b} · reclique pour tout voir', { a: lfHhmm(slot), b: lfHhmm(slot + step) }))}</span></div>
      <div class="cal-bars" style="--n:${bins.length}">${bars}</div>
    </div>` : ''}
    <div class="cal-rows">
      ${top.map(calRow).join('')}
      ${empty}
      ${more > 0 ? `<button type="button" class="cal-more" data-cal="more" data-v="">${esc(moreText)} →</button>` : ''}
    </div>`;
}

function calRow(x) {
  const me = calIsMine(x) ? CAL_ME[calMeOf(x)] : null;
  const free = ROLES.map((r) => ({ r, n: Math.max(0, (x.comp?.[r] || 0) - (x.filled?.[r] || 0)) }));
  const right = me
    ? `<span class="cal-me${me[1] ? ' is-solid' : ''}">${esc(me[0])}</span>`
    : free.some((f) => f.n)
      ? `<span class="cal-free" title="${esc(tr('Places libres'))}">${free.map((f) => `<span>${lfRoleIcon(f.r)}${f.n}</span>`).join('')}</span>`
      : `<span class="cal-free is-full">${tr('Complet')}</span>`;
  const d = lfDiff(x.difficulty);
  return `<a class="cal-row${me ? ' is-mine' : ''}" href="/groups/${esc(x.code)}" data-lf-go="/groups/${esc(x.code)}" data-track="accueil › calendrier">
    <span class="cal-time">${x.phase === 'live' ? `<span class="cal-live">${tr('En cours')}</span>` : esc(lfClock(x.startsAt))}</span>
    <span class="cal-letter cal-d${d.id}" title="${esc(d.label)}">${esc(d.letter)}</span>
    <span class="cal-row-t"><b>${esc(lfTitle(x))}</b><small>${esc(x.raidName || '')} · ${esc(LF_GOALS[x.goal] || LF_GOALS.reclear)}</small></span>
    ${right}
  </a>`;
}

// À droite : ton prochain raid (compte à rebours), puis le reste de ce qui te concerne
function calSide() {
  if (!home.mine) return '<span class="skel cal-next-skel"></span>';
  const list = calMine();
  const next = list.find((x) => CAL_ME[x.me][1]);
  let card;
  if (next) {
    const left = next.startsAt - Date.now();
    const d = lfDiff(next.difficulty);
    card = `<a class="cal-next" href="/groups/${esc(next.code)}" data-lf-go="/groups/${esc(next.code)}" data-track="accueil › mon raid">
      <span class="cal-next-k">${next.me === 'leader' ? 'Ton annonce' : 'Ton prochain raid'}</span>
      <span class="cal-next-cd">${left > 0 ? `<small>dans</small><b>${esc(lfSpan(left))}</b>` : `<b>${tr('En cours')}</b>`}</span>
      <span class="cal-next-w"><b>${esc(lfDay(next.startsAt))} · ${esc(lfClock(next.startsAt))} → ${esc(lfClock(next.endsAt))}</b>
        <small>${esc(next.raidName || '')} · <span class="cal-dk${d.id}">${esc(d.label)}</span> · ${esc(LF_GOALS[next.goal] || LF_GOALS.reclear)}</small></span>
      <span class="cal-next-btn">Ouvrir le raid</span>
    </a>`;
  } else {
    card = `<div class="cal-next is-empty">
      <span class="cal-next-k">Ton prochain raid</span>
      <span class="cal-next-w"><b>Rien de prévu pour l'instant</b><small>Postule à un raid, ou dis quand tu es libre : les leaders te proposeront une place.</small></span>
      <a class="cal-next-btn" href="/groups/search" data-lf-go="/groups/search">Je cherche un raid</a>
    </div>`;
  }
  // Une place proposée attend ta réponse : avant le reste
  const rest = list.filter((x) => x !== next).sort((x, y) => (y.me === 'invited') - (x.me === 'invited'));
  const rows = rest.map((x) => {
    const extra = x.me === 'leader' ? ` · ${tr('{n, plural, =0 {aucune candidature} one {# candidature} other {# candidatures}}', { n: x.tags || 0 })}` : '';
    return `<a class="cal-side-row${CAL_ME[x.me][1] ? '' : ' is-dash'}${x.me === 'invited' ? ' is-hot' : ''}" href="/groups/${esc(x.code)}" data-lf-go="/groups/${esc(x.code)}">
      <span>${esc(CAL_ME[x.me][0])}</span><b>${esc(calShort(x.startsAt))} · ${esc(lfClock(x.startsAt))}${esc(extra)}</b></a>`;
  });
  // Ton annonce, quand c'est elle le prochain raid : ses candidatures en attente
  if (next?.me === 'leader' && next.tags) rows.unshift(`<a class="cal-side-row" href="/groups/${esc(next.code)}" data-lf-go="/groups/${esc(next.code)}"><span>${tr('À regarder')}</span><b>${esc(tr('{n, plural, one {# candidature} other {# candidatures}}', { n: next.tags }))}</b></a>`);
  const s = home.mine.search;
  if (s) rows.push(`<a class="cal-side-row is-dash" href="/groups/search" data-lf-go="/groups/search"><span>Ta recherche</span><b>${esc(calShort(s.startsAt))} · ${esc(lfClock(s.startsAt))} → ${esc(lfClock(s.endsAt))}</b></a>`);
  return card + rows.slice(0, 3).join('');
}

function calAct(act, v) {
  if (act === 'day') {
    const i = Number(v);
    if (i === cal.sel) return;
    cal.sel = i;
    cal.slot = null;
    renderCal();
    loadCalDay();
  } else if (act === 'diff') { cal.diff = Number(v); renderCal(); }
  else if (act === 'fits') { cal.fits = !cal.fits; renderCal(); }
  else if (act === 'slot') { cal.slot = cal.slot === Number(v) ? null : Number(v); renderCal(); }
  else if (act === 'more') {
    // La liste complète du jour dans /groups, avec les mêmes filtres
    Object.assign(lfg.filters, { diff: cal.diff, day: 'date', date: lfDateValue(calDayFrom(cal.sel)), fits: cal.fits });
    goTo('/groups');
  }
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
  $('#dashCal').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cal]');
    if (b) calAct(b.dataset.cal, b.dataset.v);
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
