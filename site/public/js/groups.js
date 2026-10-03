'use strict';
/* ================================================================== */
/* Recherche de groupe (groups.js côté serveur). Pages : /groups       */
/* (raids qui recrutent), /groups/players (joueurs qui cherchent),     */
/* /groups/new (poster une annonce), /groups/search (je cherche un     */
/* raid), /groups/<CODE> (page du raid), /groups/<CODE>/edit.          */
/* Raid seulement pour l'instant.                                      */
/* ================================================================== */
const LF_LANGS = ['en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'nl', 'sv'];
const LF_LANG_NAMES = {
  en: tr('Anglais'), de: tr('Allemand'), fr: tr('Français'), es: tr('Espagnol'), it: tr('Italien'),
  pt: tr('Portugais'), pl: tr('Polonais'), nl: tr('Néerlandais'), sv: tr('Suédois'),
};
// Drapeaux dessinés (Windows n'affiche pas les drapeaux en émoji : il écrit « GB », « FR »…).
// Tous dans une case de 3:2, remplie en coupant ce qui dépasse (`slice`). Sans aucun identifiant
// (pas de clipPath) : un même drapeau est dessiné plusieurs fois dans la page, et un id en double
// cassait celui de l'Angleterre. Croix de saint Patrick décalée comme sur le vrai drapeau.
const LF_FLAG_SVG = (vb, body) => `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${body}</svg>`;
const LF_FLAGS = {
  en: LF_FLAG_SVG('0 0 60 30', '<path fill="#012169" d="M0 0h60v30H0z"/><path d="M0 0l60 30M60 0L0 30" stroke="#fff" stroke-width="6"/><path fill="#C8102E" d="M0 0l30 15-.9 1.8L-.9 1.8zM60 0L30 15l-.9-1.8L59.1-1.8zM60 30L30 15l.9-1.8 30 15zM0 30l30-15 .9 1.8-30 15z"/><path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/><path d="M30 0v30M0 15h60" stroke="#C8102E" stroke-width="6"/>'),
  de: LF_FLAG_SVG('0 0 5 3', '<path fill="#000" d="M0 0h5v1H0z"/><path fill="#DD0000" d="M0 1h5v1H0z"/><path fill="#FFCE00" d="M0 2h5v1H0z"/>'),
  fr: LF_FLAG_SVG('0 0 3 2', '<path fill="#002654" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#CE1126" d="M2 0h1v2H2z"/>'),
  es: LF_FLAG_SVG('0 0 3 2', '<path fill="#AA151B" d="M0 0h3v2H0z"/><path fill="#F1BF00" d="M0 .5h3v1H0z"/>'),
  it: LF_FLAG_SVG('0 0 3 2', '<path fill="#009246" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#CE2B37" d="M2 0h1v2H2z"/>'),
  pt: LF_FLAG_SVG('0 0 30 20', '<path fill="#046A38" d="M0 0h12v20H0z"/><path fill="#DA291C" d="M12 0h18v20H12z"/><circle cx="12" cy="10" r="4.2" fill="none" stroke="#FFE900" stroke-width="1.3"/><path fill="#DA291C" stroke="#fff" stroke-width=".7" d="M9.9 7.6h4.2v3.2a2.1 2.1 0 0 1-4.2 0z"/>'),
  pl: LF_FLAG_SVG('0 0 8 5', '<path fill="#fff" d="M0 0h8v2.5H0z"/><path fill="#DC143C" d="M0 2.5h8V5H0z"/>'),
  nl: LF_FLAG_SVG('0 0 9 6', '<path fill="#AE1C28" d="M0 0h9v2H0z"/><path fill="#fff" d="M0 2h9v2H0z"/><path fill="#21468B" d="M0 4h9v2H0z"/>'),
  sv: LF_FLAG_SVG('0 0 16 10', '<path fill="#006AA7" d="M0 0h16v10H0z"/><path fill="#FECC00" d="M5 0h2v10H5zM0 4h16v2H0z"/>'),
};
const lfFlag = (l) => (LF_FLAGS[l] ? `<span class="lf-flag" role="img" title="${esc(LF_LANG_NAMES[l])}" aria-label="${esc(LF_LANG_NAMES[l])}">${LF_FLAGS[l]}</span>` : '');
const lfFlags = (list) => `<span class="lf-flags">${(list || []).map(lfFlag).join('')}</span>`;
const LF_GOALS = { reclear: tr('Reclear'), progress: tr('Progress') };
const LF_CLASSES = Object.keys(CLASS_COLORS);
const lfCap = (s) => { const t = String(s || ''); return t.charAt(0).toLocaleUpperCase(I18N.locale) + t.slice(1); };
const lfClassName = (cls) => lfCap(CLASS_NAMES[cls] || cls || '');
const lfRoleIcon = (r) => (ROLE_ICONS[r] ? `<span class="role role-${r}" title="${esc(ROLE_ICONS[r].label)}">${ROLE_ICONS[r].svg}</span>` : '');
const LF_ROLE_LABEL = { tank: tr('Tank'), heal: tr('Soigneur'), dps: 'DPS' };
const LF_ROLE_ROWS = { tank: tr('Tanks'), heal: tr('Soigneurs'), dps: 'DPS' };
const LF_ICONS = {
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 2.5 14.5 8 2 13.5l1.4-4.6L9 8 3.4 7.1z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  mail: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4.5" width="15" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m3 5.5 7 5.5 7-5.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  x: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm.8 6H7.2v5h1.6zm0-3H7.2v1.6h1.6z"/></svg>',
  back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shield: ASSIST_ICON,
  group: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.6" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.9 13.4c.5-2.1 2.1-3.2 4.1-3.2s3.6 1.1 4.1 3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10.6 3.6a2.2 2.2 0 0 1 0 4.2M12 10.4c1.1.5 1.8 1.5 2.1 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

const lfg = {
  view: 'list',            // list | players | new | edit | search | raid
  code: null,              // annonce affichée (page du raid, modification)
  listings: null,          // GET /api/groups
  searches: null,          // GET /api/groups/searches
  mine: null,              // GET /api/groups/mine
  page: null,              // GET /api/groups/<CODE> puis le direct
  chat: null,
  source: null,
  chars: null,             // personnages du Battle.net lié ({ key, name, realm, className, level }), main en tête
  bnet: null,              // { linked, main }
  error: null,
  filters: { diff: 0, day: 'all', date: '', langs: [], fits: false },
  as: null,                // personnage avec lequel on regarde la liste (clé)
  appsTab: 'tags',
  draft: null,             // formulaire d'annonce
  searchDraft: null,       // formulaire de recherche
  busy: false,
  request: 0,
};

/* ---------------- Dates et heures ---------------------------------- */
const lfClock = (t) => new Date(t).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
const lfDayStart = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
function lfDay(t) {
  const diff = Math.round((lfDayStart(t) - lfDayStart(Date.now())) / 864e5);
  if (diff === 0) return new Date(t).getHours() >= 17 ? tr('Ce soir') : tr("Aujourd'hui");
  if (diff === 1) return tr('Demain');
  return lfCap(new Date(t).toLocaleDateString(I18N.locale, { weekday: 'long', day: 'numeric', month: 'short' }));
}
const lfWhen = (x) => `<b>${esc(lfDay(x.startsAt))}</b> <span>${esc(lfClock(x.startsAt))} → ${esc(lfClock(x.endsAt))}</span>`;
function lfSpan(ms) {
  const m = Math.max(1, Math.round(ms / 60e3));
  if (m < 60) return tr('{m} min', { m });
  if (m < 24 * 60) { const h = Math.floor(m / 60); const r = m % 60; return r ? tr('{h} h {m}', { h, m: String(r).padStart(2, '0') }) : tr('{h} h', { h }); }
  return tr('{d, plural, one {# jour} other {# jours}}', { d: Math.round(m / 1440) });
}
// Heure locale d'une date donnée par <input type="date"> et <input type="time">
function lfStamp(date, time) {
  const [y, mo, d] = String(date || '').split('-').map(Number);
  const [h, mi] = String(time || '').split(':').map(Number);
  if (!y || !mo || !d || !Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return new Date(y, mo - 1, d, h, mi).getTime();
}
const lfDateValue = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const lfTimeValue = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// Fin plus tôt que le début (20:00 → 00:30) : le lendemain
function lfRange(date, from, to) {
  const start = lfStamp(date, from);
  let end = lfStamp(date, to);
  if (start == null || end == null) return null;
  if (end <= start) end += 864e5;
  return { startsAt: start, endsAt: end };
}

/* ---------------- Choix de la date et des heures -------------------- */
// Calendrier et listes d'heures maison (demande de l'utilisateur, 30 septembre 2026 : les champs
// date et heure du navigateur ne suffisaient pas). Les brouillons gardent `date` (AAAA-MM-JJ),
// `from` et `to` (HH:MM) ; une fin plus tôt que le début tombe le lendemain (lfRange). Un seul
// panneau pour toute la page (#lfPop, posé sur <body>, en position fixe comme les listes déroulantes).
const LF_PICK_ICONS = {
  date: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  time: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  prev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg class="kselect-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const LF_AHEAD_DAYS = 14;
// Brouillon lu et écrit par les sélecteurs ; le filtre « Quand » des listes garde sa date dans lfg.filters.date
const lfPickDraft = (form) => (form === 'search' ? lfg.searchDraft : form === 'filter' ? lfg.filters : lfg.draft);
const lfDateOf = (v) => { const [y, m, d] = String(v || '').split('-').map(Number); return y ? new Date(y, m - 1, d) : null; };
const lfMinutes = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
const lfHhmm = (min) => { const m = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
// Heure affichée dans la langue de la page (20:00, 8:00 PM…)
const lfClockOf = (hhmm) => { const m = lfMinutes(hhmm); return m == null ? '—' : lfClock(new Date(2026, 0, 1, Math.floor(m / 60), m % 60).getTime()); };
function lfDateLabel(v) {
  const d = lfDateOf(v);
  if (!d) return tr('Choisir une date');
  return lfCap(d.toLocaleDateString(I18N.locale, { weekday: 'short', day: 'numeric', month: 'short' }));
}
function lfDateHint(v) {
  const d = lfDateOf(v);
  if (!d) return '';
  const diff = Math.round((d.getTime() - lfDayStart(Date.now())) / 864e5);
  return diff === 0 ? tr("Aujourd'hui") : diff === 1 ? tr('Demain') : '';
}

// Les trois boutons (date, début, fin). `started` : le raid a commencé, date et début ne bougent plus.
function lfWhenPick(d, form, { started = false, fromLabel = tr('Début'), toLabel = tr('Fin') } = {}) {
  const r = lfRange(d.date, d.from, d.to);
  const dur = r ? lfSpan(r.endsAt - r.startsAt) : '';
  const next = r && lfDayStart(r.endsAt) !== lfDayStart(r.startsAt);
  const btn = (pick, icon, label, extra, disabled) => `<button type="button" class="kselect-button lf-picker" data-lf-pick="${pick}" data-form="${form}" aria-haspopup="dialog" aria-expanded="false" aria-labelledby="lfPk-${form}-${pick} lfPkV-${form}-${pick}"${disabled ? ' disabled' : ''}>`
    + `<span class="lf-picker-ico">${icon}</span><span class="kselect-label" id="lfPkV-${form}-${pick}">${esc(label)}${extra ? ` <small>${esc(extra)}</small>` : ''}</span>${LF_PICK_ICONS.chevron}</button>`;
  return `<div class="lf-row3 lf-when-pick">
    <div class="lf-field"><span class="lf-label" id="lfPk-${form}-date">${tr('Date')}</span>${btn('date', LF_PICK_ICONS.date, lfDateLabel(d.date), lfDateHint(d.date), started)}</div>
    <div class="lf-field"><span class="lf-label" id="lfPk-${form}-from">${esc(fromLabel)}</span>${btn('from', LF_PICK_ICONS.time, lfClockOf(d.from), '', started)}</div>
    <div class="lf-field"><span class="lf-label" id="lfPk-${form}-to">${esc(toLabel)}</span>${btn('to', LF_PICK_ICONS.time, lfClockOf(d.to), [dur, next ? tr('le lendemain') : ''].filter(Boolean).join(' · '), false)}</div>
  </div>`;
}

const lfPop = { el: null, btn: null, form: null, pick: null, month: null, focus: null };

function lfPopEl() {
  if (lfPop.el) return lfPop.el;
  const el = document.createElement('div');
  el.id = 'lfPop';
  el.className = 'kselect-pop lf-pop';
  el.setAttribute('role', 'dialog');
  el.hidden = true;
  document.body.appendChild(el);
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pop]');
    if (!b || b.disabled) return;
    if (b.dataset.pop === 'month') {
      lfPop.month = new Date(lfPop.month.getFullYear(), lfPop.month.getMonth() + Number(b.dataset.v), 1);
      lfRenderPop();
      el.querySelector(`[data-pop="month"][data-v="${b.dataset.v}"]:not(:disabled)`)?.focus({ preventScroll: true });
      return;
    }
    lfPickValue(b.dataset.pop, b.dataset.v);
  });
  el.addEventListener('keydown', lfPopKey);
  // Clic ailleurs, défilement de la page, fenêtre redimensionnée : on ferme
  document.addEventListener('pointerdown', (ev) => {
    if (!lfPop.btn || el.contains(ev.target) || lfPop.btn.contains(ev.target)) return;
    lfClosePop(false);
  }, true);
  window.addEventListener('scroll', (ev) => { if (lfPop.btn && !el.contains(ev.target)) lfClosePop(false); }, true);
  window.addEventListener('resize', () => { if (lfPop.btn) lfClosePop(false); });
  lfPop.el = el;
  return el;
}

function lfOpenPick(btn) {
  const el = lfPopEl();
  if (lfPop.btn === btn) { lfClosePop(true); return; }
  if (lfPop.btn) lfClosePop(false);
  const d = lfPickDraft(btn.dataset.form);
  if (!d) return;
  lfPop.btn = btn;
  lfPop.form = btn.dataset.form;
  lfPop.pick = btn.dataset.lfPick;
  const cur = lfDateOf(d.date) || new Date();
  lfPop.month = new Date(cur.getFullYear(), cur.getMonth(), 1);
  btn.setAttribute('aria-expanded', 'true');
  btn.closest('.lf-field')?.classList.add('is-open');
  el.hidden = false;
  el.setAttribute('aria-label', btn.closest('.lf-field')?.querySelector('.lf-label')?.textContent || '');
  lfRenderPop();
  const first = el.querySelector('.lf-cal-grid .is-on:not(:disabled), .lf-times .is-on:not(:disabled)')
    || el.querySelector('.lf-cal-grid [data-pop="day"]:not(:disabled), [data-pop="time"]:not(:disabled)');
  first?.focus({ preventScroll: true });
}

function lfClosePop(refocus) {
  const btn = lfPop.btn;
  if (!btn) return;
  btn.setAttribute('aria-expanded', 'false');
  btn.closest('.lf-field')?.classList.remove('is-open');
  lfPop.btn = null;
  if (lfPop.el) { lfPop.el.hidden = true; lfPop.el.innerHTML = ''; }
  if (refocus && btn.isConnected) btn.focus({ preventScroll: true });
}

function lfPlacePop() {
  const el = lfPop.el;
  const r = lfPop.btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = lfPop.pick === 'date' ? 312 : Math.max(r.width, 220);
  el.style.width = `${Math.min(w, vw - 16)}px`;
  el.style.maxHeight = 'none';
  const below = vh - r.bottom - 14;
  const above = r.top - 14;
  const h = el.scrollHeight;
  const up = h > below && above > below;
  const room = Math.max(160, Math.min(lfPop.pick === 'date' ? 9999 : 320, up ? above : below));
  const shown = Math.min(h, room);
  el.style.maxHeight = `${room}px`;
  el.classList.toggle('is-above', up);
  el.style.left = `${Math.round(Math.max(8, Math.min(r.left, vw - 8 - el.offsetWidth)))}px`;
  el.style.top = `${Math.round(Math.max(8, up ? r.top - 6 - shown : r.bottom + 6))}px`;
}

function lfRenderPop() {
  const el = lfPop.el;
  const d = lfPickDraft(lfPop.form);
  if (!el || !d) return;
  el.classList.toggle('is-cal', lfPop.pick === 'date');
  el.innerHTML = lfPop.pick === 'date' ? lfCalendarHtml(d) : lfTimesHtml(d, lfPop.pick);
  lfPlacePop();
  if (lfPop.pick !== 'date') {
    // La liste s'ouvre sur l'heure choisie
    const on = el.querySelector('.is-on') || el.querySelector('[data-pop="time"]:not(:disabled)');
    if (on) el.scrollTop = on.offsetTop - el.clientHeight / 2 + on.offsetHeight / 2;
  }
}

// Calendrier du mois : semaines du lundi au dimanche, jours hors de la fenêtre (aujourd'hui → 14 jours) grisés
function lfCalendarHtml(d) {
  const min = lfDayStart(Date.now());
  const max = min + LF_AHEAD_DAYS * 864e5;
  const m = lfPop.month;
  const lead = (new Date(m.getFullYear(), m.getMonth(), 1).getDay() + 6) % 7;
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const heads = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(I18N.locale, { weekday: 'short' }).replace(/\.$/, ''));
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span></span>');
  for (let n = 1; n <= days; n++) {
    const t = new Date(m.getFullYear(), m.getMonth(), n).getTime();
    const v = lfDateValue(t);
    const off = t < min || t > max;
    const on = v === d.date;
    const label = lfCap(new Date(t).toLocaleDateString(I18N.locale, { weekday: 'long', day: 'numeric', month: 'long' }));
    cells.push(`<button type="button" class="lf-day${on ? ' is-on' : ''}${t === min ? ' is-today' : ''}" data-pop="day" data-v="${v}" aria-label="${esc(label)}" aria-pressed="${on}"${off ? ' disabled' : ''}>${n}</button>`);
  }
  const canPrev = new Date(m.getFullYear(), m.getMonth(), 0).getTime() >= min;
  const canNext = new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime() <= max;
  const title = lfCap(m.toLocaleDateString(I18N.locale, { month: 'long', year: 'numeric' }));
  const quick = [[min, tr("Aujourd'hui")], [min + 864e5, tr('Demain')]]
    .map(([t, l]) => `<button type="button" class="lf-qd${lfDateValue(t) === d.date ? ' is-on' : ''}" data-pop="day" data-v="${lfDateValue(t)}">${esc(l)}</button>`).join('');
  return `<div class="lf-cal">
    <div class="lf-cal-head"><button type="button" class="lf-cal-nav" data-pop="month" data-v="-1" aria-label="${esc(tr('Mois précédent'))}"${canPrev ? '' : ' disabled'}>${LF_PICK_ICONS.prev}</button><b>${esc(title)}</b><button type="button" class="lf-cal-nav" data-pop="month" data-v="1" aria-label="${esc(tr('Mois suivant'))}"${canNext ? '' : ' disabled'}>${LF_PICK_ICONS.next}</button></div>
    <div class="lf-cal-grid">${heads.map((h) => `<span class="lf-cal-wd">${esc(h)}</span>`).join('')}${cells.join('')}</div>
    <div class="lf-cal-foot">${quick}<span class="lf-dim lf-small">${esc(tr("Jusqu'à 14 jours à l'avance"))}</span></div>
  </div>`;
}

// Heures par quart d'heure. Début : toute la journée (le passé grisé pour aujourd'hui). Fin : de
// 30 minutes à 12 heures après le début, avec la durée à côté
function lfTimesHtml(d, pick) {
  const out = [];
  if (pick === 'from') {
    const now = new Date();
    const past = d.date === lfDateValue(Date.now()) ? now.getHours() * 60 + now.getMinutes() - 15 : -1;
    for (let m = 0; m < 1440; m += 15) {
      const v = lfHhmm(m);
      const on = v === d.from;
      out.push(`<button type="button" class="kselect-opt lf-time${on ? ' is-selected is-on' : ''}" data-pop="time" data-v="${v}" aria-pressed="${on}"${m < past ? ' disabled' : ''}><span>${esc(lfClockOf(v))}</span></button>`);
    }
  } else {
    const start = lfMinutes(d.from) ?? 20 * 60;
    for (let k = 30; k <= 12 * 60; k += 15) {
      const v = lfHhmm(start + k);
      const on = v === d.to;
      const next = start + k >= 1440;
      out.push(`<button type="button" class="kselect-opt lf-time${on ? ' is-selected is-on' : ''}" data-pop="time" data-v="${v}" aria-pressed="${on}"><span>${esc(lfClockOf(v))}</span><small>${esc(lfSpan(k * 60e3))}${next ? ` · ${esc(tr('le lendemain'))}` : ''}</small></button>`);
    }
  }
  return `<div class="lf-times" role="group">${out.join('')}</div>`;
}

function lfPickValue(kind, v) {
  const d = lfPickDraft(lfPop.form);
  if (!d) return;
  if (kind === 'day') d.date = v;
  else if (lfPop.pick === 'from') {
    // Le début bouge, la durée reste
    const r = lfRange(d.date, d.from, d.to);
    const dur = r ? Math.round((r.endsAt - r.startsAt) / 60e3) : 180;
    d.from = v;
    d.to = lfHhmm(lfMinutes(v) + Math.max(30, Math.min(12 * 60, dur)));
  } else d.to = v;
  const { form, pick } = lfPop;
  lfClosePop(false);
  if (form === 'search') lfRefreshSearch();
  else if (form === 'filter') { lfg.filters.day = 'date'; renderGroups(); }
  else lfRefreshForm();
  $(`[data-lf-pick="${pick}"][data-form="${form}"]`)?.focus({ preventScroll: true });
}

// Clavier : flèches dans le calendrier (±1 jour, ±1 semaine) et dans les listes, Échap ferme
function lfPopKey(ev) {
  const el = lfPop.el;
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); lfClosePop(true); return; }
  if (ev.key === 'Tab') { ev.preventDefault(); lfClosePop(true); return; }
  const cur = document.activeElement;
  if (lfPop.pick === 'date' && cur?.dataset.pop === 'day' && cur.closest('.lf-cal-grid')) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
    if (!step) return;
    ev.preventDefault();
    const target = lfDateOf(cur.dataset.v);
    target.setDate(target.getDate() + step);
    const min = lfDayStart(Date.now());
    if (target.getTime() < min || target.getTime() > min + LF_AHEAD_DAYS * 864e5) return;
    const v = lfDateValue(target.getTime());
    if (target.getMonth() !== lfPop.month.getMonth()) { lfPop.month = new Date(target.getFullYear(), target.getMonth(), 1); lfRenderPop(); }
    el.querySelector(`.lf-cal-grid [data-v="${v}"]`)?.focus();
    return;
  }
  if (lfPop.pick !== 'date' && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) {
    const items = [...el.querySelectorAll('[data-pop="time"]:not(:disabled)')];
    if (!items.length) return;
    ev.preventDefault();
    const i = items.indexOf(cur);
    const n = ev.key === 'Home' ? 0 : ev.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i) + (ev.key === 'ArrowUp' ? -1 : 1)));
    items[n].focus({ preventScroll: true });
    items[n].scrollIntoView({ block: 'nearest' });
  }
}

