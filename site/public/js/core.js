'use strict';
/* ================================================================== */
/* GroupScout — base du site : constantes, utilitaires, état, vues    */
/* ================================================================== */
// Les scripts du site se partagent leurs déclarations de premier niveau, chargés dans l'ordre
// d'index.html : core, nav, auth, player, groups, admin, home (qui démarre tout).

// Code commun avec le serveur (public/shared.js)
const { DIFFICULTIES, difficultyOf, norm } = GroupScoutShared;
// Pourcentage à la française : « 64 % »
const fmtPct = (n) => tr('{n} %', { n });

const CLASS_COLORS = {
  'Death Knight': '#C41E3A', 'Demon Hunter': '#A330C9', 'Druid': '#FF7C0A', 'Evoker': '#33937F',
  'Hunter': '#AAD372', 'Mage': '#3FC7EB', 'Monk': '#00FF98', 'Paladin': '#F48CBA',
  'Priest': '#FFFFFF', 'Rogue': '#FFF468', 'Shaman': '#2E8BEA', 'Warlock': '#8788EE', 'Warrior': '#C69B6D',
};

// Noms des classes (Blizzard les donne en anglais), en minuscules : ils se glissent dans une phrase
const CLASS_NAMES = {
  'Death Knight': 'chevalier de la mort', 'Demon Hunter': 'chasseur de démons', 'Druid': 'druide', 'Evoker': 'évocateur',
  'Hunter': 'chasseur', 'Mage': 'mage', 'Monk': 'moine', 'Paladin': 'paladin', 'Priest': 'prêtre', 'Rogue': 'voleur',
  'Shaman': 'chaman', 'Warlock': 'démoniste', 'Warrior': 'guerrier',
};

// Icônes de classe et de spé : celles de « Clean Icons - Mechagnome Edition » (AcidWeb), converties
// en PNG de 128 px dans public/icons/ sous leur nom du jeu (en minuscules). Mention dans les
// conditions d'utilisation.
// "Demon Hunter" -> classicon_demonhunter
const classIcon = (cls) => `/icons/classicon_${cls.toLowerCase().replace(/\s+/g, '')}.png`;
// Icône de chaque spé, par « Classe|Spé » en anglais comme les profils les nomment. Une spé absente
// d'ici garde l'icône de sa classe.
const SPEC_ICONS = {
  'Death Knight|Blood': 'spell_deathknight_bloodpresence', 'Death Knight|Frost': 'spell_deathknight_frostpresence', 'Death Knight|Unholy': 'spell_deathknight_unholypresence',
  'Demon Hunter|Havoc': 'ability_demonhunter_specdps', 'Demon Hunter|Vengeance': 'ability_demonhunter_spectank', 'Demon Hunter|Devourer': 'classicon_demonhunter_void',
  'Druid|Balance': 'spell_nature_starfall', 'Druid|Feral': 'ability_druid_catform', 'Druid|Guardian': 'ability_racial_bearform', 'Druid|Restoration': 'spell_nature_healingtouch',
  'Evoker|Devastation': 'classicon_evoker_devastation', 'Evoker|Preservation': 'classicon_evoker_preservation', 'Evoker|Augmentation': 'classicon_evoker_augmentation',
  'Hunter|Beast Mastery': 'ability_hunter_bestialdiscipline', 'Hunter|Marksmanship': 'ability_hunter_focusedaim', 'Hunter|Survival': 'ability_hunter_camouflage',
  'Mage|Arcane': 'spell_holy_magicalsentry', 'Mage|Fire': 'spell_fire_firebolt02', 'Mage|Frost': 'spell_frost_frostbolt02',
  'Monk|Brewmaster': 'spell_monk_brewmaster_spec', 'Monk|Mistweaver': 'spell_monk_mistweaver_spec', 'Monk|Windwalker': 'spell_monk_windwalker_spec',
  'Paladin|Holy': 'spell_holy_holybolt', 'Paladin|Protection': 'ability_paladin_shieldofthetemplar', 'Paladin|Retribution': 'spell_holy_auraoflight',
  'Priest|Discipline': 'spell_holy_powerwordshield', 'Priest|Holy': 'spell_holy_guardianspirit', 'Priest|Shadow': 'spell_shadow_shadowwordpain',
  'Rogue|Assassination': 'ability_rogue_deadlybrew', 'Rogue|Outlaw': 'ability_rogue_waylay', 'Rogue|Subtlety': 'ability_stealth',
  'Shaman|Elemental': 'spell_nature_lightning', 'Shaman|Enhancement': 'spell_shaman_improvedstormstrike', 'Shaman|Restoration': 'spell_nature_magicimmunity',
  'Warlock|Affliction': 'spell_shadow_deathcoil', 'Warlock|Demonology': 'spell_shadow_metamorphosis', 'Warlock|Destruction': 'spell_shadow_rainoffire',
  'Warrior|Arms': 'ability_warrior_savageblow', 'Warrior|Fury': 'ability_warrior_innerrage', 'Warrior|Protection': 'ability_warrior_defensivestance',
};
// Icône d'un objet ou d'une gemme : l'API Blizzard donne l'adresse de la sienne (…/icons/56/<nom>.jpg) ;
// le site sert la version Clean Icons du même nom (/api/icon/<nom>.png), et retombe sur celle de
// Blizzard s'il ne l'a pas
const itemIcon = (u) => {
  const m = String(u || '').match(/\/icons\/\d+\/([A-Za-z0-9_.-]{1,120})\.(?:jpg|png)$/);
  return m ? `/api/icon/${m[1].toLowerCase()}.png` : u;
};
// Recherche sans espaces ni casse : « Beast Mastery » et « BeastMastery » se valent
const specKey = (cls, spec) => `${cls}|${spec}`.toLowerCase().replace(/[^a-z|]/g, '');
const SPEC_ICON_KEYS = new Map(Object.entries(SPEC_ICONS).map(([k, v]) => [specKey(...k.split('|')), v]));
const specIcon = (cls, spec) => { const f = SPEC_ICON_KEYS.get(specKey(cls, spec)); return f ? `/icons/${f}.png` : null; };
// Icône de spé posée sur celle de la classe : si l'image de la spé ne charge pas, ou si la spé est
// inconnue, on voit l'icône de classe. Classe inconnue : rien.
function specIconSpan(cls, spec, className) {
  if (!cls || !CLASS_COLORS[cls]) return `<span class="${className}" aria-hidden="true"></span>`;
  const icons = [specIcon(cls, spec), classIcon(cls)].filter(Boolean).map((u) => `url('${u}')`).join(', ');
  return `<span class="${className}" style="background-image:${icons}" title="${esc([spec, cls].filter(Boolean).join(' '))}" aria-hidden="true"></span>`;
}

