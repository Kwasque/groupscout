'use strict';
/*
 * GroupScout — serveur : recherche de raid, comptes, fiche joueur
 * Node 22.5+ requis (fetch natif, node:sqlite). Aucune dépendance npm.
 *
 *   node server.js   ->  http://localhost:3000
 *
 * Données : API officielle de Blizzard (profils, équipement, talents, journal, serveurs), avec la
 * clé du site. Raider.IO ne sert qu'à la liste des raids du palier (une fois par jour, côté
 * serveur) et à la recherche d'un personnage par son nom (dans le navigateur). Aucune requête
 * vers Warcraft Logs.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAccountManager } = require('./accounts.js');
const { createMailer } = require('./mail.js');
const { createBnetManager } = require('./bnet.js');
const { createOAuthManager } = require('./oauth.js');
const { createAdminReport } = require('./admin.js');
const { createAnalytics } = require('./analytics.js');
const { createBlizzardClient } = require('./blizzard.js');
const { createIconStore } = require('./icons.js');
const { createJournalArt } = require('./journal.js');
const { createNotifier } = require('./notifications.js');
const { createGroupManager } = require('./groups.js');
const { norm, slugify, camelSplit } = require('./public/shared.js');
const i18n = require('./public/i18n.js');

/* ------------------------------------------------------------------ */
/* Config (.env)                                                       */
/* ------------------------------------------------------------------ */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
// Adresse publique : liens des e-mails, retours de Battle.net, Google et Discord
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
// Comptes : base SQLite, adresses admin d'office, envoi des e-mails par Brevo
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'data/groupscout.db';
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
// Formulaire de contact (/contact) : où arrivent les messages. L'adresse n'est jamais affichée
// sur le site : seul le serveur la connaît.
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'contact@groupscout.eu';
// Battle.net : un seul client pour tout le site (develop.battle.net). Il sert à la liaison des
// comptes (liste des personnages) et, en « client credentials », à l'API des profils.
const BNET_CLIENT_ID = String(process.env.BNET_CLIENT_ID || '').trim();
const BNET_CLIENT_SECRET = String(process.env.BNET_CLIENT_SECRET || '').trim();
const blizz = createBlizzardClient({ clientId: BNET_CLIENT_ID, clientSecret: BNET_CLIENT_SECRET });
const BNET_REDIRECT_URI = String(process.env.BNET_REDIRECT_URI || '').trim()
  || `${PUBLIC_URL || `http://localhost:${PORT}`}/api/account/bnet/callback`;
// Se connecter avec Google ou Discord (oauth.js). Adresses de retour à déclarer chez eux :
// <PUBLIC_URL>/api/auth/google/callback et <PUBLIC_URL>/api/auth/discord/callback
const OAUTH_CONFIG = {
  google: { clientId: String(process.env.GOOGLE_CLIENT_ID || '').trim(), clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || '').trim() },
  discord: { clientId: String(process.env.DISCORD_CLIENT_ID || '').trim(), clientSecret: String(process.env.DISCORD_CLIENT_SECRET || '').trim() },
};
const REGIONS = ['eu', 'us', 'kr', 'tw'];
const PUBLIC_DIR = path.join(__dirname, 'public');

// `message` : le texte affiché ; `vars` remplit ses {variables} et ses pluriels
class HttpError extends Error {
  constructor(status, message, vars) { super(message); this.status = status; if (vars) this.vars = vars; }
}
const errorText = (e) => i18n.t(e?.message || 'Erreur interne', e?.vars);

/* ------------------------------------------------------------------ */
/* Icônes et images du jeu                                             */
/* ------------------------------------------------------------------ */
// Icônes d'objets de « Clean Icons - Mechagnome Edition », lues à la demande dans le paquet publié
// sur GitHub (voir icons.js). ICON_PACK_URL : une autre version du paquet.
const ICON_PACK_URL = process.env.ICON_PACK_URL
  || 'https://github.com/AcidWeb/Clean-Icons-Mechagnome-Edition/releases/download/12.1.0.69299-V5-1/CleanIcons-MechagnomeEdition-12.1.0.69299-V5-1.zip';
const icons = createIconStore({ dir: path.resolve(__dirname, process.env.ICONS_DIR || 'data/icons'), url: ICON_PACK_URL });
// Icônes pas encore sur le disque : 150 par IP et par minute (au-delà, celle de Blizzard)
const iconFetches = new Map();
setInterval(() => { const now = Date.now(); for (const [ip, h] of iconFetches) if (h.reset < now) iconFetches.delete(ip); }, 5 * 60e3).unref();