/* ---------------- Morceaux d'une annonce ---------------------------- */
const lfDiff = (id) => difficultyOf(id);
const lfTitle = (x) => x.title || `${LF_GOALS[x.goal] || ''} · ${x.raidName || ''} ${lfDiff(x.difficulty).label}`.trim();
const lfDiffTag = (id) => { const d = lfDiff(id); return `<span class="lf-diff is-${d.key}">${esc(d.label)}</span>`; };
const lfGoalTag = (g) => `<span class="lf-goal is-${g === 'progress' ? 'progress' : 'reclear'}">${esc(LF_GOALS[g] || LF_GOALS.reclear)}</span>`;
const lfSub = (x) => `<span class="lf-sub">${lfGoalTag(x.goal)}<span>${esc(x.raidName || '')}</span>${lfDiffTag(x.difficulty)}</span>`;
const lfRaidArt = (slug) => seasonArt?.raids.find((r) => r.slug === slug) || null;
// Guillemets simples : la valeur va dans un attribut style="…"
const lfArtUrl = (u) => (u ? `url('${encodeURI(String(u)).replace(/["'()]/g, '')}')` : 'none');

function lfPhase(x) {
  if (x.phase === 'live') return `<span class="lf-pill is-live">${tr('En cours')}</span>`;
  if (x.phase === 'ended') return `<span class="lf-pill">${tr('Terminé')}</span>`;
  const left = x.startsAt - Date.now();
  return `<span class="lf-pill is-rec">${left < 864e5 ? esc(tr('Recrute · commence dans {d}', { d: lfSpan(left) })) : tr('Recrute')}</span>`;
}

function lfBosses(x, { size = '' } = {}) {
  const art = lfRaidArt(x.raid);
  const names = art?.bosses?.length ? art.bosses : (state.raids.find((r) => r.slug === x.raid)?.bosses || []).map((name) => ({ name }));
  if (!names.length) return '';
  const want = new Set((x.bosses?.length ? x.bosses : names.map((b) => b.name)).map(norm));
  return `<span class="lf-bosses${size}">${names.map((b) => `<span class="lf-boss${want.has(norm(b.name)) ? '' : ' is-off'}" title="${esc(b.name)}" style="--pic:${lfArtUrl(b.image)}">${b.image ? '' : esc(b.name.charAt(0))}</span>`).join('')}</span>`;
}
const lfBossCount = (x) => {
  const n = x.bosses?.length || x.bossCount || 0;
  return x.bosses?.length && x.bosses.length < x.bossCount
    ? tr('{n} boss sur {total}', { n, total: x.bossCount })
    : tr('{n, plural, one {# boss} other {# boss}}', { n: x.bossCount || n });
};

function lfComp(x) {
  const f = x.filled || {};
  const c = x.comp || {};
  const n = ROLES.reduce((s, r) => s + (f[r] || 0), 0);
  const m = ROLES.reduce((s, r) => s + (c[r] || 0), 0);
  return `<div class="lf-comp">${ROLES.map((r) => `<span class="lf-slot${(f[r] || 0) >= (c[r] || 0) ? ' is-full' : ''}">${lfRoleIcon(r)}<b>${f[r] || 0}</b><i>/${c[r] || 0}</i></span>`).join('')}<span class="lf-total">${n}/${m}</span></div>
    <div class="lf-bar"><i style="width:${m ? Math.round((n / m) * 100) : 0}%"></i></div>`;
}

function lfConditions(x) {
  const out = [];
  if (x.minIlvl) out.push(tr('ilvl {n}+', { n: x.minIlvl }));
  if (x.minProg) out.push(`${x.minProg}/${x.bossCount} ${lfDiff(x.difficulty).letter}`);
  return out.length ? tr('Conseillé : {c}', { c: out.join(' · ') }) : '';
}

function lfWants(x, { label = false } = {}) {
  const req = x.classMode === 'required';
  const items = (x.classes || []).map((c) => `<span class="lf-want${req ? ' is-req' : ''}" style="--cls:${CLASS_COLORS[c.cls] || '#888'}"><span class="lf-cico" style="background-image:url('${classIcon(c.cls)}')"></span>${c.n > 1 ? `${c.n} × ` : ''}${esc(lfClassName(c.cls))}<em>${req ? tr('obligatoire') : tr('préférée')}</em></span>`);
  const cond = lfConditions(x);
  const discord = x.discordRequired ? `<span class="lf-discord-tag" title="${esc(tr('Le lien du serveur Discord est donné aux membres du raid.'))}"><span class="oauth-ico oauth-discord" aria-hidden="true"></span>${tr('Discord requis')}</span>` : '';
  return `<div class="lf-wants">${label ? `<span class="lf-dim">${tr('Recherche')}</span>` : ''}${items.length ? items.join('') : `<span class="lf-dim">${tr('Toutes les classes')}</span>`}${cond ? `<span class="lf-dim">· ${esc(cond)}</span>` : ''}${discord}</div>`;
}

/* ---------------- Joueurs : profil joint ---------------------------- */
// Chaque tag et chaque recherche emportent le profil Blizzard du personnage (`snapshot.profile`),
// tel qu'il était à l'envoi : spé, niveau d'objet, progression, cote Mythique+.
function lfProg(profile, x) {
  const raid = x.raid ? state.raids.find((r) => r.slug === x.raid) : [...state.raids].sort((a, b) => b.bosses.length - a.bosses.length)[0];
  const p = raid && profile?.raidProgress?.[raid.slug];
  if (!p) return '<span class="lf-dim">—</span>';
  const total = p.total || raid.bosses.length;
  const d = lfDiff(x.difficulty);
  const here = p[d.key] || 0;
  const up = DIFFICULTIES.find((y) => y.id === d.id + 1);
  const above = up && p[up.key] ? `<small class="lf-d-${up.key}">${p[up.key]}/${total} ${up.letter}</small>` : '';
  return `<span class="lf-prog"><span class="lf-d-${d.key}">${here}/${total} ${d.letter}</span>${above}</span>`;
}
const lfIlvl = (profile) => (profile?.itemLevel ? Math.round(profile.itemLevel) : null);
// Boss tués dans la difficulté de l'annonce (ou plus haut), sur son raid
function lfKilled(profile, x) {
  const p = profile?.raidProgress?.[x.raid];
  if (!p) return 0;
  return Math.max(...DIFFICULTIES.filter((d) => d.id >= Number(x.difficulty)).map((d) => p[d.key] || 0), 0);
}
// Cote Mythique+ du personnage, dans la couleur du jeu
function lfScore(profile) {
  if (!profile) return '<span class="lf-dim">—</span><small>M+</small>';
  const s = Math.round(profile.score || 0);
  return s ? `<b style="color:${esc(profile.scoreColor || 'var(--text)')}">${s}</b><small>M+</small>` : '<span class="lf-dim">—</span><small>M+</small>';
}
// Profil introuvable ou pas chargé à l'envoi
const lfNoProfile = (snap) => (snap?.profileError ? `<span class="lf-pill is-warn">${snap.profileError === 'missing' ? 'Profil introuvable' : 'Profil pas chargé'}</span>` : '');
const lfAge = (t) => (t ? tr('infos de {t}', { t: Date.now() - t < 864e5 ? lfClock(t) : fmtDay(t) }) : '');
// Spé · serveur · âge des infos (ce qui manque est sauté)
const lfMeta = (spec, realm, at) => [spec, realm].filter(Boolean).map(esc).concat(at ? [`<span class="lf-age">${esc(lfAge(at))}</span>`] : []).join(' · ');

/* ---------------- Chargements --------------------------------------- */
async function lfLoadChars() {
  const a = state.status?.account;
  if (!a) { lfg.chars = []; lfg.bnet = { linked: false }; return; }
  if (lfg.chars && lfg.charsFor === a.id) return;
  try {
    const d = await api('/api/account');
    const b = d.bnet || { linked: false };
    const list = [...(b.characters || [])].sort((x, y) => (x.key === b.main ? -1 : y.key === b.main ? 1 : (y.level || 0) - (x.level || 0)));
    lfg.chars = list;
    lfg.bnet = { linked: Boolean(b.linked), main: b.main || null };
    lfg.charsFor = a.id;
    lfg.statusFor = a.id;
  } catch { lfg.chars = []; lfg.bnet = { linked: false }; }
}

// Statut arrivé après l'ouverture de la page, ou compte changé : personnages et listes du compte
async function lfOnStatus() {
  const id = state.status?.account?.id ?? null;
  if (lfg.statusFor === id && lfg.chars) return;
  lfg.statusFor = id;
  lfg.chars = null;
  await lfLoadChars();
  if (currentView !== 'groups') return;
  const root = $('#groups');
  if (lfg.view === 'list' || lfg.view === 'players') await lfLoadLists();
  else if (lfg.view === 'new') { await lfLoadLists(); lfg.draft = lfNewDraft(); root.innerHTML = ''; }
  else if (lfg.view === 'search') { await lfLoadLists(); lfg.searchDraft = lfSearchDraft(lfg.mine?.search); root.innerHTML = ''; }
  renderGroups();
}