/* ================================================================== */
/* Utilitaires                                                         */
/* ================================================================== */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(ts) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return tr('il y a {n} min', { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) return tr('il y a {n} h', { n: Math.round(s / 3600) });
  const d = Math.round(s / 86400);
  if (d < 30) return tr('il y a {n} j', { n: d });
  return new Date(t).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short' });
}

function mmss(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtAmount(n) {
  if (n == null) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
  return String(Math.round(n));
}

const nf = (n, d = 0) => (Number.isFinite(n) ? n.toLocaleString(I18N.locale, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const fmtDay = (ts) => new Date(ts).toLocaleDateString(I18N.locale, { day: '2-digit', month: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' });

// Clé timée : une pilule avec une étoile par niveau gagné (+1, +2 ou +3), dont la couleur change
// avec ce nombre
function pips(n) {
  if (!n) return '';
  const k = Math.min(3, n);
  const label = tr('Timée +{k}', { k });
  const star = '<svg class="pip" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l2 4.3 4.7.6-3.4 3.3.8 4.7L8 11.8l-4.1 2.3.8-4.7L1.3 6.1 6 5.5z"/></svg>';
  return `<span class="pips pips-${k}" title="${label}" aria-label="${label}">${star.repeat(k)}</span>`;
}

// Le cookie de connexion part tout seul (même origine)
async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  // Refus de la mesure d'audience : le serveur ne compte pas non plus les actions
  if (window.GSStats?.optedOut()) headers['X-GS-NoStats'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || tr('Erreur {status}', { status: res.status })), { status: res.status });
  return j;
}

// Réécrit un bloc seulement si son contenu a changé : garde le défilement et le focus. Un bloc
// vidé à la main entre-temps (innerHTML = '') est réécrit même si le texte n'a pas changé.
function setHtml(el, html) {
  if (!el || (el.dataset.html === html && (html === '' || el.childNodes.length))) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

/* Ronds de chargement et reflet des badges calés sur une même horloge : un élément recréé (page
 * redessinée) reprend son animation là où l'ancien en était, au lieu de repartir de zéro. */
const SYNCED = [
  { sel: '.spinner', name: 'spin', ms: 800, delay: (el, v) => { el.style.animationDelay = v; } },
  { sel: '.vip-badge', name: 'vip-shine', ms: 4500, delay: (el, v) => { el.style.setProperty('--shine-delay', v); } },
];
function syncAnimation(el, { name, ms, delay }) {
  try {
    const anims = el.getAnimations ? el.getAnimations({ subtree: true }).filter((a) => a.animationName === name) : [];
    if (anims.length) for (const a of anims) a.startTime = 0;
    else delay(el, `-${Math.round(performance.now() % ms)}ms`);
  } catch { /* navigateur ancien : l'animation tourne sans calage */ }
}
new MutationObserver((records) => {
  for (const r of records) {
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      for (const kind of SYNCED) {
        if (n.matches(kind.sel)) syncAnimation(n, kind);
        for (const el of n.querySelectorAll(kind.sel)) syncAnimation(el, kind);
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

/* ---------------- Petits messages ------------------------------------ */
let toastTimer = null;
function toast(message, tone = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${tone ? ` ${tone}` : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http hors localhost : pas d'API presse-papiers, on passe par un champ caché
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    return ok;
  }
}

/* ================================================================== */
/* État                                                                */
/* ================================================================== */
// EU seulement pour l'instant
const REGION = 'eu';

const state = {
  status: null,          // /api/status : compte connecté, services configurés
  statusError: null,
  raids: [],             // raids du palier en cours ({ id, slug, name, short, bosses: [noms] })
  dungeons: [],          // donjons Mythique+ de la saison (fiche joueur)
  blizzUsage: null,      // admins : requêtes à l'API Blizzard cette heure (clé du site)
  player: null,          // fiche joueur affichée
};

const ROLES = ['tank', 'heal', 'dps'];
const ROLE_ORDER = { tank: 0, heal: 1, dps: 2 };
const ROLE_ICONS = {
  tank: {
    label: 'tank',
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.1 13.5 3c.3.1.5.4.5.7v3.6c0 3.4-2.3 6.1-5.6 7.5a1 1 0 0 1-.8 0C4.3 13.4 2 10.7 2 7.3V3.7c0-.3.2-.6.5-.7z"/><path fill="#000" fill-opacity=".28" d="M8 2.6v10.9c2.6-1.2 4.3-3.4 4.3-6.2V4.2z"/></svg>',
  },
  heal: {
    label: 'soigneur',
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.5 1.8h3a.7.7 0 0 1 .7.7v3.3h3.3a.7.7 0 0 1 .7.7v3a.7.7 0 0 1-.7.7h-3.3v3.3a.7.7 0 0 1-.7.7h-3a.7.7 0 0 1-.7-.7v-3.3H2.5a.7.7 0 0 1-.7-.7v-3a.7.7 0 0 1 .7-.7h3.3V2.5a.7.7 0 0 1 .7-.7z"/></svg>',
  },
  dps: {
    label: 'DPS',
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M14.9 1.1 14.3 4.9 7.7 11.5 4.5 8.3 11.1 1.7z"/><path fill="currentColor" d="M2.6 9 4 7.6 8.4 12 7 13.4z"/><path fill="currentColor" d="M4.6 10.2 5.8 11.4 3.2 14 2 12.8z"/><circle fill="currentColor" cx="2" cy="14" r="1.35"/></svg>',
  },
};
const ASSIST_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 13 3.7v3.8c0 3.1-2.1 5.6-5 6.7-2.9-1.1-5-3.6-5-6.7V3.7L8 1.8Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m5.7 8 1.6 1.6 3-3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const REFRESH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';

// Chercher un joueur, poster, postuler : un compte à l'adresse vérifiée
const canSearchHere = () => Boolean(state.status?.account?.canSearch);

/* ================================================================== */
/* Badges VIP et admin                                                 */
/* ================================================================== */
// Un badge à côté des personnages Battle.net des comptes VIP ou admin. Demandés par lots au serveur
// (POST /api/badges) pour les clés « eu:pseudo-serveur » affichées.
const badges = { vip: new Set(), admin: new Set(), asked: new Set(), pending: new Set(), timer: null };
function wantBadges(keys) {
  for (const k of keys) {
    if (!k || badges.asked.has(k)) continue;
    badges.asked.add(k);
    badges.pending.add(k);
  }
  if (!badges.pending.size) return;
  clearTimeout(badges.timer);
  badges.timer = setTimeout(flushBadges, 120);
}
async function flushBadges() {
  const keys = [...badges.pending].slice(0, 200);
  keys.forEach((k) => badges.pending.delete(k));
  try {
    const d = await api('/api/badges', { method: 'POST', body: { keys } });
    const vip = new Set(d.vip || []);
    const admin = new Set(d.admin || []);
    let changed = false;
    for (const k of keys) {
      if (vip.has(k) || admin.has(k)) changed = true;
      if (vip.has(k)) badges.vip.add(k); else badges.vip.delete(k);
      if (admin.has(k)) badges.admin.add(k); else badges.admin.delete(k);
    }
    if (changed) refreshBadgeViews();
  } catch { /* un badge est un bonus : rien d'affiché */ }
  if (badges.pending.size) badges.timer = setTimeout(flushBadges, 120);
}
function refreshBadgeViews() {
  if (currentView === 'player') renderPlayer();
  if (currentView === 'groups') renderGroups();
}
const VIP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 2.5h7.6L14.5 6 8 13.8 1.5 6z" fill="currentColor" fill-opacity=".28" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M1.5 6h13M6 2.5 8 6l2-3.5M8 6v7.8" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';
const ADMIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 13.4 3.6v4c0 3.2-2.3 5.6-5.4 6.8C4.9 13.2 2.6 10.8 2.6 7.6v-4z" fill="currentColor" fill-opacity=".28" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="m5.6 7.9 1.7 1.7 3.2-3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ADMIN_BADGE = (cls = '') => `<span class="vip-badge admin-badge${cls}" title="Admin de GroupScout">${ADMIN_ICON}<b>Admin</b></span>`;
function vipBadge(key) {
  wantBadges([key]);
  if (badges.admin.has(key)) return ADMIN_BADGE();
  return badges.vip.has(key) ? `<span class="vip-badge" title="Membre VIP de GroupScout">${VIP_ICON}<b>VIP</b></span>` : '';
}

/* ================================================================== */
/* Données de la saison                                                */
/* ================================================================== */
function loadRaids() {
  return (async () => {
    try {
      const d = await api(`/api/raids?region=${REGION}`);
      state.raids = d.raids || [];
    } catch { state.raids = []; }
    if (currentView === 'player') renderPlayer();
    if (currentView === 'groups') renderGroups();
  })();
}

async function loadDungeons() {
  try {
    const d = await api(`/api/dungeons?region=${REGION}`);
    state.dungeons = d.dungeons || [];
  } catch { state.dungeons = []; }
  if (currentView === 'player') renderPlayer();
}

// Images de la saison : raids du palier (fond de l'histoire du journal) et portrait de chacun de
// leurs boss, image de chaque donjon Mythique+ (/api/season/art)
let seasonArt = null;          // { raids: [{ name, slug, image, bosses: [{ id, name, image }] }], dungeons: [{ name, slug, image }] }
let seasonArtAsked = false;
function loadSeasonArt() {
  if (seasonArtAsked) return;
  seasonArtAsked = true;
  api(`/api/season/art?region=${REGION}`)
    .then((d) => { seasonArt = { raids: d.raids || [], dungeons: d.dungeons || [] }; })
    .catch(() => { seasonArt = { raids: [], dungeons: [] }; })
    .then(() => {
      if (currentView === 'player') renderPlayer();
      if (currentView === 'groups') renderGroups();
      if (currentView === 'home') renderHome();
    });
}

/* ================================================================== */
/* Statut du compte                                                    */
/* ================================================================== */
// Faux tant que /api/status n'a pas répondu : la barre ne dessine rien de lié au compte avant,
// sinon un visiteur connecté verrait d'abord « Créer un compte »
let statusKnown = false;
// Premier affichage : la page ET la barre apparaissent ensemble, une fois la première page prête
// (showView) et le compte connu (loadStatus)
let firstViewShown = false;
function endBoot() {
  if (firstViewShown && statusKnown) document.body.classList.remove('booting');
}

async function loadStatus() {
  try {
    state.status = await api('/api/status');
    state.statusError = null;
    state.blizzUsage = state.status.blizzard || null;
  } catch (e) {
    state.statusError = e.message;
  }
  statusKnown = true;
  renderAccountNav();
  syncNotifications();
  endBoot();
  renderImpersonation();
  renderAuthProviders();
  // Palette ouverte avant que le compte soit connu (/player au chargement) : les listes arrivent
  if (pal.open) palInput();
  // Page du compte dessinée avant le statut : le bloc Google / Discord en dépend
  if (currentView === 'account' && accountPayload) renderAccountPage(accountPayload);
  // Recherche de groupe ouverte avant le statut (ou compte changé) : personnages et listes du compte
  if (currentView === 'groups') lfOnStatus();
  if (currentView === 'home') loadHome();
  if (currentView === 'player') renderPlayer();
}

/* ================================================================== */
/* Vues et adresses                                                    */
/* ================================================================== */
let currentView = 'home';
const VIEWS = ['home', 'player', 'login', 'account', 'admin', 'legal', 'contact', 'groups'];

function showView(view) {
  closeNavMenu({ focus: false });
  closeNotifPanel({ focus: false });
  closePalette({ focus: false });
  firstViewShown = true;
  endBoot();
  const wanted = VIEWS.includes(view) ? view : 'home';
  // Une fenêtre ouverte n'a plus de sens ailleurs que sur la page qui l'a ouverte
  closeModal();
  const changed = wanted !== currentView;
  if (changed) document.title = 'GroupScout';
  currentView = wanted;
  for (const v of VIEWS) document.body.classList.toggle(`view-${v}`, currentView === v);
  if (currentView !== 'groups') stopGroups();
  for (const v of VIEWS) { const el = $(`#${v}`); if (el) el.hidden = currentView !== v; }
  // Seulement en changeant de vue : sinon un simple clic sur une ancre remonterait la page
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
  if (changed && currentView === 'home') loadHome();
  if (changed) verifyAskedIn = null;
  renderNavParts();
  askToVerify();
  scheduleFitNav();
}

// Adresse déjà traitée : un clic sur une ancre (#faq) ne doit pas rejouer la route
let routedPath = null;
const currentPath = () => location.pathname + location.search;

function route() {
  routedPath = currentPath();
  // Retour de Google, Discord ou Battle.net : le message part avec la page (erreur sur /login, bulle ailleurs)
  const oauthResult = takeOAuthResult();
  takeBnetResult();
  const path = location.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  if (oauthResult && path !== '/login') {
    const [texte, ton] = oauthText(oauthResult.code, oauthResult.provider);
    setTimeout(() => toast(texte, ton === 'err' ? 'err' : ''), 400);
  }
  if (path === '/login' || path === '/reset-password') {
    const p = new URLSearchParams(location.search);
    // Retour après connexion : seulement vers une page de la recherche de groupe ou une fiche
    const back = p.get('back') || '';
    authView.back = /^\/groups(\/[A-Za-z]{3,7}(\/edit)?)?$/.test(back) || /^\/player\/[^/?#]+\/[^/?#]+$/.test(back) ? back : null;
    authView.note = '';
    if (oauthResult && path === '/login') {
      if (oauthResult.code === 'exists') showPendingLink();
      else if (oauthResult.code === 'bnet-new') showBnetPending();
      else {
        const [texte, ton] = oauthText(oauthResult.code, oauthResult.provider);
        openAuth('login', ton === 'err' ? { error: texte } : { message: texte });
      }
      return;
    }
    if (path === '/reset-password') openAuth('reset', { token: p.get('token') || '' });
    else if (p.get('verified')) openAuth('login', { message: 'Adresse confirmée. Connecte-toi.' });
    else if (p.get('error')) openAuth('login', { error: 'Ce lien de confirmation est invalide ou a expiré.' });
    else openAuth(p.get('signup') ? 'register' : 'login');
    return;
  }
  if (LEGAL_PAGES[path]) { openLegal(LEGAL_PAGES[path]); return; }
  if (path === '/account') { openAccountPage(); return; }
  if (path === '/contact') { openContact(); return; }
  if (path === '/admin') { openAdminPage(); return; }
  // Recherche de groupe : /groups, /groups/players, /groups/new, /groups/search, /groups/<CODE>[/edit]
  const lm = location.pathname.match(/^\/groups(?:\/([A-Za-z]+)(?:\/(edit))?)?\/?$/i);
  if (lm) { openGroups(lm[1] || '', lm[2] || ''); return; }
  // Fiche joueur : /player/<Nom>/<Serveur> ; /player seul ouvre la recherche par-dessus l'accueil
  const pm = location.pathname.match(/^\/player(?:\/([^/]+)\/([^/]+))?\/?$/i);
  if (pm) {
    if (!pm[1]) {
      history.replaceState({}, '', '/');
      routedPath = currentPath();
      showView('home');
      openPalette();
      return;
    }
    showView('player');
    openPlayer(decodeURIComponent(pm[1]), decodeURIComponent(pm[2]), REGION);
    return;
  }
  if (path !== '/') { history.replaceState({}, '', '/'); routedPath = currentPath(); }
  showView('home');
}

// Navigation interne, sans recharger la page
function goTo(path) {
  if (currentPath() + location.hash !== path) history.pushState({}, '', path);
  route();
}

/* ================================================================== */
/* Fenêtre (modale) et confirmations                                   */
/* ================================================================== */
let modalOpener = null;

function openModalWith(title, body) {
  const m = $('#modal');
  if (!m.hidden) closeModal();
  modalOpener = document.activeElement;
  $('#modalTitle').textContent = title;
  setHtml($('#modalBody'), body);
  m.hidden = false;
  document.body.classList.add('has-modal');
}

// Confirmation avant une action qui ne se rattrape pas : jamais d'alert() ni de confirm() du
// navigateur. Renvoie une promesse : true si l'action est confirmée, false si on annule ou ferme.
let confirmResolve = null;
function askConfirm({ title, text = '', ok = 'Confirmer', danger = true }) {
  return new Promise((resolve) => {
    openModalWith(title, `${text ? `<p class="modal-text">${esc(text)}</p>` : ''}
      <div class="modal-actions">
        <button class="btn primary${danger ? ' danger' : ''}" type="button" data-confirm="oui">${esc(ok)}</button>
        <button class="linkish" type="button" data-confirm="non">Annuler</button>
      </div>`);
    confirmResolve = resolve;
    // Le focus sur « Annuler » : une touche Entrée de trop ne doit rien supprimer
    $('#modal [data-confirm="non"]').focus();
  });
}

function closeModal() {
  const m = $('#modal');
  if (!m || m.hidden) return;
  // Fermée par la croix, le fond ou Échap pendant une confirmation : c'est un « non »
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
  m.hidden = true;
  setHtml($('#modalBody'), '');
  document.body.classList.remove('has-modal');
  // Le focus revient sur le bouton qui a ouvert la fenêtre
  modalOpener?.focus?.();
  modalOpener = null;
}

function bindModal() {
  const m = $('#modal');
  m.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-action="modal-close"]')) { closeModal(); return; }
    const b = ev.target.closest('[data-confirm]');
    if (!b || !confirmResolve) return;
    const resolve = confirmResolve;
    confirmResolve = null;
    closeModal();
    resolve(b.dataset.confirm === 'oui');
  });
  // Échap ferme, et Tab tourne en rond dans la fenêtre
  document.addEventListener('keydown', (ev) => {
    if (m.hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); closeModal(); return; }
    if (ev.key !== 'Tab') return;
    const focusables = [...m.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent);
    if (!focusables.length) return;
    const premier = focusables[0];
    const dernier = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === premier) { ev.preventDefault(); dernier.focus(); }
    else if (!ev.shiftKey && document.activeElement === dernier) { ev.preventDefault(); premier.focus(); }
  });
}

/* ================================================================== */
/* Barre du haut : elle ne passe jamais à la ligne                     */
/* ================================================================== */
// On retire le superflu par paliers jusqu'à ce que tout rentre (style.css : écarts, pseudo, pages
// dans ☰, bouton d'action, logo). C'est mesuré et non fixé par des media queries : la largeur
// d'un pseudo est inconnue à l'avance.
const FIT_STEPS = 5;

// Un élément passe le bord droit de la barre, ou un bloc intérieur en flex comprimé déborde sur
// son voisin (les éléments volontairement coupés, avec ellipsis, sont exclus)
function navOverflows(nav) {
  const right = nav.getBoundingClientRect().right - (parseFloat(getComputedStyle(nav).paddingRight) || 0) + 0.5;
  for (const el of nav.querySelectorAll('*')) {
    if (!el.offsetWidth) continue;
    if (el.getBoundingClientRect().right > right) return true;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible') return true;
  }
  return false;
}

let fitPending = false;
function fitNav() {
  fitPending = false;
  const nav = $('.nav');
  if (!nav) return;
  for (let i = 1; i <= FIT_STEPS; i++) nav.classList.remove(`fit-${i}`);
  for (let i = 1; i <= FIT_STEPS && navOverflows(nav); i++) nav.classList.add(`fit-${i}`);
  // Les pages rentrent de nouveau dans la barre : le menu ☰ n'a plus de bouton
  if (navMenu.open && navMenu.mode === 'pages' && !nav.classList.contains('fit-3')) closeNavMenu({ focus: false });
}
function scheduleFitNav() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(fitNav);
}
function watchNavWidth() {
  const nav = $('.nav');
  new ResizeObserver(scheduleFitNav).observe(nav);
  new MutationObserver(scheduleFitNav).observe(nav, { childList: true, subtree: true, characterData: true });
  if (document.fonts) document.fonts.ready.then(scheduleFitNav);
  // requestAnimationFrame ne tourne pas dans un onglet caché : on rattrape au retour
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fitNav(); });
  fitNav();
}

/* ================================================================== */
/* Outils admin en local                                               */
/* ================================================================== */
// Petit module repliable en bas à gauche : se connecter en tant qu'un autre compte, et ne pas
// charger depuis le cache. Visible seulement si la page est ouverte sur localhost ET que le compte
// est admin (ou un admin « connecté en tant que »). Le module n'ouvre aucun droit : le serveur
// vérifie toujours l'admin.
const DEV_HOST = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const DEV_KEYS = { open: 'groupscout.dev.open', accounts: 'groupscout.dev.accounts', nocache: 'groupscout.dev.nocache' };
const DEV_STATUS = { normal: 'normal', vip: 'VIP', admin: 'admin' };
const dev = { query: '', accounts: null, loading: false, fetched: false, busy: false, error: '' };
function devRead(key, store = 'local') {
  try { return window[`${store}Storage`].getItem(key); } catch { return null; }
}
function devWrite(key, value, store = 'local') {
  try {
    const s = window[`${store}Storage`];
    if (value == null) s.removeItem(key); else s.setItem(key, value);
  } catch { /* stockage indisponible : le réglage ne survit pas au rechargement */ }
}
function devActive() {
  const st = state.status;
  return DEV_HOST && Boolean(st?.account?.admin || st?.impersonatedBy);
}
const devOpen = () => devRead(DEV_KEYS.open) === '1';
// « Sans cache » : chaque fiche joueur redemande tout (?fresh=1, que le serveur n'accepte que d'un admin)
const devNoCache = () => devActive() && devRead(DEV_KEYS.nocache) === '1';

// Liste des comptes : lue sur le serveur tant qu'on est admin, gardée pour l'onglet
// (sessionStorage) parce qu'un compte visité n'a pas le droit de la relire
function devAccounts() {
  if (!dev.accounts) {
    try { dev.accounts = JSON.parse(devRead(DEV_KEYS.accounts, 'session') || 'null'); } catch { dev.accounts = null; }
  }
  return dev.accounts;
}
async function loadDevAccounts() {
  if (dev.loading || state.status?.impersonatedBy || !state.status?.account?.admin) return;
  dev.loading = true;
  dev.fetched = true;
  renderDevAccounts();
  try {
    const d = await api('/api/admin/accounts');
    dev.accounts = d.accounts.map((a) => ({ id: a.id, name: a.name, email: a.email, status: a.status }));
    devWrite(DEV_KEYS.accounts, JSON.stringify(dev.accounts), 'session');
    dev.error = '';
  } catch (e) { dev.error = e.message; }
  dev.loading = false;
  renderDevAccounts();
}

const DEV_ICON = '<svg class="dev-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 13.5 4v3.6c0 3.2-2.3 5.6-5.5 6.6-3.2-1-5.5-3.4-5.5-6.6V4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m5.6 8 1.7 1.7 3.2-3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DEV_CHEVRON = '<svg class="dev-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 10 3.5-3.5 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderDevDock() {
  const el = $('#devDock');
  if (!el) return;
  const on = devActive();
  document.body.classList.toggle('dev-dock-on', on);
  el.hidden = !on;
  if (!on) return setHtml(el, '');
  const me = state.status.account;
  const by = state.status.impersonatedBy;
  const open = devOpen();
  setHtml(el, `
    <div class="dev-panel" id="devPanel" ${open ? '' : 'hidden'}>
      <div class="dev-head">
        <span class="dev-title">Outils admin</span>
        <span class="dev-tag">localhost</span>
      </div>
      <div class="dev-sec">
        <div class="dev-label">Compte</div>
        <div class="dev-me${by ? ' imp' : ''}">
          <span class="dev-dot" aria-hidden="true"></span>
          <span class="dev-me-name"><b>${esc(me?.name || '?')}</b><small>${esc(DEV_STATUS[me?.status] || me?.status || '')}${by ? ` · vu en tant que, depuis ${esc(by.name)}` : ''}</small></span>
          ${by ? '<button type="button" class="dev-back" data-dev="back">Revenir</button>' : ''}
        </div>
        <input type="search" id="devQuery" class="dev-query" placeholder="Se connecter en tant que…" autocomplete="off" spellcheck="false" aria-label="Chercher un compte">
        <div id="devAccounts" class="dev-accounts" role="list"></div>
      </div>
      <div class="dev-sec">
        <div class="dev-label">Requêtes</div>
        <label class="toggle dev-toggle">
          <input type="checkbox" data-dev-nocache${devNoCache() ? ' checked' : ''}>
          <span>Ne pas charger depuis le cache<small>Profils, équipement et talents redemandés à Blizzard à chaque fiche.</small></span>
        </label>
      </div>
    </div>
    <button type="button" class="dev-pill${by ? ' imp' : ''}" data-dev="toggle" aria-expanded="${open}" aria-controls="devPanel" title="${open ? 'Replier les outils admin' : 'Outils admin'}">
      ${DEV_ICON}<span class="dev-pill-label">Admin</span>
      ${by ? `<span class="dev-dot" aria-hidden="true"></span><span class="dev-pill-who">${esc(me?.name || '?')}</span>` : ''}
      ${devNoCache() ? '<span class="dev-pill-lang" title="Sans cache">∅</span>' : ''}
      ${DEV_CHEVRON}
    </button>`);
  const q = $('#devQuery', el);
  if (q && q.value !== dev.query) q.value = dev.query;
  renderDevAccounts();
  if (open && !dev.fetched) loadDevAccounts();
}