// Une icône gardée sur le disque (PNG du paquet ou JPEG de Blizzard), un mois chez le navigateur ;
// illisible : fallback()
function sendIconFile(req, res, file, fallback) {
  fs.readFile(file, (err, buf) => {
    if (err) return fallback();
    res.writeHead(200, {
      'Content-Type': file.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
      'Cache-Control': 'public, max-age=2592000, immutable', 'Content-Length': buf.length,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}
function iconBudget(req, limit) {
  const ip = clientIp(req);
  const now = Date.now();
  const h = iconFetches.get(ip);
  if (!h || h.reset < now) { iconFetches.set(ip, { count: 1, reset: now + 60e3 }); return true; }
  return ++h.count <= limit;
}

// GET /api/icon/<nom>.png : l'icône d'un objet (nom de l'icône du jeu, celui de l'adresse que donne
// l'API Blizzard). Sur le disque : servie. Sinon lue dans le paquet, ou à défaut téléchargée chez
// Blizzard et gardée ; injoignable ou trop de demandes : redirigée vers celle de Blizzard.
async function serveItemIcon(req, res, rawName) {
  const name = icons.cleanName(rawName);
  if (!name) { res.writeHead(404); return res.end(); }
  const blizzard = () => {
    res.writeHead(302, { Location: `https://render.worldofwarcraft.com/eu/icons/56/${name}.jpg`, 'Cache-Control': 'public, max-age=3600' });
    res.end();
  };
  let file = icons.cached(name) || icons.blizzardCached(name);
  if (!file) {
    if (!iconBudget(req, 150)) return blizzard();
    file = (await icons.get(name)) || (await icons.blizzard(name));
  }
  if (!file) return blizzard();
  sendIconFile(req, res, file, blizzard);
}

// Images du Journal des rencontres du jeu (portraits des boss, images des instances), lues sur
// wago.tools et gardées en PNG (voir journal.js)
const journal = createJournalArt({ dir: path.resolve(__dirname, process.env.JOURNAL_DIR || 'data/journal') });
async function serveJournalImage(req, res, name) {
  const file = await journal.png(name).catch(() => null);
  if (!file) { res.writeHead(404, { 'Cache-Control': 'public, max-age=600' }); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=2592000, immutable', 'Content-Length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/* ------------------------------------------------------------------ */
/* Cache mémoire + déduplication des requêtes en cours                 */
/* ------------------------------------------------------------------ */
const TTL = { dungeons: 3600e3, raids: 3600e3 };
const cache = new Map();
const inflight = new Map();

async function cached(key, ttl, fn, force = false) {
  const hit = cache.get(key);
  if (!force && hit && hit.expires > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      cache.set(key, { value, expires: Date.now() + ttl });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ */
/* Profils des personnages : API Blizzard                              */
/* ------------------------------------------------------------------ */
// Serveurs à essayer pour un nom tapé ou venu de Raider.IO : le slug officiel (liste des
// serveurs de Blizzard), puis ce qu'on devine en découpant le nom
async function realmCandidates(region, realmInput, known = null) {
  const official = await blizz.realmSlug(region, realmInput).catch(() => null);
  return [...new Set([known, official, slugify(camelSplit(realmInput)), slugify(realmInput)].filter(Boolean))];
}

// Profil d'un personnage : { found: true, … }, { found: false } ou { error: 'limit' | 'down' }.
async function loadProfile(region, realm, name, { force = false, slug = null } = {}) {
  try {
    const realms = await realmCandidates(region, realm, slug);
    const d = await blizz.profile({ region, realms, name, force });
    if (!d.found) return { found: false };
    // Nom court des donjons de la saison (fiche joueur). La composition du groupe n'est gardée que
    // sur la meilleure et l'autre clé de chaque donjon (info-bulle des vignettes Mythique+)
    const shorts = new Map(((await fetchDungeons(region).catch(() => null))?.dungeons || []).map((x) => [x.mapId, x.short]));
    const runs = (list, keep = false) => list.map(({ members, ...r }) => ({
      ...r,
      short: shorts.get(r.mapId) || null,
      ...(keep && members?.length ? { members: members.map(({ name, realmSlug, spec, className, role, ilvl }) => ({ name, realm: realmSlug, spec, className, role, ilvl })) } : {}),
    }));
    return { ...d, bestRuns: runs(d.bestRuns, true), alternateRuns: runs(d.alternateRuns, true), recentRuns: runs(d.recentRuns), highestRuns: runs(d.highestRuns) };
  } catch (e) {
    if (e.code !== 'limit' && e.code !== 'down') console.error('[blizzard]', e.message);
    return { error: e.code === 'limit' ? 'limit' : 'down' };
  }
}

// Équipement d'un personnage : { found: true, items, stats } | { found: false } | { error }
async function loadGear(region, realm, name, { force = false, slug = null } = {}) {
  try {
    const realms = await realmCandidates(region, realm, slug);
    return await blizz.equipment({ region, realms, name, lang: 'fr', force });
  } catch (e) {
    if (e.code !== 'limit' && e.code !== 'down') console.error('[blizzard]', e.message);
    return { error: e.code === 'limit' ? 'limit' : 'down' };
  }
}

// Talents d'un personnage : seulement la configuration équipée de la spé active :
// { found: true, spec: { id, name }, loadout: { code, hero, picks }, tree, at } | { found: false } | { error }.
async function loadTalents(region, realm, name, { force = false, slug = null } = {}) {
  try {
    const realms = await realmCandidates(region, realm, slug);
    const t = await blizz.talents({ region, realms, name, lang: 'fr', force });
    if (!t.found) return { found: false };
    const shown = t.specs.find((s) => s.active) || t.specs[0] || null;
    const lo = shown ? shown.loadouts.find((x) => x.active) || shown.loadouts[0] : null;
    const treeId = lo?.tree ?? shown?.loadouts.find((x) => x.tree)?.tree ?? null;
    const tree = shown && treeId ? await blizz.talentTree({ region, treeId, specId: shown.id, lang: 'fr' }).catch(() => null) : null;
    // Seul l'arbre de héros de la configuration est envoyé
    const heroes = tree ? tree.heroes.filter((h) => h.id === lo?.hero?.id) : [];
    if (tree) {
      for (const n of [...tree.classNodes, ...tree.specNodes, ...(tree.apex ? [tree.apex] : []), ...heroes.flatMap((h) => h.nodes)]) {
        for (const e of n.entries) if (e.spell) talentSpells.add(e.spell);
      }
    }
    return {
      found: true,
      at: t.at,
      spec: shown ? { id: shown.id, name: shown.name } : null,
      loadout: lo ? { code: lo.code, hero: lo.hero, picks: lo.picks } : null,
      tree: tree ? { ...tree, heroes } : null,
    };
  } catch (e) {
    if (e.code !== 'limit' && e.code !== 'down') console.error('[blizzard]', e.message);
    return { error: e.code === 'limit' ? 'limit' : 'down' };
  }
}

// Icônes des talents : celles de Blizzard. Sort -> nom du fichier, gardé en base (static_data,
// « spell-icons ») pour qu'un redémarrage ne redemande rien. On ne cherche que les sorts des arbres
// déjà servis (talentSpells) : personne ne peut faire dépenser des requêtes Blizzard au hasard.
const talentSpells = new Set();
const spellFetches = new Map();
setInterval(() => { const now = Date.now(); for (const [ip, h] of spellFetches) if (h.reset < now) spellFetches.delete(ip); }, 5 * 60e3).unref();
let spellIconMap = null;
let spellIconSave = null;
function spellIcons() {
  if (!spellIconMap) {
    spellIconMap = new Map();
    try {
      const row = staticStore().get.get('spell-icons');
      if (row) for (const [k, v] of Object.entries(JSON.parse(row.data))) spellIconMap.set(Number(k), v);
    } catch { /* ligne abîmée : les icônes seront redemandées */ }
  }
  return spellIconMap;
}
function keepSpellIcon(id, name) {
  spellIcons().set(id, name);
  if (spellIconSave) return;
  spellIconSave = setTimeout(() => {
    spellIconSave = null;
    try { staticStore().set.run('spell-icons', JSON.stringify(Object.fromEntries(spellIconMap)), Date.now()); } catch { /* retentée au prochain ajout */ }
  }, 5000);
}

// GET /api/talent-icon/<sort>.jpg : l'icône du talent, gardée sur le disque après le premier
// téléchargement. Sort inconnu : 404 ; trop de demandes ou Blizzard injoignable : redirigée.
async function serveTalentIcon(req, res, id) {
  const redirectTo = (name) => {
    res.writeHead(302, { Location: `https://render.worldofwarcraft.com/eu/icons/56/${name}.jpg`, 'Cache-Control': 'no-store' });
    res.end();
  };
  let name = spellIcons().get(id);
  const onDisk = name && icons.blizzardCached(name);
  if (onDisk) return sendIconFile(req, res, onDisk, () => redirectTo(name));
  if (!name && !talentSpells.has(id)) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
  const ip = clientIp(req);
  const now = Date.now();
  const h = spellFetches.get(ip);
  if (!h || h.reset < now) spellFetches.set(ip, { count: 1, reset: now + 60e3 });
  else if (++h.count > 400) return redirectTo(name || 'inv_misc_questionmark');
  if (!name) {
    name = await blizz.spellIcon('eu', id).catch(() => null);
    if (!name) return redirectTo('inv_misc_questionmark');
    keepSpellIcon(id, name);
  }
  const file = await icons.blizzard(name);
  if (!file) return redirectTo(name);
  sendIconFile(req, res, file, () => redirectTo(name));
}

/* ------------------------------------------------------------------ */
/* Données de la saison gardées en base                                */
/* ------------------------------------------------------------------ */
/* Raids du palier et donjons de la saison : demandés à Raider.IO une fois par jour au plus
 * (Blizzard ne dit pas quel raid est celui du palier en cours), puis gardés dans la table
 * `static_data`, donc un redémarrage ne redemande rien. Raider.IO injoignable ou liste vide :
 * on garde la dernière liste connue, et on réessaie une heure plus tard. */
const STATIC_MAX_AGE = 24 * 3600e3;
let staticQ = null;
function staticStore() {
  if (!staticQ) {
    accounts.db.exec(`CREATE TABLE IF NOT EXISTS static_data (
      key TEXT PRIMARY KEY,           -- « raids:eu », « dungeons:eu »…
      data TEXT NOT NULL,             -- JSON
      fetched_at INTEGER NOT NULL
    )`);
    staticQ = {
      get: accounts.db.prepare('SELECT data, fetched_at FROM static_data WHERE key = ?'),
      set: accounts.db.prepare(`INSERT INTO static_data (key, data, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`),
    };
  }
  return staticQ;
}

async function storedDaily(key, fetchFresh, isEmpty) {
  const q = staticStore();
  const row = q.get.get(key);
  let kept = null;
  if (row) { try { kept = JSON.parse(row.data); } catch { /* ligne abîmée : redemandée */ } }
  if (kept && Date.now() - row.fetched_at < STATIC_MAX_AGE) return kept;
  const fresh = await fetchFresh().catch(() => null);
  if (fresh && !isEmpty(fresh)) {
    q.set.run(key, JSON.stringify(fresh), Date.now());
    return fresh;
  }
  return kept || fresh;
}

// Donjons de la saison Mythique+ en cours (fiche joueur)
function fetchDungeons(region) {
  return cached(`rio:dungeons:${region}`, TTL.dungeons,
    () => storedDaily(`dungeons:${region}`, () => dungeonsFromRio(region), (d) => !d.dungeons.length));
}

async function dungeonsFromRio(region) {
  const now = Date.now();
  for (const exp of [12, 11, 10]) {
    try {
      const res = await fetch(`https://raider.io/api/v1/mythic-plus/static-data?expansion_id=${exp}`);
      if (!res.ok) continue;
      const j = await res.json();
      const seasons = (j.seasons || []).filter((s) => s.is_main_season !== false);
      const current = seasons.find((s) => {
        const start = Date.parse(s.starts?.[region] || s.starts?.us || '');
        const end = Date.parse(s.ends?.[region] || s.ends?.us || '');
        return start && start <= now && (!end || end > now);
      });
      if (current) {
        return {
          season: current.name,
          slug: current.slug,
          dungeons: (current.dungeons || []).map((d) => ({
            name: d.name, short: d.short_name, slug: d.slug, mapId: d.challenge_mode_id ?? null,
          })),
        };
      }
    } catch { /* expansion suivante */ }
  }
  return { season: null, dungeons: [] };
}

// Raids du palier en cours (un palier peut en compter plusieurs)
function fetchRaids(region) {
  return cached(`rio:raids:${region}`, TTL.raids,
    () => storedDaily(`raids:${region}`, () => raidsFromRio(region), (d) => !d.raids.length));
}

async function raidsFromRio(region) {
  const now = Date.now();
  for (const exp of [12, 11, 10]) {
    try {
      const res = await fetch(`https://raider.io/api/v1/raiding/static-data?expansion_id=${exp}`);
      if (!res.ok) continue;
      const j = await res.json();
      const current = (j.raids || []).filter((r) => {
        const start = Date.parse(r.starts?.[region] || r.starts?.us || '');
        const end = Date.parse(r.ends?.[region] || r.ends?.us || '');
        return start && start <= now && (!end || end > now);
      });
      if (current.length) {
        return {
          raids: current.map((r) => ({
            id: r.id, slug: r.slug, name: r.name, short: r.short_name,
            bosses: (r.encounters || []).map((e) => e.name),
          })),
        };
      }
    } catch { /* extension précédente */ }
  }
  return { raids: [] };
}

// Images de la saison : raids du palier (fond de l'histoire du journal) et portrait de chacun de
// leurs boss, image de chaque donjon Mythique+. La liste des boss et les identifiants viennent de
// l'API Blizzard (journal des rencontres) ; les images, des tables du jeu (journal.js).
function fetchSeasonArt(region) {
  return cached(`blizz:seasonart:${region}`, TTL.raids, async () => {
    if (!blizz.configured()) return { raids: [], dungeons: [] };
    const [{ raids }, { dungeons }] = await Promise.all([fetchRaids(region), fetchDungeons(region)]);
    const raidNames = (raids || []).map((r) => r.name).filter(Boolean);
    const dungeonNames = (dungeons || []).map((d) => d.name).filter(Boolean);
    const [r, d] = await Promise.all([
      raidNames.length ? storedDaily(`journal-raids:${region}:${raidNames.map(slugify).join(',')}`,
        () => blizz.raidArt({ region, names: raidNames }), (x) => !x.raids.some((y) => y.bosses.length)) : null,
      dungeonNames.length ? storedDaily(`journal-dungeons:${region}:${dungeonNames.map(slugify).join(',')}`,
        () => blizz.dungeonArt({ region, names: dungeonNames }), (x) => !x.dungeons.some((y) => y.id)) : null,
    ]);
    const image = async (id) => {
      if (!id) return null;
      const x = await journal.instance(id).catch(() => ({}));
      return x.lore || x.button || null;
    };
    return {
      raids: await Promise.all((r?.raids || []).map(async (x) => ({
        ...x,
        image: await image(x.id),
        bosses: await Promise.all(x.bosses.map(async (b) => ({ ...b, image: await journal.boss(b.id).catch(() => null) }))),
      }))),
      dungeons: await Promise.all((d?.dungeons || []).map(async (x) => ({ ...x, image: await image(x.id) }))),
    };
  });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Requête trop grosse.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const mailer = createMailer({ apiKey: BREVO_API_KEY, from: MAIL_FROM, publicUrl: PUBLIC_URL });
const accounts = createAccountManager({
  file: path.resolve(__dirname, ACCOUNTS_FILE),
  adminEmails: ADMIN_EMAILS,
  publicUrl: PUBLIC_URL,
  sendMail: (msg) => mailer.send(msg),
  t: i18n.t,
});
const bnet = createBnetManager({
  db: accounts.db,
  clientId: BNET_CLIENT_ID,
  clientSecret: BNET_CLIENT_SECRET,
  redirectUri: BNET_REDIRECT_URI,
});
// Notifications des comptes (cloche de la barre du haut), avec leur direct (voir notifications.js)
const notifier = createNotifier({ db: accounts.db });
// Recherche de groupe : annonces de raid, tags, recherches, chat (voir groups.js)
const groups = createGroupManager({
  db: accounts.db,
  notify: (id, kind, data, ref) => notifier.add(id, kind, data, ref),
});
// Au moment de l'envoi : une notification dit si son annonce existe encore
notifier.setDecorator((item) => {
  if (item.kind.startsWith('lfg_')) item.live = item.kind !== 'lfg_deleted' && groups.exists(item.data.code);
  return item;
});
const oauth = createOAuthManager({ config: OAUTH_CONFIG, baseUrl: PUBLIC_URL || `http://localhost:${PORT}` });

// Mesure d'audience maison, sans cookie tiers ni IP gardée (voir analytics.js)
const stats = createAnalytics({
  db: accounts.db,
  ownHosts: [PUBLIC_URL && (() => { try { return new URL(PUBLIC_URL).host; } catch { return null; } })(), 'localhost', '127.0.0.1'].filter(Boolean),
});
// Qui n'est pas compté : un admin (il fausserait ses propres chiffres, même « en tant que »
// quelqu'un), et quiconque a refusé (fenêtre « Confidentialité ») ou envoie le signal
// Global Privacy Control de son navigateur.
function statsCtx(req, who) {
  return {
    ip: clientIp(req),
    ua: String(req.headers['user-agent'] || ''),
    logged: Boolean(who),
    skip: who?.status === 'admin' || Boolean(accounts.impersonator(req))
      || req.headers['sec-gpc'] === '1' || req.headers['x-gs-nostats'] === '1',
  };
}
// Action réussie côté serveur. `who` = le compte après l'action (null pour un visiteur)
const track = (req, name, who) => stats.server(name, statsCtx(req, who));

// IP du visiteur. Derrière Caddy (sur la même machine), toutes les requêtes arrivent de
// 127.0.0.1 et la vraie adresse est dans X-Forwarded-For. L'en-tête n'est lu que si la requête
// vient de la machine elle-même (sinon n'importe qui s'inventerait une IP), et on prend la
// dernière adresse, celle ajoutée par Caddy. Aucun droit ne dépend de l'IP, seulement des limites.
const LOOPBACK = new Set(['127.0.0.1', '::1']);
function clientIp(req) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!LOOPBACK.has(peer)) return peer;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim().replace(/^::ffff:/, '');
  return require('net').isIP(fwd) ? fwd : peer;
}

// Formulaire de contact : 5 messages par heure et par IP, et des sujets connus
const CONTACT_MAX = 3000;
const CONTACT_TOPICS = { question: 'Question', bug: 'Problème sur le site', idea: 'Idée', data: 'Mes données', other: 'Autre' };
const contactHits = new Map();
function contactLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const h = contactHits.get(ip);
  if (!h || h.reset < now) { contactHits.set(ip, { count: 1, reset: now + 3600e3 }); return; }
  if (++h.count > 5) throw new HttpError(429, 'Tu as déjà envoyé plusieurs messages : réessaie dans une heure.');
}
setInterval(() => { const now = Date.now(); for (const [ip, h] of contactHits) if (h.reset < now) contactHits.delete(ip); }, 10 * 60e3).unref();

// Limite simple, par compte connecté, sinon par adresse IP. Deux compteurs : les lectures (GET),
// et les actions (le reste) : les pages qui se relisent toutes seules (/groups toutes les 30 s)
// ne mangent pas la limite des actions.
const hits = new Map();
function limitKey(req) {
  if (!('gsLimitWho' in req)) {
    let id = null;
    try { id = accounts.current(req)?.id ?? null; } catch { id = null; }
    req.gsLimitWho = id;
  }
  const who = req.gsLimitWho != null ? `a${req.gsLimitWho}` : `ip:${clientIp(req)}`;
  return `${req.method === 'GET' ? 'read' : 'act'}:${who}`;
}
function rateLimit(req, max = 60, windowMs = 60e3) {
  const key = limitKey(req);
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); return; }
  if (++h.count > max) throw new HttpError(429, 'Trop de requêtes. Réessaie dans une minute.');
}
setInterval(() => { const now = Date.now(); for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip); }, 5 * 60e3).unref();

// Backoffice de l'admin : tout ce que la base sait, plus ce qui ne vit qu'en mémoire ici
const STARTED_AT = Date.now();
const report = createAdminReport({
  db: accounts.db,
  accounts,
  live: {
    lockouts: () => accounts.lockouts(),
    blizzard: () => blizz.usage(),
    rateLimits: () => [...hits].filter(([, h]) => h.reset > Date.now()).map(([key, h]) => ({
      // « actions · compte 12 », « lectures · 1.2.3.4 » (les compteurs sont par compte ou par IP)
      ip: key.replace(/^read:/, 'lectures · ').replace(/^act:/, 'actions · ').replace(/· a(\d+)$/, '· compte $1').replace('ip:', ''),
      count: h.count, reset: h.reset,
    })).sort((a, b) => b.count - a.count).slice(0, 100),
    server: () => {
      let dbSize = null;
      try { dbSize = fs.statSync(path.resolve(__dirname, ACCOUNTS_FILE)).size; } catch { /* base absente */ }
      return {
        startedAt: STARTED_AT,
        node: process.version,
        memory: process.memoryUsage().rss,
        dbSize,
        cacheEntries: cache.size,
        publicUrl: PUBLIC_URL || null,
        mail: mailer.configured(),
        bnet: bnet.configured,
        adminEmails: ADMIN_EMAILS.length,
      };
    },
  },
});

// Recherche d'un joueur : un compte à l'adresse vérifiée
function requireSearchAccess(me) {
  if (!me) throw new HttpError(401, 'Connecte-toi pour chercher un joueur.');
  if (!accounts.publicAccount(me).canSearch) throw new HttpError(403, "Confirme d'abord ton adresse e-mail.");
}
// ?fresh=1 redemande tout, pour un admin (ou un admin « connecté en tant que ») seulement
const adminFresh = (req, url, me) => url.searchParams.get('fresh') === '1'
  && (me?.status === 'admin' || Boolean(accounts.impersonator(req)));

function readPlayer(url) {
  const name = String(url.searchParams.get('name') || '').trim();
  const realm = String(url.searchParams.get('realm') || '').trim();
  if (!name || !realm || name.length > 24 || realm.length > 64) throw new HttpError(400, 'Pseudo ou serveur invalide.');
  return { name, realm, region: readRegion(url) };
}

function readRegion(url) {
  const region = String(url.searchParams.get('region') || 'eu').toLowerCase();
  if (!REGIONS.includes(region)) throw new HttpError(400, 'Région inconnue.');
  return region;
}

/* ------------------------------------------------------------------ */
/* Comptes : inscription, connexion, vérification, administration     */
/* ------------------------------------------------------------------ */
function requireAccount(me) {
  if (!me) throw new HttpError(401, 'Connecte-toi pour faire ça.');
  return me;
}

function requireAdmin(me) {
  requireAccount(me);
  if (me.status !== 'admin') throw new HttpError(403, 'Réservé aux administrateurs.');
  return me;
}

// Un admin connecté « en tant que » quelqu'un voit tout de son compte, mais ne doit pas
// pouvoir l'en enfermer dehors : ni changer son mot de passe, ni supprimer son compte.
function refuseImpersonated(req, message) {
  if (!accounts.impersonator(req)) return;
  throw new HttpError(403, message);
}

// Codes de résultat renvoyés dans l'adresse après Google, Discord et Battle.net : en anglais
// (les liens du site le sont tous), mis en texte par le front. Les modules gardent leurs codes.
const RESULT_CODES = {
  connecte: 'signed-in', bienvenue: 'welcome', rattache: 'attached', lie: 'linked', refus: 'denied', lien: 'expired',
  adresse: 'email', pris: 'taken', deja: 'already', fournisseur: 'provider', indisponible: 'unavailable',
  usurpation: 'impersonation', connexion: 'login', existe: 'exists', 'nouveau-bnet': 'bnet-new',
};
const resultCode = (c) => RESULT_CODES[c] || c;

/* ------------------------------------------------------------------ */
/* Google et Discord : ce qu'on fait de l'identité rendue par oauth.js */
/* ------------------------------------------------------------------ */
// Cookie de courte durée (nonce de la connexion, rattachement en attente)
const shortCookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PUBLIC_URL.startsWith('https://') ? '; Secure' : ''}`;

// Rattachement en attente : quelqu'un arrive par Google avec l'adresse d'un compte qui existe
// déjà. Un seul compte par adresse, mais on ne rattache pas d'office : il faut d'abord entrer
// dans ce compte par son moyen habituel. Le rattachement se fait à cette connexion-là,
// seulement si c'est bien le compte de cette adresse. En mémoire, 15 min.
// Battle.net (connexion par Battle.net) : Blizzard ne donne pas d'adresse, donc un Battle.net
// lié à aucun compte attend ici le compte créé ou ouvert ensuite dans ce navigateur.
const PENDING_COOKIE = 'groupscout_rattacher';
const PENDING_TTL = 15 * 60e3;
const pendingLinks = new Map();   // id -> { provider, subject, email, bnet?, expires }
function addPending(link) {
  const t = Date.now();
  for (const [k, v] of pendingLinks) if (v.expires < t) pendingLinks.delete(k);
  if (pendingLinks.size > 5000) pendingLinks.delete(pendingLinks.keys().next().value);
  const id = crypto.randomBytes(24).toString('base64url');
  pendingLinks.set(id, { ...link, expires: t + PENDING_TTL });
  return id;
}
function pendingOf(req) {
  const id = readCookie(req, PENDING_COOKIE);
  const p = id ? pendingLinks.get(id) : null;
  return p && p.expires > Date.now() ? { id, ...p } : null;
}
// À appeler après une connexion réussie : rattache le service en attente si c'est le bon
// compte, et efface le cookie dans tous les cas. Renvoie le service rattaché, ou null.
function attachPending(req, row, cookies) {
  const id = readCookie(req, PENDING_COOKIE);
  if (!id) return null;
  cookies.push(shortCookie(PENDING_COOKIE, '', 0));
  const p = pendingOf(req);
  pendingLinks.delete(id);
  if (!p || !row) return null;
  if (p.provider === 'bnet') {
    try {
      // Un compte qui a déjà un autre Battle.net le garde : on ne remplace rien en silence
      const link = bnet.linkOf(row.id);
      if (link && link.bnetId !== p.bnet.bnetId) return null;
      bnet.saveLink(row.id, p.bnet);
      track(req, 'bnet', row);
      return 'bnet';
    } catch { return null; }
  }
  if (p.email !== row.email) return null;
  try {
    accounts.addIdentity(row.id, p.provider, p.subject, p.email);
    accounts.markVerified(row.id);            // le service a vérifié cette même adresse
    return p.provider;
  } catch { return null; }
}

// Redirection du navigateur ; le code ?oauth= passe en anglais (RESULT_CODES)
function redirect(res, location, cookies = []) {
  location = location.replace(/([?&]oauth=)([a-z-]+)/, (m, a, c) => a + resultCode(c));
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end();
  return true;
}

// Nonce de la connexion par Battle.net (même rôle que celui de oauth.js)
const BNET_NONCE_COOKIE = 'groupscout_bnet';

// Retour de Battle.net, dans le navigateur. Liaison (depuis le compte) : on finit la liaison et
// on revient avec ?bnet=<résultat>. Connexion : Battle.net déjà lié -> son compte est ouvert et
// la liste relue ; inconnu -> il attend le compte créé ou ouvert ensuite.
async function handleBnetCallback(req, url, res, me) {
  let st;
  try { st = bnet.takeState(url.searchParams.get('state'), readCookie(req, BNET_NONCE_COOKIE)); }
  catch (e) { return redirect(res, `${me ? '/account' : '/login'}?${me ? 'bnet' : 'oauth'}=${resultCode(e.code || 'lien')}${me ? '' : '&p=bnet'}`); }

  if (st.intent === 'link') {
    const back = (result) => redirect(res, withResult(st.back || '/account', `bnet=${resultCode(result)}`));
    if (!me || me.id !== st.accountId) return back('connexion');
    if (accounts.impersonator(req)) return back('usurpation');
    if (url.searchParams.get('error')) return back('refus');
    try {
      rateLimit(req, 10);
      bnet.saveLink(me.id, await bnet.readAccount(url.searchParams.get('code')));
      track(req, 'bnet', me);
      return back('ok');
    } catch (e) {
      if (!e.status) console.error('Liaison Battle.net :', e);
      return back(e.code || 'blizzard');
    }
  }

  const clearNonce = shortCookie(BNET_NONCE_COOKIE, '', 0);
  const fail = (code) => redirect(res, `/login?oauth=${code}&p=bnet`, [clearNonce]);
  if (url.searchParams.get('error')) return fail('refus');
  try {
    rateLimit(req, 20);
    const data = await bnet.readAccount(url.searchParams.get('code'));
    const accountId = bnet.accountOf(data.bnetId);
    if (!accountId) {
      // Déjà connecté (et pas en tant que quelqu'un d'autre) : autant le lier à ce compte
      if (me && !accounts.impersonator(req) && !bnet.linkOf(me.id)) {
        bnet.saveLink(me.id, data);
        track(req, 'bnet', me);
        return redirect(res, withResult(st.back || '/', 'bnet=ok'), [clearNonce]);
      }
      // La page demande alors l'adresse e-mail pour créer le compte (POST /api/auth/bnet/register)
      const id = addPending({ provider: 'bnet', bnet: data });
      const back = st.back ? `&back=${encodeURIComponent(st.back)}` : '';
      return redirect(res, `/login?oauth=nouveau-bnet&p=bnet${back}`, [clearNonce, shortCookie(PENDING_COOKIE, id, PENDING_TTL / 1000)]);
    }
    const row = accounts.promote(accounts.getById(accountId));
    if (!row) return fail('fournisseur');
    bnet.saveLink(row.id, data);                 // la liste est relue à chaque connexion
    track(req, 'connexion', row);
    if (me) accounts.closeSession(req);          // on change de compte : l'ancienne connexion est fermée
    const cookies = [clearNonce, accounts.cookieHeader(accounts.openSession(row, req))];
    const attached = attachPending(req, row, cookies);
    if (attached) return redirect(res, `/account?oauth=rattache&p=${attached}`, cookies);
    return redirect(res, withResult(st.back || '/', 'oauth=connecte&p=bnet'), cookies);
  } catch (e) {
    if (!e.status) console.error('Connexion Battle.net :', e);
    return fail(e.code || 'fournisseur');
  }
}

// Page où revenir après la connexion : un chemin du site, sans requête, jamais une autre adresse
const cleanBack = (v) => (/^\/(?!\/)[A-Za-z0-9/_-]{0,80}$/.test(String(v || '')) ? String(v) : null);
// Ajoute le résultat à l'adresse de retour, qu'elle ait déjà une requête ou non
const withResult = (back, query) => `${back}${back.includes('?') ? '&' : '?'}${query}`;

// Départ vers Google / Discord / Battle.net, et retour. Renvoie true si traité.
async function handleOAuth(req, url, res, me) {
  const m = url.pathname.match(/^\/api\/auth\/(google|discord|bnet)\/(start|callback)$/);
  if (!m) return false;
  if (req.method !== 'GET') throw new HttpError(405, 'Méthode non autorisée.');
  const [, provider, step] = m;
  const go = (location, cookies = []) => redirect(res, location, cookies);

  // Se connecter avec Battle.net : le retour arrive sur l'adresse de la liaison
  // (/api/account/bnet/callback, la seule déclarée chez Blizzard), voir handleBnetCallback
  if (provider === 'bnet') {
    if (step !== 'start') throw new HttpError(404, 'Introuvable.');
    try {
      rateLimit(req, 20);
      const { url: to, nonce } = bnet.startLogin({ back: cleanBack(url.searchParams.get('back')) });
      return go(to, [shortCookie(BNET_NONCE_COOKIE, nonce, 600)]);
    } catch (e) {
      return go(`/login?oauth=${e.code || 'indisponible'}&p=bnet`);
    }
  }

  if (step === 'start') {
    // ?link=1 : depuis la page du compte, pour y ajouter ce service
    const link = url.searchParams.get('link') === '1';
    if (link && !me) return go('/login');
    if (link && accounts.impersonator(req)) return go('/account?oauth=usurpation');
    try {
      rateLimit(req, 20);
      const { url: to, nonce } = oauth.start(provider, {
        intent: link ? 'link' : 'login',
        accountId: link ? me.id : null,
        back: cleanBack(url.searchParams.get('back')),
      });
      return go(to, [shortCookie(oauth.NONCE_COOKIE, nonce, 600)]);
    } catch (e) {
      return go(`${link ? '/account' : '/login'}?oauth=${e.code || 'fournisseur'}&p=${provider}`);
    }
  }

  const clearNonce = shortCookie(oauth.NONCE_COOKIE, '', 0);
  let st;
  try { st = oauth.takeState(provider, url.searchParams.get('state'), readCookie(req, oauth.NONCE_COOKIE)); }
  catch (e) { return go(`/login?oauth=${e.code || 'lien'}&p=${provider}`, [clearNonce]); }
  const fail = (code) => go(`${st.intent === 'link' ? '/account' : '/login'}?oauth=${code}&p=${provider}`, [clearNonce]);
  if (url.searchParams.get('error')) return fail('refus');
  try {
    rateLimit(req, 20);
    const who = await oauth.finish(provider, url.searchParams.get('code'));

    // Ajout depuis la page du compte : même compte connecté qu'au départ
    if (st.intent === 'link') {
      if (!me || me.id !== st.accountId) return fail('connexion');
      if (accounts.impersonator(req)) return fail('usurpation');
      accounts.addIdentity(me.id, provider, who.subject, who.email || null);
      return go(`/account?oauth=lie&p=${provider}`, [clearNonce]);
    }

    let row = accounts.accountForIdentity(provider, who.subject, who.email || null);
    let created = false;
    if (!row) {
      // Une adresse que le service n'a pas vérifiée ne prouve rien : ni création, ni rattachement
      if (!who.email || !who.emailVerified) return fail('adresse');
      if (accounts.getByEmail(who.email)) {
        const id = addPending({ provider, subject: who.subject, email: who.email });
        return go(`/login?oauth=existe&p=${provider}`, [clearNonce, shortCookie(PENDING_COOKIE, id, PENDING_TTL / 1000)]);
      }
      row = accounts.createFromIdentity({ provider, subject: who.subject, email: who.email, name: who.name });
      created = true;
    }
    track(req, created ? 'inscription' : 'connexion', row);
    if (me) accounts.closeSession(req);          // on change de compte : l'ancienne connexion est fermée
    const cookies = [clearNonce, accounts.cookieHeader(accounts.openSession(row, req))];
    const attached = attachPending(req, row, cookies);
    if (attached) return go(`/account?oauth=rattache&p=${attached}`, cookies);
    const back = st.back || '/';
    return go(withResult(back, `oauth=${created ? 'bienvenue' : 'connecte'}&p=${provider}`), cookies);
  } catch (e) {
    if (!e.status) console.error(`Connexion ${provider} :`, e);
    return fail(e.code || 'fournisseur');
  }
}

// Renvoie true si la requête a été traitée ici.
async function handleAuth(req, url, res, me) {
  const p = url.pathname;
  if (!p.startsWith('/api/auth') && !p.startsWith('/api/account') && !p.startsWith('/api/admin')) return false;

  // Ancien lien de vérification ouvert dans le navigateur : on redirige vers la page de connexion
  if (p === '/api/auth/verify' && req.method === 'GET') {
    let ok = true;
    try { accounts.verify(url.searchParams.get('token')); } catch { ok = false; }
    res.writeHead(302, { Location: `/login?${ok ? 'verified=1' : 'error=link'}`, 'Cache-Control': 'no-store' });
    return res.end(), true;
  }

  if (req.method !== 'POST' && req.method !== 'GET') throw new HttpError(405, 'Méthode non autorisée.');
  const body = req.method === 'POST' ? await readJson(req) : {};

  switch (p) {
    // Rattachement en attente : la page de connexion dit quel compte il faut ouvrir
    case '/api/auth/pending': {
      const pend = pendingOf(req);
      return sendJson(res, 200, { pending: pend ? { provider: pend.provider, email: pend.email || null, battletag: pend.bnet?.battletag || null } : null }), true;
    }

    // Délier Google ou Discord : { provider, action: "supprimer" }
    case '/api/account/identities': {
      requireAccount(me);
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      refuseImpersonated(req, "Impossible de changer les connexions de ce compte quand tu es connecté en tant que quelqu'un d'autre.");
      rateLimit(req, 10);
      if (body.action !== 'supprimer' || !oauth.isProvider(body.provider)) throw new HttpError(400, 'Action inconnue.');
      const row = accounts.removeIdentity(me.id, body.provider, { bnetLinked: Boolean(bnet.linkOf(me.id)) });
      return sendJson(res, 200, { account: accounts.publicAccount(row) }), true;
    }

    case '/api/auth/me':
      return sendJson(res, 200, { account: accounts.publicAccount(me), impersonatedBy: accounts.impersonator(req) }), true;

    case '/api/auth/register': {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      rateLimit(req, 10);
      const row = await accounts.register(body, req);
      track(req, 'inscription', row);
      const cookies = [accounts.cookieHeader(accounts.openSession(row, req))];
      // Arrivé par un Battle.net lié à aucun compte : il est lié à ce compte tout neuf
      const attached = attachPending(req, row, cookies);
      res.setHeader('Set-Cookie', cookies);
      return sendJson(res, 201, { account: accounts.publicAccount(accounts.getById(row.id)), attached }), true;
    }

    // Battle.net lié à aucun compte : Blizzard ne donne pas d'adresse, la personne tape la sienne
    // et le compte est créé avec, sans mot de passe, puis le Battle.net en attente y est lié.
    // Adresse déjà prise : { exists: true }, la page propose de se connecter à ce compte.
    case '/api/auth/bnet/register': {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      rateLimit(req, 10);
      const pend = pendingOf(req);
      if (pend?.provider !== 'bnet') throw new HttpError(400, 'Cette connexion a pris trop de temps. Recommence.');
      if (bnet.accountOf(pend.bnet.bnetId)) throw new HttpError(409, 'Ce Battle.net est déjà lié à un autre compte GroupScout.');
      if (accounts.getByEmail(body.email)) return sendJson(res, 200, { exists: true }), true;
      let row;
      try {
        row = await accounts.registerWithoutPassword({ email: body.email, name: String(pend.bnet.battletag || '').split('#')[0] });
      } catch (e) {
        if (e.code === 'existe') return sendJson(res, 200, { exists: true }), true;
        throw e;
      }
      track(req, 'inscription', row);
      if (me) accounts.closeSession(req);
      const cookies = [accounts.cookieHeader(accounts.openSession(row, req))];
      const attached = attachPending(req, row, cookies);
      res.setHeader('Set-Cookie', cookies);
      return sendJson(res, 201, { account: accounts.publicAccount(accounts.getById(row.id)), attached }), true;
    }

    case '/api/auth/login': {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      rateLimit(req, 20);
      let row;
      try { row = await accounts.login(body, req, clientIp(req)); } catch (e) { track(req, 'connexion_ratee', null); throw e; }
      track(req, 'connexion', row);
      const cookies = [accounts.cookieHeader(accounts.openSession(row, req))];
      const attached = attachPending(req, row, cookies);
      res.setHeader('Set-Cookie', cookies);
      return sendJson(res, 200, { account: accounts.publicAccount(accounts.getById(row.id)), attached }), true;
    }

    // Se connecter en tant que quelqu'un, depuis le backoffice. POST obligatoire : en GET, un
    // simple lien suffirait à déclencher le changement.
    case '/api/admin/impersonate': {
      requireAdmin(me);
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      rateLimit(req, 20);
      const { target, cookie } = accounts.impersonate(req, me, body.id);
      res.setHeader('Set-Cookie', accounts.cookieHeader(cookie));
      return sendJson(res, 200, { account: accounts.publicAccount(target) }), true;
    }

    // Retour à son compte : c'est la ligne de connexion qui porte le droit
    case '/api/auth/unimpersonate': {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      const { admin: back, cookie } = accounts.stopImpersonating(req);
      res.setHeader('Set-Cookie', accounts.cookieHeader(cookie));
      return sendJson(res, 200, { account: accounts.publicAccount(back) }), true;
    }

    case '/api/auth/logout':
      if (me) track(req, 'deconnexion', me);
      accounts.closeSession(req);
      res.setHeader('Set-Cookie', accounts.clearCookieHeader());
      return sendJson(res, 200, { ok: true }), true;

    case '/api/auth/resend': {
      rateLimit(req, 5);
      requireAccount(me);
      if (me.verified) return sendJson(res, 200, { ok: true }), true;
      await accounts.sendVerification(me);
      return sendJson(res, 200, { ok: true }), true;
    }

    // Code à 6 chiffres reçu par e-mail
    case '/api/auth/verify': {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      rateLimit(req, 20);
      requireAccount(me);
      const row = accounts.verifyCode(me, body.code);
      track(req, 'verification', row);
      return sendJson(res, 200, { account: accounts.publicAccount(row) }), true;
    }

    case '/api/auth/forgot': {
      rateLimit(req, 5);
      await accounts.forgot(body.email);
      // Toujours la même réponse : sinon on apprend quelles adresses ont un compte
      return sendJson(res, 200, { ok: true }), true;
    }

    case '/api/auth/reset': {
      rateLimit(req, 10);
      const row = await accounts.resetPassword(body.token, body.password);
      const cookies = [accounts.cookieHeader(accounts.openSession(row, req))];
      const attached = attachPending(req, row, cookies);
      res.setHeader('Set-Cookie', cookies);
      return sendJson(res, 200, { account: accounts.publicAccount(accounts.getById(row.id)), attached }), true;
    }

    case '/api/account': {
      requireAccount(me);
      if (req.method === 'GET') return sendJson(res, 200, { account: accounts.publicAccount(me), bnet: bnet.publicLink(me.id) }), true;
      if (body.action !== 'supprimer') throw new HttpError(400, 'Action inconnue.');
      refuseImpersonated(req, "Impossible de supprimer ce compte quand tu es connecté en tant que quelqu'un d'autre.");
      accounts.removeAccount(me.id);
      accounts.closeSession(req);
      res.setHeader('Set-Cookie', accounts.clearCookieHeader());
      return sendJson(res, 200, { ok: true }), true;
    }

    case '/api/account/password': {
      requireAccount(me);
      refuseImpersonated(req, "Impossible de changer ce mot de passe quand tu es connecté en tant que quelqu'un d'autre.");
      rateLimit(req, 10);
      await accounts.changePassword(me, body.current, body.password, clientIp(req));
      return sendJson(res, 200, { ok: true }), true;
    }

    // Lier (ou relire) son Battle.net : { action: "lier", back? } -> { url } où envoyer le
    // navigateur, { action: "supprimer" } pour délier, { action: "main", key } pour choisir son
    // personnage principal (le premier proposé quand on postule)
    case '/api/account/bnet': {
      requireAccount(me);
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      refuseImpersonated(req, "Impossible de changer le Battle.net de ce compte quand tu es connecté en tant que quelqu'un d'autre.");
      if (body.action === 'main') {
        rateLimit(req);
        bnet.setMain(me.id, body.key || null);
        return sendJson(res, 200, { bnet: bnet.publicLink(me.id) }), true;
      }
      rateLimit(req, 10);
      if (body.action === 'supprimer') {
        // Un compte créé par Battle.net n'a ni mot de passe ni autre service : le délier l'enfermerait dehors
        if (!me.password_hash && !accounts.publicAccount(me).identities.length) {
          throw new HttpError(400, "C'est ta seule façon de te connecter : choisis d'abord un mot de passe.");
        }
        bnet.unlink(me.id);
        return sendJson(res, 200, { bnet: bnet.publicLink(me.id) }), true;
      }
      if (body.action !== 'lier') throw new HttpError(400, 'Action inconnue.');
      return sendJson(res, 200, { url: bnet.startLink(me.id, { back: cleanBack(body.back) }) }), true;
    }

    // Retour de Battle.net, dans le navigateur : liaison ou connexion (handleBnetCallback)
    case '/api/account/bnet/callback':
      return handleBnetCallback(req, url, res, me);

    case '/api/account/name': {
      requireAccount(me);
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      accounts.setName(me.id, body.name);
      return sendJson(res, 200, { account: accounts.publicAccount(accounts.getById(me.id)) }), true;
    }

    case '/api/admin/accounts': {
      requireAdmin(me);
      const liste = () => report.listAccounts(me.id);
      if (req.method === 'GET') return sendJson(res, 200, { accounts: liste() }), true;
      // { id, status } pour changer le statut, { id, action: "supprimer" } pour effacer
      if (Number(body.id) === me.id && body.status && body.status !== 'admin') {
        throw new HttpError(400, 'Tu ne peux pas retirer ton propre statut admin.');
      }
      if (body.action === 'supprimer') accounts.removeAccount(body.id);
      else accounts.setStatus(body.id, String(body.status || ''));
      return sendJson(res, 200, { accounts: liste() }), true;
    }

    // Backoffice : lecture seule, tout en GET
    case '/api/admin/overview': requireAdmin(me); return sendJson(res, 200, report.overview()), true;
    // Requêtes à l'API Blizzard cette heure (clé du site), relues par le menu du compte
    case '/api/admin/blizzard': requireAdmin(me); return sendJson(res, 200, blizz.usage()), true;
    case '/api/admin/account': requireAdmin(me); return sendJson(res, 200, report.accountDetail(url.searchParams.get('id'), me.id)), true;
    case '/api/admin/groups': requireAdmin(me); return sendJson(res, 200, report.groups()), true;
    case '/api/admin/bnet': requireAdmin(me); return sendJson(res, 200, report.battlenet(Object.fromEntries(url.searchParams))), true;
    case '/api/admin/security': requireAdmin(me); return sendJson(res, 200, report.security()), true;
    // Audience : le rapport, la liste des visites (`visits=1`) ou le détail d'une visite (`visit=`)
    case '/api/admin/audience': {
      requireAdmin(me);
      const q = Object.fromEntries(url.searchParams);
      if (q.visit) return sendJson(res, 200, stats.visitDetail(q.visit)), true;
      if (q.visits) return sendJson(res, 200, stats.listVisits(q)), true;
      return sendJson(res, 200, stats.report(q)), true;
    }

    default:
      throw new HttpError(404, 'Route inconnue.');
  }
}

// Notifications : /api/notifications (liste), /events (direct), /read et /clear ({ ids? })
async function handleNotifications(req, url, res, me) {
  requireAccount(me);
  const route = url.pathname.replace(/^\/api\/notifications\/?/, '').replace(/\/$/, '');
  if (req.method === 'GET') {
    if (route === '') return sendJson(res, 200, notifier.list(me.id));
    if (route === 'events') return notifier.stream(me.id, req, res);
    throw new HttpError(404, 'Route inconnue.');
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
  rateLimit(req, 60);
  const body = await readJson(req);
  const ids = Array.isArray(body.ids) ? body.ids : undefined;
  // Un admin « connecté en tant que » regarde : il ne change rien aux notifications du compte
  if (accounts.impersonator(req)) return sendJson(res, 200, notifier.list(me.id));
  if (route === 'read') return sendJson(res, 200, notifier.markRead(me.id, ids));
  if (route === 'clear') return sendJson(res, 200, notifier.remove(me.id, ids));
  throw new HttpError(404, 'Route inconnue.');
}

/* ------------------------------------------------------------------ */
/* Recherche de groupe (groups.js)                                     */
/* ------------------------------------------------------------------ */
// Ce qui accompagne un tag, une recherche ou le personnage d'un leader (`snapshot`) : le profil
// Blizzard du personnage, sans ses clés Mythique+ (inutiles pour un raid, et lourdes)
async function lfgSnapshot(char, { force = false } = {}) {
  const profile = await loadProfile(groups.REGION, char.realm, char.name, { force, slug: char.realmSlug });
  if (!profile.found) return { profile: null, profileError: profile.error || 'missing', at: Date.now() };
  const { found: _f, bestRuns: _b, alternateRuns: _a, recentRuns: _r, highestRuns: _h, ...data } = profile;
  return { profile: data, profileError: null, at: Date.now() };
}

// Se taguer, poster une annonce ou une recherche : un compte à l'adresse vérifiée, avec son
// Battle.net lié (le personnage doit en faire partie)
function requireLfg(me) {
  requireAccount(me);
  if (!me.verified) throw new HttpError(403, "Confirme d'abord ton adresse e-mail.");
  if (!bnet.linkOf(me.id)) throw new HttpError(403, 'Lie ton Battle.net dans ton compte pour choisir ton personnage.');
  return me;
}
const lfgRaids = async () => (await fetchRaids(groups.REGION).catch(() => null))?.raids || [];

// /api/groups                     GET : annonces en cours ; POST : poster une annonce
// /api/groups/searches            GET : joueurs qui cherchent ; POST : publier ou modifier sa recherche
// /api/groups/searches/close|refresh
// /api/groups/mine                GET : ton annonce, tes tags, ta recherche
// /api/groups/<CODE>              GET : la page du raid ; /events : son direct
// /api/groups/<CODE>/<action>     POST : voir le switch plus bas
async function handleGroups(req, url, res, me) {
  const admin = me?.status === 'admin';
  const viewer = me?.id ?? null;
  const parts = url.pathname.replace(/^\/api\/groups\/?/, '').split('/').filter(Boolean);
  const isCode = (v) => /^[A-Za-z]{6}$/.test(v || '');

  if (req.method === 'GET') {
    rateLimit(req, 120);
    if (!parts.length) {
      // ?from=&to= : les annonces d'un jour du calendrier de l'accueil (deux jours au plus)
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const range = url.searchParams.has('from') && Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 2 * 864e5;
      return sendJson(res, 200, { listings: groups.list({ viewerId: viewer, ...(range ? { from, to } : {}) }) });
    }
    if (parts.length === 1 && parts[0] === 'calendar') return sendJson(res, 200, { raids: groups.calendar() });
    if (parts.length === 1 && parts[0] === 'searches') return sendJson(res, 200, { searches: groups.searches({ viewerId: viewer }) });
    if (parts.length === 1 && parts[0] === 'mine') { requireAccount(me); return sendJson(res, 200, groups.mine(me.id)); }
    if (isCode(parts[0]) && parts.length === 1) return sendJson(res, 200, { listing: groups.view(parts[0], viewer, admin) });
    if (isCode(parts[0]) && parts.length === 2 && parts[1] === 'events') return groups.subscribe(parts[0], req, res, viewer, admin);
    throw new HttpError(404, 'Route inconnue.');
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
  rateLimit(req, 60);
  requireAccount(me);
  const body = await readJson(req);

  // Poster une annonce : validée d'abord, puis le personnage du leader est chargé
  if (!parts.length) {
    requireLfg(me);
    rateLimit(req, 20);
    const v = groups.create(me.id, body, { chars: bnet.characters(me.id), raids: await lfgRaids() });
    const lead = v.tags.find((t) => t.leader);
    groups.saveTagSnapshot(v.code, lead.id, await lfgSnapshot(lead.char));
    track(req, 'annonce', me);
    return sendJson(res, 201, { listing: groups.view(v.code, me.id, admin) });
  }

  if (parts[0] === 'searches') {
    if (parts.length === 1) {
      requireLfg(me);
      rateLimit(req, 20);
      const s = groups.saveSearch(me.id, body, { chars: bnet.characters(me.id), raids: await lfgRaids() });
      // Nouvelle recherche ou autre personnage : son profil est chargé maintenant
      if (!s.snapshot?.at) groups.saveSearchSnapshot(s.id, await lfgSnapshot(s.char));
      track(req, 'recherche_raid', me);
      return sendJson(res, 200, { search: groups.mine(me.id).search });
    }
    if (parts.length === 2 && parts[1] === 'close') return sendJson(res, 200, groups.closeSearch(me.id));
    if (parts.length === 2 && parts[1] === 'refresh') {
      rateLimit(req, 10);
      const s = groups.ownSearch(me.id);
      groups.saveSearchSnapshot(s.id, await lfgSnapshot(s.char, { force: true }));
      return sendJson(res, 200, { search: groups.mine(me.id).search });
    }
    throw new HttpError(404, 'Route inconnue.');
  }

  if (!isCode(parts[0]) || parts.length !== 2) throw new HttpError(404, 'Route inconnue.');
  const code = parts[0].toUpperCase();
  let out;
  switch (parts[1]) {
    case 'edit': out = groups.edit(code, me.id, body, { raids: await lfgRaids(), admin }); break;
    case 'delete': return sendJson(res, 200, groups.remove(code, me.id, admin));
    // Se taguer : { char, role, note }. Le tag est posé, puis le profil du personnage chargé
    case 'tag': {
      requireLfg(me);
      rateLimit(req, 30);
      const v = groups.tag(code, me.id, body, { chars: bnet.characters(me.id) });
      const t = v.me.tag;
      groups.saveTagSnapshot(code, t.id, await lfgSnapshot(t.char));
      track(req, 'candidature', me);
      out = groups.view(code, me.id, admin);
      break;
    }
    case 'note': out = groups.setNote(code, me.id, body.note); break;
    case 'withdraw': out = groups.withdraw(code, me.id); break;
    // « Actualiser » : le joueur recharge son profil
    case 'refresh': {
      rateLimit(req, 10);
      const o = groups.ownTag(code, me.id);
      groups.saveTagSnapshot(code, o.tag.id, await lfgSnapshot(o.char, { force: true }));
      out = groups.view(code, me.id, admin);
      break;
    }
    case 'invite': out = groups.invite(code, me.id, body, admin); break;
    case 'decline': out = groups.decline(code, me.id, body, admin); break;
    case 'offer': requireLfg(me); out = groups.offer(code, me.id, body, admin); track(req, 'place_proposee', me); break;
    case 'answer': out = groups.answer(code, me.id, body.accept === true); if (body.accept === true) track(req, 'place_acceptee', me); break;
    case 'kick': out = groups.kick(code, me.id, body, admin); break;
    case 'leave': out = groups.leave(code, me.id, body.message); break;
    case 'colead': out = groups.setCo(code, me.id, body, admin); break;
    case 'chat': rateLimit(req, 30); return sendJson(res, 200, { message: groups.post(code, me.id, body.text, admin) });
    case 'chat-delete': return sendJson(res, 200, groups.deleteMessage(code, me.id, body.id, admin));
    default: throw new HttpError(404, 'Action inconnue.');
  }
  return sendJson(res, 200, { listing: out });
}

async function handleApi(req, url, res) {
  // Icônes et images : ni compte ni cookie, avant tout le reste
  const iconMatch = url.pathname.match(/^\/api\/icon\/([A-Za-z0-9_.-]{1,120})\.png$/);
  if (iconMatch && (req.method === 'GET' || req.method === 'HEAD')) return serveItemIcon(req, res, iconMatch[1]);
  const journalMatch = url.pathname.match(/^\/api\/journal\/(\d{1,10}(?:-button|-lore|-boss)?)\.png$/);
  if (journalMatch && (req.method === 'GET' || req.method === 'HEAD')) return serveJournalImage(req, res, journalMatch[1]);
  const talentIconMatch = url.pathname.match(/^\/api\/talent-icon\/(\d{1,9})\.jpg$/);
  if (talentIconMatch && (req.method === 'GET' || req.method === 'HEAD')) return serveTalentIcon(req, res, Number(talentIconMatch[1]));
  // Compte connecté (cookie signé), ou null
  const me = accounts.current(req);
  const admin = me?.status === 'admin';

  if (await handleOAuth(req, url, res, me)) return;
  if (await handleAuth(req, url, res, me)) return;
  if (url.pathname === '/api/notifications' || url.pathname.startsWith('/api/notifications/')) return handleNotifications(req, url, res, me);
  if (url.pathname === '/api/groups' || url.pathname.startsWith('/api/groups/')) return handleGroups(req, url, res, me);

  switch (url.pathname) {
    // Formulaire de contact : { name?, email, topic, message, website } → un e-mail au propriétaire,
    // avec l'adresse du visiteur en « répondre à ». Rien n'est gardé sur le site. `website` est
    // un piège à robots (champ caché) : rempli, on répond comme si c'était parti.
    case '/api/contact': {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      rateLimit(req);
      const body = await readJson(req, 16 * 1024);
      if (String(body.website || '').trim()) return sendJson(res, 200, { sent: true });
      const clean = (v, n) => String(v ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, n);
      const email = clean(body.email, 200).toLowerCase();
      const name = clean(body.name, 60).replace(/\s+/g, ' ');
      const message = clean(body.message, CONTACT_MAX);
      const topic = CONTACT_TOPICS[body.topic] ? body.topic : 'other';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Cette adresse e-mail ne ressemble à rien.');
      if (message.length < 10) throw new HttpError(400, 'Ton message est un peu court : dis-nous en un peu plus.');
      contactLimit(req);
      const who = me ? `compte n° ${me.id} (${me.email}${me.name ? `, ${me.name}` : ''})` : 'pas connecté';
      const text = [
        `De : ${name || '(sans pseudo)'} <${email}>`,
        `Sujet : ${CONTACT_TOPICS[topic]}`,
        `Compte GroupScout : ${who}`,
        '',
        message,
      ].join('\n');
      const ok = await mailer.sendMessage({
        to: CONTACT_EMAIL,
        replyTo: { email, name },
        subject: `[GroupScout] ${CONTACT_TOPICS[topic]}${name ? ` · ${name}` : ''}`,
        text,
      });
      if (!ok) throw new HttpError(502, "Ton message n'a pas pu partir. Réessaie dans quelques minutes.");
      return sendJson(res, 200, { sent: true });
    }
    // Mesure d'audience : envoyée par le navigateur (sendBeacon), toujours 204, même refusée
    case '/api/stats': {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      let body = {};
      try { body = await readJson(req, 16 * 1024); } catch { /* envoi abîmé : ignoré */ }
      stats.collect(body, statsCtx(req, me));
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    // Badges VIP et admin d'une liste de personnages (clés « eu:pseudo-serveur »)
    case '/api/badges': {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée.');
      rateLimit(req, 120);
      const body = await readJson(req);
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
      return sendJson(res, 200, bnet.badgeKeys(keys));
    }
    // Fiche joueur : le profil du personnage (API Blizzard), et son main s'il en a choisi un sur
    // GroupScout → { profile: { found, … } | { found: false } | { error }, main }
    case '/api/player': {
      rateLimit(req, 30);
      requireSearchAccess(me);
      const p = readPlayer(url);
      const force = adminFresh(req, url, me);
      const profile = await loadProfile(p.region, p.realm, p.name, { force });
      if (!profile.error) track(req, profile.found ? 'recherche_joueur' : 'joueur_introuvable', me);
      if (!profile.found) return sendJson(res, 200, { profile });
      // Main choisi sur GroupScout par le propriétaire du personnage (Battle.net de /account)
      let main = bnet.declaredMain(`${p.region}:${norm(p.name)}-${norm(profile.realmSlug)}`);
      if (main === undefined) main = bnet.declaredMain(`${p.region}:${norm(p.name)}-${norm(p.realm)}`);
      if (main?.name && main.realmSlug) {
        const m = await loadProfile(main.region || p.region, main.realmSlug, main.name, { force, slug: main.realmSlug });
        main = { ...main, score: m.found ? m.score : null, itemLevel: m.found ? m.itemLevel : null, raidProgress: m.found ? m.raidProgress : null };
      }
      return sendJson(res, 200, { profile, main: main === undefined ? null : main });
    }
    // Fiche joueur : équipement du personnage
    case '/api/player/gear': {
      rateLimit(req, 30);
      requireSearchAccess(me);
      const p = readPlayer(url);
      return sendJson(res, 200, { gear: await loadGear(p.region, p.realm, p.name, { force: adminFresh(req, url, me) }) });
    }
    // Fiche joueur : talents du personnage
    case '/api/player/talents': {
      rateLimit(req, 30);
      requireSearchAccess(me);
      const p = readPlayer(url);
      return sendJson(res, 200, { talents: await loadTalents(p.region, p.realm, p.name, { force: adminFresh(req, url, me) }) });
    }
    case '/api/status':
      return sendJson(res, 200, {
        account: accounts.publicAccount(me),
        // L'admin qui regarde le site avec les yeux de ce compte, ou null
        impersonatedBy: accounts.impersonator(req),
        admin,
        mail: { configured: mailer.configured() },
        // Boutons « Continuer avec Google / Discord / Battle.net » : seulement pour un service configuré
        oauth: { ...oauth.available(), bnet: bnet.configured },
        // Admins : requêtes à l'API Blizzard cette heure (clé du site, tous les comptes confondus)
        blizzard: admin ? blizz.usage() : null,
      });
    case '/api/dungeons':
      return sendJson(res, 200, await fetchDungeons(readRegion(url)));
    case '/api/raids':
      return sendJson(res, 200, await fetchRaids(readRegion(url)));
    case '/api/season/art':
      return sendJson(res, 200, await fetchSeasonArt(readRegion(url)));
    default:
      throw new HttpError(404, 'Route inconnue.');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Pages du site : toutes servies par index.html, le front lit l'adresse
const PAGE_RE = [
  /^\/$/,
  /^\/(login|account|admin|reset-password|privacy|terms|contact)\/?$/i,
  /^\/player(\/[^/]+\/[^/]+)?\/?$/i,
  /^\/groups(\/(players|new|search|[A-Za-z]{6}(\/edit)?))?\/?$/i,
];

function serveStatic(req, pathname, res) {
  if (pathname === '/index.html' || PAGE_RE.some((re) => re.test(pathname))) {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, url, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, url.pathname, res);
  } catch (e) {
    if (!e.status) console.error(e);
    if (res.headersSent) return res.end();
    return sendJson(res, e.status || 500, { error: errorText(e.status ? e : null) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  GroupScout tourne sur http://localhost:${PORT}`);
    console.log(`  Comptes : ${accounts.count()} en base${ADMIN_EMAILS.length ? `, admin d'office : ${ADMIN_EMAILS.join(', ')}` : " — ATTENTION : aucun ADMIN_EMAILS dans .env, personne ne sera admin"}`);
    console.log(`  E-mails : ${mailer.configured() ? 'Brevo configuré' : 'non configurés, les codes et les liens s\'afficheront ici'}`);
    if (mailer.configured() && !PUBLIC_URL) console.log('  ATTENTION : PUBLIC_URL est vide, les liens des e-mails seront inutilisables.');
    console.log(bnet.configured
      ? `  Battle.net : liaison active, retour sur ${BNET_REDIRECT_URI}`
      : '  Battle.net : BNET_CLIENT_ID / BNET_CLIENT_SECRET absents : personne ne peut lier son Battle.net, donc ni poster ni postuler');
    if (!blizz.configured()) console.log('  ATTENTION : sans BNET_CLIENT_ID / BNET_CLIENT_SECRET, aucun profil de personnage ne se charge (API Blizzard).');
    for (const id of ['google', 'discord']) {
      console.log(oauth.configured(id)
        ? `  ${oauth.label(id)} : connexion active, retour sur ${oauth.redirectUri(id)}`
        : `  ${oauth.label(id)} : ${id.toUpperCase()}_CLIENT_ID / ${id.toUpperCase()}_CLIENT_SECRET absents, bouton désactivé`);
    }
    console.log('');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}

module.exports = { server, accounts, bnet, groups, oauth, blizz };