async function lfLoadLists() {
  const id = ++lfg.request;
  try {
    const [l, s, m] = await Promise.all([
      api('/api/groups'),
      api('/api/groups/searches'),
      state.status?.account ? api('/api/groups/mine') : Promise.resolve(null),
    ]);
    if (id !== lfg.request) return;
    lfg.listings = l.listings || [];
    lfg.searches = s.searches || [];
    lfg.mine = m;
    lfg.error = null;
  } catch (e) {
    if (id !== lfg.request) return;
    lfg.error = e.message;
  }
}

// Ce qu'il manque pour se taguer ou poster (null : rien)
function lfGate(action = 'tag') {
  const a = state.status?.account;
  const back = encodeURIComponent(location.pathname);
  if (!a) return { text: action === 'post' ? tr('Connecte-toi pour poster une annonce.') : tr('Connecte-toi pour postuler à un raid.'), label: tr('Se connecter'), href: `/login?back=${back}` };
  if (!a.verified) return { text: tr('Confirme ton adresse e-mail pour participer.'), label: tr('Voir mon compte'), href: '/account' };
  if (lfg.bnet && !lfg.bnet.linked) return { text: tr('Lie ton Battle.net pour choisir ton personnage.'), label: tr('Lier mon Battle.net'), href: '/account' };
  if (lfg.chars && !lfg.chars.length) return { text: tr("Ton Battle.net n'a aucun personnage."), label: tr('Voir mon compte'), href: '/account' };
  return null;
}
const lfGateHtml = (g) => `<div class="lf-gate"><p>${esc(g.text)}</p><a class="btn primary small" href="${esc(g.href)}" data-lf-go="${esc(g.href)}">${esc(g.label)}</a></div>`;

/* ---------------- Ouverture des pages ------------------------------- */
function stopGroups() {
  lfg.source?.close();
  lfg.source = null;
}

async function openGroups(sub, action) {
  const low = String(sub || '').toLowerCase();
  let view = 'list';
  let code = null;
  if (low === 'players') view = 'players';
  else if (low === 'new') view = 'new';
  else if (low === 'search') view = 'search';
  else if (/^[a-z]{6}$/.test(low)) { code = low.toUpperCase(); view = action === 'edit' ? 'edit' : 'raid'; }
  else if (low) { history.replaceState({}, '', '/groups'); routedPath = currentPath(); }
  if (view !== 'raid' || code !== lfg.code) stopGroups();
  lfg.view = view;
  lfg.code = code;
  // Formulaire : son brouillon est refait une fois les données arrivées (sinon celui d'une autre
  // annonce resterait, ou un rendu venu entre-temps planterait sans brouillon)
  if (view === 'new' || view === 'edit') lfg.draft = null;
  if (view === 'search') lfg.searchDraft = null;
  showView('groups');
  document.title = `${{ list: tr('Raids qui recrutent'), players: tr('Joueurs qui cherchent'), new: tr('Poster une annonce'), edit: tr("Modifier l'annonce"), search: tr('Je cherche un raid'), raid: tr('Raid') }[view]} · GroupScout`;
  const root = $('#groups');
  if (view !== 'raid' || !lfg.page || lfg.page.code !== code) setHtml(root, `<div class="lf-loading"><span class="spinner" aria-hidden="true"></span>${tr('Chargement…')}</div>`);
  loadSeasonArt();
  if (!state.raids.length) await loadRaids();
  await lfLoadChars();
  if (view === 'raid' || view === 'edit') {
    try {
      const d = await api(`/api/groups/${code}`);
      if (lfg.code !== code) return;
      lfg.page = d.listing;
      lfg.chat = d.listing.chat;
    } catch (e) {
      if (lfg.code !== code) return;
      lfg.page = null;
      setHtml(root, `<div class="lf-empty-page card"><h1>${tr("Cette annonce n'existe plus")}</h1><p>${esc(e.message)}</p><a class="btn primary" href="/groups" data-lf-go="/groups">${tr('Voir les raids qui recrutent')}</a></div>`);
      return;
    }
    if (view === 'edit') {
      if (!lfg.page.me.canManage) { goTo(`/groups/${code}`); return; }
      lfg.draft = lfDraftFrom(lfg.page);
      renderGroups();
      return;
    }
    lfg.skeleton = null;
    lfg.searches = null;   // relus pour la page du raid (onglet « Joueurs qui cherchent »)
    renderGroups();
    lfConnect(code);
    return;
  }
  await lfLoadLists();
  if (view === 'new') {
    if (lfg.mine?.listing) { toast(tr('Tu as déjà une annonce de raid en cours.')); goTo(`/groups/${lfg.mine.listing.code}`); return; }
    lfg.draft = lfNewDraft();
  }
  if (view === 'search') lfg.searchDraft = lfSearchDraft(lfg.mine?.search);
  renderGroups();
}

function renderGroups() {
  if (currentView !== 'groups') return;
  const root = $('#groups');
  if (lfg.view === 'list' || lfg.view === 'players') {
    setHtml(root, lfListPage());
    const as = $('#lfAs');
    if (as) enhanceSelect(as);
  }
  else if ((lfg.view === 'new' || lfg.view === 'edit') && !lfg.draft) setHtml(root, `<div class="lf-loading"><span class="spinner" aria-hidden="true"></span>${tr('Chargement…')}</div>`);
  else if (lfg.view === 'search' && !lfg.searchDraft) setHtml(root, `<div class="lf-loading"><span class="spinner" aria-hidden="true"></span>${tr('Chargement…')}</div>`);
  else if (lfg.view === 'new' || lfg.view === 'edit') { if (!root.querySelector('#lfForm')) { setHtml(root, lfFormPage()); lfEnhanceForm(); } else lfRefreshForm(); }
  else if (lfg.view === 'search') { if (!root.querySelector('#lfSearchForm')) { setHtml(root, lfSearchPage()); lfEnhanceForm(); } else lfRefreshSearch(); }
  else if (lfg.view === 'raid' && lfg.page) renderRaidPage();
}

// Listes relues toutes les 30 s (nouvelles annonces, places prises), page du raid toutes les 30 s
// pour le compte à rebours (le direct apporte le reste)
setInterval(async () => {
  if (document.hidden || currentView !== 'groups') return;
  if (lfg.view === 'list' || lfg.view === 'players') { await lfLoadLists(); renderGroups(); }
  else if (lfg.view === 'raid' && lfg.page) renderRaidPage();
}, 30e3);

/* ---------------- Listes : raids qui recrutent, joueurs qui cherchent */
function lfListHead() {
  const own = lfg.mine?.listing;
  const players = lfg.view === 'players';
  return `
    <div class="lf-page-head">
      <div>
        <span class="lf-kicker">${tr('Trouver un groupe')}</span>
        <h1>${players ? tr('Joueurs qui cherchent') : tr('Raids qui recrutent')}</h1>
        <p>${players
          ? tr('Ils cherchent un raid et ont donné leur créneau. Propose-leur une place depuis ton annonce.')
          : tr("Postule à un raid avec un de tes personnages. Le leader voit ta spé, ton équipement et ta progression, et t'invite si ton profil lui convient.")}</p>
      </div>
      <div class="lf-head-actions">
        <a class="btn glass" href="/groups/search" data-lf-go="/groups/search" data-track="groupes › je cherche">${lfg.mine?.search ? tr('Ma recherche') : tr('Je cherche un raid')}</a>
        ${own
          ? `<a class="btn primary" href="/groups/${esc(own.code)}" data-lf-go="/groups/${esc(own.code)}" data-track="groupes › mon annonce">${tr('Mon annonce')}</a>`
          : `<a class="btn primary" href="/groups/new" data-lf-go="/groups/new" data-track="groupes › poster">${LF_ICONS.plus}${tr('Poster une annonce')}</a>`}
      </div>
    </div>
    <div class="lf-toolbar">
      <nav class="lf-tabs" aria-label="${esc(tr('Trouver un groupe'))}">
        <a class="lf-tab${players ? '' : ' is-on'}" href="/groups" data-lf-go="/groups"${players ? '' : ' aria-current="page"'}>${tr('Raids qui recrutent')} <small>${lfg.listings?.length ?? ''}</small></a>
        <a class="lf-tab${players ? ' is-on' : ''}" href="/groups/players" data-lf-go="/groups/players"${players ? ' aria-current="page"' : ''}>${tr('Joueurs qui cherchent')} <small>${lfg.searches?.length ?? ''}</small></a>
      </nav>
      ${lfFilters()}
    </div>`;
}

function lfFilters() {
  const f = lfg.filters;
  const diffs = [{ id: 0, label: tr('Toutes') }, ...DIFFICULTIES.map((d) => ({ id: d.id, label: d.letter }))];
  const days = [['all', tr('Tout')], ['today', tr("Aujourd'hui")], ['tomorrow', tr('Demain')], ['later', tr('Plus tard')]];
  return `<div class="lf-filters">
    <div class="segmented lf-seg" role="radiogroup" aria-label="${esc(tr('Difficulté'))}">${diffs.map((d) => `<button type="button" role="radio" aria-checked="${f.diff === d.id}" data-lf="f-diff" data-v="${d.id}"${d.id ? ` title="${esc(lfDiff(d.id).label)}"` : ''}>${esc(d.label)}</button>`).join('')}</div>
    <div class="segmented lf-seg" role="radiogroup" aria-label="${esc(tr('Quand'))}">${days.map(([v, l]) => `<button type="button" role="radio" aria-checked="${f.day === v}" data-lf="f-day" data-v="${v}">${esc(l)}</button>`).join('')}<button type="button" role="radio" class="lf-seg-date" aria-checked="${f.day === 'date'}" aria-haspopup="dialog" aria-expanded="false" data-lf-pick="date" data-form="filter" title="${esc(tr('Choisir une date'))}">${LF_PICK_ICONS.date}<span>${esc(f.day === 'date' ? lfDateLabel(f.date) : tr('Date'))}</span></button></div>
    <div class="lf-langf" role="group" aria-label="${esc(tr('Langues'))}">${LF_LANGS.map((l) => `<button type="button" class="lf-langb${f.langs.includes(l) ? ' is-on' : ''}" aria-pressed="${f.langs.includes(l)}" data-lf="f-lang" data-v="${l}" title="${esc(LF_LANG_NAMES[l])}">${lfFlag(l)}</button>`).join('')}</div>
  </div>`;
}

function lfDayOk(t) {
  const f = lfg.filters.day;
  if (f === 'all') return true;
  const diff = Math.round((lfDayStart(t) - lfDayStart(Date.now())) / 864e5);
  // Date précise choisie dans le calendrier du filtre
  if (f === 'date') return lfDateValue(t) === lfg.filters.date;
  return f === 'today' ? diff <= 0 : f === 'tomorrow' ? diff === 1 : diff >= 2;
}
const lfLangOk = (langs) => !lfg.filters.langs.length || (langs || []).some((l) => lfg.filters.langs.includes(l));

// Personnage avec lequel on regarde la liste (main par défaut)
const lfAsChar = () => lfg.chars?.find((c) => c.key === lfg.as) || lfg.chars?.[0] || null;

// Peut-on se taguer dans cette annonce avec ce personnage ? null : oui ; sinon la raison
function lfTagBlock(x, char) {
  if (x.phase === 'ended') return tr('Terminé');
  if (x.classMode === 'required' && char && !(x.classes || []).some((c) => c.cls === char.className)) return tr('Classe non demandée');
  if (!ROLES.some((r) => (x.filled?.[r] || 0) < (x.comp?.[r] || 0))) return tr('Complet');
  return null;
}

const LF_STATUS = {
  pending: ['is-rec', tr('Candidature envoyée · en attente')],
  invited: ['is-live', tr('Place proposée')],
  accepted: ['is-good', tr('Dans le raid')],
  declined: ['', tr('Candidature non retenue')],
  refused: ['', tr('Proposition refusée')],
  withdrawn: ['', tr('Candidature retirée')],
  removed: ['is-bad', tr('Place retirée par le leader')],
  left: ['', tr('Tu as quitté le raid')],
};
const lfStatusPill = (s) => (LF_STATUS[s] ? `<span class="lf-pill ${LF_STATUS[s][0]}">${esc(LF_STATUS[s][1])}</span>` : '');

function lfCard(x) {
  const char = lfAsChar();
  const block = lfTagBlock(x, char);
  const art = lfRaidArt(x.raid);
  let action;
  if (x.mine?.leader) action = `<span class="lf-pill is-good">${tr('Ton annonce')}</span>`;
  else if (x.mine && LF_STATUS[x.mine.status] && ['pending', 'invited', 'accepted'].includes(x.mine.status)) action = lfStatusPill(x.mine.status);
  else if (block) action = `<button class="btn glass small" type="button" disabled title="${esc(block)}">${esc(block)}</button>`;
  else action = `<button class="btn primary small" type="button" data-lf="tag-open" data-code="${esc(x.code)}" data-track="groupes › me taguer">${tr('Postuler')}</button>`;
  const leader = x.leader?.char;
  const lkey = leader?.key;
  return `<article class="card lf-card${x.phase === 'live' ? ' is-live' : ''}">
    <div class="lf-card-art" style="--art:${lfArtUrl(art?.image)}">${lfPhase(x)}${lfFlags(x.langs)}</div>
    <div class="lf-card-body">
      <div class="lf-card-title"><h3><a href="/groups/${esc(x.code)}" data-lf-go="/groups/${esc(x.code)}" data-track="groupes › ouvrir">${esc(lfTitle(x))}</a></h3>${lfSub(x)}</div>
      <div class="lf-when">${lfWhen(x)}</div>
      <div class="lf-when">${lfBosses(x)}<span class="lf-dim">${esc(lfBossCount(x))}</span></div>
      <div>${lfComp(x)}</div>
      ${lfWants(x)}
      <div class="lf-card-foot">
        ${leader ? `<span class="lf-leader">${specIconSpan(leader.className, null, 'lf-ico-s')}<span><span class="lf-cname" style="--cls:${CLASS_COLORS[leader.className] || 'var(--text)'}">${esc(leader.name)}</span>${vipBadge(lkey)}<small>${tr('raid leader')}</small></span></span>` : ''}
        <span class="lf-grow"></span>
        <span class="lf-dim lf-tags-n">${tr('{n, plural, one {# candidature} other {# candidatures}}', { n: x.tags || 0 })}</span>
        ${action}
      </div>
    </div>
  </article>`;
}

function lfListPage() {
  const players = lfg.view === 'players';
  if (lfg.error && !lfg.listings) return `${lfListHead()}<div class="card lf-empty"><p>${esc(lfg.error)}</p></div>`;
  if (!lfg.listings) return `${lfListHead()}<div class="lf-loading"><span class="spinner" aria-hidden="true"></span></div>`;
  return lfListHead() + (players ? lfPlayersBody() : lfListingsBody());
}

function lfAsBar() {
  if (!lfg.chars?.length) return '';
  const char = lfAsChar();
  const opts = lfg.chars.map((c) => `<option value="${esc(c.key)}"${c.key === char.key ? ' selected' : ''}>${esc(c.name)} · ${esc(lfClassName(c.className))}</option>`).join('');
  return `<div class="lf-as">
    ${specIconSpan(char.className, null, 'lf-ico-s')}
    <label for="lfAs">${tr('Tu regardes avec')}</label>
    <select id="lfAs" data-lf-as>${opts}</select>
    <label class="toggle lf-fits"><input type="checkbox" data-lf="f-fits"${lfg.filters.fits ? ' checked' : ''}><span>${tr('Seulement ceux où je peux postuler')}</span></label>
  </div>`;
}

function lfListingsBody() {
  const f = lfg.filters;
  const char = lfAsChar();
  const list = lfg.listings.filter((x) => (!f.diff || x.difficulty === f.diff) && lfDayOk(x.startsAt) && lfLangOk(x.langs)
    && (!f.fits || x.mine?.leader || !lfTagBlock(x, char)));
  const grid = list.length
    ? `<div class="lf-grid">${list.map(lfCard).join('')}</div>`
    : `<div class="card lf-empty"><b>${lfg.listings.length ? tr('Aucune annonce avec ces filtres') : tr("Aucun raid ne recrute pour l'instant")}</b><p>${tr('Poste la tienne : les joueurs qui cherchent un raid à cette heure-là la verront.')}</p></div>`;
  return lfAsBar() + grid;
}

