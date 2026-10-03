'use strict';
/* ================================================================== */
/* Fiche joueur : /player/<Nom>/<Serveur>                              */
/* ================================================================== */
// Tout vient de l'API Blizzard (par le serveur) : en-tête (spé, ilvl, cote Mythique+, main),
// progression dans les raids du palier, donjons Mythique+ de la saison, équipement et talents.
// Plus aucune note ni aucun log : la fiche montre le joueur tel que le jeu le connaît.
let playerRequest = 0;

/* ---------------- Historique des recherches et favoris ------------- */
/* ---------------- Historique des recherches ----------------------- */
// Demande de l'utilisateur : sur /player sans joueur, les derniers joueurs consultés, chacun avec
// une croix pour le retirer. Gardé dans ce navigateur (une commodité, rien de partagé), un
// historique par compte pour qu'un autre compte sur le même ordinateur ne voie pas le tien.
// Seules les fiches trouvées y entrent ; 12 au plus, la plus récente d'abord.
const RECENT_MAX = 12;
const FAV_MAX = 30;
const recentId = (x) => `${x.region}:${norm(x.name)}-${norm(x.realm)}`;
// Une liste de joueurs dans localStorage, par compte : `recent` (historique) ou `favs` (favoris)
const playerListKey = (kind) => `groupscout.${kind}.v1.${state.status?.account?.id || 'anon'}`;
function readPlayerList(kind) {
  try {
    const list = JSON.parse(localStorage.getItem(playerListKey(kind)) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && x.name && x.realm && x.region) : [];
  } catch { return []; }
}
function writePlayerList(kind, list, max) {
  try { localStorage.setItem(playerListKey(kind), JSON.stringify(list.slice(0, max))); } catch { /* stockage bloqué : rien de gardé */ }
}
const readRecent = () => readPlayerList('recent');
const writeRecent = (list) => writePlayerList('recent', list, RECENT_MAX);
const playerEntry = (pl) => {
  const r = pl.p.rio.data || {};
  return { name: r.name || pl.name, realm: r.realm || pl.realm, region: pl.region, cls: r.class || null, spec: r.spec || null, at: Date.now() };
};
function rememberPlayer(pl) {
  const entry = playerEntry(pl);
  writeRecent([entry, ...readRecent().filter((x) => recentId(x) !== recentId(entry))]);
  // Favori déjà enregistré : sa classe et sa spé suivent (spé changée, ou favori d'avant l'icône
  // de spé), sans changer sa place ni sa date d'ajout
  const id = recentId(entry);
  const favs = readFavs();
  const fav = favs.find((x) => recentId(x) === id);
  if (fav && (fav.cls !== entry.cls || fav.spec !== entry.spec)) {
    writePlayerList('favs', favs.map((x) => (x === fav ? { ...x, cls: entry.cls, spec: entry.spec } : x)), FAV_MAX);
  }
}
const forgetPlayer = (id) => writeRecent(readRecent().filter((x) => recentId(x) !== id));

// Favoris (demande de l'utilisateur) : même stockage, dans l'ordre où on les ajoute.
// Une étoile sur la fiche du joueur et sur chaque ligne de l'historique ; en cartes sur /player.
const readFavs = () => readPlayerList('favs');
const isFav = (id) => readFavs().some((x) => recentId(x) === id);
function toggleFav(entry) {
  const id = recentId(entry);
  const favs = readFavs();
  const on = favs.some((x) => recentId(x) === id);
  writePlayerList('favs', on ? favs.filter((x) => recentId(x) !== id) : [...favs, { ...entry, at: Date.now() }], FAV_MAX);
  return !on;
}
const STAR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.2-3 4.3-.5z" stroke-linejoin="round"/></svg>';
// Étoile d'ajout / de retrait. `data-fav` porte le joueur, pour pouvoir l'ajouter depuis n'importe où.
function favButton(entry, cls = 'fav-star') {
  const on = isFav(recentId(entry));
  const label = on ? tr('Retirer {name} des favoris', { name: entry.name }) : tr('Ajouter {name} aux favoris', { name: entry.name });
  const data = { name: entry.name, realm: entry.realm, region: entry.region, cls: entry.cls || null, spec: entry.spec || null };
  return `<button class="${cls}${on ? ' on' : ''}" type="button" data-fav="${esc(JSON.stringify(data))}" data-fav-id="${esc(recentId(entry))}" data-track="favoris › ${on ? 'retirer' : 'ajouter'}" aria-pressed="${on}" title="${on ? tr('Retirer des favoris') : tr('Ajouter aux favoris')}" aria-label="${esc(label)}">${STAR_ICON}</button>`;
}

// Profil d'un joueur : { state: 'ok' | 'missing' | 'error', data?, error? }. Gardé 20 min dans la
// page : revenir sur une fiche ne redemande rien.
const profilePages = new Map();
const PROFILE_PAGE_TTL = 20 * 60e3;
async function loadPlayerProfile({ region, name, realm, fresh = false }) {
  fresh = fresh || devNoCache();
  const id = `${region}:${norm(name)}-${norm(realm)}`;
  const kept = profilePages.get(id);
  if (!fresh && kept && Date.now() - kept.at < PROFILE_PAGE_TTL) return kept.value;
  const q = { region, name, realm, ...(fresh ? { fresh: '1' } : {}) };
  const { profile, main } = await api(`/api/player?${new URLSearchParams(q)}`);
  if (profile?.error) return { state: 'error', error: GroupScoutShared.PROFILE_ERRORS[profile.error] || GroupScoutShared.PROFILE_ERRORS.down };
  if (!profile?.found) return { state: 'missing', error: GroupScoutShared.PROFILE_MISSING, at: Date.now() };
  const { found: _found, ...data } = profile;
  const value = { state: 'ok', data: { ...data, main }, at: Date.now() };
  profilePages.set(id, { value, at: Date.now() });
  return value;
}

// Ce qui empêche de chercher un joueur : pas connecté, ou adresse pas confirmée
function playerSearchGate() {
  if (canSearchHere()) return null;
  const a = state.status?.account;
  if (!a) return { text: 'Connecte-toi pour chercher un joueur.', label: 'Se connecter', href: '/login' };
  return { text: 'Confirme ton adresse e-mail pour chercher un joueur.', label: 'Voir mon compte', href: '/account' };
}

async function openPlayer(name, realm, region = REGION) {
  const id = ++playerRequest;
  state.player = {
    name, realm, region, error: null,
    p: { key: `${region}:${norm(name)}-${norm(realm)}`, name, realm, region, rio: { state: 'loading' } },
  };
  document.title = `${name}-${realm} · GroupScout`;
  renderPlayer();
  const pl = state.player;
  // Compte pas encore connu : la fiche est demandée quand il l'est (loadStatus redessine)
  if (!statusKnown) await new Promise((resolve) => { const t = setInterval(() => { if (statusKnown) { clearInterval(t); resolve(); } }, 50); });
  if (id !== playerRequest) return;
  const gate = playerSearchGate();
  if (gate) { pl.p.rio = { state: 'gate' }; renderPlayer(); return; }
  try {
    const rio = await loadPlayerProfile({ region, name, realm });
    if (id !== playerRequest) return;
    pl.p.rio = rio;
    if (rio.state === 'ok') rememberPlayer(pl);
    else if (rio.state === 'error') pl.error = rio.error;
  } catch (e) {
    if (id !== playerRequest) return;
    pl.error = e.status === 401 ? "Connecte-toi pour consulter la fiche d'un joueur." : e.message;
    pl.p.rio = { state: 'error', error: e.message };
  }
  renderPlayer();
}

// Main du joueur : choisi sur GroupScout par le propriétaire du personnage (Battle.net lié)
function mainOf(p) {
  const m = p.rio.data?.main;
  return m?.name ? m : null;
}
// Fiche du joueur sur GroupScout
const playerPath = (name, realm, region = 'eu') => `/player/${encodeURIComponent(name)}/${encodeURIComponent(realm)}${region && region !== 'eu' ? `?region=${region}` : ''}`;
function mainPath(p) {
  const m = mainOf(p);
  return m?.name && m.realm ? playerPath(m.name, m.realm, m.region || p.region) : null;
}

/* ------------------------------------------------------------------ */
/* Progression : raids du palier et donjons Mythique+                  */
/* ------------------------------------------------------------------ */
// Sous l'en-tête, sur toute la largeur : les raids du palier côte à côte, chacun en frise avec un
// portrait par boss (journal des rencontres du jeu), les boss tués dans la plus haute difficulté
// faite en pleine lumière, et sous chacun ses kills dans les deux plus hautes difficultés du
// joueur dans ce raid. Dessous, les donjons Mythique+ de la saison en vignettes (image du donjon,
// meilleure clé, info-bulle de la clé).
const RAID_KILL_DIFFS = [
  { k: 'l', letter: 'LFR', label: 'Outil Raids' },
  { k: 'n', letter: 'NM', label: 'Normal' },
  { k: 'h', letter: 'HM', label: 'Héroïque' },
  { k: 'm', letter: 'MM', label: 'Mythique' },
];

// Meilleure clé de chaque donjon de la saison : la plus haute timée (puis le plus de paliers),
// et la plus haute hors temps si elle est au-dessus
function mplusByDungeon(p) {
  const r = p.rio.data;
  const runs = [...r.bestRuns, ...r.alternateRuns, ...r.highestRuns, ...r.recentRuns];
  const dungeons = state.dungeons.length
    ? state.dungeons.map((d) => ({ name: d.name, short: d.short, mapId: d.mapId }))
    : [...new Map(runs.map((x) => [norm(x.dungeon), { name: x.dungeon, mapId: x.mapId }])).values()];
  return dungeons.map((d) => {
    const mine = runs.filter((x) => (d.mapId && x.mapId === d.mapId) || norm(x.dungeon) === norm(d.name));
    const timed = mine.filter((x) => x.timed).sort((a, b) => b.level - a.level || (b.upgrades || 0) - (a.upgrades || 0))[0] || null;
    const over = mine.filter((x) => !x.timed && x.level > (timed?.level || 0)).sort((a, b) => b.level - a.level)[0] || null;
    return { name: d.name, short: d.short || null, timed, over, mine, level: Math.max(timed?.level || 0, over?.level || 0) };
  }).sort((a, b) => (b.timed?.level || 0) - (a.timed?.level || 0) || b.level - a.level);
}

// Slug d'un nom de donjon ou de raid, comme celui du serveur (apostrophes retirées, tirets)
const slugOf = (s) => GroupScoutShared.slugify(s);