function renderDevAccounts() {
  const box = $('#devAccounts');
  if (!box) return;
  const me = state.status?.account;
  const by = state.status?.impersonatedBy;
  const list = devAccounts();
  if (!list) {
    return setHtml(box, `<p class="dev-empty">${by ? 'Reviens sur ton compte pour afficher la liste.'
      : dev.error ? esc(dev.error) : 'Chargement…'}</p>`);
  }
  const words = dev.query.split(/\s+/).map(norm).filter(Boolean);
  const hits = list.filter((a) => {
    const hay = norm(`${a.name} ${a.email} ${a.status}`);
    return words.every((w) => hay.includes(w));
  });
  if (!hits.length) return setHtml(box, '<p class="dev-empty">Aucun compte ne correspond.</p>');
  const adminId = by ? by.id : me?.id;
  setHtml(box, hits.slice(0, 50).map((a) => {
    const current = a.id === me?.id;
    const tag = current ? 'actif' : a.id === adminId ? 'toi' : DEV_STATUS[a.status] || a.status;
    return `<button type="button" role="listitem" class="dev-acc${current ? ' current' : ''}" data-dev-account="${a.id}" ${current || dev.busy ? 'disabled' : ''}>
      <span class="dev-acc-name"><b>${esc(a.name)}</b><small>${esc(a.email)}</small></span>
      <span class="dev-acc-tag st-${esc(a.status)}">${esc(tag)}</span>
    </button>`;
  }).join('') + (hits.length > 50 ? `<p class="dev-empty">${hits.length - 50} de plus : précise la recherche.</p>` : ''));
}