// Joueurs qui cherchent, comparés à ton annonce si tu en as une
function lfPlayersBody() {
  const f = lfg.filters;
  const own = lfg.mine?.listing;
  const list = lfg.searches.filter((s) => (!f.diff || s.difficulties.includes(f.diff)) && lfDayOk(s.startsAt) && lfLangOk(s.langs));
  const intro = own
    ? `<div class="lf-as">${specIconSpan(own.leader?.char?.className, null, 'lf-ico-s')}<span>${tr('Comparés à ton annonce')} <b>${esc(lfTitle(own))}</b> · ${lfWhen(own)}</span></div>`
    : '';
  if (!list.length) return `${intro}<div class="card lf-empty"><b>${lfg.searches.length ? tr('Personne avec ces filtres') : tr("Personne ne cherche de raid pour l'instant")}</b><p>${tr('Publie ta recherche : les raid leaders pourront te proposer une place.')}</p></div>`;
  return `${intro}<div class="card lf-rows">${list.map((s) => lfSearchRow(s, own)).join('')}</div>`;
}

// Créneau d'un joueur face à celui du raid : barre de 6 h autour du raid, verte s'il couvre tout
function lfWindow(s, x) {
  const text = `${esc(lfClock(s.startsAt))} → ${esc(lfClock(s.endsAt))}`;
  if (!x) return `<span class="lf-win"><span>${esc(lfDay(s.startsAt))}</span> ${text}</span>`;
  const from = Math.min(x.startsAt, s.startsAt) - 30 * 60e3;
  const to = Math.max(x.endsAt, s.endsAt) + 30 * 60e3;
  const pos = (t) => `${Math.max(0, Math.min(100, ((t - from) / (to - from)) * 100)).toFixed(1)}%`;
  const full = s.startsAt <= x.startsAt && s.endsAt >= x.endsAt;
  const none = s.endsAt <= x.startsAt || s.startsAt >= x.endsAt;
  const title = full ? tr('Disponible pendant tout le raid') : none ? tr("Pas disponible à l'heure du raid") : s.startsAt > x.startsAt ? tr('Arrive à {t}', { t: lfClock(s.startsAt) }) : tr('Part à {t}', { t: lfClock(s.endsAt) });
  return `<span class="lf-win" title="${esc(title)}"><span class="lf-tl"><u style="left:${pos(x.startsAt)};right:calc(100% - ${pos(x.endsAt)})"></u><i class="${full ? '' : none ? 'is-none' : 'is-part'}" style="left:${pos(s.startsAt)};right:calc(100% - ${pos(s.endsAt)})"></i></span>${text}</span>`;
}

// Boss choisis par un joueur qui cherche (les autres grisés)
function lfSearchBosses(s) {
  const bossCount = lfRaidOf(s.raid)?.bosses.length || s.bosses.length;
  return `<span class="lf-sbosses" title="${esc(s.bosses.join(', '))}">${lfBosses({ raid: s.raid, bosses: s.bosses, bossCount })}</span>`;
}
// Les boss d'un joueur qui cherche croisent-ils ceux de l'annonce ? (aucun choisi = n'importe lesquels)
const lfBossesMatch = (s, x) => !s.bosses?.length || !x.bosses?.length || s.bosses.some((b) => x.bosses.includes(b));

// `offer` : peut-on lui proposer une place (leader ou co-leader de `own`) ?
function lfSearchRow(s, own, { offer = Boolean(own && lfg.mine?.listing) } = {}) {
  const set = own ? { raid: own.raid, difficulty: own.difficulty } : { raid: s.raid || '', difficulty: s.difficulties[0] };
  const prof = s.snapshot?.profile;
  const color = CLASS_COLORS[s.char.className] || 'var(--text)';
  const canOffer = offer && own && !s.mine && s.startsAt < own.endsAt && s.endsAt > own.startsAt;
  return `<div class="lf-row is-search" style="--cls:${color}">
    ${specIconSpan(s.char.className, prof?.spec, 'lf-ico')}
    <div class="lf-who">
      <div class="lf-nm">${s.roles.map(lfRoleIcon).join('')}<a class="lf-cname" style="--cls:${color}" href="${esc(playerPath(s.char.name, s.char.realm))}" data-player-link>${esc(s.char.name)}</a>${vipBadge(s.char.key)}</div>
      <div class="lf-meta">${lfMeta(prof?.spec, s.char.realm, s.snapshot?.at)}</div>
      ${s.note ? `<div class="lf-note">${esc(s.note)}</div>` : ''}
    </div>
    <div class="lf-c lf-hide-s"><span class="lf-dim lf-small">${esc(s.raidName || tr('Tout le palier'))} · ${s.difficulties.map((d) => lfDiff(d).letter).join(' / ')}</span>${s.raid && s.bosses?.length ? lfSearchBosses(s) : ''}${lfWindow(s, own)}</div>
    <div class="lf-c lf-hide-s"><b>${lfIlvl(prof) ?? '—'}</b><small>ilvl</small></div>
    <div class="lf-c lf-hide-s">${lfProg(prof, set)}</div>
    <div class="lf-c">${lfScore(prof)}</div>
    <div class="lf-acts">
      ${lfFlags(s.langs)}
      ${canOffer ? `<button class="btn primary small" type="button" data-lf="offer-open" data-id="${s.id}">${tr('Proposer une place')}</button>` : ''}
      ${s.mine ? `<span class="lf-pill is-rec">${tr('Ta recherche')}</span>` : ''}
    </div>
  </div>`;
}

/* ---------------- Page du raid -------------------------------------- */
function lfSkeleton() {
  return `<div class="lf-raid">
    <div id="lfBanner"></div>
    <section class="card lf-head" id="lfHead"></section>
    <div class="lf-raid-grid">
      <div class="lf-main">
        <section class="card lf-me" id="lfMe"></section>
        <section class="card lf-game" id="lfGame"></section>
        <section class="card lf-roster" id="lfRoster" aria-label="${esc(tr('Le raid'))}"></section>
      </div>
      <aside class="lf-side lf-chat-side">
        <section class="card lf-chat" id="lfChat">
          <div class="lf-chat-head"><h2>${tr('Chat du raid')}</h2><span class="lf-pill" id="lfChatCount"></span></div>
          <div class="lf-msgs" id="lfMsgs" aria-live="polite"></div>
          <div class="lf-chat-lock" id="lfChatLock" hidden>${LF_ICONS.lock}<b>${tr("Le chat s'ouvre quand tu es dans le raid")}</b><small>${tr('Il est réservé aux membres acceptés.')}</small></div>
          <form class="lf-chat-in" id="lfChatForm" data-lf-form="chat" autocomplete="off">
            <label class="visually-hidden" for="lfChatText">${tr('Écris au raid')}</label>
            <input id="lfChatText" type="text" maxlength="500" placeholder="${esc(tr('Écris au raid…'))}">
            <button class="btn primary" type="submit" aria-label="${esc(tr('Envoyer'))}" title="${esc(tr('Envoyer'))}">${LF_ICONS.send}</button>
          </form>
        </section>
      </aside>
    </div>
    <section class="card lf-apps" id="lfApps"></section>
  </div>`;
}

function renderRaidPage() {
  const x = lfg.page;
  const root = $('#groups');
  if (!x || currentView !== 'groups' || lfg.view !== 'raid') return;
  if (lfg.skeleton !== x.code || !root.querySelector('#lfHead')) { root.innerHTML = lfSkeleton(); lfg.skeleton = x.code; }
  document.title = `${lfTitle(x)} · GroupScout`;
  setHtml($('#lfBanner'), lfInviteBanner(x));
  setHtml($('#lfHead'), lfHead(x));
  $('#lfHead').style.setProperty('--art', lfArtUrl(lfRaidArt(x.raid)?.image));
  setHtml($('#lfRoster'), lfRoster(x));
  // Le leader n'a pas de carte à lui : ses boutons sont dans la carte du raid
  setHtml($('#lfMe'), x.me.leader ? '' : lfMeCard(x));
  $('#lfMe').hidden = x.me.leader;
  const member = x.me.member || x.chat;
  $('#lfChatLock').hidden = Boolean(member);
  $('#lfChatForm').hidden = !member;
  $('#lfMsgs').hidden = !member;
  $('#lfChat').classList.toggle('is-locked', !member);
  setHtml($('#lfChatCount'), member ? esc(tr('{n, plural, one {# membre} other {# membres}}', { n: ROLES.reduce((s, r) => s + (x.filled[r] || 0), 0) })) : esc(tr('Membres seulement')));
  renderChat();
  setHtml($('#lfGame'), lfGameCard(x));
  $('#lfGame').hidden = x.phase === 'ended';
  setHtml($('#lfApps'), lfApps(x));
  // Leader : les joueurs qui cherchent (compteur de l'onglet), une fois par ouverture de la page
  if (x.me.canManage && !lfg.searches) lfLoadSearchesFor();
}

function lfHead(x) {
  const leader = x.tags.find((t) => t.leader);
  const desc = x.description ? `<p class="lf-desc">${esc(x.description).replace(/\n/g, '<br>')}</p>` : '';
  const actions = [`<button class="btn glass small" type="button" data-lf="copy-link">${tr('Copier le lien')}</button>`];
  return `<div class="lf-head-art" aria-hidden="true"></div>
    <div class="lf-head-in">
      <div class="lf-head-top">${lfPhase(x)}${lfFlags(x.langs)}<a class="lf-dim lf-small" href="/groups" data-lf-go="/groups">${LF_ICONS.back}${tr('Tous les raids')}</a></div>
      <h1>${esc(lfTitle(x))}</h1>
      ${lfSub(x)}
      <div class="lf-meta-row"><span class="lf-when">${lfWhen(x)}</span>${leader ? `<span>${tr('Raid de {name}', { name: `<b class="lf-cname" style="--cls:${CLASS_COLORS[leader.char.className] || 'var(--text)'}">${esc(leader.char.name)}</b>` })}</span>` : ''}</div>
      <div class="lf-when">${lfBosses(x, { size: ' is-big' })}<span class="lf-dim">${esc(lfBossCount(x))}</span></div>
      ${desc}
      ${lfWants(x, { label: true })}
      <div class="lf-actions">${actions.join('')}</div>
    </div>`;
}

function lfInviteBanner(x) {
  const t = x.me.tag;
  if (!t || t.status !== 'invited') return '';
  return `<div class="lf-banner">
    <span class="lf-banner-ico">${LF_ICONS.mail}</span>
    <div><h2>${tr('Une place de {role} t\'est proposée', { role: LF_ROLE_LABEL[t.role].toLocaleLowerCase(I18N.locale) })}</h2><p>${tr('Accepte pour rejoindre le raid : tes autres candidatures sur ce créneau et ta recherche seront retirés.')}</p></div>
    <div class="lf-banner-btns"><button class="btn ghost" type="button" data-lf="answer" data-v="no">${tr('Refuser')}</button><button class="btn primary" type="button" data-lf="answer" data-v="yes">${tr('Accepter')}</button></div>
  </div>`;
}

function lfMemberCard(t, x) {
  const prof = t.snapshot?.profile;
  const color = CLASS_COLORS[t.char.className] || 'var(--text)';
  const me = x.me.tag?.id === t.id;
  const acts = [];
  if (t.status === 'accepted' && !t.leader) {
    if (x.me.leader) acts.push(`<button type="button" class="lf-mact${t.co ? ' is-on' : ''}" data-lf="colead" data-tag="${t.id}" data-on="${t.co ? '0' : '1'}" title="${esc(t.co ? tr('Retirer le rôle de co-leader') : tr('Nommer co-leader'))}" aria-label="${esc(t.co ? tr('Retirer le rôle de co-leader') : tr('Nommer co-leader'))}">${LF_ICONS.shield}</button>`);
    if (x.me.canManage && (!t.co || x.me.leader)) acts.push(`<button type="button" class="lf-mact is-danger" data-lf="kick-open" data-tag="${t.id}" title="${esc(tr('Retirer du raid'))}" aria-label="${esc(tr('Retirer du raid'))}">${LF_ICONS.x}</button>`);
  }
  if (t.status === 'invited' && x.me.canManage) acts.push(`<button type="button" class="lf-mact" data-lf="decline" data-tag="${t.id}" title="${esc(tr('Reprendre la proposition'))}" aria-label="${esc(tr('Reprendre la proposition'))}">${LF_ICONS.x}</button>`);
  const badge = t.leader ? `<span class="lf-badge">${tr('Leader')}</span>` : t.co ? `<span class="lf-badge is-co">${tr('Co-leader')}</span>` : '';
  const sub = t.status === 'invited' ? `<small class="lf-invited">${tr('Place proposée')}</small>` : `<small>${esc([prof?.spec, lfIlvl(prof) ? `${lfIlvl(prof)} ilvl` : ''].filter(Boolean).join(' · '))}</small>`;
  return `<div class="lf-mcard${t.status === 'invited' ? ' is-pending' : ''}${me ? ' is-me' : ''}" style="--cls:${color}">
    ${badge}
    ${specIconSpan(t.char.className, prof?.spec, 'lf-ico-s')}
    <div class="lf-mt"><a class="lf-cname" style="--cls:${color}" href="${esc(playerPath(t.char.name, t.char.realm))}" data-player-link>${esc(t.char.name)}</a>${sub}</div>
    ${acts.length ? `<span class="lf-macts">${acts.join('')}</span>` : ''}
  </div>`;
}

function lfRoster(x) {
  const total = ROLES.reduce((s, r) => s + (x.comp[r] || 0), 0);
  const filled = ROLES.reduce((s, r) => s + (x.filled[r] || 0), 0);
  const rows = ROLES.filter((r) => x.comp[r] > 0 || x.tags.some((t) => t.role === r && ['accepted', 'invited'].includes(t.status))).map((r) => {
    const members = x.tags.filter((t) => t.role === r && (t.status === 'accepted' || t.status === 'invited'))
      .sort((a, b) => (b.leader - a.leader) || (b.co - a.co) || ((a.status === 'invited') - (b.status === 'invited')));
    const invited = members.filter((t) => t.status === 'invited').length;
    const empty = Math.max(0, (x.comp[r] || 0) - members.length);
    const shown = Math.min(empty, r === 'dps' ? 2 : empty);
    const cells = members.map((t) => lfMemberCard(t, x)).join('')
      + Array.from({ length: shown }, () => `<div class="lf-mcard is-empty">${tr('Place libre')}</div>`).join('')
      + (empty > shown ? `<div class="lf-mcard is-empty">${tr('+{n} places', { n: empty - shown })}</div>` : '');
    return `<div class="lf-rrow"><div class="lf-rrow-t">${lfRoleIcon(r)}${esc(LF_ROLE_ROWS[r])} <b>${x.filled[r] || 0}/${x.comp[r] || 0}</b>${invited ? `<span class="lf-dim">· ${esc(tr('{n, plural, one {# proposition en attente} other {# propositions en attente}}', { n: invited }))}</span>` : ''}</div>
      <div class="lf-mgrid">${cells}</div></div>`;
  }).join('');
  const acts = [];
  if (x.me.canManage && x.phase !== 'ended') acts.push(`<a class="btn glass small" href="/groups/${esc(x.code)}/edit" data-lf-go="/groups/${esc(x.code)}/edit">${tr("Modifier l'annonce")}</a>`);
  if (x.me.canDelete) acts.push(`<button class="btn ghost small" type="button" data-lf="delete">${tr("Supprimer l'annonce")}</button>`);
  const foot = acts.length || x.discordUrl
    ? `<div class="lf-roster-foot">${lfDiscordJoin(x)}${acts.length ? `<div class="lf-roster-acts">${acts.join('')}</div>` : ''}</div>`
    : '';
  return `<div class="lf-roster-head"><h2>${tr('Le raid')}</h2><span class="lf-pill">${esc(tr('{n, plural, one {# membre} other {# membres}}', { n: filled }))} · ${esc(tr('{n, plural, one {# place} other {# places}}', { n: Math.max(0, total - filled) }))}</span><span class="lf-total">${filled}/${total}</span></div>${rows}${foot}`;
}