function mplusProgressCard(p) {
  const r = p.rio.data;
  const rows = mplusByDungeon(p);
  const timedCount = rows.filter((x) => x.timed).length;
  const best = rows.reduce((m, x) => Math.max(m, x.timed?.level || 0), 0);
  const tiles = rows.map((x) => {
    const run = x.timed || x.over;
    const image = seasonArt?.dungeons.find((d) => d.slug === slugOf(x.name) || norm(d.name) === norm(x.name))?.image;
    // Le niveau en haut à gauche ; à droite, sur un fond sombre, les étoiles de la clé timée (ou « Hors temps »)
    const lvl = !run ? '<b class="dtile-lvl">—</b>'
      : x.timed ? `<b class="dtile-lvl">+${x.timed.level}</b>`
        : `<b class="dtile-lvl depleted">+${x.over.level}</b>`;
    const badge = !run ? ''
      : x.timed ? `<span class="dtile-badge">${pips(x.timed.upgrades)}</span>`
        : '<span class="dtile-badge dtile-over">Hors temps</span>';
    // Survol ou focus : l'info-bulle de la clé (cote, date, durée, groupe, autres clés du donjon)
    let tip = ` title="${esc(x.name)}"`;
    if (run) {
      const id = `prog|${p.key}|${norm(x.name)}`;
      const seen = new Set([`${run.level}|${run.completedAt}`]);
      const others = x.mine.filter((o) => {
        const k = `${o.level}|${o.completedAt}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).sort((a, b) => b.level - a.level || Date.parse(b.completedAt) - Date.parse(a.completedAt));
      runTips.set(id, { run, others, self: r.name });
      tip = ` data-run-tip="${esc(id)}" tabindex="0" aria-label="${esc(`${x.name} +${run.level}`)}"`;
    }
    const tier = x.timed ? ` up-${Math.min(3, x.timed.upgrades || 1)}` : '';
    return `<li class="dtile${!run ? ' is-none' : x.timed ? tier : ' is-over'}"${tip}${image ? ` style="--img:url('${esc(image)}')"` : ''}>
      <span class="dtile-key">${lvl}${badge}</span>
      <span class="dtile-name">${esc(x.short || x.name)}</span>
    </li>`;
  }).join('');
  const color = r.scoreColor || 'var(--violet)';
  return `<section class="prog-card prog-mplus" aria-labelledby="progMplusTitle">
    <div class="prog-head">
      <h3 id="progMplusTitle">Mythique+</h3>
      <span class="prog-sub">${rows.length ? tr('{n}/{total} donjons timés', { n: timedCount, total: rows.length }) : 'Aucune clé cette saison'}</span>
      ${best ? `<span class="pm-score" style="--sc:${esc(color)}"><small>Meilleure clé timée</small><b>+${best}</b></span>` : ''}
    </div>
    ${rows.length ? `<ul class="dtile-grid">${tiles}</ul>` : ''}
  </section>`;
}

// Un raid du palier : ses boss dans l'ordre (journal du jeu, sinon la liste du site), et les kills
// du profil, reconnus par l'identifiant de la rencontre (ou le nom, faute d'identifiant)
function raidTimeline(raid, rp) {
  const art = (seasonArt?.raids || []).find((x) => x.slug === raid.slug || norm(x.name) === norm(raid.name));
  const known = rp?.bosses || [];
  const list = art?.bosses?.length ? art.bosses : (raid.bosses || []).map((name) => ({ id: null, name, image: null }));
  const bosses = list.map((b) => {
    const k = known.find((x) => (b.id && x.id === b.id) || norm(x.name) === norm(b.name));
    return { ...b, kills: k || { l: 0, n: 0, h: 0, m: 0 }, at: k?.at || null };
  });
  const did = (b, d) => b.kills[d.k] > 0;
  const topAt = RAID_KILL_DIFFS.reduce((t, d, i) => (bosses.some((b) => did(b, d)) ? i : t), -1);
  const shown = topAt < 0 ? [] : RAID_KILL_DIFFS.slice(Math.max(0, topAt - 1), topAt + 1);
  const topDiff = RAID_KILL_DIFFS[topAt] || null;
  const downTop = topDiff ? bosses.filter((b) => did(b, topDiff)).length : 0;
  const nodes = bosses.map((b, i) => {
    const onTop = topDiff && did(b, topDiff);
    const onLower = !onTop && RAID_KILL_DIFFS.some((d) => did(b, d));
    const st = onTop ? 'is-down' : onLower ? 'is-lower' : 'is-up';
    const kills = shown.map((d) => `<span class="rb-kill d-${d.k}${did(b, d) ? '' : ' is-zero'}"><i>${d.letter}</i>${b.kills[d.k] || 0}</span>`).join('');
    const killText = (d) => (b.kills[d.k] ? tr('{n, plural, one {# kill} other {# kills}}', { n: b.kills[d.k] }) : 'pas encore tué');
    const tip = [b.name, ...shown.map((d) => `${d.label} : ${killText(d)}`),
      b.at ? tr('Dernier kill {ago}', { ago: timeAgo(b.at) }) : ''].filter(Boolean).join('\n');
    return `<li class="rb ${st}" style="--i:${i}" title="${esc(tip)}">
      <span class="rb-pic"${b.image ? ` style="--pic:url('${esc(b.image)}')"` : ''}>${b.image ? '' : `<span>${esc((b.name || '?').replace(/^the\s+/i, '').charAt(0))}</span>`}</span>
      <span class="rb-name">${esc(b.name)}</span>
      ${kills ? `<span class="rb-kills">${kills}</span>` : ''}
    </li>`;
  }).join('');
  const summary = topDiff ? `${downTop}/${bosses.length} ${topDiff.letter}` : `0/${bosses.length}`;
  return `<div class="raid-line${topDiff ? ` top-${topDiff.k}` : ''}"${art?.image ? ` style="--tile:url('${esc(art.image)}')"` : ''}>
    <div class="rl-head">
      <h4>${esc(raid.name)}</h4>
      <span class="rl-sum">${summary}</span>
    </div>
    <ol class="rl-bosses" style="--n:${Math.max(1, bosses.length)}">${nodes}</ol>
  </div>`;
}

function raidProgressCard(p) {
  const r = p.rio.data;
  // Les raids côte à côte sur toute la largeur, le principal (le plus de boss) à gauche ; chacun
  // prend une part de la largeur selon son nombre de boss, avec un minimum pour son titre
  const raids = [...state.raids].sort((a, b) => (b.bosses?.length || 0) - (a.bosses?.length || 0));
  if (!raids.length) return '<section class="prog-raid"><div class="raid-line"><p class="note">Raids du palier indisponibles pour le moment.</p></div></section>';
  const cols = raids.map((x) => {
    const n = Math.max(1, x.bosses?.length || 1);
    return `minmax(${Math.max(300, n * 72)}px, ${Math.max(2, n)}fr)`;
  }).join(' ');
  return `<section class="prog-raid" aria-label="Raid" style="--raid-cols:${cols}">
    ${raids.map((raid) => raidTimeline(raid, r.raidProgress?.[raid.slug] || null)).join('')}
  </section>`;
}

function progressSection(p) {
  loadSeasonArt();
  return `<div class="player-prog">${raidProgressCard(p)}${mplusProgressCard(p)}</div>`;
}

// Rôle et spé joués sur une clé : pastille dans l'info-bulle des vignettes
const RUN_ROLE = { tank: 'tank', healer: 'heal', dps: 'dps' };
/* Info-bulle d'une clé des vignettes Mythique+ : tout ce que la vignette ne montre pas, tiré du profil du jeu déjà chargé (aucune requête de plus) : cote du
 * donjon (Blizzard donne la même à toutes les clés d'un donjon : celle du donjon, pas de la clé), date, durée et temps à battre, spé jouée, composition du groupe avec le niveau d'objet de
 * chacun à ce moment-là, et les autres clés connues dans ce donjon. Dessinée dans l'info-bulle de
 * l'équipement (showGearTip). runTips : « joueur|donjon » -> { run, others, self } */
const runTips = new Map();
const PIP_COLORS = { 1: '#4a9eff', 2: '#b46cf0', 3: '#ff9a2e' };
const runStatus = (x) => (x.timed ? tr('Timée +{k}', { k: Math.min(3, x.upgrades || 1) }) : tr('Hors temps'));
function runTipHtml({ run, others, self }) {
  const t = run.completedAt ? Date.parse(run.completedAt) : null;
  const q = run.timed ? PIP_COLORS[Math.min(3, run.upgrades || 1)] : 'var(--depleted)';
  const pair = (a, b) => `<div class="gt-pair"><span class="gt-dim">${esc(a)}</span><span>${b}</span></div>`;
  const pairs = [];
  if (run.score != null) pairs.push(pair(tr('Cote du donjon'), `<b>${esc(Math.round(run.score))}</b>`));
  if (run.clearMs) pairs.push(pair(tr('Durée'), esc(mmss(run.clearMs))));
  if (run.parMs) pairs.push(pair(tr('Temps à battre'), esc(mmss(run.parMs))));
  const role = ROLE_ICONS[RUN_ROLE[run.role]];
  if (run.spec) pairs.push(pair(tr('Jouée en'), esc(role ? `${run.spec} (${role.label})` : run.spec)));
  const blocks = [];
  if (pairs.length) blocks.push(`<div class="gt-block">${pairs.join('')}</div>`);
  const members = [...(run.members || [])].sort((a, b) => (ROLE_ORDER[RUN_ROLE[a.role]] ?? 3) - (ROLE_ORDER[RUN_ROLE[b.role]] ?? 3));
  if (members.length) {
    blocks.push(`<div class="gt-block"><div class="rt-h">${tr('Groupe')}</div>${members.map((m) => {
      const color = CLASS_COLORS[m.className];
      const me = self && norm(m.name) === norm(self);
      return `<div class="rt-mem${me ? ' is-self' : ''}">${specIconSpan(m.className, m.spec, 'rt-ico')}<span class="rt-name"${color ? ` style="color:${color}"` : ''}>${esc(m.name)}</span><span class="rt-spec">${esc(m.spec || '')}</span><span class="rt-ilvl">${m.ilvl ? esc(Math.round(m.ilvl)) : ''}</span></div>`;
    }).join('')}</div>`);
  }
  if (others.length) {
    blocks.push(`<div class="gt-block"><div class="rt-h">${tr('Autres clés dans ce donjon')}</div>${others.slice(0, 3).map((x) => `<div class="rt-other">
      <span class="lvl${x.timed ? '' : ' depleted'}">+${esc(x.level)}</span><span>${esc(runStatus(x))}</span>
      <span class="gt-dim">${esc(timeAgo(x.completedAt))}</span></div>`).join('')}</div>`);
  }
  return `<div class="gtip rtip" style="--q:${q}">
    <div class="gt-head"><div class="gt-titles">
      <div class="gt-name">+${esc(run.level)} ${esc(run.dungeon || '')}</div>
      <div class="gt-slot">${esc([runStatus(run), t ? `${fmtDate(t)} (${timeAgo(t)})` : ''].filter(Boolean).join(' · '))}</div>
    </div></div>
    <div class="gt-body">${blocks.join('')}</div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Équipement et talents                                               */
/* ------------------------------------------------------------------ */
// Bloc « Équipement » de la fiche joueur : une grille façon feuille de personnage (deux colonnes et
// les armes) et une info-bulle façon jeu par objet. Chargé à la demande (API Blizzard, par le
// serveur) ; le bloc ouvert ou fermé est gardé pour ce navigateur.
const GEAR_OPEN_KEY = 'groupscout.gear.v1';
const GEAR_PAGE_TTL = 10 * 60e3;
const gearPages = new Map();     // id -> { state: 'loading' | 'ok' | 'missing' | 'error', data, error, at }
const gearTargets = new Map();   // id -> { id, url } (pour charger depuis un clic ou un survol)
const GEAR_LEFT = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'SHIRT', 'TABARD', 'WRIST'];
const GEAR_RIGHT = ['HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2'];
const GEAR_WEAPONS = ['MAIN_HAND', 'OFF_HAND'];
// Emplacements enchantables en Midnight (vérifié sur de vrais personnages) ; la main gauche aussi
// si c'est une arme
const ENCHANT_SLOTS = new Set(['HEAD', 'SHOULDER', 'CHEST', 'LEGS', 'FEET', 'FINGER_1', 'FINGER_2', 'MAIN_HAND']);
const COSMETIC_SLOTS = new Set(['SHIRT', 'TABARD']);
const SLOT_LABELS = {
  HEAD: tr('Tête'), NECK: tr('Cou'), SHOULDER: tr('Épaules'), BACK: tr('Dos'), CHEST: tr('Torse'), SHIRT: tr('Chemise'),
  TABARD: tr('Tabard'), WRIST: tr('Poignets'), HANDS: tr('Mains'), WAIST: tr('Taille'), LEGS: tr('Jambes'), FEET: tr('Pieds'),
  FINGER_1: tr('Doigt'), FINGER_2: tr('Doigt'), TRINKET_1: tr('Bijou'), TRINKET_2: tr('Bijou'), MAIN_HAND: tr('Main droite'), OFF_HAND: tr('Main gauche'),
};
const GEAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2.8 4.5 5.6v5.6c0 4.6 3.1 8.5 7.5 10 4.4-1.5 7.5-5.4 7.5-10V5.6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 7v9M8.5 10.5h7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const GEAR_CHEVRON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function gearOpen() {
  try { return localStorage.getItem(GEAR_OPEN_KEY) === '1'; } catch { return false; }
}
function setGearOpen(on) {
  try { localStorage.setItem(GEAR_OPEN_KEY, on ? '1' : '0'); } catch { /* navigateur sans stockage */ }
}

const playerGearTarget = (pl) => {
  const q = new URLSearchParams({ region: pl.region, name: pl.name, realm: pl.realm });
  const t = { id: `p:${pl.p.key}`, url: `/api/player/gear?${q}`, turl: `/api/player/talents?${q}` };
  gearTargets.set(t.id, t);
  return t;
};

async function loadGear(t, force = false) {
  const kept = gearPages.get(t.id);
  if (kept?.state === 'loading' || kept?.refreshing) return;
  const fresh = force || devNoCache();
  if (!fresh && kept && Date.now() - kept.at < GEAR_PAGE_TTL) return;
  // Équipement déjà affiché (bouton « Actualiser ») : il reste à l'écran pendant la relecture
  gearPages.set(t.id, kept?.state === 'ok' ? { ...kept, refreshing: true } : { state: 'loading', at: Date.now() });
  refreshGearViews(t.id);
  let value;
  try {
    const { gear } = await api(t.url + (fresh ? '&fresh=1' : ''));
    if (gear?.error) value = { state: 'error', error: GroupScoutShared.PROFILE_ERRORS[gear.error] || GroupScoutShared.PROFILE_ERRORS.down };
    else if (!gear?.found) value = { state: 'missing' };
    else value = { state: 'ok', data: gear };
  } catch (e) {
    value = { state: 'error', error: e.message };
  }
  gearPages.set(t.id, { ...value, at: Date.now() });
  refreshGearViews(t.id);
}

// Redessine ce qui montre cet équipement : la fiche joueur
function refreshGearViews() {
  if (currentView === 'player') renderPlayerGear();
}

// Un objet à palier d'amélioration prend la couleur du palier au lieu de celle de sa qualité
// (bordure, nom, info-bulle : demande de l'utilisateur)
const upClass = (it) => (it.upgrade ? ` has-up up-${esc(it.upgrade.track)}` : '');
const gearItem = (it, slot) => it.items.find((x) => x.slot === slot) || null;
const needsEnchant = (it) => ENCHANT_SLOTS.has(it.slot) || (it.slot === 'OFF_HAND' && Boolean(it.weapon));

// Ce qui se lit d'un coup d'œil : ilvl moyen (arme à deux mains comptée deux fois, comme en jeu),
// pièces d'ensemble, enchantements et châsses
function gearSummary(d) {
  const worn = d.items.filter((x) => !COSMETIC_SLOTS.has(x.slot) && Number.isFinite(x.level));
  const main = gearItem(d, 'MAIN_HAND');
  const levels = worn.map((x) => x.level);
  if (main && !gearItem(d, 'OFF_HAND') && Number.isFinite(main.level)) levels.push(main.level);
  const ilvl = levels.length ? levels.reduce((a, b) => a + b, 0) / Math.max(16, levels.length) : null;
  const sets = new Map();
  for (const x of d.items) if (x.set?.name) sets.set(x.set.name, x.set);
  const set = [...sets.values()].map((s) => ({ name: s.name, on: s.items.filter((i) => i.on).length, total: s.items.length }))
    .sort((a, b) => b.on - a.on)[0] || null;
  const enchantable = d.items.filter(needsEnchant);
  const enchanted = enchantable.filter((x) => x.enchants.some((e) => !e.temp));
  const sockets = d.items.flatMap((x) => x.sockets);
  return {
    ilvl, set,
    enchants: { done: enchanted.length, total: enchantable.length, missing: enchantable.filter((x) => !enchanted.includes(x)) },
    gems: { done: sockets.filter((s) => s.gem).length, total: sockets.length },
  };
}

function gearChips(d) {
  const s = gearSummary(d);
  const chip = (cls, label, value, title = '') => `<span class="gchip${cls}"${title ? ` title="${esc(title)}"` : ''}><small>${label}</small><b>${value}</b></span>`;
  const missing = s.enchants.missing.map((x) => x.slotName || SLOT_LABELS[x.slot]).join(', ');
  return [
    s.ilvl ? chip(' is-ilvl', 'ilvl', nf(s.ilvl, 1), tr('Niveau d\'objet moyen équipé')) : '',
    s.set && s.set.on >= 2 ? chip(' is-set', tr('Ensemble'), `${s.set.on}/${s.set.total}`, s.set.name) : '',
    s.enchants.total ? chip(s.enchants.done < s.enchants.total ? ' is-warn' : ' is-ok', tr('Enchant.'), `${s.enchants.done}/${s.enchants.total}`,
      missing ? tr('Sans enchantement : {slots}', { slots: missing }) : tr('Tout est enchanté')) : '',
    s.gems.total ? chip(s.gems.done < s.gems.total ? ' is-warn' : ' is-ok', tr('Châsses'), `${s.gems.done}/${s.gems.total}`,
      s.gems.done < s.gems.total ? tr('{n, plural, one {# châsse vide} other {# châsses vides}}', { n: s.gems.total - s.gems.done }) : tr('Toutes les châsses sont remplies')) : '',
  ].join('');
}

// Rang d'un enchantement (qualité d'artisanat) : un petit losange argent, puis or
const enchantRank = (rank) => (rank ? `<i class="erank erank-${Math.min(3, rank)}" title="${esc(tr('Qualité {n}', { n: rank }))}" aria-hidden="true"></i>` : '');

function gearSlot(t, d, slot, side) {
  const it = gearItem(d, slot);
  if (!it) {
    return `<div class="gslot is-empty ${side}"><span class="gslot-ico"></span><span class="gslot-text"><span class="gslot-name">${SLOT_LABELS[slot]}</span><span class="gslot-sub">${tr('Vide')}</span></span></div>`;
  }
  const idx = d.items.indexOf(it);
  const cosmetic = COSMETIC_SLOTS.has(slot);
  // Sous le nom : un losange si l'objet est enchanté (le détail est dans l'info-bulle), un losange
  // rouge vide s'il devrait l'être, puis le palier d'amélioration (« Mythe 6/6 ») plutôt que la
  // provenance (demande de l'utilisateur), « Craft » pour un objet d'artisanat ; sinon le type d'objet
  const ench = it.enchants.find((e) => !e.temp);
  let sub = '';
  if (ench) sub = `<i class="gslot-dia erank erank-${Math.min(3, ench.rank || 0)}" aria-label="${esc(tr('Enchanté'))}"></i>`;
  else if (needsEnchant(it)) sub = `<i class="gslot-dia is-miss" aria-label="${esc(tr('Sans enchantement'))}"></i>`;
  if (it.crafted) sub += `<span class="gslot-track is-craft">${tr('Craft')}</span>`;
  else if (it.upgrade) sub += `<span class="gslot-track up-${esc(it.upgrade.track)}">${esc(`${it.upgrade.name} ${it.upgrade.rank}/${it.upgrade.max}`)}</span>`;
  else if (it.subclass || it.type) sub += `<span class="gslot-track">${esc(it.subclass || it.type)}</span>`;
  const gems = it.sockets.map((g) => (g.gem
    ? `<span class="gslot-gem"${g.icon ? ` style="background-image:url('${esc(itemIcon(g.icon))}')"` : ''}></span>`
    : `<span class="gslot-gem is-empty" title="${esc(tr('Châsse vide'))}"></span>`)).join('');
  const label = `${it.name}${cosmetic ? '' : `, ${tr('niveau d\'objet {n}', { n: it.level })}`}`;
  // Secondaires que donne l'objet, pour le surligner au survol de la barre de la stat
  const secs = [...new Set(it.stats.filter((s) => !s.off).map((s) => ITEM_STAT_TYPES[s.type]).filter(Boolean))].join(' ');
  const up = it.upgrade ? ` up-${esc(it.upgrade.track)}` : '';
  return `<button type="button" class="gslot q-${esc(it.quality)}${upClass(it)} ${side}${cosmetic ? ' is-cosmetic' : ''}" data-gear-item="${esc(t.id)}|${idx}"${secs ? ` data-gstats="${secs}"` : ''} aria-label="${esc(label)}">
    <span class="gslot-ico"${it.icon ? ` style="background-image:url('${esc(itemIcon(it.icon))}')"` : ''}>${cosmetic || !it.level ? '' : `<b class="gslot-ilvl${up}">${it.level}</b>`}</span>
    <span class="gslot-text"><span class="gslot-name">${esc(it.name)}</span><span class="gslot-sub">${sub}${gems ? `<span class="gslot-gems">${gems}</span>` : ''}</span></span>
  </button>`;
}

// Statistiques du personnage : principale, endurance, points de vie, puis les quatre secondaires
// en barres (à l'échelle de la plus haute, pour voir la répartition d'un coup). Les secondaires
// sont en valeur brute (points), le pourcentage en info-bulle (demande de l'utilisateur) ; faute
// de points pour toutes, repli sur les pourcentages, pour ne jamais mélanger les deux échelles.
const PRIMARY_LABELS = { str: tr('Force'), agi: tr('Agilité'), int: tr('Intelligence') };
// Type d'une stat d'objet chez Blizzard → barre de la feuille de personnage
const ITEM_STAT_TYPES = { CRIT_RATING: 'crit', HASTE_RATING: 'haste', MASTERY_RATING: 'mastery', VERSATILITY: 'vers' };
function gearStats(st) {
  if (!st) return '';
  const all = [
    ['crit', tr('Critique'), st.crit, st.critRating],
    ['haste', tr('Hâte'), st.haste, st.hasteRating],
    ['mastery', tr('Maîtrise'), st.mastery, st.masteryRating],
    ['vers', tr('Polyvalence'), st.vers, st.versRating],
  ].filter((x) => Number.isFinite(x[2]) || Number.isFinite(x[3]));
  const raw = all.length && all.every((x) => Number.isFinite(x[3]));
  const secs = all
    .filter((x) => raw || Number.isFinite(x[2]))
    .map(([id, label, pct, rating]) => ({
      id, label,
      value: raw ? rating : pct,
      text: raw ? nf(rating) : fmtPct(nf(pct, 1)),
      tip: raw
        ? (Number.isFinite(pct) ? tr('{label} : {pct}', { label, pct: fmtPct(nf(pct, 1)) }) : '')
        : (Number.isFinite(rating) ? tr('{label} : {rating} points', { label, rating: nf(rating) }) : ''),
    }));
  const top = Math.max(1, ...secs.map((x) => x.value));
  const big = (label, value) => `<div class="gstat-big"><small>${label}</small><b>${value}</b></div>`;
  return `<div class="gear-stats">
    <div class="gstat-bigs">
      ${st.primary ? big(PRIMARY_LABELS[st.primary.stat] || '', nf(st.primary.value)) : ''}
      ${Number.isFinite(st.stamina) ? big(tr('Endurance'), nf(st.stamina)) : ''}
      ${Number.isFinite(st.health) ? big(tr('Points de vie'), fmtAmount(st.health)) : ''}
    </div>
    <div class="gstat-bars">${secs.map(({ id, label, value, text, tip }) => `
      <div class="gstat gstat-${id}" data-gstat-hi="${id}"${tip ? ` title="${esc(tip)}"` : ''}>
        <span class="gstat-lab">${label}</span>
        <span class="gstat-bar"><i style="width:${Math.max(3, Math.round((value / top) * 100))}%"></i></span>
        <span class="gstat-val">${text}</span>
      </div>`).join('')}
    </div>
  </div>`;
}

function gearSkeleton() {
  const col = (side) => Array.from({ length: 8 }, () => `<div class="gslot is-loading ${side}"><span class="gslot-ico skel"></span><span class="gslot-text"><span class="skel skel-gname"></span><span class="skel skel-gsub"></span></span></div>`).join('');
  return `<div class="gear-doll"><div class="gear-col">${col('left')}</div><div class="gear-col">${col('right')}</div></div>`;
}

function gearSection(t, { cls = null } = {}) {
  const open = gearOpen();
  // Un autre joueur : retour sur l'onglet Équipement
  if (gearTabState.id !== t.id) gearTabState = { id: t.id, tab: 'gear' };
  const tab = gearTabState.tab;
  const g = gearPages.get(t.id);
  // Ouvert sur l'équipement et jamais chargé (ou trop vieux) : chargé tout de suite, hors du rendu.
  // Sur l'onglet des talents, l'équipement n'est pas demandé (et inversement).
  if (open && tab === 'gear' && (!g || (g.state === 'ok' && Date.now() - g.at > GEAR_PAGE_TTL))) queueMicrotask(() => loadGear(t));
  const loading = tab === 'gear' ? !g || g.state === 'loading' : talentsLoading(t);
  let body = '';
  if (open && tab === 'talents') body = talentsPane(t, cls);
  else if (open) {
    if (g?.state === 'ok') {
      const d = g.data;
      const sum = gearSummary(d);
      // Au centre de la feuille de personnage quand la place le permet (fiche joueur) : l'ilvl en grand
      const hero = sum.ilvl ? `<div class="gear-hero"${cls ? ` style="--cls:${cls}"` : ''}>
          <small>${tr("Niveau d'objet moyen équipé")}</small><b>${nf(sum.ilvl, 1)}</b>
          ${sum.set && sum.set.on >= 2 ? `<span>${esc(sum.set.name)} · ${sum.set.on}/${sum.set.total}</span>` : ''}
        </div>` : '';
      body = `${gearStats(d.stats)}${hero}
        <div class="gear-doll">
          <div class="gear-col">${GEAR_LEFT.map((s) => gearSlot(t, d, s, 'left')).join('')}</div>
          <div class="gear-col">${GEAR_RIGHT.map((s) => gearSlot(t, d, s, 'right')).join('')}</div>
        </div>
        <div class="gear-weapons">${GEAR_WEAPONS.map((s, i) => gearSlot(t, d, s, i ? 'right' : 'left')).join('')}</div>
        <p class="gear-foot">${tr('Survole un objet pour voir son détail. Équipement vu par le jeu {ago}.', { ago: timeAgo(g.at) })}</p>`;
    } else if (g?.state === 'missing') {
      body = `<p class="note gear-msg">${tr('Équipement introuvable pour ce personnage.')}</p>`;
    } else if (g?.state === 'error') {
      body = `<p class="error gear-msg">${esc(tr(g.error))} <button class="btn ghost small" type="button" data-gear-retry="${esc(t.id)}">${tr('Réessayer')}</button></p>`;
    } else {
      body = gearSkeleton();
    }
  }
  const chips = g?.state === 'ok' ? gearChips(g.data) : '';
  // Fiche joueur, onglet Équipement ouvert : « Actualiser » relit l'équipement sans le cache.
  // Admins seulement (demande de l'utilisateur ; le serveur ignore fresh=1 pour les autres)
  let refresh = '';
  const adminHere = Boolean(state.status?.account?.admin || state.status?.impersonatedBy);
  if (open && tab === 'gear' && t.id.startsWith('p:') && g && adminHere) {
    refresh = g.state === 'loading' || g.refreshing
      ? `<span class="gear-refresh is-busy" role="status" aria-label="${esc(tr('Chargement de l\'équipement…'))}"><span class="spinner"></span></span>`
      : `<button class="gear-refresh" type="button" data-gear-refresh="${esc(t.id)}" title="Actualiser l'équipement (sans le cache)" aria-label="Actualiser l'équipement" data-track="équipement › actualiser">${REFRESH_ICON}</button>`;
  }
  const tabBtn = (id, label) => `<button class="gear-tab${tab === id ? ' is-on' : ''}" type="button" role="tab" id="gtab-${id}-${esc(t.id)}" aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}" data-gear-tab="${id}" data-track="équipement › onglet ${id === 'gear' ? 'équipement' : 'talents'}">${label}</button>`;
  // En-tête : les onglets tiennent lieu de titre (demande de l'utilisateur) ; un clic ailleurs dans
  // la ligne ouvre ou ferme le bloc, comme « Masquer » / « Afficher »
  return `<section class="gear${open ? ' is-open' : ''}${open && loading ? ' is-loading' : ''}">
    <div class="gear-head" data-gear-head="${esc(t.id)}">
      <span class="gear-toggle-ico">${GEAR_ICON}</span>
      <div class="gear-tabs" role="tablist" aria-label="${esc(tr('Équipement et talents'))}" data-gear-tabs="${esc(t.id)}">
        ${tabBtn('gear', tr('Équipement'))}${tabBtn('talents', tr('Talents'))}
      </div>
      <span class="gear-chips">${tab === 'gear' ? chips : ''}</span>
      ${refresh}
      <button class="gear-toggle" type="button" data-gear-toggle="${esc(t.id)}" aria-expanded="${open}" data-track="${open ? 'équipement › masquer' : 'équipement › afficher'}">${open ? tr('Masquer') : tr('Afficher')}${GEAR_CHEVRON}</button>
    </div>
    ${open ? `<div class="gear-body">
      <div class="gear-pane is-${tab === 'talents' ? 'talents' : 'gear'}" role="tabpanel" aria-labelledby="gtab-${tab}-${esc(t.id)}">${body}</div>
    </div>` : ''}
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Talents : onglet du bloc Équipement (demande de l'utilisateur, 28 septembre 2026) */
/* ------------------------------------------------------------------ */
// La configuration équipée de la spé active seulement (ni les autres spés ni les autres
// configurations) : les arbres du jeu (classe, héros, spé), le talent apex à part, une info-bulle par
// talent, et un bouton qui copie le code d'export à coller dans le jeu (fenêtre des talents ›
// Importer). Rien n'est demandé avant l'ouverture de l'onglet : le personnage et l'arbre de sa spé
// (API Blizzard, par le serveur), puis les icônes au fil de l'affichage (/api/talent-icon/<sort>.jpg).
// L'onglet n'est pas mémorisé : chaque nouveau joueur s'ouvre sur l'équipement.
const talentPages = new Map();   // cible -> { state, data, error, at }
let gearTabState = { id: null, tab: 'gear' };
const gearTabOf = (id) => (gearTabState.id === id ? gearTabState.tab : 'gear');
const talentsLoading = (t) => { const g = talentPages.get(t.id); return !g || g.state === 'loading'; };
const talentIcon = (e) => (e?.spell ? `/api/talent-icon/${Number(e.spell)}.jpg` : '');

async function loadTalents(t, force = false) {
  const kept = talentPages.get(t.id);
  if (kept?.state === 'loading') return;
  const fresh = force || devNoCache();
  if (!fresh && kept && kept.state !== 'error' && Date.now() - kept.at < GEAR_PAGE_TTL) return;
  talentPages.set(t.id, { state: 'loading', at: Date.now() });
  refreshGearViews(t.id);
  let value;
  try {
    const { talents } = await api(t.turl + (fresh ? '&fresh=1' : ''));
    if (talents?.error) value = { state: 'error', error: GroupScoutShared.PROFILE_ERRORS[talents.error] || GroupScoutShared.PROFILE_ERRORS.down };
    else if (!talents?.found) value = { state: 'missing' };
    else value = { state: 'ok', data: talents };
  } catch (e) {
    value = { state: 'error', error: e.message };
  }
  talentPages.set(t.id, { ...value, at: Date.now() });
  refreshGearViews(t.id);
}

// Talents choisis : nœud -> { rank, talent, parts } (parts : les paliers du talent apex)
const talentPicks = (lo) => new Map((lo?.picks || []).map(([id, rank, talent, parts]) => [id, { rank, talent, parts: parts || null }]));
const pickRank = (n, pick) => (pick ? Math.min(n.max, Math.max(1, pick.rank)) : 0);

// Icône d'un nœud : celle du talent pris (ou les deux moitiés d'un choix pas pris)
function talentFace(n, pick) {
  const chosen = pick && n.type === 'choice' ? n.entries.find((e) => e.talent === pick.talent) : null;
  const face = n.type !== 'choice' ? [n.entries[0]] : chosen ? [chosen] : n.entries.slice(0, 2);
  const ico = face.length > 1
    ? `<span class="tal-ico is-split"><i style="background-image:url('${talentIcon(face[0])}')"></i><i style="background-image:url('${talentIcon(face[1])}')"></i></span>`
    : `<span class="tal-ico" style="background-image:url('${talentIcon(face[0])}')"></span>`;
  return { ico, name: chosen?.name || n.entries.map((e) => e.name).join(' / ') };
}

function talentNode(n, pick, tipBase, style = '') {
  const rank = pickRank(n, pick);
  const { ico, name } = talentFace(n, pick);
  const label = `${name}${n.max > 1 ? `, ${tr('rang {r}/{max}', { r: rank, max: n.max })}` : ''}${pick ? '' : `, ${tr('pas choisi')}`}`;
  const cls = `tal-node is-${n.type}${pick ? ' is-on' : ''}${pick && rank < n.max ? ' is-part' : ''}`;
  return `<button type="button" class="${cls}"${style ? ` style="${style}"` : ''} data-talent-tip="${esc(`${tipBase}#${n.id}`)}" tabindex="${pick ? 0 : -1}" aria-label="${esc(label)}">
    <span class="tal-shape">${ico}</span>${n.max > 1 ? `<b class="tal-rank">${rank}/${n.max}</b>` : ''}
  </button>`;
}

// Un arbre : les nœuds sur la grille du jeu, les traits vers ce qu'ils débloquent (allumés entre
// deux talents choisis), un rang « 1/2 » sur les talents à plusieurs rangs
function talentTreeHtml(nodes, picks, tipBase) {
  if (!nodes.length) return '';
  const r0 = Math.min(...nodes.map((n) => n.row));
  const c0 = Math.min(...nodes.map((n) => n.col));
  const cols = Math.max(...nodes.map((n) => n.col)) - c0 + 1;
  const nrows = Math.max(...nodes.map((n) => n.row)) - r0 + 1;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const x = (n) => n.col - c0 + 0.5;
  const y = (n) => n.row - r0 + 0.5;
  const links = nodes.flatMap((n) => n.unlocks.map((id) => byId.get(id)).filter(Boolean).map((m) => {
    const on = picks.has(n.id) && picks.has(m.id);
    return `<line x1="${x(n)}" y1="${y(n)}" x2="${x(m)}" y2="${y(m)}"${on ? ' class="on"' : ''}/>`;
  })).join('');
  const cells = nodes.map((n) => talentNode(n, picks.get(n.id), tipBase, `--x:${x(n)};--y:${y(n)}`)).join('');
  return `<div class="tal-tree" style="--cols:${cols};--rows:${nrows}">
    <svg class="tal-links" viewBox="0 0 ${cols} ${nrows}" preserveAspectRatio="none" aria-hidden="true">${links}</svg>${cells}
  </div>`;
}

const treeWidth = (nodes) => Math.max(...nodes.map((n) => n.col)) - Math.min(...nodes.map((n) => n.col)) + 1;

function talentsPane(t, cls) {
  const g = talentPages.get(t.id);
  if (!g || (g.state === 'ok' && Date.now() - g.at > GEAR_PAGE_TTL)) queueMicrotask(() => loadTalents(t));
  if (!g || g.state === 'loading') return `<p class="loading tal-loading"><span class="spinner"></span>${tr('Chargement des talents…')}</p>`;
  if (g.state === 'missing') return `<p class="note gear-msg">${tr('Talents introuvables pour ce personnage.')}</p>`;
  if (g.state === 'error') return `<p class="error gear-msg">${esc(tr(g.error))} <button class="btn ghost small" type="button" data-talent-retry="${esc(t.id)}">${tr('Réessayer')}</button></p>`;
  const d = g.data;
  const lo = d.loadout;
  if (!d.spec || !lo) return `<p class="note gear-msg">${tr('Aucun talent choisi pour ce personnage.')}</p>`;
  const picks = talentPicks(lo);
  const tree = d.tree;
  const tipBase = t.id;
  const panel = (kind, title, nodes) => {
    const html = talentTreeHtml(nodes, picks, tipBase);
    if (!html) return '';
    return `<section class="tal-panel is-${kind}"${kind === 'hero' ? '' : ` style="--n:${treeWidth(nodes)}"`}>
      <header><b>${esc(title || '')}</b></header>
      ${html}
    </section>`;
  };
  // Talent apex (dernier talent de l'arbre de spé) : sous l'arbre de héros, avec ses points sur 4
  const apexPanel = (n) => {
    const pick = picks.get(n.id);
    const rank = pickRank(n, pick);
    const pips = Array.from({ length: n.max }, (_, i) => `<i${i < rank ? ' class="on"' : ''}></i>`).join('');
    return `<section class="tal-panel is-apex">
      <header><b>${esc(n.entries[0].name)}</b></header>
      <div class="tal-apex">${talentNode(n, pick, tipBase)}<span class="tal-pips" aria-hidden="true">${pips}</span></div>
    </section>`;
  };
  // Le bouton Exporter : au milieu, entre les arbres de gauche et de droite, sous le talent apex,
  // calé sur le bas des arbres de classe et de spé
  const exportBtn = lo.code ? `<div class="tal-actions">
      <button class="btn primary tal-copy" type="button" data-talent-copy="${esc(lo.code)}" title="${esc(tr('Copie le code à coller dans le jeu : fenêtre des talents › Importer.'))}" data-track="talents › exporter">${TALENT_COPY_ICON}${tr('Exporter')}</button>
    </div>` : '';
  const hero = tree?.heroes?.[0] || null;
  const mid = [hero ? panel('hero', hero.name, hero.nodes) : '', tree?.apex ? apexPanel(tree.apex) : '', exportBtn].join('');
  const trees = tree ? `<div class="tal-trees">
      ${panel('class', tree.className, tree.classNodes)}
      ${mid ? `<div class="tal-mid" style="--n:${hero ? treeWidth(hero.nodes) : 3}">${mid}</div>` : ''}
      ${panel('spec', tree.specName || d.spec.name, tree.specNodes)}
    </div>` : `<p class="note gear-msg">${tr("L'arbre de talents n'a pas pu être lu : le bouton Exporter reste utilisable.")}</p>${exportBtn}`;
  return `<div class="tal"${cls ? ` style="--cls:${cls}"` : ''}>
    ${trees}
    <p class="gear-foot">${tr('Survole un talent pour voir son détail. Talents vus par le jeu {ago}.', { ago: timeAgo(d.at || g.at) })}</p>
  </div>`;
}
const TALENT_COPY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// Info-bulle d'un talent : comme celle du jeu (coût, portée, incantation, temps de recharge, texte) ;
// pour un choix, les deux talents, celui qui a été pris en premier ; pour le talent apex, chaque
// palier pris avec ses points
const talentText = (s) => esc(s || '').replace(/\n/g, '<br>');
function talentTipHtml(anchor) {
  const [key, nodeId] = String(anchor.dataset.talentTip || '').split('#');
  const d = talentPages.get(key)?.data;
  const tree = d?.tree;
  if (!d?.loadout || !tree) return '';
  const id = Number(nodeId);
  const n = [...tree.classNodes, ...tree.specNodes, ...(tree.apex ? [tree.apex] : []), ...tree.heroes.flatMap((h) => h.nodes)].find((x) => x.id === id);
  if (!n) return '';
  const p = talentPicks(d.loadout).get(id);
  const rank = pickRank(n, p);
  const pair = (a, b) => (a || b ? `<div class="gt-pair"><span>${esc(a || '')}</span><span>${esc(b || '')}</span></div>` : '');
  // Talent apex : Blizzard le dit actif alors que ses paliers sont passifs ; on donne ses points
  const apex = tree.apex?.id === n.id;
  const kind = apex ? tr('Jusqu’à {max} points', { max: n.max })
    : n.type === 'active' ? tr('Talent actif') : n.type === 'choice' ? tr('Choix de talent') : tr('Talent passif');
  const status = p
    ? `<div class="gt-block gt-green">${n.max > 1 ? esc(tr('Rang {r}/{max}', { r: rank, max: n.max })) : esc(tr('Talent choisi'))}</div>`
    : `<div class="gt-block gt-dim">${esc(tr('Pas choisi'))}</div>`;
  // Un talent passif dit déjà « Talent passif » : son incantation (« Passif ») n'est pas répétée
  const spell = (e) => `${pair(e.cost, e.range)}${(n.type === 'passive' || apex) && !e.cd ? '' : pair(e.cast, e.cd)}`;
  let body;
  let head = n.entries[0];
  if (n.type === 'choice') {
    const chosen = p ? n.entries.find((e) => e.talent === p.talent) : null;
    if (chosen) head = chosen;
    const list = chosen ? [chosen, ...n.entries.filter((e) => e !== chosen)] : n.entries;
    body = list.map((e) => `<div class="tt-choice${chosen && e !== chosen ? ' is-off' : ''}">
      <div class="tt-choice-head"><span class="tt-mini" style="background-image:url('${talentIcon(e)}')"></span><b>${esc(e.name)}</b>${chosen === e ? `<small>${tr('Choisi')}</small>` : ''}</div>
      ${spell(e)}<div class="gt-block gt-yellow">${talentText(e.desc)}</div>
    </div>`).join('');
  } else if (p?.parts?.length > 1) {
    // Talent apex : le palier de base (celui de l'arbre) d'abord, puis les autres
    const e = n.entries[0];
    const parts = [...p.parts].sort((a, b) => (b.talent === e.talent) - (a.talent === e.talent));
    body = `${spell(e)}${parts.map((x) => `<div class="gt-block tt-part">
      <div class="gt-dim">${tr('{n, plural, one {# point} other {# points}}', { n: x.rank })}</div>
      <div class="gt-yellow">${talentText(x.desc)}</div>
    </div>`).join('')}`;
  } else {
    const e = n.entries[0];
    const descs = n.descs || [];
    const now = descs[Math.max(0, rank - 1)] || e.desc;
    const next = rank && rank < n.max ? descs[rank] : '';
    body = `${spell(e)}<div class="gt-block gt-yellow">${talentText(now)}</div>
      ${next && next !== now ? `<div class="gt-block"><div class="gt-dim">${tr('Rang suivant :')}</div><div class="gt-yellow tt-next">${talentText(next)}</div></div>` : ''}`;
  }
  return `<div class="gtip ttip${p ? ' is-on' : ''}${p && rank < n.max ? ' is-part' : ''}">
    <div class="gt-head">
      <span class="gt-ico tt-ico is-${n.type}" style="background-image:url('${talentIcon(head)}')"></span>
      <div class="gt-titles"><div class="gt-name">${esc(n.type === 'choice' && !p ? n.entries.map((e) => e.name).join(' / ') : head.name)}</div><div class="gt-slot">${kind}</div></div>
    </div>
    <div class="gt-body">${body}${status}</div>
  </div>`;
}

function renderPlayerGear() {
  const el = $('#playerGear');
  if (!el) return;
  const pl = state.player;
  if (!pl || currentView !== 'player' || pl.p.rio.state !== 'ok') { setHtml(el, ''); return; }
  setHtml(el, gearSection(playerGearTarget(pl), { cls: CLASS_COLORS[pl.p.rio.data?.class] || null }));
}

/* Info-bulle d'un objet, à la manière du jeu : nom dans la couleur de sa qualité, niveau d'objet
 * en jaune, caractéristiques secondaires, enchantements et effets en vert, ensemble, etc. */
const GT_GREEN = new Set(['#00ff00', '#1eff00']);
function gearTipHtml(it) {
  const line = (html, cls = '') => `<div class="gt-line${cls}">${html}</div>`;
  const pair = (a, b) => `<div class="gt-pair"><span>${esc(a || '')}</span><span>${esc(b || '')}</span></div>`;
  const colored = (text, color, fallback = '') => {
    if (color && GT_GREEN.has(color.toLowerCase())) return line(esc(text), ' gt-green');
    if (color && color.toLowerCase() !== '#ffffff') return `<div class="gt-line" style="color:${esc(color)}">${esc(text)}</div>`;
    return line(esc(text), fallback);
  };
  const out = [];
  if (it.track?.text) out.push(colored(it.track.text, it.track.color, ' gt-green'));
  if (it.levelText) out.push(line(esc(it.levelText), ' gt-yellow'));
  // Palier d'amélioration, comme la ligne du jeu (nom du palier déjà dans la langue de la page)
  if (it.upgrade) out.push(line(esc(tr("Niveau d'amélioration : {track} {rank}/{max}", { track: it.upgrade.name, rank: it.upgrade.rank, max: it.upgrade.max })), ' gt-yellow'));
  if (it.transmog) out.push(line(esc(it.transmog), ' gt-pink'));
  if (it.binding) out.push(line(esc(it.binding)));
  if (it.unique) out.push(line(esc(it.unique)));
  if (it.type || it.subclass) out.push(pair(it.type, it.subclass));
  if (it.weapon?.damage || it.weapon?.speed) out.push(pair(it.weapon.damage, it.weapon.speed));
  if (it.weapon?.dps) out.push(line(esc(it.weapon.dps)));
  if (it.armor) out.push(line(esc(it.armor)));
  const stats = it.stats.filter((s) => !s.off);
  if (stats.length) out.push(`<div class="gt-block">${stats.map((s) => colored(s.text, s.color, s.equip ? ' gt-green' : '')).join('')}</div>`);
  if (it.enchants.length) {
    out.push(`<div class="gt-block">${it.enchants.map((e) => line(`${enchantRank(e.rank)}${esc(e.text)}${e.temp ? ` <span class="gt-dim">(${tr('temporaire')})</span>` : ''}`, ' gt-green')).join('')}</div>`);
  }
  if (needsEnchant(it) && !it.enchants.some((e) => !e.temp)) out.push(`<div class="gt-block">${line(esc(tr('Sans enchantement')), ' gt-miss')}</div>`);
  if (it.sockets.length) {
    out.push(`<div class="gt-block">${it.sockets.map((g) => `<div class="gt-socket${g.gem ? '' : ' is-empty'}">
      <span class="gt-gem"${g.icon ? ` style="background-image:url('${esc(itemIcon(g.icon))}')"` : ''}></span>
      <span>${g.gem ? `${esc(g.text || g.gem)}${g.text && g.gem ? `<small>${esc(g.gem)}</small>` : ''}` : esc(g.type || tr('Châsse vide'))}</span>
    </div>`).join('')}</div>`);
  }
  if (it.spells.length) out.push(`<div class="gt-block">${it.spells.map((s) => colored(s.text, s.color, ' gt-green')).join('')}</div>`);
  if (it.set) {
    const on = it.set.items.filter((i) => i.on).length;
    out.push(`<div class="gt-block gt-set">
      ${line(`${esc(it.set.name)} (${on}/${it.set.items.length})`, ' gt-yellow')}
      ${it.set.items.map((i) => line(esc(i.name), i.on ? ' gt-setitem gt-indent' : ' gt-dim gt-indent')).join('')}
      ${it.set.effects.map((e) => line(`${e.count ? `(${e.count}) ` : ''}${esc(e.text)}`, e.on ? ' gt-green' : ' gt-dim')).join('')}
    </div>`);
  }
  if (it.requires) out.push(line(esc(it.requires)));
  if (it.durability) out.push(line(esc(it.durability), ' gt-dim'));
  if (it.description) out.push(line(`« ${esc(it.description)} »`, ' gt-yellow gt-italic'));
  return `<div class="gtip q-${esc(it.quality)}${upClass(it)}">
    <div class="gt-head">
      <span class="gt-ico"${it.icon ? ` style="background-image:url('${esc(itemIcon(it.icon))}')"` : ''}></span>
      <div class="gt-titles"><div class="gt-name">${esc(it.name)}</div>${it.slotName ? `<div class="gt-slot">${esc(it.slotName)}</div>` : ''}</div>
    </div>
    <div class="gt-body">${out.join('')}</div>
  </div>`;
}

// Un seul élément pour l'info-bulle, posé sur <body> en position fixe : la liste et le détail
// sont réécrits souvent, l'info-bulle ne doit pas partir avec eux
let gearTipEl = null;
let gearTipAnchor = null;
function gearTipNode() {
  if (!gearTipEl) {
    gearTipEl = document.createElement('div');
    gearTipEl.className = 'gear-tip';
    gearTipEl.setAttribute('role', 'tooltip');
    gearTipEl.hidden = true;
    document.body.appendChild(gearTipEl);
  }
  return gearTipEl;
}
function itemOfAnchor(el) {
  const [id, idx] = String(el?.dataset.gearItem || '').split('|');
  return gearPages.get(id)?.data?.items?.[Number(idx)] || null;
}
// Même info-bulle pour une clé de « Donjons de la saison » (data-run-tip)
function tipHtmlOf(anchor) {
  if (anchor.dataset.runTip) {
    const t = runTips.get(anchor.dataset.runTip);
    return t ? runTipHtml(t) : '';
  }
  if (anchor.dataset.talentTip) return talentTipHtml(anchor);
  const it = itemOfAnchor(anchor);
  return it ? gearTipHtml(it) : '';
}
const TIP_ANCHORS = '[data-gear-item], [data-run-tip], [data-talent-tip]';
function showGearTip(anchor) {
  // Élément remplacé entre-temps (la page a été redessinée au clic) : rien à montrer
  if (!anchor?.isConnected) return;
  const html = tipHtmlOf(anchor);
  if (!html) return;
  const tip = gearTipNode();
  gearTipAnchor = anchor;
  tip.innerHTML = html;
  tip.hidden = false;
  tip.classList.remove('is-in');
  const a = anchor.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const gap = 12;
  let left = a.right + gap;
  if (left + w > vw - 8) left = a.left - gap - w;
  if (left < 8) left = Math.max(8, Math.min(vw - w - 8, a.left + a.width / 2 - w / 2));
  let top = a.top + a.height / 2 - Math.min(h / 2, 60);
  top = Math.max(8, Math.min(vh - h - 8, top));
  // Posée au-dessus ou en dessous si elle recouvre l'objet (écran étroit)
  if (left < a.right && left + w > a.left) top = a.bottom + gap + h < vh ? a.bottom + gap : Math.max(8, a.top - gap - h);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  requestAnimationFrame(() => tip.classList.add('is-in'));
}
function hideGearTip() {
  gearTipAnchor = null;
  if (gearTipEl) { gearTipEl.hidden = true; gearTipEl.classList.remove('is-in'); }
}

function selectGearTab(btn, focus = false) {
  const tab = btn.dataset.gearTab === 'talents' ? 'talents' : 'gear';
  const id = btn.closest('[data-gear-tabs]')?.dataset.gearTabs;
  if (!id) return;
  gearTabState = { id, tab };
  if (!gearOpen()) setGearOpen(true);
  hideGearTip();
  if (currentView === 'player') renderPlayerGear();
  if (focus) {
    const sel = `[data-gear-tabs="${CSS.escape(id)}"] [data-gear-tab="${tab}"]`;
    requestAnimationFrame(() => document.querySelector(sel)?.focus());
  }
}

function bindGear() {
  document.addEventListener('click', (ev) => {
    // « Masquer » / « Afficher », ou un clic dans la ligne du haut hors des onglets
    const head = ev.target.closest('[data-gear-head]');
    const toggle = ev.target.closest('[data-gear-toggle]') || (head && !ev.target.closest('button') ? head : null);
    if (toggle) {
      const id = toggle.dataset.gearToggle || toggle.dataset.gearHead;
      const open = !gearOpen();
      setGearOpen(open);
      hideGearTip();
      // Seul l'onglet affiché est demandé (les talents le sont au rendu de leur onglet)
      if (open && gearTabOf(id) === 'gear') { const t = gearTargets.get(id); if (t) loadGear(t); }
          if (currentView === 'player') renderPlayerGear();
      return;
    }
    const retry = ev.target.closest('[data-gear-retry]') || ev.target.closest('[data-gear-refresh]');
    if (retry) {
      const t = gearTargets.get(retry.dataset.gearRetry || retry.dataset.gearRefresh);
      if (!t) return;
      hideGearTip();
      // Le bouton devient un rond de chargement : le focus lui est rendu une fois l'équipement relu
      const refocus = retry.dataset.gearRefresh && document.activeElement === retry;
      loadGear(t, true).then(() => {
        if (refocus) document.querySelector(`[data-gear-refresh="${CSS.escape(t.id)}"]`)?.focus();
      });
      return;
    }
    // Onglets Équipement / Talents : chacun n'est demandé qu'à son ouverture
    const tabBtn = ev.target.closest('[data-gear-tab]');
    if (tabBtn) { selectGearTab(tabBtn); return; }
    const tRetry = ev.target.closest('[data-talent-retry]');
    if (tRetry) { const t = gearTargets.get(tRetry.dataset.talentRetry); if (t) loadTalents(t, true); return; }
    const copy = ev.target.closest('[data-talent-copy]');
    if (copy) {
      // Export : le code du jeu part dans le presse-papiers, sans être affiché
      copyText(copy.dataset.talentCopy).then((ok) => {
        toast(ok ? tr('Code copié : colle-le dans la fenêtre des talents du jeu (Importer).') : tr('Copie impossible dans ce navigateur.'), ok ? 'ok' : 'err');
      });
      return;
    }
    // Écran tactile : un appui sur un objet ouvre ou ferme son info-bulle
    const item = ev.target.closest(TIP_ANCHORS);
    if (item) {
      // À la souris, le survol a déjà ouvert l'info-bulle : le clic ne la referme pas
      if (ev.pointerType === 'mouse') { if (gearTipAnchor !== item) showGearTip(item); return; }
      if (gearTipAnchor === item && !gearTipEl?.hidden) hideGearTip();
      else showGearTip(item);
    } else if (!ev.target.closest('.gear-tip')) hideGearTip();
  });
  // Survol d'une barre de stat secondaire : les objets qui la donnent s'allument, les autres
  // s'estompent (demande de l'utilisateur)
  const statHi = (bar, on) => {
    const body = bar.closest('.gear-body');
    if (!body) return;
    const id = bar.dataset.gstatHi;
    body.classList.toggle('stat-hi', on);
    body.style.setProperty('--hi', on ? `var(--st-${id})` : '');
    bar.classList.toggle('is-hi', on);
    for (const s of body.querySelectorAll('.gslot')) s.classList.toggle('has-stat', on && (s.dataset.gstats || '').split(' ').includes(id));
  };
  document.addEventListener('pointerover', (ev) => {
    const bar = ev.target.closest?.('[data-gstat-hi]');
    if (bar && !bar.contains(ev.relatedTarget)) statHi(bar, true);
  });
  document.addEventListener('pointerout', (ev) => {
    const bar = ev.target.closest?.('[data-gstat-hi]');
    if (bar && !bar.contains(ev.relatedTarget)) statHi(bar, false);
  });
  document.addEventListener('pointerover', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    const item = ev.target.closest(TIP_ANCHORS);
    if (item && item !== gearTipAnchor) showGearTip(item);
  });
  document.addEventListener('pointerout', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    const to = ev.relatedTarget;
    const item = ev.target.closest(TIP_ANCHORS);
    if (item && item === gearTipAnchor && !item.contains(to)) hideGearTip();
  });
  document.addEventListener('focusin', (ev) => {
    const item = ev.target.closest?.(TIP_ANCHORS);
    if (item) showGearTip(item);
  });
  // Onglets au clavier : flèches, Début, Fin (le focus suit l'onglet choisi)
  document.addEventListener('keydown', (ev) => {
    const tab = ev.target.closest?.('[data-gear-tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll('[data-gear-tab]')];
    const i = tabs.indexOf(tab);
    const next = ev.key === 'Home' ? tabs[0] : ev.key === 'End' ? tabs[tabs.length - 1]
      : tabs[(i + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    ev.preventDefault();
    selectGearTab(next, true);
  });
  document.addEventListener('focusout', (ev) => {
    if (ev.target.closest?.(TIP_ANCHORS) === gearTipAnchor) hideGearTip();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && gearTipAnchor) hideGearTip();
  });
  // Défilement (hors de l'info-bulle elle-même) ou fenêtre redimensionnée : elle se ferme
  window.addEventListener('scroll', (ev) => {
    if (ev.target instanceof Element && ev.target.closest('.gear-tip')) return;
    hideGearTip();
  }, { capture: true, passive: true });
  window.addEventListener('resize', hideGearTip);
}

/* ------------------------------------------------------------------ */
/* La fiche                                                            */
/* ------------------------------------------------------------------ */
function renderPlayer() {
  renderPlayerMain();
  renderPlayerGear();
}

function renderPlayerMain() {
  const head = $('#playerHead');
  const prog = $('#playerProg');
  const pl = state.player;
  $('#playerTop').classList.toggle('is-card', pl?.p.rio.state === 'ok');
  const only = (html) => { setHtml(head, html); setHtml(prog, ''); };
  if (!pl) { only(''); return; }
  const p = pl.p;
  if (p.rio.state === 'loading') {
    only('<div class="player-empty"><p class="loading"><span class="spinner"></span>Chargement du profil…</p></div>');
    return;
  }
  if (p.rio.state === 'gate') {
    const gate = playerSearchGate();
    if (!gate) { openPlayer(pl.name, pl.realm, pl.region); return; }
    const href = gate.href === '/login' ? `/login?back=${encodeURIComponent(location.pathname)}` : gate.href;
    only(`<div class="player-empty"><h2>${esc(pl.name)}-${esc(pl.realm)}</h2><p>${esc(gate.text)}</p><p><a class="btn primary small" href="${esc(href)}" data-view="${gate.href === '/login' ? 'login' : 'account'}">${esc(gate.label)}</a></p></div>`);
    return;
  }
  if (p.rio.state !== 'ok') {
    const message = pl.error || (p.rio.state === 'missing'
      ? tr('{name} est introuvable. Vérifie le pseudo et le serveur.', { name: `${pl.name}-${pl.realm}` })
      : p.rio.error || 'Erreur');
    only(`<div class="player-empty"><h2>Pas de fiche</h2><p class="error">${esc(message)}</p></div>`);
    return;
  }

  const r = p.rio.data;
  const color = CLASS_COLORS[r.class] || 'var(--violet)';
  const main = mainOf(p);
  setHtml(prog, progressSection(p));
  const lastSeen = r.lastLogin ? `<span class="ph-seen">${esc(tr('Vu en jeu {ago}', { ago: timeAgo(r.lastLogin) }))}</span>` : '';
  setHtml(head, `
    <section class="player-head" style="--cls:${color}">
      <div>
        <div class="ph-title">${r.class && CLASS_COLORS[r.class] ? specIconSpan(r.class, r.spec, 'ph-ico') : ''}<h1 class="ph-name">${esc(r.name)}</h1>${vipBadge(pl.p.key)}${favButton(playerEntry(pl), 'fav-star ph-star')}</div>
        <div class="ph-sub">${esc(r.spec || '')} ${esc(r.class || '')} · ${esc(r.realm)} · ${esc(pl.region.toUpperCase())}${lastSeen ? ` · ${lastSeen}` : ''}</div>
      </div>
      <div class="ph-stats">
        <span class="ph-stat"><small>ilvl</small><b>${r.itemLevel ? Math.round(r.itemLevel) : '—'}</b></span>
        <span class="ph-stat"><small>Cote M+</small><b style="color:${esc(r.scoreColor || 'var(--text)')}">${Math.round(r.score || 0)}</b></span>
        ${main?.name ? (mainPath(p)
          ? `<a class="ph-stat ph-main" href="${esc(mainPath(p))}" data-player-link data-track="fiche › main" title="${esc(tr('Voir la fiche de {name}', { name: `${main.name}-${main.realm}` }))}"><small>Main</small><b>${esc(main.name)}</b></a>`
          : `<span class="ph-stat"><small>Main</small><b>${esc(main.name)}</b></span>`) : ''}
      </div>
    </section>`);
}

/* ------------------------------------------------------------------ */
/* Rechercher un joueur                                                */
/* ------------------------------------------------------------------ */
// "Pseudo-Serveur" (ou "Pseudo Serveur") -> fiche joueur
function searchPlayer(text) {
  text = String(text || '').trim();
  const m = text.match(/^([^\s-]+)\s*[-\s]\s*(.+)$/u);
  if (!m) { toast('Écris le joueur sous la forme Pseudo-Serveur.', 'err'); return; }
  window.GSStats?.event('search', currentView === 'home' ? 'accueil' : currentView === 'player' ? 'fiche joueur' : currentView);
  history.pushState({}, '', playerPath(m[1], m[2].trim()));
  route();
}

// Joueurs trouvés pendant la frappe (recherche de Raider.IO, depuis le navigateur), gardés 10 min
const rioSearches = new Map();
async function rioSearch(term) {
  const k = term.toLowerCase();
  const kept = rioSearches.get(k);
  const fresh = devNoCache();
  if (kept && !fresh && Date.now() - kept.at < 10 * 60e3) return kept.players;
  const players = await GroupScoutShared.searchRioCharacters(term, { fresh });
  rioSearches.set(k, { players, at: Date.now() });
  return players;
}

/* ---------------- Recherche d'un joueur, en palette ---------------- */
// Demande de l'utilisateur (28 septembre 2026) : « Rechercher un joueur » (barre du haut, menu ☰,
// pieds de page) ouvre une palette à la Raycast au lieu de mener à une page : un champ, tes
// favoris et tes dernières recherches, puis les joueurs trouvés pendant la frappe (Raider.IO,
// comme les autres suggestions). Choisir un joueur ouvre sa fiche. /player sans joueur n'existe
// plus : l'adresse ramène à l'accueil et ouvre la palette. Pas de raccourci clavier global
// (retiré à la demande de l'utilisateur). Attributs à elle (`data-pal-*`) : l'étoile de la fiche
// joueur a son gestionnaire sur tout le document.
const pal = { open: false, items: [], active: 0, loading: false, results: null, request: 0, timer: null, back: null };
const PAL_ICONS = {
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.5 10.5 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  go: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

// Ce qui empêche de chercher ; rien tant que le compte n'est pas connu (/player au chargement),
// pour ne pas montrer « Connecte-toi » une fraction de seconde à un compte connecté
const palGate = () => (statusKnown ? playerSearchGate() : null);

// `text` : premier caractère tapé dans le champ de l'accueil, repris dans la palette
function openPalette(text = '') {
  // Une autre fenêtre est déjà ouverte : on ne l'empile pas dessus
  if (!$('#modal').hidden) return;
  closeNavMenu({ focus: false });
  closeNotifPanel({ focus: false });
  if (!pal.open) pal.back = document.activeElement;
  pal.open = true;
  $('#palette').hidden = false;
  document.body.classList.add('has-pal');
  const card = $('#paletteCard');
  card.classList.remove('open');
  void card.offsetWidth;          // rejoue l'arrivée
  card.classList.add('open');
  const input = $('#palQuery');
  input.value = text;
  // Sur téléphone, la phrase entière ne tient pas dans le champ
  input.placeholder = matchMedia('(max-width: 640px)').matches ? tr('Pseudo-Serveur') : tr('Rechercher un joueur : Pseudo-Serveur');
  palInput();
  input.focus({ preventScroll: true });
}

function closePalette({ focus = true } = {}) {
  if (!pal.open) return;
  pal.open = false;
  clearTimeout(pal.timer);
  pal.request++;
  $('#palette').hidden = true;
  $('#paletteCard').classList.remove('open');
  document.body.classList.remove('has-pal');
  const back = pal.back;
  pal.back = null;
  if (focus && back?.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

// Texte tapé : les joueurs connus filtrés tout de suite, Raider.IO 220 ms après la dernière touche
function palInput() {
  clearTimeout(pal.timer);
  const id = ++pal.request;
  const [namePart, realmPart = ''] = $('#palQuery').value.split('-');
  const term = namePart.trim();
  pal.active = 0;
  if (term.length < 2 || palGate()) {
    pal.loading = false;
    pal.results = null;
    renderPalette();
    return;
  }
  pal.loading = true;
  renderPalette();
  pal.timer = setTimeout(async () => {
    try {
      const players = await rioSearch(term);
      if (id !== pal.request) return;
      const realm = norm(realmPart);
      pal.results = players
        .filter((it) => it.region === REGION && (!realm || norm(it.realm).startsWith(realm)))
        .slice(0, 8)
        .map((it) => ({ name: it.name, realm: it.realm, region: it.region, cls: it.class || null, spec: null }));
    } catch {
      if (id !== pal.request) return;
      pal.results = [];
    }
    pal.loading = false;
    renderPalette();
  }, 220);
}

// Une ligne de joueur : icône de spé (ou de classe), pseudo en couleur de classe, serveur, puis
// à droite la date (historique), l'étoile, et la croix d'une recherche récente
function palRow(it, i, { when = false, forget = false } = {}) {
  const x = it.entry;
  const color = CLASS_COLORS[x.cls] || 'var(--violet)';
  const on = isFav(recentId(x));
  const acts = `<span class="pal-acts">
      <button class="fav-star pal-star${on ? ' on' : ''}" type="button" tabindex="-1" data-pal-fav="${i}" data-track="recherche › ${on ? 'retirer des favoris' : 'ajouter aux favoris'}" title="${on ? tr('Retirer des favoris') : tr('Ajouter aux favoris')}" aria-label="${esc(on ? tr('Retirer {name} des favoris', { name: x.name }) : tr('Ajouter {name} aux favoris', { name: x.name }))}">${STAR_ICON}</button>
      ${forget ? `<button class="pal-x" type="button" tabindex="-1" data-pal-forget="${i}" data-track="recherche › retirer de l'historique" title="${tr("Retirer de l'historique")}" aria-label="${esc(tr("Retirer {name} de l'historique", { name: x.name }))}">${PAL_ICONS.x}</button>` : ''}
    </span>`;
  return `<div class="pal-row">
    <a class="pal-item${i === pal.active ? ' active' : ''}" id="pal-opt-${i}" role="option" aria-selected="${i === pal.active}" tabindex="-1" href="${esc(playerPath(x.name, x.realm, x.region))}" data-pal-i="${i}" data-track="recherche › ${it.track}" style="--cls:${color}">
      ${specIconSpan(x.cls, x.spec, 'pal-ico')}
      <span class="pal-text"><span class="pal-name">${esc(x.name)}</span><span class="pal-sub">${esc(x.realm)} · ${esc(String(x.region).toUpperCase())}</span></span>
      ${when && x.at ? `<span class="pal-when">${esc(timeAgo(x.at))}</span>` : ''}
      <span class="pal-go" aria-hidden="true">${PAL_ICONS.go}</span>
    </a>
    ${acts}
  </div>`;
}

// Un favori : une tuile (demande de l'utilisateur : « un affichage différent pour les favs »),
// plusieurs par ligne, grande icône de spé, pseudo et serveur dessous, étoile dans le coin
function palTile(it, i) {
  const x = it.entry;
  const color = CLASS_COLORS[x.cls] || 'var(--violet)';
  return `<div class="pal-tile-wrap">
    <a class="pal-item pal-tile${i === pal.active ? ' active' : ''}" id="pal-opt-${i}" role="option" aria-selected="${i === pal.active}" tabindex="-1" href="${esc(playerPath(x.name, x.realm, x.region))}" data-pal-i="${i}" data-track="recherche › ${it.track}" style="--cls:${color}">
      ${specIconSpan(x.cls, x.spec, 'pal-tile-ico')}
      <span class="pal-name">${esc(x.name)}</span>
      <span class="pal-sub">${esc(x.realm)}</span>
    </a>
    <button class="fav-star pal-star pal-tile-star on" type="button" tabindex="-1" data-pal-fav="${i}" data-track="recherche › retirer des favoris" title="${tr('Retirer des favoris')}" aria-label="${esc(tr('Retirer {name} des favoris', { name: x.name }))}">${STAR_ICON}</button>
  </div>`;
}

function renderPalette() {
  const body = $('#palList');
  const input = $('#palQuery');
  if (!body || !input) return;
  const gate = palGate();
  input.disabled = Boolean(gate);
  // Champ réactivé (compte arrivé) : il reprend le focus, perdu en étant désactivé
  if (!gate && pal.open && document.activeElement !== input) input.focus({ preventScroll: true });
  if (gate) {
    pal.items = [];
    input.removeAttribute('aria-activedescendant');
    const view = gate.href === '/login' ? 'login' : 'account';
    setHtml(body, `<div class="pal-empty"><span class="pal-empty-ico">${PAL_ICONS.search}</span>
      <p>${esc(gate.text)}</p>
      <a class="btn primary small" href="${esc(gate.href)}" data-view="${view}">${esc(gate.label)}</a></div>`);
    return;
  }
  const text = input.value.trim();
  const [namePart, realmPart = ''] = text.split('-');
  const favs = readFavs();
  const recent = readRecent();
  const items = [];
  const sections = [];
  const seen = new Set();
  const add = (title, list, opts = {}) => {
    const rows = [];
    for (const entry of list) {
      const id = recentId(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ entry, track: opts.track, tile: Boolean(opts.tiles) });
      rows.push((opts.tiles ? palTile : palRow)(items[items.length - 1], items.length - 1, opts));
    }
    const content = opts.tiles ? `<div class="pal-tiles">${rows.join('')}</div>` : rows.join('');
    if (rows.length || opts.status) sections.push(`<div class="pal-section" role="group" aria-label="${esc(title)}"><div class="pal-title" aria-hidden="true">${esc(title)}${opts.count ? ` <span>${opts.count}</span>` : ''}</div>${opts.status || ''}${content}</div>`);
  };
  if (!text) {
    add(tr('Favoris'), favs, { track: 'favori', count: favs.length || '', tiles: true });
    add(tr('Recherches récentes'), recent, { track: 'récente', when: true, forget: true });
  } else {
    // « Pseudo-Serveur » complet : sa fiche directement, en tête
    const m = text.match(/^([^\s-]+)\s*-\s*(.+)$/u);
    if (m) {
      const entry = { name: m[1], realm: m[2].trim(), region: REGION, cls: null, spec: null };
      const known = [...favs, ...recent, ...(pal.results || [])].find((x) => recentId(x) === recentId(entry));
      add(tr('Ouvrir la fiche'), [known || entry], { track: 'fiche directe' });
    }
    const n = norm(namePart);
    const r = norm(realmPart);
    const mine = [...favs, ...recent].filter((x) => norm(x.name).includes(n) && (!r || norm(x.realm).startsWith(r)));
    add(tr('Tes joueurs'), mine.slice(0, 6), { track: 'connu' });
    if (namePart.trim().length >= 2) {
      const status = pal.loading
        ? `<div class="pal-status" role="status"><span class="spinner" aria-hidden="true"></span>${tr('Recherche…')}</div>`
        : pal.results && !pal.results.some((x) => !seen.has(recentId(x))) && !items.length
          ? `<div class="pal-status" role="status">${tr('Aucun joueur trouvé')}</div>` : '';
      add(tr('Joueurs trouvés'), pal.results || [], { track: 'trouvé', status });
    } else if (!items.length) {
      sections.push(`<div class="pal-status">${tr('Tape au moins deux lettres du pseudo.')}</div>`);
    }
  }
  pal.items = items;
  if (pal.active >= items.length) pal.active = Math.max(0, items.length - 1);
  if (!sections.length) {
    // Rien de gardé et rien de tapé : ce que la palette fait
    setHtml(body, `<div class="pal-empty"><span class="pal-empty-ico">${PAL_ICONS.search}</span>
      <p><b>${tr('Cherche un joueur par son pseudo')}</b>${tr('Tes favoris et les fiches que tu ouvres apparaîtront ici.')}</p></div>`);
  } else {
    setHtml(body, sections.join(''));
  }
  if (items.length) input.setAttribute('aria-activedescendant', `pal-opt-${pal.active}`);
  else input.removeAttribute('aria-activedescendant');
}

// Change la ligne choisie sans tout redessiner (survol, flèches)
function palSetActive(i, { scroll = true } = {}) {
  if (!pal.items.length) return;
  pal.active = (i + pal.items.length) % pal.items.length;
  const body = $('#palList');
  body.querySelectorAll('.pal-item').forEach((el) => {
    const on = Number(el.dataset.palI) === pal.active;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  });
  $('#palQuery').setAttribute('aria-activedescendant', `pal-opt-${pal.active}`);
  if (scroll) $(`#pal-opt-${pal.active}`)?.closest('.pal-row, .pal-tile-wrap')?.scrollIntoView({ block: 'nearest' });
}

// Flèches : dans les tuiles des favoris, gauche / droite de tuile en tuile et haut / bas d'une
// rangée à l'autre (le nombre de tuiles par rangée est mesuré) ; ailleurs, ligne par ligne
function palArrow(key) {
  const tiles = pal.items.filter((x) => x.tile).length;
  const n = pal.items.length;
  const at = pal.active;
  if (!n) return false;
  const inTiles = at < tiles;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (!inTiles) return false;
    palSetActive(Math.max(0, Math.min(tiles - 1, at + (key === 'ArrowRight' ? 1 : -1))));
    return true;
  }
  const down = key === 'ArrowDown';
  if (!inTiles) {
    // Remonter depuis la première ligne sous les tuiles : la dernière tuile
    palSetActive(!down && at === tiles && tiles ? tiles - 1 : at + (down ? 1 : -1));
    return true;
  }
  const els = [...$('#palList').querySelectorAll('.pal-tile-wrap')];
  const top = els[0]?.offsetTop;
  const cols = Math.max(1, els.filter((el) => el.offsetTop === top).length);
  if (down) palSetActive(at + cols < tiles ? at + cols : (tiles < n ? tiles : at));
  else palSetActive(at - cols >= 0 ? at - cols : n - 1);
  return true;
}

function palChoose(i) {
  const it = pal.items[i];
  if (!it) return;
  const x = it.entry;
  closePalette({ focus: false });
  window.GSStats?.event('search', 'palette');
  history.pushState({}, '', playerPath(x.name, x.realm, x.region));
  route();
}

function bindPalette() {
  const wrap = $('#palette');
  $('#paletteCard').innerHTML = `
    <form class="pal-search" id="palForm" autocomplete="off" role="search">
      <span class="pal-search-ico">${PAL_ICONS.search}</span>
      <label class="visually-hidden" for="palQuery">${tr('Joueur (Pseudo-Serveur)')}</label>
      <input id="palQuery" type="text" spellcheck="false" placeholder="${esc(tr('Rechercher un joueur : Pseudo-Serveur'))}" role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list">
      <button class="pal-close" type="button" data-pal="close" title="${tr('Fermer')}" aria-label="${tr('Fermer')}">${PAL_ICONS.x}</button>
    </form>
    <div class="pal-body" id="palList" role="listbox" aria-label="${esc(tr('Joueurs'))}"></div>`;
  const input = $('#palQuery');
  input.addEventListener('input', palInput);
  $('#palForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (pal.items[pal.active]) { palChoose(pal.active); return; }
    const text = input.value.trim();
    if (!text) return;
    closePalette({ focus: false });
    searchPlayer(text);
  });
  input.addEventListener('keydown', (ev) => {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(ev.key) && palArrow(ev.key)) ev.preventDefault();
  });
  wrap.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePalette(); return; }
    // Tab : le focus reste dans le champ (les lignes se choisissent aux flèches)
    if (ev.key === 'Tab' && !input.disabled) { ev.preventDefault(); input.focus(); }
  });
  wrap.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-pal="close"]')) { closePalette(); return; }
    const star = ev.target.closest('[data-pal-fav]');
    if (star) {
      ev.preventDefault();
      ev.stopPropagation();
      const { entry } = pal.items[Number(star.dataset.palFav)] || {};
      if (!entry) return;
      const added = toggleFav(entry);
      renderPalette();
      if (currentView === 'player') renderPlayer();
      toast(added ? tr('{name} est dans tes favoris.', { name: entry.name }) : tr("{name} n'est plus dans tes favoris.", { name: entry.name }));
      input.focus();
      return;
    }
    const x = ev.target.closest('[data-pal-forget]');
    if (x) {
      ev.preventDefault();
      ev.stopPropagation();
      const { entry } = pal.items[Number(x.dataset.palForget)] || {};
      if (!entry) return;
      forgetPlayer(recentId(entry));
      renderPalette();
      if (currentView === 'player') renderPlayer();
      input.focus();
      return;
    }
    const item = ev.target.closest('[data-pal-i]');
    // Ctrl+clic, clic du milieu : la fiche dans un nouvel onglet, la palette reste
    if (!item || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    palChoose(Number(item.dataset.palI));
  });
  // Le survol choisit la ligne, sans faire défiler
  $('#palList').addEventListener('pointermove', (ev) => {
    const item = ev.target.closest('[data-pal-i]');
    if (item && Number(item.dataset.palI) !== pal.active) palSetActive(Number(item.dataset.palI), { scroll: false });
  });
  // Un clic dans la liste ne fait pas perdre le focus au champ
  $('#palList').addEventListener('mousedown', (ev) => { if (ev.target.closest('.pal-item, .pal-acts, .pal-tile-star')) ev.preventDefault(); });
  // Le focus ne sort pas de la palette tant qu'elle est ouverte
  document.addEventListener('focusin', (ev) => {
    if (pal.open && !wrap.contains(ev.target)) input.focus({ preventScroll: true });
  });
  // Liens et boutons « Rechercher un joueur » (barre, pieds de page) : la palette, sauf Ctrl+clic
  document.addEventListener('click', (ev) => {
    const link = ev.target.closest('[data-pal-open]');
    if (!link || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    openPalette();
  }, true);
}

function bindPlayerPage() {
  bindPalette();
  // Étoile des favoris de la fiche : bascule, redessine, et garde le focus sur l'étoile
  document.addEventListener('click', (ev) => {
    const star = ev.target.closest('[data-fav]');
    if (!star) return;
    ev.preventDefault();
    let entry;
    try { entry = JSON.parse(star.dataset.fav); } catch { return; }
    const id = star.dataset.favId;
    const added = toggleFav(entry);
    renderPlayer();
    document.querySelector(`[data-fav-id="${CSS.escape(id)}"]`)?.focus();
    toast(added ? tr('{name} est dans tes favoris.', { name: entry.name }) : tr("{name} n'est plus dans tes favoris.", { name: entry.name }));
  });
  // Liens internes vers une fiche joueur : sans recharger la page
  document.addEventListener('click', (ev) => {
    const link = ev.target.closest('a[data-player-link]');
    if (!link || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    if ($('#modal') && !$('#modal').hidden) closeModal();
    history.pushState({}, '', link.getAttribute('href'));
    route();
  });
}