// Changer de compte : retour sur le compte admin d'abord si on en visite déjà un, puis la page se
// recharge telle quelle avec les droits du compte choisi
async function devSwitch(id) {
  if (dev.busy) return;
  const by = state.status?.impersonatedBy;
  const adminId = by ? by.id : state.status?.account?.id;
  dev.busy = true;
  renderDevAccounts();
  try {
    if (by) await api('/api/auth/unimpersonate', { method: 'POST' });
    if (id !== adminId) await api('/api/admin/impersonate', { method: 'POST', body: { id } });
    location.reload();
  } catch (e) {
    dev.busy = false;
    toast(e.message, 'err');
    await loadStatus();
  }
}

function setDevOpen(open, { focus = false } = {}) {
  devWrite(DEV_KEYS.open, open ? '1' : null);
  renderDevDock();
  if (open) {
    loadDevAccounts();
    if (focus) $('#devQuery')?.focus();
  } else if (focus) $('#devDock .dev-pill')?.focus();
}

function bindDevDock() {
  const el = $('#devDock');
  if (!el || !DEV_HOST) return;
  el.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-dev], [data-dev-account]');
    if (!t || t.disabled) return;
    if (t.dataset.dev === 'toggle') setDevOpen(!devOpen(), { focus: true });
    else if (t.dataset.dev === 'back') devSwitch(state.status.impersonatedBy.id);
    else if (t.dataset.devAccount) devSwitch(Number(t.dataset.devAccount));
  });
  el.addEventListener('change', (ev) => {
    if (!ev.target.matches('[data-dev-nocache]')) return;
    devWrite(DEV_KEYS.nocache, ev.target.checked ? '1' : null);
    renderDevDock();
    $('#devDock [data-dev-nocache]')?.focus();
  });
  el.addEventListener('input', (ev) => {
    if (ev.target.id !== 'devQuery') return;
    dev.query = ev.target.value;
    renderDevAccounts();
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && devOpen()) { ev.preventDefault(); ev.stopPropagation(); setDevOpen(false, { focus: true }); }
    // Entrée dans la recherche : le premier compte proposé
    if (ev.key === 'Enter' && ev.target.id === 'devQuery') {
      ev.preventDefault();
      $('#devAccounts .dev-acc:not([disabled])')?.click();
    }
  });
}