function lfMeCard(x) {
  const t = x.me.tag;
  if (!t || !['pending', 'invited', 'accepted'].includes(t.status)) {
    const closed = t ? `<p class="lf-closed">${lfStatusPill(t.status)}${t.message ? `<span class="lf-msg-quote">« ${esc(t.message)} »</span>` : ''}</p>` : '';
    if (x.phase === 'ended') return `<span class="lf-kicker">${tr('Ce raid est terminé')}</span>${closed}`;
    const gate = lfGate('tag');
    if (gate) return `<span class="lf-kicker">${tr('Postuler à ce raid')}</span>${closed}${lfGateHtml(gate)}`;
    if (t && ['declined', 'removed'].includes(t.status)) return `<span class="lf-kicker">${tr('Ta place')}</span>${closed}`;
    const free = ROLES.filter((r) => (x.filled[r] || 0) < (x.comp[r] || 0));
    const block = lfTagBlock(x, lfAsChar());
    return `<span class="lf-kicker">${tr('Postuler à ce raid')}</span>${closed}
      <p class="lf-small lf-muted">${free.length ? esc(tr('Places libres : {list}.', { list: free.map((r) => `${(x.comp[r] || 0) - (x.filled[r] || 0)} ${LF_ROLE_LABEL[r].toLocaleLowerCase(I18N.locale)}`).join(', ') })) : esc(tr('Le raid est complet.'))} ${tr('Le leader voit ta spé, ton équipement et ta progression.')}</p>
      <button class="btn primary lf-wide" type="button" data-lf="tag-open" data-code="${esc(x.code)}"${free.length ? '' : ' disabled'}>${tr('Postuler')}</button>
      ${block && free.length && x.classMode === 'required' ? `<p class="lf-small lf-warn">${esc(tr('Seules certaines classes peuvent postuler à ce raid.'))}</p>` : ''}`;
  }
  const own = x.tags.find((y) => y.id === t.id);
  const snap = own?.snapshot;
  const prof = snap?.profile;
  const color = CLASS_COLORS[t.char.className] || 'var(--text)';
  return `<span class="lf-kicker">${t.status === 'accepted' ? tr('Ta place') : tr('Ta candidature')}</span>
    <div class="lf-me-who">${specIconSpan(t.char.className, prof?.spec, 'lf-ico')}<div><b class="lf-cname" style="--cls:${color}">${esc(t.char.name)}</b> <span class="lf-dim lf-small">${esc(t.char.realm)}</span><div class="lf-small lf-muted">${esc([prof?.spec, lfIlvl(prof) ? `${lfIlvl(prof)} ilvl` : ''].filter(Boolean).join(' · '))}</div></div></div>
    <dl class="lf-dl">
      <dt>${tr('Rôle')}</dt><dd>${lfRoleIcon(t.role)} ${esc(LF_ROLE_LABEL[t.role])}</dd>
      <dt>${tr('État')}</dt><dd>${lfStatusPill(t.status)}</dd>
      ${t.note && t.status !== 'accepted' ? `<dt>${t.origin === 'offer' ? tr('Mot du leader') : tr('Ta note')}</dt><dd class="lf-muted">« ${esc(t.note)} »</dd>` : ''}
    </dl>
    <div class="lf-refresh"><span>${esc(tr('Infos envoyées à {t}', { t: snap?.at ? lfClock(snap.at) : '—' }))}</span><button class="btn glass small" type="button" data-lf="refresh">${LF_ICONS.refresh}${tr('Actualiser')}</button></div>
    <p class="lf-small lf-muted">${tr('Ton équipement ou ta progression ont changé ? Actualise pour que le leader voie ton profil à jour.')}</p>
    <div class="lf-me-actions">${t.status === 'accepted'
      ? `<button class="btn ghost small lf-wide" type="button" data-lf="leave-open">${tr('Quitter le raid')}</button>`
      : t.status === 'invited'
        ? `<button class="btn ghost small" type="button" data-lf="answer" data-v="no">${tr('Refuser')}</button><button class="btn primary small" type="button" data-lf="answer" data-v="yes">${tr('Accepter')}</button>`
        : `<button class="btn glass small" type="button" data-lf="note-open">${tr('Modifier ma note')}</button><button class="btn ghost small" type="button" data-lf="withdraw">${tr('Retirer ma candidature')}</button>`}</div>`;
}

// Lien du Discord du raid : pour les membres, les joueurs à qui une place est proposée et qui gère l'annonce
function lfDiscordJoin(x) {
  if (!x.discordUrl) return '';
  const url = String(x.discordUrl);
  return `<a class="lf-discord-join" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-track="groupes › discord du raid">
    <span class="oauth-ico oauth-discord" aria-hidden="true"></span><span><b>${tr('Rejoindre le Discord du raid')}</b><small>${esc(url.replace(/^https:\/\//, ''))}</small></span></a>`;
}

// Titre à donner à l'annonce dans le jeu : les membres acceptés la retrouvent par la recherche de groupe
function lfGameCard(x) {
  const title = `GroupScout: ${x.code}`;
  return `<span class="lf-kicker">${tr('Dans le jeu')}</span>
    <div class="lf-gametitle"><span>${esc(title)}</span><button class="lf-copy" type="button" data-lf="copy-title" title="${esc(tr('Copier'))}" aria-label="${esc(tr('Copier'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button></div>
    <p class="lf-small lf-muted">${x.me.leader
      ? tr('Liste ton raid dans la recherche de groupe du jeu avec ce titre : tes membres le retrouvent en le cherchant, et tu les invites.')
      : tr("Le leader liste le raid dans la recherche de groupe du jeu avec ce titre : une fois dans le raid, cherche-le pour postuler.")}</p>`;
}

/* ---------------- Tags et joueurs qui cherchent (page du raid) ------ */
function lfTagMarks(t, x) {
  const out = [];
  const prof = t.snapshot?.profile;
  const wanted = (x.classes || []).some((c) => c.cls === t.char.className);
  if (wanted) out.push(['is-good', tr('Classe recherchée')]);
  else if (x.classMode === 'required') out.push(['is-bad', tr('Ne correspond plus')]);
  if (t.status === 'pending' && (x.filled[t.role] || 0) >= (x.comp[t.role] || 0)) out.push(['is-warn', tr('Rôle complet')]);
  if (x.minIlvl && lfIlvl(prof) && lfIlvl(prof) < x.minIlvl) out.push(['is-bad', tr("Sous l'ilvl conseillé")]);
  if (x.minProg && prof && lfKilled(prof, x) < x.minProg) out.push(['is-warn', tr('Sous la progression conseillée')]);
  if (t.origin === 'offer') out.push(['is-rec', tr('Proposé depuis sa recherche')]);
  return out;
}

function lfTagRow(t, x, manage) {
  const prof = t.snapshot?.profile;
  const color = CLASS_COLORS[t.char.className] || 'var(--text)';
  const acts = [];
  if (manage && t.status === 'pending') {
    acts.push(`<button class="lf-x" type="button" data-lf="decline" data-tag="${t.id}" title="${esc(tr('Refuser'))}" aria-label="${esc(tr('Refuser'))}">${LF_ICONS.x}</button>`);
    acts.push(`<button class="btn primary small" type="button" data-lf="invite" data-tag="${t.id}"${(x.filled[t.role] || 0) >= (x.comp[t.role] || 0) ? ' disabled' : ''}>${tr('Inviter')}</button>`);
  } else if (manage && t.status === 'invited') {
    acts.push(`<span class="lf-pill is-live">${tr('Place proposée')}</span><button class="lf-x" type="button" data-lf="decline" data-tag="${t.id}" title="${esc(tr('Reprendre la proposition'))}" aria-label="${esc(tr('Reprendre la proposition'))}">${LF_ICONS.x}</button>`);
  } else if (t.status === 'invited') acts.push(`<span class="lf-pill is-live">${tr('Place proposée')}</span>`);
  return `<div class="lf-row" style="--cls:${color}">
    ${specIconSpan(t.char.className, prof?.spec, 'lf-ico')}
    <div class="lf-who">
      <div class="lf-nm">${lfRoleIcon(t.role)}<a class="lf-cname" style="--cls:${color}" href="${esc(playerPath(t.char.name, t.char.realm))}" data-player-link>${esc(t.char.name)}</a>${vipBadge(t.char.key)}</div>
      <div class="lf-meta">${lfMeta(prof?.spec, t.char.realm, t.snapshot?.at)}</div>
      ${t.note ? `<div class="lf-note">${esc(t.note)}</div>` : ''}
      <div class="lf-marks">${lfTagMarks(t, x).map(([c, l]) => `<span class="lf-pill ${c}">${esc(l)}</span>`).join('')}${lfNoProfile(t.snapshot)}</div>
    </div>
    <div class="lf-c lf-hide-s"><b>${lfIlvl(prof) ?? '—'}</b><small>ilvl</small></div>
    <div class="lf-c lf-hide-s">${lfProg(prof, x)}</div>
    <div class="lf-c">${lfScore(prof)}</div>
    <div class="lf-acts">${acts.join('')}</div>
  </div>`;
}

function lfApps(x) {
  const manage = x.me.canManage && x.phase !== 'ended';
  // Dans l'ordre d'arrivée : les places proposées d'abord, puis les candidatures
  const tags = x.tags.filter((t) => t.status === 'pending' || t.status === 'invited')
    .sort((a, b) => (b.status === 'invited') - (a.status === 'invited') || a.at - b.at);
  const inRaid = new Set(x.tags.map((t) => t.char.key));
  const seekers = manage ? (lfg.searches || []).filter((s) => !s.mine && !inRaid.has(s.char.key) && s.startsAt < x.endsAt && s.endsAt > x.startsAt
    && s.difficulties.includes(x.difficulty) && (!s.raid || s.raid === x.raid) && lfBossesMatch(s, x)) : [];
  const tab = manage ? lfg.appsTab : 'tags';
  const tabs = manage
    ? `<div class="lf-tabs is-small" role="tablist"><button type="button" role="tab" class="lf-tab${tab === 'tags' ? ' is-on' : ''}" aria-selected="${tab === 'tags'}" data-lf="apps-tab" data-v="tags">${tr('Candidatures')} <small>${tags.length}</small></button><button type="button" role="tab" class="lf-tab${tab === 'seekers' ? ' is-on' : ''}" aria-selected="${tab === 'seekers'}" data-lf="apps-tab" data-v="seekers">${tr('Joueurs qui cherchent')} <small>${seekers.length}</small></button></div>`
    : `<h2>${tr('Candidatures')} <small class="lf-dim">${tags.length}</small></h2>`;
  const hint = tab === 'tags' ? tr("Dans l'ordre d'arrivée. Clique un pseudo pour voir sa fiche.") : tr('Leur créneau et leur difficulté correspondent à ton raid');
  let body;
  if (tab === 'tags') {
    body = tags.length ? tags.map((t) => lfTagRow(t, x, manage)).join('') : `<p class="lf-apps-empty">${tr("Aucune candidature pour l'instant.")}</p>`;
  } else {
    if (!lfg.searches) lfLoadSearchesFor();
    body = seekers.length ? seekers.map((s) => lfSearchRow(s, x, { offer: manage })).join('') : `<p class="lf-apps-empty">${lfg.searches ? tr('Personne ne cherche de raid sur ce créneau.') : `<span class="spinner" aria-hidden="true"></span>`}</p>`;
  }
  return `<div class="lf-apps-head">${tabs}<span class="lf-dim lf-small">${esc(hint)}</span></div><div class="lf-rows">${body}</div>`;
}

async function lfLoadSearchesFor() {
  if (lfg.searchesAsked) return;
  lfg.searchesAsked = true;
  try { lfg.searches = (await api('/api/groups/searches')).searches || []; } catch { lfg.searches = []; }
  lfg.searchesAsked = false;
  if (lfg.view === 'raid') renderRaidPage();
}

/* ---------------- Chat ---------------------------------------------- */
function lfSysText(d) {
  const name = `<b>${esc(d.name || '')}</b>`;
  if (d.event === 'joined') return tr('{name} a rejoint le raid.', { name });
  if (d.event === 'co') return tr('{name} est co-leader.', { name });
  if (d.event === 'left') return `${tr('{name} a quitté le raid.', { name })} <span class="lf-msg-quote">« ${esc(d.message || '')} »</span>`;
  if (d.event === 'removed') return `${tr('Le leader a retiré {name} du raid.', { name })} <span class="lf-msg-quote">« ${esc(d.message || '')} »</span>`;
  return '';
}

function renderChat() {
  const box = $('#lfMsgs');
  if (!box || !lfg.page) return;
  const list = lfg.chat || [];
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const manage = lfg.page.me.canManage;
  const html = list.length ? list.map((m) => {
    if (m.kind === 'sys') return `<div class="lf-msg is-sys${m.data?.event === 'left' || m.data?.event === 'removed' ? ' is-out' : ''}">${lfSysText(m.data || {})}</div>`;
    const color = CLASS_COLORS[m.author?.className] || 'var(--text)';
    return `<div class="lf-msg"><div class="lf-msg-h"><b class="lf-cname" style="--cls:${color}">${esc(m.author?.name || '')}</b><time>${esc(lfClock(m.at))}</time>${manage ? `<button class="lf-msg-del" type="button" data-lf="chat-delete" data-id="${m.id}" title="${esc(tr('Supprimer ce message'))}" aria-label="${esc(tr('Supprimer ce message'))}">${LF_ICONS.x}</button>` : ''}</div><p>${esc(m.text).replace(/\n/g, '<br>')}</p></div>`;
  }).join('') : `<p class="lf-chat-empty">${tr('Pas encore de message. Dis bonjour au raid !')}</p>`;
  setHtml(box, html);
  if (nearBottom || lfg.chatScroll) { box.scrollTop = box.scrollHeight; lfg.chatScroll = false; }
}

/* ---------------- Direct -------------------------------------------- */
function lfConnect(code) {
  stopGroups();
  const src = new EventSource(`/api/groups/${code}/events`);
  lfg.source = src;
  const on = (name, fn) => src.addEventListener(name, (ev) => {
    if (lfg.source !== src) return;
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    fn(d);
  });
  on('state', (d) => {
    lfg.page = d;
    if (d.chat) { lfg.chat = d.chat; } else lfg.chat = null;
    renderRaidPage();
  });
  on('message', (m) => {
    if (!lfg.chat) return;
    if (!lfg.chat.some((x) => x.id === m.id)) lfg.chat.push(m);
    renderChat();
  });
  on('message-deleted', ({ id }) => {
    if (!lfg.chat) return;
    lfg.chat = lfg.chat.filter((x) => x.id !== id);
    renderChat();
  });
  on('closed', () => {
    stopGroups();
    toast(tr('Cette annonce a été supprimée.'));
    if (currentView === 'groups' && lfg.code === code) goTo('/groups');
  });
}

/* ---------------- Formulaire d'une annonce -------------------------- */
function lfNewDraft() {
  const main = [...state.raids].sort((a, b) => b.bosses.length - a.bosses.length)[0];
  const start = new Date();
  start.setHours(20, 0, 0, 0);
  if (start.getTime() < Date.now() + 30 * 60e3) start.setDate(start.getDate() + 1);
  const langs = ['fr'];
  return {
    char: lfg.chars?.[0]?.key || '', role: '', title: '', goal: 'reclear',
    raid: main?.slug || '', difficulty: 4, bosses: main ? [...main.bosses] : [],
    date: lfDateValue(start), from: '20:00', to: '23:00', langs,
    comp: { tank: 2, heal: 4, dps: 14 }, classes: [], classMode: 'preferred', minIlvl: '', minProg: 0, description: '',
    discordRequired: false, discord: '',
  };
}

function lfDraftFrom(x) {
  return {
    title: x.title || '', goal: x.goal, raid: x.raid, difficulty: x.difficulty, bosses: [...(x.bosses || [])],
    date: lfDateValue(x.startsAt), from: lfTimeValue(x.startsAt), to: lfTimeValue(x.endsAt), langs: [...x.langs],
    comp: { ...x.comp }, classes: (x.classes || []).map((c) => ({ ...c })), classMode: x.classMode,
    minIlvl: x.minIlvl || '', minProg: x.minProg || 0, description: x.description || '', started: x.phase !== 'open',
    discordRequired: Boolean(x.discordRequired), discord: x.discordUrl || '',
  };
}

const lfRaidOf = (slug) => state.raids.find((r) => r.slug === slug) || null;

function lfFormPage() {
  const d = lfg.draft;
  const edit = lfg.view === 'edit';
  const gate = edit ? null : lfGate('post');
  const head = `<div class="lf-page-head"><div><span class="lf-kicker"><a href="${edit ? `/groups/${esc(lfg.code)}` : '/groups'}" data-lf-go="${edit ? `/groups/${esc(lfg.code)}` : '/groups'}">${LF_ICONS.back}${edit ? tr('Retour au raid') : tr('Trouver un groupe')}</a></span>
    <h1>${edit ? tr("Modifier l'annonce") : tr('Poster une annonce de raid')}</h1>
    <p>${edit ? tr('Les candidatures déjà reçues restent : celles qui ne correspondent plus sont signalées.') : tr('Une annonce de raid à la fois. Tu pourras la modifier tant que le raid n\'est pas terminé.')}</p></div></div>`;
  if (gate) return `${head}<div class="card lf-empty">${lfGateHtml(gate)}</div>`;
  if (!state.raids.length) return `${head}<div class="card lf-empty"><p>${tr('Les raids de la saison ne sont pas disponibles pour le moment. Réessaie dans un moment.')}</p></div>`;
  const raidOpts = state.raids.map((r) => `<option value="${esc(r.slug)}"${r.slug === d.raid ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
  const charOpts = (lfg.chars || []).map((c) => `<option value="${esc(c.key)}"${c.key === d.char ? ' selected' : ''}>${esc(c.name)} · ${esc(lfClassName(c.className))} · ${esc(c.realm)}</option>`).join('');
  return `${head}
  <form class="lf-form-grid" id="lfForm" data-lf-form="listing" novalidate>
    <div class="card lf-form">
      ${edit ? '' : `<div class="lf-fsec"><h2>${tr('Toi')}</h2>
        <div class="lf-row2">
          <div class="lf-field"><label for="lfChar">${tr('Ton personnage')}</label><select id="lfChar" name="char">${charOpts}</select></div>
          <div class="lf-field"><span class="lf-label">${tr('Ton rôle')}</span><div id="lfRolePick">${lfRolePick(d.role, 'role')}</div></div>
        </div></div>`}
      <div class="lf-fsec"><h2>${tr('Le raid')}</h2>
        <div class="lf-field lf-count-wrap"><label for="lfTitle">${tr("Titre de l'annonce")} <span class="lf-dim">· ${tr('facultatif')}</span></label><input id="lfTitle" name="title" type="text" maxlength="60" value="${esc(d.title)}" placeholder="${esc(tr('Par exemple : Reclear HM chill du mercredi'))}"><span class="lf-count" data-count-for="lfTitle">${d.title.length} / 60</span></div>
        <div class="lf-field"><span class="lf-label">${tr('Objectif')}</span><div class="lf-choice" id="lfGoal">${lfGoalPick(d.goal)}</div></div>
        <div class="lf-row2">
          <div class="lf-field"><label for="lfRaid">${tr('Raid')}</label><select id="lfRaid" name="raid">${raidOpts}</select></div>
          <div class="lf-field"><span class="lf-label">${tr('Difficulté')}</span><div id="lfDiffPick">${lfDiffPick(d.difficulty)}</div></div>
        </div>
        <div class="lf-field"><span class="lf-label">${tr('Boss prévus')} <span class="lf-dim" id="lfBossCount"></span></span><div class="lf-boss-pick" id="lfBossPick"></div></div>
      </div>
      <div class="lf-fsec"><h2>${tr('Quand')}</h2>
        <div id="lfWhen">${lfWhenPick(d, 'listing', { started: d.started })}</div>
        <p class="lf-hint" id="lfWhenHint"></p>
      </div>
      <div class="lf-fsec"><h2>${tr('Langues parlées')}</h2><div class="lf-lang-pick" id="lfLangPick">${lfLangPick(d.langs)}</div></div>
      <div class="lf-fsec"><h2>${tr('Composition')}</h2>
        <div class="lf-row3" id="lfComp">${lfCompPick(d.comp)}</div>
        <p class="lf-hint" id="lfCompHint"></p>
        <span class="lf-label">${tr('Classes recherchées')}</span>
        <div class="lf-choice" id="lfClassMode">${lfModePick(d.classMode)}</div>
        <div class="lf-cls-pick" id="lfClsPick">${lfClassPick(d.classes)}</div>
      </div>
      <div class="lf-fsec"><h2>${tr('Conditions')} <span class="lf-dim lf-small">· ${tr('facultatif, juste affiché')}</span></h2>
        <div class="lf-row2">
          <div class="lf-field"><label for="lfIlvl">${tr("Niveau d'objet conseillé")}</label><input id="lfIlvl" name="minIlvl" type="number" min="100" max="999" inputmode="numeric" value="${esc(d.minIlvl)}" placeholder="—"></div>
          <div class="lf-field"><label for="lfProg">${tr('Progression conseillée')}</label><select id="lfProg" name="minProg">${lfProgOptions(d)}</select></div>
        </div></div>
      <div class="lf-fsec"><h2>Discord</h2>
        <label class="toggle lf-discord-req"><input type="checkbox" id="lfDiscordReq" name="discordRequired"${d.discordRequired ? ' checked' : ''}><span>${tr('Discord obligatoire pour le raid')}</span></label>
        <div class="lf-field" id="lfDiscordField"${d.discordRequired ? '' : ' hidden'}><label for="lfDiscord">${tr("Lien d'invitation de ton serveur")}</label><input id="lfDiscord" name="discord" type="text" inputmode="url" autocomplete="off" spellcheck="false" maxlength="120" value="${esc(d.discord)}" placeholder="https://discord.gg/…"></div>
        <p class="lf-hint">${tr("Tout le monde voit que le Discord est obligatoire. Le lien, lui, n'est montré qu'aux membres du raid et aux joueurs à qui une place est proposée.")}</p>
      </div>
      <div class="lf-fsec"><h2>${tr('Description')}</h2>
        <div class="lf-field lf-count-wrap"><label class="visually-hidden" for="lfDesc">${tr('Description')}</label><textarea id="lfDesc" name="description" maxlength="600" rows="4" placeholder="${esc(tr('Ambiance, Discord, règles de loot…'))}">${esc(d.description)}</textarea><span class="lf-count" data-count-for="lfDesc">${d.description.length} / 600</span></div></div>
      <div class="lf-form-foot"><a class="btn ghost" href="${edit ? `/groups/${esc(lfg.code)}` : '/groups'}" data-lf-go="${edit ? `/groups/${esc(lfg.code)}` : '/groups'}">${tr('Annuler')}</a><button class="btn primary" type="submit">${edit ? tr('Enregistrer') : tr("Publier l'annonce")}</button></div>
    </div>
    <div class="lf-side lf-sticky">
      <div class="card glow lf-game-hint"><span class="lf-kicker">${tr('Dans le jeu')}</span><h3>${tr('Liste ton raid sous le titre donné par GroupScout')}</h3><p class="lf-small lf-muted">${tr('Une fois l\'annonce publiée, sa page te donne un titre à mettre dans la recherche de groupe du jeu : les joueurs que tu acceptes le cherchent pour postuler.')}</p></div>
      <div class="card lf-preview"><span class="lf-kicker">${tr('Aperçu')}</span><div id="lfPreview"></div></div>
    </div>
  </form>`;
}

const lfGoalPick = (g) => ['reclear', 'progress'].map((v) => `<button type="button" class="lf-opt${g === v ? ' is-on' : ''}" aria-pressed="${g === v}" data-lf="d-goal" data-v="${v}"><b>${esc(LF_GOALS[v])}</b><span>${v === 'reclear' ? tr('Des boss déjà tombés, on les enchaîne.') : tr('On tente des boss pas encore tombés, des wipes à prévoir.')}</span></button>`).join('');
const lfModePick = (m) => [['preferred', tr('Préférées'), tr('Tout le monde peut postuler, ces classes sont mises en avant.')], ['required', tr('Obligatoires'), tr('Seules ces classes peuvent postuler, jusqu\'à leur nombre.')]]
  .map(([v, l, s]) => `<button type="button" class="lf-opt${m === v ? ' is-on' : ''}" aria-pressed="${m === v}" data-lf="d-mode" data-v="${v}"><b>${esc(l)}</b><span>${esc(s)}</span></button>`).join('');
const lfDiffPick = (id) => `<div class="segmented" role="radiogroup">${DIFFICULTIES.map((d) => `<button type="button" role="radio" aria-checked="${d.id === id}" data-lf="d-diff" data-v="${d.id}">${esc(d.label)}</button>`).join('')}</div>`;
function lfRolePick(role, act, only = null, counts = null) {
  return `<div class="lf-role-pick">${ROLES.filter((r) => !only || only.includes(r)).map((r) => {
    const full = counts && counts[r] <= 0;
    const extra = counts ? `<small>${full ? tr('complet') : esc(tr('{n, plural, one {# place} other {# places}}', { n: counts[r] }))}</small>` : '';
    return `<button type="button" class="lf-rp${role === r ? ' is-on' : ''}${full ? ' is-full' : ''}" aria-pressed="${role === r}" data-lf="${act}" data-v="${r}"${full ? ' disabled' : ''}>${lfRoleIcon(r)}${esc(LF_ROLE_LABEL[r])}${extra}</button>`;
  }).join('')}</div>`;
}
const lfLangPick = (langs) => LF_LANGS.map((l) => `<button type="button" class="lf-lp${langs.includes(l) ? ' is-on' : ''}" aria-pressed="${langs.includes(l)}" data-lf="d-lang" data-v="${l}">${lfFlag(l)}${esc(LF_LANG_NAMES[l])}</button>`).join('');
const lfCompPick = (c) => ROLES.map((r) => `<div class="lf-stepper"><span class="lf-st-l">${lfRoleIcon(r)}${esc(LF_ROLE_ROWS[r])}</span><span class="lf-st-n"><button type="button" data-lf="d-comp" data-r="${r}" data-v="-1" aria-label="${esc(tr('Une place de moins'))}">−</button><b>${c[r]}</b><button type="button" data-lf="d-comp" data-r="${r}" data-v="1" aria-label="${esc(tr('Une place de plus'))}">+</button></span></div>`).join('');
function lfClassPick(classes) {
  return LF_CLASSES.map((cls) => {
    const c = classes.find((x) => x.cls === cls);
    return `<div class="lf-cp${c ? ' is-on' : ''}" style="--cls:${CLASS_COLORS[cls]}">
      <button type="button" class="lf-cp-main" data-lf="d-class" data-v="${esc(cls)}" aria-pressed="${Boolean(c)}" title="${esc(lfClassName(cls))}"><span class="lf-cico" style="background-image:url('${classIcon(cls)}')"></span><span class="lf-cp-name">${esc(lfClassName(cls))}</span></button>
      ${c ? `<span class="lf-cp-n"><button type="button" data-lf="d-class-n" data-v="${esc(cls)}" data-d="-1" aria-label="${esc(tr('Un de moins'))}">−</button><b>${c.n}</b><button type="button" data-lf="d-class-n" data-v="${esc(cls)}" data-d="1" aria-label="${esc(tr('Un de plus'))}">+</button></span>` : ''}
    </div>`;
  }).join('');
}
function lfProgOptions(d) {
  const raid = lfRaidOf(d.raid);
  const n = raid?.bosses.length || 0;
  const letter = lfDiff(d.difficulty).letter;
  return [`<option value="0">${esc(tr('Aucune'))}</option>`, ...Array.from({ length: n }, (_, i) => `<option value="${i + 1}"${d.minProg === i + 1 ? ' selected' : ''}>${i + 1}/${n} ${letter}</option>`)].join('');
}

// Ce qui change dans le formulaire sans le réécrire (champs tapés gardés)
function lfRefreshForm() {
  const d = lfg.draft;
  if (!d || !$('#lfForm')) return;
  const raid = lfRaidOf(d.raid);
  const art = lfRaidArt(d.raid);
  const imgs = new Map((art?.bosses || []).map((b) => [norm(b.name), b.image]));
  setHtml($('#lfBossPick'), (raid?.bosses || []).map((name) => {
    const on = d.bosses.includes(name);
    return `<button type="button" class="lf-bp${on ? ' is-on' : ''}" aria-pressed="${on}" data-lf="d-boss" data-v="${esc(name)}"><span class="lf-boss" style="--pic:${lfArtUrl(imgs.get(norm(name)))}">${imgs.get(norm(name)) ? '' : esc(name.charAt(0))}</span><span>${esc(name)}</span></button>`;
  }).join(''));
  $('#lfBossCount').textContent = raid ? `· ${tr('{n} sur {total}', { n: d.bosses.length, total: raid.bosses.length })}` : '';
  setHtml($('#lfDiffPick'), lfDiffPick(d.difficulty));
  setHtml($('#lfGoal'), lfGoalPick(d.goal));
  setHtml($('#lfLangPick'), lfLangPick(d.langs));
  setHtml($('#lfComp'), lfCompPick(d.comp));
  const total = ROLES.reduce((s, r) => s + d.comp[r], 0);
  const cap = d.difficulty === 5 ? 20 : 30;
  const hint = $('#lfCompHint');
  hint.textContent = tr('{n} places. Un rôle complet ne prend plus de candidature.', { n: total }) + (total > cap ? ` ${tr('Un raid de cette difficulté compte {n} joueurs au plus.', { n: cap })}` : '');
  hint.classList.toggle('is-bad', total > cap);
  setHtml($('#lfClassMode'), lfModePick(d.classMode));
  setHtml($('#lfClsPick'), lfClassPick(d.classes));
  if ($('#lfRolePick')) setHtml($('#lfRolePick'), lfRolePick(d.role, 'd-role'));
  const prog = $('#lfProg');
  if (prog) { const html = lfProgOptions(d); if (prog.dataset.html !== html) { prog.innerHTML = html; prog.dataset.html = html; } }
  if ($('#lfWhen')) setHtml($('#lfWhen'), lfWhenPick(d, 'listing', { started: d.started }));
  const df = $('#lfDiscordField');
  if (df) df.hidden = !d.discordRequired;
  const r = lfRange(d.date, d.from, d.to);
  const wh = $('#lfWhenHint');
  if (wh) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    wh.textContent = r
      ? `${lfDay(r.startsAt)} ${lfClock(r.startsAt)} → ${lfClock(r.endsAt)}${lfDayStart(r.endsAt) !== lfDayStart(r.startsAt) ? ` (${tr('le lendemain')})` : ''} · ${tr('à ton heure ({tz}) : chaque joueur voit l\'heure de chez lui.', { tz })}`
      : tr('À ton heure : chaque joueur voit l\'heure de chez lui.');
  }
  const preview = $('#lfPreview');
  if (preview && r) {
    const char = lfg.chars?.find((c) => c.key === d.char);
    const x = {
      code: '', title: d.title.trim(), goal: d.goal, raid: d.raid, raidName: raid?.name || '', difficulty: d.difficulty, bosses: d.bosses,
      bossCount: raid?.bosses.length || 0, langs: d.langs, comp: d.comp, classes: d.classes, classMode: d.classMode,
      minIlvl: Number(d.minIlvl) || null, minProg: d.minProg || null, startsAt: r.startsAt, endsAt: r.endsAt, phase: 'open', discordRequired: d.discordRequired,
      filled: { tank: 0, heal: 0, dps: 0, ...(d.role ? { [d.role]: 1 } : {}) }, tags: 0,
      leader: char ? { char: { name: char.name, className: char.className, key: char.key } } : null, mine: { leader: true },
    };
    if (lfg.view === 'edit' && lfg.page) { x.filled = lfg.page.filled; x.leader = { char: lfg.page.tags.find((t) => t.leader)?.char }; }
    setHtml(preview, lfCard(x).replace('class="card lf-card', 'class="lf-card is-preview'));
  }
}

function lfEnhanceForm() {
  for (const s of $('#groups').querySelectorAll('select')) enhanceSelect(s);
  if (lfg.view === 'search') lfRefreshSearch(); else lfRefreshForm();
}

function lfReadForm() {
  const d = lfg.draft;
  const f = $('#lfForm');
  d.title = f.elements.title.value;
  d.description = f.elements.description.value;
  d.minIlvl = f.elements.minIlvl.value;
  d.minProg = Number(f.elements.minProg.value) || 0;
  d.discordRequired = f.elements.discordRequired.checked;
  d.discord = f.elements.discord.value;
  if (f.elements.char) d.char = f.elements.char.value;
  return d;
}

async function lfSubmitListing() {
  if (lfg.busy) return;
  const d = lfReadForm();
  const r = lfRange(d.date, d.from, d.to);
  if (!r) { toast(tr("Indique l'heure de début et de fin."), 'err'); return; }
  const body = {
    title: d.title.trim(), goal: d.goal, raid: d.raid, difficulty: d.difficulty, bosses: d.bosses, langs: d.langs,
    comp: d.comp, classes: d.classes, classMode: d.classMode, minIlvl: Number(d.minIlvl) || null, minProg: d.minProg || null,
    description: d.description, discordRequired: d.discordRequired, discord: d.discord.trim(), ...r,
  };
  const edit = lfg.view === 'edit';
  // Le raid a commencé : le début ne bouge plus
  if (edit && d.started) body.startsAt = lfg.page.startsAt;
  if (!edit) { body.char = d.char; body.role = d.role; }
  lfg.busy = true;
  const btn = $('#lfForm button[type="submit"]');
  btn?.classList.add('is-loading');
  try {
    const res = await api(edit ? `/api/groups/${lfg.code}/edit` : '/api/groups', { method: 'POST', body });
    lfg.page = res.listing;
    lfg.chat = res.listing.chat;
    toast(edit ? tr('Annonce enregistrée.') : tr('Annonce publiée.'));
    goTo(`/groups/${res.listing.code}`);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    lfg.busy = false;
    btn?.classList.remove('is-loading');
  }
}

/* ---------------- Formulaire « Je cherche un raid » ------------------ */
function lfSearchDraft(s) {
  const start = new Date();
  start.setHours(20, 0, 0, 0);
  if (start.getTime() < Date.now()) start.setTime(Math.ceil((Date.now() + 5 * 60e3) / 9e5) * 9e5);
  const langs = ['fr'];
  if (s) {
    const raid = lfRaidOf(s.raid);
    return { id: s.id, char: s.char.key, roles: [...s.roles], raid: s.raid || '', difficulties: [...s.difficulties], bosses: s.bosses?.length ? [...s.bosses] : [...(raid?.bosses || [])], date: lfDateValue(s.startsAt), from: lfTimeValue(s.startsAt), to: lfTimeValue(s.endsAt), langs: [...s.langs], note: s.note || '' };
  }
  // Fin : 23 h, ou une heure après le début s'il est tard
  const to = new Date(start);
  to.setHours(23, 0, 0, 0);
  if (to.getTime() - start.getTime() < 3600e3) to.setTime(start.getTime() + 3600e3);
  return { id: null, char: lfg.chars?.[0]?.key || '', roles: [], raid: '', difficulties: [4], bosses: [], date: lfDateValue(start), from: lfTimeValue(start), to: lfTimeValue(to), langs, note: '' };
}

function lfSearchPage() {
  const d = lfg.searchDraft;
  const gate = lfGate('post');
  const head = `<div class="lf-page-head"><div><span class="lf-kicker"><a href="/groups/players" data-lf-go="/groups/players">${LF_ICONS.back}${tr('Trouver un groupe')}</a></span>
    <h1>${tr('Je cherche un raid')}</h1><p>${tr('Les raid leaders voient ta recherche quand ton créneau et ton rôle correspondent à leur annonce, et peuvent te proposer une place.')}</p></div></div>`;
  if (gate) return `${head}<div class="card lf-empty">${lfGateHtml(gate)}</div>`;
  const charOpts = (lfg.chars || []).map((c) => `<option value="${esc(c.key)}"${c.key === d.char ? ' selected' : ''}>${esc(c.name)} · ${esc(lfClassName(c.className))} · ${esc(c.realm)}</option>`).join('');
  const raidOpts = [`<option value="">${esc(tr('Tous les raids du palier'))}</option>`, ...state.raids.map((r) => `<option value="${esc(r.slug)}"${r.slug === d.raid ? ' selected' : ''}>${esc(r.name)}</option>`)].join('');
  const s = lfg.mine?.search;
  return `${head}
  <form class="lf-form-grid" id="lfSearchForm" data-lf-form="search" novalidate>
    <div class="card lf-form">
      <div class="lf-fsec"><h2>${tr('Ton personnage')}</h2>
        <div class="lf-field"><label class="visually-hidden" for="lfSChar">${tr('Ton personnage')}</label><select id="lfSChar" name="char">${charOpts}</select></div>
        <div class="lf-field"><span class="lf-label">${tr('Rôles que tu peux jouer')} <span class="lf-dim">· ${tr('le premier choisi est ton rôle principal')}</span></span><div id="lfSRoles"></div></div>
      </div>
      <div class="lf-fsec"><h2>${tr('Quoi')}</h2>
        <div class="lf-row2">
          <div class="lf-field"><label for="lfSRaid">${tr('Raid')}</label><select id="lfSRaid" name="raid">${raidOpts}</select></div>
          <div class="lf-field"><span class="lf-label">${tr('Difficultés')}</span><div id="lfSDiffs"></div></div>
        </div>
        <div class="lf-field"><span class="lf-label">${tr('Boss recherchés')} <span class="lf-dim" id="lfSBossCount"></span></span><div class="lf-boss-pick" id="lfSBossPick"></div></div>
      </div>
      <div class="lf-fsec"><h2>${tr('Quand')}</h2>
        <div id="lfSWhen">${lfWhenPick(d, 'search', { fromLabel: tr('Disponible de'), toLabel: tr('à') })}</div></div>
      <div class="lf-fsec"><h2>${tr('Langues parlées')}</h2><div class="lf-lang-pick" id="lfSLangs"></div></div>
      <div class="lf-fsec"><h2>${tr('Un mot pour les leaders')}</h2>
        <div class="lf-field lf-count-wrap"><label class="visually-hidden" for="lfSNote">${tr('Un mot pour les leaders')}</label><textarea id="lfSNote" name="note" maxlength="200" rows="3" placeholder="${esc(tr('Progression sur ton main, micro, dispo…'))}">${esc(d.note)}</textarea><span class="lf-count" data-count-for="lfSNote">${d.note.length} / 200</span></div></div>
      <div class="lf-form-foot">${s ? `<button class="btn ghost" type="button" data-lf="search-close">${tr('Retirer ma recherche')}</button>` : `<a class="btn ghost" href="/groups/players" data-lf-go="/groups/players">${tr('Annuler')}</a>`}<button class="btn primary" type="submit">${s ? tr('Mettre à jour') : tr('Publier ma recherche')}</button></div>
    </div>
    <div class="lf-side lf-sticky">
      <div class="lf-info">${LF_ICONS.info}<span>${tr('Ta spé, ton équipement et ta progression partent avec ta recherche, tels que le jeu les connaît. Si tu progresses entre-temps, actualise-les.')}</span></div>
      ${s ? `<div class="card lf-mysearch"><span class="lf-kicker">${tr('Ta recherche en ligne')}</span><div class="lf-refresh"><span>${esc(tr('Infos envoyées à {t}', { t: s.snapshot?.at ? lfClock(s.snapshot.at) : '—' }))}</span><button class="btn glass small" type="button" data-lf="search-refresh">${LF_ICONS.refresh}${tr('Actualiser')}</button></div></div>` : ''}
      <div class="card lf-preview"><span class="lf-kicker">${tr('Ce que voient les leaders')}</span><div id="lfSPreview"></div></div>
    </div>
  </form>`;
}

function lfRefreshSearch() {
  const d = lfg.searchDraft;
  if (!d || !$('#lfSearchForm')) return;
  setHtml($('#lfSRoles'), `<div class="lf-role-pick">${ROLES.map((r) => { const i = d.roles.indexOf(r); return `<button type="button" class="lf-rp${i >= 0 ? ' is-on' : ''}" aria-pressed="${i >= 0}" data-lf="s-role" data-v="${r}">${lfRoleIcon(r)}${esc(LF_ROLE_LABEL[r])}${i === 0 && d.roles.length > 1 ? `<small>${tr('principal')}</small>` : ''}</button>`; }).join('')}</div>`);
  setHtml($('#lfSDiffs'), `<div class="lf-role-pick">${DIFFICULTIES.map((x) => `<button type="button" class="lf-rp${d.difficulties.includes(x.id) ? ' is-on' : ''}" aria-pressed="${d.difficulties.includes(x.id)}" data-lf="s-diff" data-v="${x.id}">${esc(x.label)}</button>`).join('')}</div>`);
  setHtml($('#lfSLangs'), lfLangPick(d.langs).replace(/data-lf="d-lang"/g, 'data-lf="s-lang"'));
  setHtml($('#lfSWhen'), lfWhenPick(d, 'search', { fromLabel: tr('Disponible de'), toLabel: tr('à') }));
  // Boss recherchés : seulement avec un raid choisi (tous cochés = n'importe lesquels)
  const raid = lfRaidOf(d.raid);
  const imgs = new Map((lfRaidArt(d.raid)?.bosses || []).map((b) => [norm(b.name), b.image]));
  setHtml($('#lfSBossPick'), raid
    ? raid.bosses.map((name) => {
      const on = d.bosses.includes(name);
      return `<button type="button" class="lf-bp${on ? ' is-on' : ''}" aria-pressed="${on}" data-lf="s-boss" data-v="${esc(name)}"><span class="lf-boss" style="--pic:${lfArtUrl(imgs.get(norm(name)))}">${imgs.get(norm(name)) ? '' : esc(name.charAt(0))}</span><span>${esc(name)}</span></button>`;
    }).join('')
    : `<p class="lf-hint">${tr('Choisis un raid pour cibler des boss.')}</p>`);
  $('#lfSBossCount').textContent = raid ? `· ${tr('{n} sur {total}', { n: d.bosses.length, total: raid.bosses.length })}` : '';
  const r = lfRange(d.date, d.from, d.to);
  const char = lfg.chars?.find((c) => c.key === d.char);
  const s = lfg.mine?.search;
  const preview = $('#lfSPreview');
  if (preview && char && r) {
    const fake = {
      id: 0, char: { key: char.key, name: char.name, realm: char.realm, className: char.className }, roles: d.roles.length ? d.roles : ['dps'],
      raid: d.raid, raidName: lfRaidOf(d.raid)?.name || '', difficulties: d.difficulties.length ? d.difficulties : [4], langs: d.langs,
      bosses: raid && d.bosses.length < raid.bosses.length ? d.bosses : [],
      note: $('#lfSNote')?.value || d.note, startsAt: r.startsAt, endsAt: r.endsAt,
      snapshot: s && s.char.key === char.key ? s.snapshot : {}, mine: false,
    };
    setHtml(preview, `<div class="lf-rows is-preview">${lfSearchRow(fake, null)}</div>`);
  }
}

async function lfSubmitSearch() {
  if (lfg.busy) return;
  const d = lfg.searchDraft;
  const f = $('#lfSearchForm');
  d.char = f.elements.char.value;
  d.raid = f.elements.raid.value;
  d.note = f.elements.note.value;
  const r = lfRange(d.date, d.from, d.to);
  if (!r) { toast(tr("Indique l'heure de début et de fin."), 'err'); return; }
  const raid = lfRaidOf(d.raid);
  if (raid && !d.bosses.length) { toast(tr('Choisis au moins un boss.'), 'err'); return; }
  lfg.busy = true;
  const btn = f.querySelector('button[type="submit"]');
  btn?.classList.add('is-loading');
  try {
    await api('/api/groups/searches', { method: 'POST', body: { char: d.char, roles: d.roles, raid: d.raid, difficulties: d.difficulties, bosses: raid ? d.bosses : [], langs: d.langs, note: d.note, ...r } });
    toast(tr('Ta recherche est en ligne.'));
    goTo('/groups/players');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    lfg.busy = false;
    btn?.classList.remove('is-loading');
  }
}

/* ---------------- Fenêtres (tag, note, départ, retrait, proposition) - */
function lfModal(title, body) {
  openModalWith(title, body);
  const m = $('#modal');
  (m.querySelector('.lf-modal [autofocus]') || m.querySelector('.lf-modal input, .lf-modal textarea, .lf-modal button'))?.focus();
}

function lfCounted(id, name, max, value = '', { required = false, placeholder = '', rows = 3 } = {}) {
  return `<div class="lf-field lf-count-wrap"><textarea id="${id}" name="${name}" maxlength="${max}" rows="${rows}"${required ? ' required' : ''} placeholder="${esc(placeholder)}">${esc(value)}</textarea><span class="lf-count" data-count-for="${id}">${value.length} / ${max}</span></div>`;
}

// Se taguer : depuis la liste (résumé de l'annonce) ou la page du raid
function lfOpenTag(x) {
  const gate = lfGate('tag');
  if (gate) { lfModal(tr('Postuler'), `<div class="lf-modal">${lfGateHtml(gate)}</div>`); return; }
  const free = Object.fromEntries(ROLES.map((r) => [r, Math.max(0, (x.comp?.[r] || 0) - (x.filled?.[r] || 0))]));
  const avail = ROLES.filter((r) => free[r] > 0);
  const chars = lfg.chars || [];
  const allowed = (c) => x.classMode !== 'required' || (x.classes || []).some((w) => w.cls === c.className);
  const first = chars.find((c) => c.key === lfg.as && allowed(c)) || chars.find(allowed);
  lfg.tagForm = { code: x.code, char: first?.key || '', role: avail.length === 1 ? avail[0] : '', free };
  lfModal(tr('Postuler'), `<form class="lf-modal" data-lfm-form="tag">
    <p class="lf-small lf-muted">${esc(lfTitle(x))} · ${lfWhen(x)}</p>
    <div class="lf-field"><span class="lf-label">${tr('Avec quel personnage')}</span><div class="lf-char-pick">${chars.map((c) => `<button type="button" class="lf-chp${c.key === lfg.tagForm.char ? ' is-on' : ''}" aria-pressed="${c.key === lfg.tagForm.char}" data-lfm="char" data-v="${esc(c.key)}"${allowed(c) ? '' : ` disabled title="${esc(tr('Classe non demandée'))}"`}>${specIconSpan(c.className, null, 'lf-ico-s')}<span><b class="lf-cname" style="--cls:${CLASS_COLORS[c.className] || 'var(--text)'}">${esc(c.name)}</b><small>${esc(lfClassName(c.className))} · ${esc(c.realm)}</small></span>${c.key === lfg.bnet?.main ? `<em>${tr('Main')}</em>` : ''}</button>`).join('')}</div></div>
    <div class="lf-field"><span class="lf-label">${tr('Rôle')}</span><div id="lfmRoles">${lfRolePick(lfg.tagForm.role, 'lfm-role', null, free).replace(/data-lf="lfm-role"/g, 'data-lfm="role"')}</div></div>
    <div class="lf-field"><label class="lf-label" for="lfmNote">${tr('Une note pour le leader')} <span class="lf-dim">· ${tr('facultatif')}</span></label>${lfCounted('lfmNote', 'note', 200, '', { placeholder: tr('Dispo, expérience du raid, spé de secours…') })}</div>
    <div class="lf-info">${LF_ICONS.info}<span>${tr('Ta candidature part avec ta spé, ton équipement et ta progression, tels que le jeu les connaît maintenant. Si tu progresses avant le raid, clique « Actualiser » dans ta candidature.')}</span></div>
    <div class="lf-modal-foot"><button class="btn ghost" type="button" data-action="modal-close">${tr('Annuler')}</button><button class="btn primary" type="submit">${tr('Postuler')}</button></div>
  </form>`);
}

function lfOpenMessage(kind, tag) {
  const x = lfg.page;
  const t = tag ? x.tags.find((y) => y.id === Number(tag)) : null;
  const title = kind === 'kick' ? tr('Retirer {name} du raid ?', { name: t?.char.name || '' }) : tr('Quitter le raid ?');
  const lead = kind === 'kick'
    ? tr('Ton message part avec le retrait, et s\'affiche aussi dans le chat du raid.')
    : tr('Ta place se libère. Le leader et le raid voient ton message.');
  lfg.msgForm = { kind, tag: t?.id || null };
  lfModal(title, `<form class="lf-modal" data-lfm-form="message">
    <p class="lf-small lf-muted">${esc(lead)}</p>
    <div class="lf-field"><label class="lf-label" for="lfmMsg">${tr('Ton message')} <span class="lf-req">· ${tr('obligatoire')}</span></label>${lfCounted('lfmMsg', 'message', 200, '', { required: true, placeholder: kind === 'kick' ? tr('Explique pourquoi…') : tr('Un mot pour le raid…') })}</div>
    <div class="lf-modal-foot"><button class="btn ghost" type="button" data-action="modal-close">${kind === 'kick' ? tr('Annuler') : tr('Rester')}</button><button class="btn primary danger" type="submit" disabled>${kind === 'kick' ? tr('Retirer du raid') : tr('Quitter le raid')}</button></div>
  </form>`);
}

function lfOpenNote() {
  const t = lfg.page?.me.tag;
  lfModal(tr('Ta note pour le leader'), `<form class="lf-modal" data-lfm-form="note">
    ${lfCounted('lfmNote', 'note', 200, lfg.page.tags.find((y) => y.id === t?.id)?.note || '', { placeholder: tr('Dispo, expérience du raid, spé de secours…') })}
    <div class="lf-modal-foot"><button class="btn ghost" type="button" data-action="modal-close">${tr('Annuler')}</button><button class="btn primary" type="submit">${tr('Enregistrer')}</button></div>
  </form>`);
}

function lfOpenOffer(searchId) {
  const s = (lfg.searches || []).find((y) => y.id === Number(searchId));
  const x = lfg.view === 'raid' ? lfg.page : null;
  const code = x?.code || lfg.mine?.listing?.code;
  if (!s || !code) return;
  const base = x || lfg.mine.listing;
  const free = Object.fromEntries(ROLES.map((r) => [r, Math.max(0, (base.comp?.[r] || 0) - (base.filled?.[r] || 0))]));
  const role = s.roles.find((r) => free[r] > 0) || '';
  lfg.offerForm = { code, search: s.id, role };
  lfModal(tr('Proposer une place à {name} ?', { name: s.char.name }), `<form class="lf-modal" data-lfm-form="offer">
    <p class="lf-small lf-muted">${tr("{name} cherche un raid sur ce créneau mais n'a pas postulé au tien. Ta proposition lui arrive, à accepter ou à refuser.", { name: esc(s.char.name) })}</p>
    <div class="lf-field"><span class="lf-label">${tr('Pour quel rôle')}</span><div id="lfmRoles">${lfRolePick(role, 'x', s.roles, free).replace(/data-lf="x"/g, 'data-lfm="role"')}</div></div>
    <div class="lf-field"><label class="lf-label" for="lfmNote">${tr('Un mot')} <span class="lf-dim">· ${tr('facultatif')}</span></label>${lfCounted('lfmNote', 'note', 200, '')}</div>
    <div class="lf-modal-foot"><button class="btn ghost" type="button" data-action="modal-close">${tr('Annuler')}</button><button class="btn primary" type="submit">${tr('Envoyer la proposition')}</button></div>
  </form>`);
}

// Action sur l'annonce affichée : la réponse (vue à jour) remplace la page tout de suite
async function lfAct(action, body = {}, { quiet = false } = {}) {
  const code = lfg.page?.code || lfg.code;
  try {
    const res = await api(`/api/groups/${code}/${action}`, { method: 'POST', body });
    if (res.listing) { lfg.page = res.listing; lfg.chat = res.listing.chat; renderRaidPage(); }
    return res;
  } catch (e) {
    if (!quiet) toast(e.message, 'err');
    return null;
  }
}

function bindGroups() {
  const root = $('#groups');
  // Liens internes (sans recharger la page)
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-lf-go]');
    if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    if (!$('#modal').hidden) closeModal();
    goTo(a.dataset.lfGo);
  });
  root.addEventListener('click', async (ev) => {
    const pk = ev.target.closest('[data-lf-pick]');
    if (pk) { if (!pk.disabled) lfOpenPick(pk); return; }
    const b = ev.target.closest('[data-lf]');
    if (!b || b.disabled) return;
    const act = b.dataset.lf;
    const v = b.dataset.v;
    const d = lfg.draft;
    const sd = lfg.searchDraft;
    switch (act) {
      // Filtres des listes
      case 'f-diff': lfg.filters.diff = Number(v) || 0; renderGroups(); return;
      case 'f-day': lfg.filters.day = v; renderGroups(); return;
      case 'f-lang': { const l = lfg.filters.langs; lfg.filters.langs = l.includes(v) ? l.filter((x) => x !== v) : [...l, v]; renderGroups(); return; }
      case 'f-fits': lfg.filters.fits = b.checked; renderGroups(); return;
      case 'apps-tab': lfg.appsTab = v; renderRaidPage(); return;
      // Formulaire d'une annonce
      case 'd-goal': d.goal = v; lfRefreshForm(); return;
      case 'd-mode': d.classMode = v; lfRefreshForm(); return;
      case 'd-diff': d.difficulty = Number(v); lfRefreshForm(); return;
      case 'd-role': d.role = v; lfRefreshForm(); return;
      case 'd-boss': d.bosses = d.bosses.includes(v) ? d.bosses.filter((x) => x !== v) : lfRaidOf(d.raid).bosses.filter((x) => x === v || d.bosses.includes(x)); lfRefreshForm(); return;
      case 'd-lang': d.langs = d.langs.includes(v) ? d.langs.filter((x) => x !== v) : [...d.langs, v]; lfRefreshForm(); return;
      case 'd-comp': { const r = b.dataset.r; d.comp[r] = Math.max(0, Math.min(30, d.comp[r] + Number(v))); lfRefreshForm(); return; }
      case 'd-class': d.classes = d.classes.some((c) => c.cls === v) ? d.classes.filter((c) => c.cls !== v) : [...d.classes, { cls: v, n: 1 }]; lfRefreshForm(); return;
      // En dessous de 1, la classe n'est plus recherchée
      case 'd-class-n': {
        const c = d.classes.find((x) => x.cls === v);
        if (c) c.n = Math.min(30, c.n + Number(b.dataset.d));
        if (c && c.n < 1) d.classes = d.classes.filter((x) => x.cls !== v);
        lfRefreshForm();
        return;
      }
      // Formulaire de recherche
      case 's-role': sd.roles = sd.roles.includes(v) ? sd.roles.filter((x) => x !== v) : [...sd.roles, v]; lfRefreshSearch(); return;
      case 's-diff': { const n = Number(v); sd.difficulties = sd.difficulties.includes(n) ? sd.difficulties.filter((x) => x !== n) : [...sd.difficulties, n].sort(); lfRefreshSearch(); return; }
      case 's-lang': sd.langs = sd.langs.includes(v) ? sd.langs.filter((x) => x !== v) : [...sd.langs, v]; lfRefreshSearch(); return;
      case 's-boss': sd.bosses = sd.bosses.includes(v) ? sd.bosses.filter((x) => x !== v) : lfRaidOf(sd.raid).bosses.filter((x) => x === v || sd.bosses.includes(x)); lfRefreshSearch(); return;
      case 'search-close':
        if (!(await askConfirm({ title: tr('Retirer ta recherche ?'), text: tr('Les raid leaders ne la verront plus.'), ok: tr('Retirer') }))) return;
        try { await api('/api/groups/searches/close', { method: 'POST', body: {} }); toast(tr('Recherche retirée.')); goTo('/groups/players'); } catch (e) { toast(e.message, 'err'); }
        return;
      case 'search-refresh':
        b.classList.add('is-loading');
        try { await api('/api/groups/searches/refresh', { method: 'POST', body: {} }); await lfLoadLists(); toast(tr('Infos actualisées.')); lfg.searchDraft = lfSearchDraft(lfg.mine?.search); $('#groups').innerHTML = ''; renderGroups(); } catch (e) { toast(e.message, 'err'); }
        b.classList.remove('is-loading');
        return;
      case 'offer-open': lfOpenOffer(b.dataset.id); return;
      case 'tag-open': {
        const x = lfg.view === 'raid' ? lfg.page : (lfg.listings || []).find((y) => y.code === b.dataset.code);
        if (x) lfOpenTag(x);
        return;
      }
      // Page du raid
      case 'copy-link': copyText(`${location.origin}/groups/${lfg.page.code}`).then(() => toast(tr('Lien copié.'))); return;
      case 'copy-title': copyText(`GroupScout: ${lfg.page.code}`).then(() => toast(tr('Titre copié.'))); return;
      case 'delete':
        if (!(await askConfirm({ title: tr("Supprimer l'annonce ?"), text: tr('Le raid disparaît pour tout le monde, chat compris. Les membres sont prévenus.'), ok: tr('Supprimer') }))) return;
        try { await api(`/api/groups/${lfg.page.code}/delete`, { method: 'POST', body: {} }); stopGroups(); toast(tr('Annonce supprimée.')); goTo('/groups'); } catch (e) { toast(e.message, 'err'); }
        return;
      case 'answer': {
        const yes = v === 'yes';
        if (await lfAct('answer', { accept: yes })) toast(yes ? tr('Bienvenue dans le raid !') : tr('Proposition refusée.'));
        return;
      }
      case 'withdraw':
        if (!(await askConfirm({ title: tr('Retirer ta candidature ?'), text: tr('Le leader ne verra plus ta candidature. Tu pourras postuler de nouveau.'), ok: tr('Retirer') }))) return;
        if (await lfAct('withdraw')) toast(tr('Candidature retirée.'));
        return;
      case 'refresh':
        b.classList.add('is-loading');
        if (await lfAct('refresh')) toast(tr('Infos actualisées.'));
        b.classList.remove('is-loading');
        return;
      case 'invite': b.disabled = true; if (await lfAct('invite', { tag: Number(b.dataset.tag) })) toast(tr('Place proposée.')); return;
      case 'decline': await lfAct('decline', { tag: Number(b.dataset.tag) }); return;
      case 'colead': await lfAct('colead', { tag: Number(b.dataset.tag), on: b.dataset.on === '1' }); return;
      case 'kick-open': lfOpenMessage('kick', b.dataset.tag); return;
      case 'leave-open': lfOpenMessage('leave'); return;
      case 'note-open': lfOpenNote(); return;
      case 'chat-delete': await lfAct('chat-delete', { id: Number(b.dataset.id) }); return;
      default:
    }
  });
  // Cases à cocher et listes : changement plutôt que clic
  root.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('[data-lf="f-fits"]')) { lfg.filters.fits = t.checked; renderGroups(); return; }
    if (t.matches('[data-lf-as]')) { lfg.as = t.value; renderGroups(); return; }
    if (t.id === 'lfRaid' && lfg.draft) {
      const raid = lfRaidOf(t.value);
      lfg.draft.raid = t.value;
      lfg.draft.bosses = raid ? [...raid.bosses] : [];
      lfg.draft.minProg = 0;
      lfRefreshForm();
      return;
    }
    if (t.closest('#lfForm')) { lfReadForm(); lfRefreshForm(); return; }
    if (t.closest('#lfSearchForm')) {
      const d = lfg.searchDraft;
      const f = $('#lfSearchForm');
      if (d.raid !== f.elements.raid.value) d.bosses = [...(lfRaidOf(f.elements.raid.value)?.bosses || [])];
      Object.assign(d, { char: f.elements.char.value, raid: f.elements.raid.value });
      lfRefreshSearch();
    }
  });
  root.addEventListener('input', (ev) => {
    const t = ev.target;
    const count = t.id && root.querySelector(`[data-count-for="${t.id}"]`);
    if (count) count.textContent = `${t.value.length} / ${t.maxLength}`;
    if (t.closest('#lfForm') && (t.id === 'lfTitle' || t.id === 'lfIlvl')) { lfReadForm(); lfRefreshForm(); }
  });
  root.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('form[data-lf-form]');
    if (!f) return;
    ev.preventDefault();
    const kind = f.dataset.lfForm;
    if (kind === 'listing') { lfSubmitListing(); return; }
    if (kind === 'search') { lfSubmitSearch(); return; }
    if (kind === 'chat') {
      const input = $('#lfChatText');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      lfg.chatScroll = true;
      const res = await lfAct('chat', { text });
      if (!res) { input.value = text; return; }
      if (res.message && lfg.chat && !lfg.chat.some((m) => m.id === res.message.id)) { lfg.chat.push(res.message); renderChat(); }
    }
  });

  // Fenêtres
  const modal = $('#modal');
  modal.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lfm]');
    if (!b || b.disabled) return;
    const v = b.dataset.v;
    if (b.dataset.lfm === 'char' && lfg.tagForm) {
      lfg.tagForm.char = v;
      for (const x of modal.querySelectorAll('[data-lfm="char"]')) { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
    }
    if (b.dataset.lfm === 'role') {
      const form = lfg.tagForm && modal.querySelector('[data-lfm-form="tag"]') ? lfg.tagForm : lfg.offerForm;
      if (form) form.role = v;
      for (const x of modal.querySelectorAll('[data-lfm="role"]')) { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
    }
  });
  modal.addEventListener('input', (ev) => {
    const t = ev.target;
    const count = t.id && modal.querySelector(`[data-count-for="${t.id}"]`);
    if (count) count.textContent = `${t.value.length} / ${t.maxLength}`;
    const f = t.closest('[data-lfm-form="message"]');
    if (f) f.querySelector('button[type="submit"]').disabled = !t.value.trim();
  });
  modal.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('form[data-lfm-form]');
    if (!f) return;
    ev.preventDefault();
    const kind = f.dataset.lfmForm;
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.classList.add('is-loading');
    const done = () => { btn.disabled = false; btn.classList.remove('is-loading'); };
    try {
      if (kind === 'tag') {
        const tf = lfg.tagForm;
        const res = await api(`/api/groups/${tf.code}/tag`, { method: 'POST', body: { char: tf.char, role: tf.role, note: f.elements.note.value } });
        closeModal();
        toast(tr('Candidature envoyée : le leader la voit.'));
        lfg.page = res.listing;
        lfg.chat = res.listing.chat;
        if (lfg.view === 'raid' && lfg.code === tf.code) renderRaidPage();
        else goTo(`/groups/${tf.code}`);
        return;
      }
      if (kind === 'note') {
        const res = await lfAct('note', { note: f.elements.note.value });
        if (res) { closeModal(); toast(tr('Note enregistrée.')); }
        else done();
        return;
      }
      if (kind === 'message') {
        const m = lfg.msgForm;
        const res = await lfAct(m.kind === 'kick' ? 'kick' : 'leave', m.kind === 'kick' ? { tag: m.tag, message: f.elements.message.value } : { message: f.elements.message.value });
        if (res) { closeModal(); toast(m.kind === 'kick' ? tr('Membre retiré du raid.') : tr('Tu as quitté le raid.')); }
        else done();
        return;
      }
      if (kind === 'offer') {
        const o = lfg.offerForm;
        const res = await api(`/api/groups/${o.code}/offer`, { method: 'POST', body: { search: o.search, role: o.role, note: f.elements.note.value } });
        closeModal();
        toast(tr('Proposition envoyée.'));
        if (lfg.view === 'raid') { lfg.page = res.listing; renderRaidPage(); } else { await lfLoadLists(); renderGroups(); }
      }
    } catch (e) {
      toast(e.message, 'err');
      done();
    }
  });
}
