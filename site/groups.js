'use strict';
/* Recherche de groupe du site : le cœur de GroupScout.
 *
 * Deux côtés :
 *  - l'annonce d'un raid leader (« je fais un raid ce soir de 20 h à 23 h, je cherche du monde »),
 *    où les joueurs se taguent avec un de leurs personnages, que le leader invite petit à petit ;
 *  - la recherche d'un joueur (« je cherche un raid ce soir de 20 h à 23 h 30 »), à qui un leader
 *    peut proposer une place.
 *
 * Tout est public (annonces, groupe, tags, recherches), sauf le chat du raid, réservé aux membres
 * acceptés. Raid seulement pour l'instant ; `kind` prépare le Mythique+ (une annonce de chaque au
 * plus par compte).
 *
 * Ce module ne fait que les règles et le stockage, sans réseau : server.js charge le profil
 * Blizzard du personnage (ce qui accompagne un tag ou une recherche, `snapshot` : spé, niveau
 * d'objet, progression) et le lui passe. Il ne voit jamais d'identifiants d'API.
 *
 * Tables (même base que les comptes, supprimées avec le compte) :
 *  - lfg_listings : une annonce (réglages en JSON dans `data`) ;
 *  - lfg_tags     : un compte dans une annonce (tag, invitation, membre, départ…), une ligne par
 *                   compte et par annonce ; le leader y est un membre comme un autre (`leader`) ;
 *  - lfg_searches : la recherche d'un joueur (une active par compte) ;
 *  - lfg_messages : le chat du raid.
 * Une annonce et tout ce qui s'y rattache sont effacés 24 h après la fin du raid (le chat vit
 * 24 h de plus, demande de l'utilisateur) ; une recherche, une heure après la fin de son créneau. */

const crypto = require('crypto');

const REGION = 'eu';
const ROLES = ['tank', 'heal', 'dps'];
const CLASSES = ['Death Knight', 'Demon Hunter', 'Druid', 'Evoker', 'Hunter', 'Mage', 'Monk', 'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior'];
// Langues proposées avec leur drapeau : celles du site, plus d'autres langues de l'Union européenne
// (le russe a été retiré à la demande de l'utilisateur, 30 septembre 2026)
const LANGS = ['en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'nl', 'sv'];
const GOALS = ['reclear', 'progress'];
const DIFFICULTIES = [3, 4, 5];               // normal, héroïque, mythique (mêmes numéros que shared.js)
const DEFAULT_COMP = { tank: 2, heal: 4, dps: 14 };

const MAX_AHEAD = 14 * 24 * 3600e3;           // jusqu'à 14 jours à l'avance
const MIN_LENGTH = 30 * 60e3;
const MAX_LENGTH = 12 * 3600e3;
const START_GRACE = 15 * 60e3;                // un début dans le passé récent est accepté (formulaire rempli lentement)
const KEEP_AFTER_END = 24 * 3600e3;           // annonce, tags et chat : effacés 24 h après la fin
const SEARCH_KEEP = 3600e3;                   // recherche : effacée une heure après la fin du créneau
const TITLE_MAX = 60;
const DESC_MAX = 600;
const NOTE_MAX = 200;
const MESSAGE_MAX = 200;                      // message obligatoire d'un départ ou d'un retrait
const CHAT_MAX = 500;
const CHAT_SENT = 200;                        // messages envoyés à l'ouverture
const MAX_VIEWERS = 200;
const HEARTBEAT_MS = 25e3;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // sans I ni O, qui se confondent avec 1 et 0

// Statuts d'une ligne de lfg_tags
//  pending   : tagué, en attente du leader         invited  : place proposée, en attente du joueur
//  accepted  : membre du raid                       declined : refusé par le leader
//  refused   : proposition refusée par le joueur    withdrawn: tag retiré (par le joueur, ou tout seul quand il rejoint un autre raid)
//  removed   : retiré du raid par le leader         left     : a quitté le raid
const OPEN = new Set(['pending', 'invited', 'accepted']);

function httpError(status, message, vars) {
  const e = new Error(message);
  e.status = status;
  if (vars) e.vars = vars;
  return e;
}

const clean = (v, n) => String(v ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
// Texte sur plusieurs lignes (description) : retours à la ligne gardés, deux au plus d'affilée
const cleanText = (v, n) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
const json = (raw, fallback) => { try { return JSON.parse(raw) ?? fallback; } catch { return fallback; } };
const overlaps = (a, b) => a.starts_at < b.ends_at && b.starts_at < a.ends_at;
// Lien d'invitation Discord (discord.gg/…, discord.com/invite/…), remis sous une forme unique ; null s'il ne l'est pas
function discordInvite(v) {
  const m = String(v ?? '').trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|(?:discord|discordapp)\.com\/invite)\/([A-Za-z0-9-]{2,32})\/?(?:[?#].*)?$/i);
  return m ? `https://discord.gg/${m[1]}` : null;
}

function createGroupManager({ db, notify = () => {}, now = () => Date.now() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lfg_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'raid',
      data TEXT NOT NULL DEFAULT '{}',
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lfg_listings_end ON lfg_listings(ends_at);
    CREATE INDEX IF NOT EXISTS lfg_listings_account ON lfg_listings(account_id);
    CREATE TABLE IF NOT EXISTS lfg_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES lfg_listings(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      char_key TEXT NOT NULL,
      char TEXT NOT NULL,
      role TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'tag',
      leader INTEGER NOT NULL DEFAULT 0,
      co INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      snapshot TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (listing_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS lfg_tags_account ON lfg_tags(account_id);
    CREATE TABLE IF NOT EXISTS lfg_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'raid',
      char_key TEXT NOT NULL,
      char TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      snapshot TEXT NOT NULL DEFAULT '{}',
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lfg_searches_end ON lfg_searches(ends_at);
    CREATE TABLE IF NOT EXISTS lfg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES lfg_listings(id) ON DELETE CASCADE,
      account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'msg',
      author TEXT,
      text TEXT NOT NULL DEFAULT '',
      data TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lfg_messages_listing ON lfg_messages(listing_id, id);
  `);

  const q = {
    listingByCode: db.prepare('SELECT * FROM lfg_listings WHERE code = ?'),
    listingById: db.prepare('SELECT * FROM lfg_listings WHERE id = ?'),
    codeUsed: db.prepare('SELECT 1 FROM lfg_listings WHERE code = ?'),
    activeListings: db.prepare('SELECT * FROM lfg_listings WHERE ends_at > ? ORDER BY starts_at, id'),
    ownActive: db.prepare('SELECT * FROM lfg_listings WHERE account_id = ? AND kind = ? AND ends_at > ?'),
    insertListing: db.prepare(`INSERT INTO lfg_listings (code, account_id, kind, data, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateListing: db.prepare('UPDATE lfg_listings SET data = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?'),
    deleteListing: db.prepare('DELETE FROM lfg_listings WHERE id = ?'),
    tags: db.prepare('SELECT * FROM lfg_tags WHERE listing_id = ? ORDER BY created_at, id'),
    tag: db.prepare('SELECT * FROM lfg_tags WHERE id = ?'),
    tagOf: db.prepare('SELECT * FROM lfg_tags WHERE listing_id = ? AND account_id = ?'),
    insertTag: db.prepare(`INSERT INTO lfg_tags (listing_id, account_id, char_key, char, role, note, status, origin, leader, snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    retag: db.prepare(`UPDATE lfg_tags SET char_key = ?, char = ?, role = ?, note = ?, status = ?, origin = ?, co = 0, message = NULL,
      snapshot = ?, updated_at = ? WHERE id = ?`),
    setStatus: db.prepare('UPDATE lfg_tags SET status = ?, message = ?, co = CASE WHEN ? = \'accepted\' THEN co ELSE 0 END, updated_at = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE lfg_tags SET role = ?, updated_at = ? WHERE id = ?'),
    setNote: db.prepare('UPDATE lfg_tags SET note = ?, updated_at = ? WHERE id = ?'),
    setCo: db.prepare('UPDATE lfg_tags SET co = ?, updated_at = ? WHERE id = ?'),
    setSnapshot: db.prepare('UPDATE lfg_tags SET snapshot = ?, updated_at = ? WHERE id = ?'),
    // Tags d'un compte dans les annonces encore à venir ou en cours
    accountTags: db.prepare(`SELECT t.*, l.code, l.starts_at, l.ends_at, l.data AS listing_data, l.account_id AS owner_id
      FROM lfg_tags t JOIN lfg_listings l ON l.id = t.listing_id WHERE t.account_id = ? AND l.ends_at > ? ORDER BY l.starts_at`),
    search: db.prepare('SELECT * FROM lfg_searches WHERE id = ?'),
    ownSearch: db.prepare('SELECT * FROM lfg_searches WHERE account_id = ? AND kind = ? AND ends_at > ?'),
    activeSearches: db.prepare('SELECT * FROM lfg_searches WHERE ends_at > ? ORDER BY starts_at, id'),
    insertSearch: db.prepare(`INSERT INTO lfg_searches (account_id, kind, char_key, char, data, snapshot, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateSearch: db.prepare('UPDATE lfg_searches SET char_key = ?, char = ?, data = ?, snapshot = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?'),
    setSearchSnapshot: db.prepare('UPDATE lfg_searches SET snapshot = ?, updated_at = ? WHERE id = ?'),
    deleteSearch: db.prepare('DELETE FROM lfg_searches WHERE id = ?'),
    messages: db.prepare(`SELECT * FROM (SELECT * FROM lfg_messages WHERE listing_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`),
    message: db.prepare('SELECT * FROM lfg_messages WHERE id = ?'),
    insertMessage: db.prepare('INSERT INTO lfg_messages (listing_id, account_id, kind, author, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    deleteMessage: db.prepare('DELETE FROM lfg_messages WHERE id = ?'),
    purgeListings: db.prepare('DELETE FROM lfg_listings WHERE ends_at < ?'),
    purgeSearches: db.prepare('DELETE FROM lfg_searches WHERE ends_at < ?'),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  /* ---------------------------------------------------------------- */
  /* Validation                                                        */
  /* ---------------------------------------------------------------- */
  // Personnage choisi : il doit faire partie du Battle.net lié du compte (`chars` : lignes de bnet_characters)
  function pickChar(chars, key) {
    const c = (chars || []).find((x) => x.key === String(key || ''));
    if (!c) throw httpError(400, "Choisis un de tes personnages Battle.net.");
    return { key: c.key, name: c.name, realm: c.realm, realmSlug: c.realm_slug, className: c.class || null };
  }

  function readTimes(body, { past = false } = {}) {
    const start = Math.round(Number(body.startsAt));
    const end = Math.round(Number(body.endsAt));
    const t = now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw httpError(400, "Indique l'heure de début et de fin.");
    if (end - start < MIN_LENGTH) throw httpError(400, "L'heure de fin doit être au moins 30 minutes après le début.");
    if (end - start > MAX_LENGTH) throw httpError(400, 'Un créneau dure 12 heures au plus.');
    if (!past && start < t - START_GRACE) throw httpError(400, 'Le début est déjà passé.');
    if (end <= t) throw httpError(400, "L'heure de fin est déjà passée.");
    if (start > t + MAX_AHEAD) throw httpError(400, "Tu peux t'y prendre jusqu'à 14 jours à l'avance.");
    return { start, end };
  }

  // Réglages d'une annonce de raid. `raids` : raids du palier ({ slug, name, bosses: [noms] })
  function readListing(body, raids) {
    const raid = (raids || []).find((r) => r.slug === String(body.raid || ''));
    if (!raid) throw httpError(400, 'Choisis un raid du palier en cours.');
    const difficulty = Number(body.difficulty);
    if (!DIFFICULTIES.includes(difficulty)) throw httpError(400, 'Choisis la difficulté du raid.');
    const goal = GOALS.includes(body.goal) ? body.goal : 'reclear';
    const bossSet = new Set(Array.isArray(body.bosses) ? body.bosses.map(String) : []);
    const bosses = raid.bosses.filter((b) => bossSet.has(b));
    const langs = [...new Set(Array.isArray(body.langs) ? body.langs.filter((l) => LANGS.includes(l)) : [])];
    if (!langs.length) throw httpError(400, 'Choisis au moins une langue.');
    const comp = {};
    for (const r of ROLES) {
      const n = Math.round(Number(body.comp?.[r]));
      comp[r] = Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : DEFAULT_COMP[r];
    }
    const total = comp.tank + comp.heal + comp.dps;
    const cap = difficulty === 5 ? 20 : 30;
    if (total < 2) throw httpError(400, 'Il faut au moins deux places dans le raid.');
    if (total > cap) throw httpError(400, 'Un raid de cette difficulté compte {n} joueurs au plus.', { n: cap });
    const seen = new Set();
    const classes = [];
    for (const c of Array.isArray(body.classes) ? body.classes : []) {
      const cls = String(c?.cls || '');
      if (!CLASSES.includes(cls) || seen.has(cls)) continue;
      seen.add(cls);
      classes.push({ cls, n: Math.max(1, Math.min(30, Math.round(Number(c.n)) || 1)) });
    }
    const classMode = body.classMode === 'required' && classes.length ? 'required' : 'preferred';
    const minIlvl = Math.round(Number(body.minIlvl));
    const minProg = Math.round(Number(body.minProg));
    // Discord obligatoire : le lien d'invitation n'est montré qu'aux membres et aux joueurs invités
    let discord = '';
    if (body.discordRequired) {
      if (!String(body.discord || '').trim()) throw httpError(400, "Donne le lien d'invitation de ton serveur Discord.");
      discord = discordInvite(body.discord);
      if (!discord) throw httpError(400, "Ce lien d'invitation Discord n'est pas valable (discord.gg/…).");
    }
    return {
      title: clean(body.title, TITLE_MAX),
      goal,
      raid: raid.slug,
      raidName: raid.name,
      difficulty,
      bosses,
      bossCount: raid.bosses.length,
      langs,
      comp,
      classes,
      classMode,
      minIlvl: minIlvl >= 100 && minIlvl <= 999 ? minIlvl : null,
      // Progression conseillée : nombre de boss tués dans la difficulté de l'annonce
      minProg: minProg >= 1 && minProg <= raid.bosses.length ? minProg : null,
      description: cleanText(body.description, DESC_MAX),
      discord,
    };
  }

  function readSearch(body, raids) {
    // Dans l'ordre du joueur : le premier est son rôle principal
    const roles = [...new Set((Array.isArray(body.roles) ? body.roles : []).filter((r) => ROLES.includes(r)))];
    if (!roles.length) throw httpError(400, 'Choisis au moins un rôle.');
    const raid = body.raid ? (raids || []).find((r) => r.slug === String(body.raid)) : null;
    if (body.raid && !raid) throw httpError(400, 'Choisis un raid du palier en cours.');
    const difficulties = DIFFICULTIES.filter((d) => Array.isArray(body.difficulties) && body.difficulties.map(Number).includes(d));
    if (!difficulties.length) throw httpError(400, 'Choisis au moins une difficulté.');
    const langs = [...new Set(Array.isArray(body.langs) ? body.langs.filter((l) => LANGS.includes(l)) : [])];
    if (!langs.length) throw httpError(400, 'Choisis au moins une langue.');
    // Boss recherchés, dans l'ordre du raid ; aucun (ou tous) = n'importe lesquels. Seulement avec un raid choisi.
    const bossSet = new Set(Array.isArray(body.bosses) ? body.bosses.map(String) : []);
    const picked = raid ? raid.bosses.filter((b) => bossSet.has(b)) : [];
    const bosses = picked.length < (raid?.bosses.length || 0) ? picked : [];
    return { roles, raid: raid?.slug || '', raidName: raid?.name || '', difficulties, bosses, langs, note: clean(body.note, NOTE_MAX) };
  }

  const newCode = () => {
    for (let i = 0; i < 20; i++) {
      const c = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      // /groups/search est une page du site : ce code ne peut pas être celui d'une annonce
      if (c !== 'SEARCH' && !q.codeUsed.get(c)) return c;
    }
    throw httpError(500, 'Erreur interne');
  };

  /* ---------------------------------------------------------------- */
  /* Lecture                                                           */
  /* ---------------------------------------------------------------- */
  function listingOf(code) {
    const row = q.listingByCode.get(String(code || '').toUpperCase());
    if (!row) throw httpError(404, "Cette annonce n'existe plus.");
    return row;
  }
  const phase = (row) => (now() >= row.ends_at ? 'ended' : now() >= row.starts_at ? 'live' : 'open');
  const tagsOf = (row) => q.tags.all(row.id);
  const shapeChar = (raw) => json(raw, {});

  function counts(tags) {
    const c = { tank: 0, heal: 0, dps: 0 };
    for (const t of tags) if (t.status === 'accepted') c[t.role]++;
    return c;
  }
  const classCount = (tags, cls) => tags.filter((t) => t.status === 'accepted' && shapeChar(t.char).className === cls).length;

  function publicTag(t, withSnapshot = true) {
    return {
      id: t.id,
      char: shapeChar(t.char),
      role: t.role,
      note: t.note,
      status: t.status,
      origin: t.origin,
      leader: Boolean(t.leader),
      co: Boolean(t.co),
      at: t.created_at,
      ...(withSnapshot ? { snapshot: json(t.snapshot, {}) } : {}),
    };
  }

  function publicMessage(m) {
    return { id: m.id, kind: m.kind, author: json(m.author, null), text: m.text, data: json(m.data, null), at: m.created_at };
  }

  // Résumé d'une annonce pour la liste : sans les infos jointes aux tags (trop lourdes)
  function summary(row, viewerId = null) {
    const d = json(row.data, {});
    const tags = tagsOf(row);
    const leader = tags.find((t) => t.leader);
    const mine = viewerId ? tags.find((t) => t.account_id === viewerId) : null;
    const { discord, ...rest } = d;
    return {
      code: row.code,
      kind: row.kind,
      ...rest,
      discordRequired: Boolean(discord),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      phase: phase(row),
      leader: leader ? { char: shapeChar(leader.char), role: leader.role } : null,
      filled: counts(tags),
      tags: tags.filter((t) => t.status === 'pending' || t.status === 'invited').length,
      mine: mine ? { status: mine.status, leader: Boolean(mine.leader), role: mine.role } : null,
    };
  }

  function roleOf(row, accountId) {
    if (!accountId) return { member: false, leader: false, co: false, tag: null };
    const t = q.tagOf.get(row.id, accountId);
    const member = t?.status === 'accepted';
    return { member, leader: row.account_id === accountId, co: member && Boolean(t.co), tag: t || null };
  }

  // Page d'une annonce : réglages, groupe, tags ouverts (avec le profil de chaque personnage), et le
  // chat pour un membre. `admin` : l'admin du site voit et gère comme le leader.
  function view(code, viewerId = null, admin = false) {
    const row = listingOf(code);
    const d = json(row.data, {});
    const tags = tagsOf(row);
    const me = roleOf(row, viewerId);
    const canManage = me.leader || me.co || admin;
    // Le lien Discord : aux membres, aux joueurs à qui une place est proposée, et à qui gère l'annonce
    const { discord, ...rest } = d;
    const seeDiscord = me.member || canManage || me.tag?.status === 'invited';
    return {
      code: row.code,
      kind: row.kind,
      ...rest,
      discordRequired: Boolean(discord),
      discordUrl: discord && seeDiscord ? discord : null,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      phase: phase(row),
      filled: counts(tags),
      tags: tags.filter((t) => OPEN.has(t.status)).map((t) => publicTag(t)),
      me: {
        member: me.member,
        leader: me.leader,
        co: me.co,
        canManage,
        canDelete: me.leader || admin,
        // Sa propre ligne, même fermée : le joueur voit qu'il a été refusé ou retiré, et pourquoi
        tag: me.tag ? { ...publicTag(me.tag, false), message: me.tag.message || null } : null,
      },
      chat: me.member || admin ? q.messages.all(row.id, CHAT_SENT).map(publicMessage) : null,
    };
  }

  function list({ kind = 'raid', viewerId = null } = {}) {
    return q.activeListings.all(now()).filter((r) => r.kind === kind).map((r) => summary(r, viewerId));
  }

  function publicSearch(row, viewerId = null) {
    return {
      id: row.id,
      kind: row.kind,
      char: shapeChar(row.char),
      ...json(row.data, {}),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      snapshot: json(row.snapshot, {}),
      mine: viewerId != null && row.account_id === viewerId,
      at: row.updated_at,
    };
  }

  function searches({ kind = 'raid', viewerId = null } = {}) {
    return q.activeSearches.all(now()).filter((r) => r.kind === kind).map((r) => publicSearch(r, viewerId));
  }

  // Ce qui concerne un compte : son annonce, ses tags et places dans les raids à venir, sa recherche
  function mine(accountId) {
    const t = now();
    const own = q.ownActive.get(accountId, 'raid', t);
    const tags = q.accountTags.all(accountId, t).filter((x) => !x.leader).map((x) => {
      const d = json(x.listing_data, {});
      return {
        code: x.code, title: d.title, goal: d.goal, raid: d.raid, raidName: d.raidName, difficulty: d.difficulty,
        startsAt: x.starts_at, endsAt: x.ends_at, status: x.status, role: x.role, char: shapeChar(x.char), message: x.message || null,
      };
    });
    const search = q.ownSearch.get(accountId, 'raid', t);
    return { listing: own ? summary(own, accountId) : null, tags, search: search ? publicSearch(search, accountId) : null };
  }

  /* ---------------------------------------------------------------- */
  /* Direct : une annonce → ceux qui la regardent                      */
  /* ---------------------------------------------------------------- */
  const streams = new Map();   // code -> Set<{ res, accountId, admin }>

  function send(conn, event, payload) {
    try { conn.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* onglet fermé */ }
  }

  // L'annonce a changé : chacun reçoit SA vue (le chat et ses droits dépendent de qui regarde)
  function emit(code) {
    const set = streams.get(code);
    if (!set) return;
    for (const conn of set) {
      try { send(conn, 'state', view(code, conn.accountId, conn.admin)); } catch { send(conn, 'closed', {}); }
    }
  }

  function emitChat(row, event, payload) {
    const set = streams.get(row.code);
    if (!set) return;
    for (const conn of set) {
      if (conn.admin || roleOf(row, conn.accountId).member) send(conn, event, payload);
    }
  }

  function subscribe(code, req, res, accountId = null, admin = false) {
    const first = view(code, accountId, admin);
    let set = streams.get(first.code);
    if (!set) streams.set(first.code, (set = new Set()));
    if (set.size >= MAX_VIEWERS) throw httpError(503, 'Trop de monde regarde cette annonce. Réessaie dans un moment.');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    const conn = { res, accountId, admin };
    send(conn, 'state', first);
    set.add(conn);
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* fermé */ } }, HEARTBEAT_MS);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      set.delete(conn);
      if (!set.size) streams.delete(first.code);
    });
  }

  function closeStreams(code) {
    const set = streams.get(code);
    if (!set) return;
    for (const conn of set) { send(conn, 'closed', {}); try { conn.res.end(); } catch { /* déjà fermé */ } }
    streams.delete(code);
  }

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */
  function notice(row, extra = {}) {
    const d = json(row.data, {});
    return { code: row.code, title: d.title || '', goal: d.goal, raid: d.raidName || '', difficulty: d.difficulty, startsAt: row.starts_at, ...extra };
  }
  // Le leader et ses co-leaders (sauf `skip`)
  function managers(row, skip = null) {
    return [...new Set([row.account_id, ...tagsOf(row).filter((t) => t.status === 'accepted' && t.co).map((t) => t.account_id)])]
      .filter((id) => id !== skip);
  }
  const say = (accountId, kind, data, ref) => { try { notify(accountId, kind, data, ref); } catch (e) { console.error(e); } };

  // Message du système dans le chat (arrivée, départ, co-leader), traduit par le navigateur
  function system(row, event, data) {
    const r = q.insertMessage.run(row.id, null, 'sys', null, '', JSON.stringify({ event, ...data }), now());
    emitChat(row, 'message', publicMessage(q.message.get(Number(r.lastInsertRowid))));
  }

  /* ---------------------------------------------------------------- */
  /* Droits                                                            */
  /* ---------------------------------------------------------------- */
  function requireManager(row, accountId, admin) {
    if (admin || row.account_id === accountId) return;
    const t = q.tagOf.get(row.id, accountId);
    if (t?.status === 'accepted' && t.co) return;
    throw httpError(403, 'Seuls le leader et ses co-leaders peuvent faire ça.');
  }
  function requireNotEnded(row) {
    if (now() >= row.ends_at) throw httpError(400, 'Ce raid est terminé.');
  }
  function tagIn(row, id) {
    const t = q.tag.get(Number(id) || 0);
    if (!t || t.listing_id !== row.id) throw httpError(404, "Ce joueur n'est plus dans l'annonce.");
    return t;
  }
  // Déjà membre d'un autre raid qui chevauche celui-ci ?
  function busyElsewhere(accountId, row) {
    return q.accountTags.all(accountId, now()).some((x) => x.listing_id !== row.id && x.status === 'accepted' && overlaps(x, row));
  }
  function roleFree(row, tags, role, except = null) {
    const d = json(row.data, {});
    const taken = tags.filter((t) => t.status === 'accepted' && t.role === role && t.id !== except).length;
    return taken < (d.comp?.[role] ?? 0);
  }
  // Une classe obligatoire a son nombre : au-delà, elle ne prend plus personne
  function classAllowed(row, tags, cls) {
    const d = json(row.data, {});
    if (d.classMode !== 'required') return true;
    const want = (d.classes || []).find((c) => c.cls === cls);
    return Boolean(want) && classCount(tags, cls) < want.n;
  }

  /* ---------------------------------------------------------------- */
  /* Annonce                                                           */
  /* ---------------------------------------------------------------- */
  // body : réglages (readListing) + startsAt / endsAt + char (clé du personnage du leader) + role.
  // snapshot : profil du personnage du leader, chargé par server.js
  function create(accountId, body, { chars, raids, snapshot = {} }) {
    const t = now();
    if (q.ownActive.get(accountId, 'raid', t)) throw httpError(409, 'Tu as déjà une annonce de raid en cours : modifie-la ou supprime-la.');
    const d = readListing(body, raids);
    const { start, end } = readTimes(body);
    const char = pickChar(chars, body.char);
    const role = ROLES.includes(body.role) ? body.role : null;
    if (!role) throw httpError(400, 'Choisis ton rôle dans le raid.');
    if (!(d.comp[role] > 0)) throw httpError(400, "Ta composition n'a pas de place pour ton propre rôle.");
    const row = { starts_at: start, ends_at: end };
    if (busyElsewhere(accountId, { ...row, id: -1 })) throw httpError(409, 'Tu es déjà dans un raid à cette heure-là.');
    const code = newCode();
    tx(() => {
      const r = q.insertListing.run(code, accountId, 'raid', JSON.stringify(d), start, end, t, t);
      const id = Number(r.lastInsertRowid);
      q.insertTag.run(id, accountId, char.key, JSON.stringify(char), role, '', 'accepted', 'leader', 1, JSON.stringify(snapshot || {}), t, t);
      withdrawOverlapping(accountId, { id, starts_at: start, ends_at: end });
    });
    flush();
    return view(code, accountId);
  }

  function edit(code, accountId, body, { raids, admin = false }) {
    const row = listingOf(code);
    requireManager(row, accountId, admin);
    requireNotEnded(row);
    const d = readListing(body, raids);
    // Une fois le raid commencé, le début ne bouge plus (sinon les heures affichées partout mentiraient)
    const { start, end } = readTimes(body, { past: true });
    const started = now() >= row.starts_at;
    q.updateListing.run(JSON.stringify(d), started ? row.starts_at : start, end, now(), row.id);
    emit(row.code);
    return view(row.code, accountId, admin);
  }

  function remove(code, accountId, admin = false) {
    const row = listingOf(code);
    if (!admin && row.account_id !== accountId) throw httpError(403, "Seul le leader peut supprimer l'annonce.");
    const tags = tagsOf(row).filter((t) => OPEN.has(t.status) && t.account_id !== row.account_id);
    const n = notice(row);
    q.deleteListing.run(row.id);
    closeStreams(row.code);
    for (const t of tags) say(t.account_id, 'lfg_deleted', n, `lfg:${row.code}:deleted`);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- */
  /* Tags                                                              */
  /* ---------------------------------------------------------------- */
  // Rejoindre un raid retire ses autres tags et propositions sur le même créneau, et ferme sa recherche
  function withdrawOverlapping(accountId, row) {
    const t = now();
    for (const x of q.accountTags.all(accountId, t)) {
      if (x.listing_id === row.id || !overlaps(x, row) || (x.status !== 'pending' && x.status !== 'invited')) continue;
      q.setStatus.run('withdrawn', 'busy', 'withdrawn', t, x.id);
      pending.add(x.code);
    }
    const s = q.ownSearch.get(accountId, 'raid', t);
    if (s && overlaps(s, row)) q.deleteSearch.run(s.id);
  }
  // Annonces touchées par withdrawOverlapping : leur direct est relancé après la transaction
  const pending = new Set();
  function flush() {
    for (const c of pending) emit(c);
    pending.clear();
  }

  // Se taguer : { char, role, note }. snapshot : profil du personnage, chargé par server.js
  function tag(code, accountId, body, { chars, snapshot = {} }) {
    const row = listingOf(code);
    requireNotEnded(row);
    if (row.account_id === accountId) throw httpError(400, 'Tu es le leader de ce raid.');
    const char = pickChar(chars, body.char);
    const role = ROLES.includes(body.role) ? body.role : null;
    if (!role) throw httpError(400, 'Choisis ton rôle.');
    const tags = tagsOf(row);
    const old = tags.find((t) => t.account_id === accountId);
    if (old && OPEN.has(old.status)) throw httpError(409, 'Tu as déjà postulé à ce raid.');
    if (old?.status === 'declined') throw httpError(403, "Le leader n'a pas retenu ta candidature pour ce raid.");
    if (old?.status === 'removed') throw httpError(403, 'Le leader a retiré ton personnage de ce raid.');
    if (!roleFree(row, tags, role)) throw httpError(409, 'Il ne reste plus de place pour ce rôle.');
    if (!classAllowed(row, tags, char.className)) throw httpError(403, "Ce raid ne prend pas ta classe.");
    if (busyElsewhere(accountId, row)) throw httpError(409, 'Tu es déjà dans un raid à cette heure-là.');
    const note = clean(body.note, NOTE_MAX);
    const t = now();
    let id;
    if (old) { q.retag.run(char.key, JSON.stringify(char), role, note, 'pending', 'tag', JSON.stringify(snapshot || {}), t, old.id); id = old.id; }
    else id = Number(q.insertTag.run(row.id, accountId, char.key, JSON.stringify(char), role, note, 'pending', 'tag', 0, JSON.stringify(snapshot || {}), t, t).lastInsertRowid);
    emit(row.code);
    for (const m of managers(row)) say(m, 'lfg_tag', notice(row, { name: char.name, className: char.className, role }), `lfg:${row.code}:tag:${id}`);
    return view(row.code, accountId);
  }

  function setNote(code, accountId, note) {
    const row = listingOf(code);
    const t = q.tagOf.get(row.id, accountId);
    if (!t || !OPEN.has(t.status)) throw httpError(404, "Tu n'as pas de candidature dans ce raid.");
    q.setNote.run(clean(note, NOTE_MAX), now(), t.id);
    emit(row.code);
    return view(row.code, accountId);
  }

  function withdraw(code, accountId) {
    const row = listingOf(code);
    const t = q.tagOf.get(row.id, accountId);
    if (!t || (t.status !== 'pending' && t.status !== 'invited')) throw httpError(404, "Tu n'as pas de candidature dans ce raid.");
    q.setStatus.run('withdrawn', null, 'withdrawn', now(), t.id);
    emit(row.code);
    return view(row.code, accountId);
  }

  // Profil joint remplacé : bouton « Actualiser » du joueur
  function ownTag(code, accountId) {
    const row = listingOf(code);
    const t = q.tagOf.get(row.id, accountId);
    if (!t || !OPEN.has(t.status)) throw httpError(404, "Tu n'as pas de candidature dans ce raid.");
    return { row, tag: t, char: shapeChar(t.char), snapshot: json(t.snapshot, {}) };
  }
  function saveTagSnapshot(code, tagId, snapshot) {
    const row = listingOf(code);
    const t = tagIn(row, tagId);
    q.setSnapshot.run(JSON.stringify(snapshot || {}), now(), t.id);
    emit(row.code);
  }

  /* ---------------------------------------------------------------- */
  /* Leader et co-leaders                                              */
  /* ---------------------------------------------------------------- */
  // Proposer une place à un joueur tagué : { tag, role? }
  function invite(code, accountId, body, admin = false) {
    const row = listingOf(code);
    requireManager(row, accountId, admin);
    requireNotEnded(row);
    const t = tagIn(row, body.tag);
    if (t.status !== 'pending') throw httpError(409, "Ce joueur n'attend pas de réponse.");
    const role = ROLES.includes(body.role) ? body.role : t.role;
    const tags = tagsOf(row);
    if (!roleFree(row, tags, role)) throw httpError(409, 'Il ne reste plus de place pour ce rôle.');
    const tm = now();
    tx(() => {
      if (role !== t.role) q.setRole.run(role, tm, t.id);
      q.setStatus.run('invited', null, 'invited', tm, t.id);
    });
    emit(row.code);
    say(t.account_id, 'lfg_invite', notice(row, { role, name: shapeChar(t.char).name }), `lfg:${row.code}:invite:${t.id}`);
    return view(row.code, accountId, admin);
  }

  // Refuser un tag, ou retirer une proposition pas encore acceptée
  function decline(code, accountId, body, admin = false) {
    const row = listingOf(code);
    requireManager(row, accountId, admin);
    const t = tagIn(row, body.tag);
    if (t.status === 'invited') q.setStatus.run(t.origin === 'offer' ? 'withdrawn' : 'pending', null, 'x', now(), t.id);
    else if (t.status === 'pending') q.setStatus.run('declined', null, 'declined', now(), t.id);
    else throw httpError(409, "Ce joueur n'attend pas de réponse.");
    emit(row.code);
    return view(row.code, accountId, admin);
  }

  // Proposer une place à un joueur qui cherche un raid (sans tag) : { search, role, note? }.
  // Son profil est repris de sa recherche.
  function offer(code, accountId, body, admin = false) {
    const row = listingOf(code);
    requireManager(row, accountId, admin);
    requireNotEnded(row);
    const s = q.search.get(Number(body.search) || 0);
    if (!s || s.ends_at <= now()) throw httpError(404, 'Ce joueur ne cherche plus de raid.');
    if (s.account_id === row.account_id) throw httpError(400, "C'est toi.");
    const sd = json(s.data, {});
    const role = ROLES.includes(body.role) && sd.roles.includes(body.role) ? body.role : sd.roles[0];
    const tags = tagsOf(row);
    const old = tags.find((x) => x.account_id === s.account_id);
    if (old && OPEN.has(old.status)) throw httpError(409, 'Ce joueur est déjà dans ton annonce.');
    if (!roleFree(row, tags, role)) throw httpError(409, 'Il ne reste plus de place pour ce rôle.');
    const char = shapeChar(s.char);
    const note = clean(body.note, NOTE_MAX);
    const tm = now();
    let id;
    if (old) { q.retag.run(s.char_key, s.char, role, note, 'invited', 'offer', s.snapshot, tm, old.id); id = old.id; }
    else id = Number(q.insertTag.run(row.id, s.account_id, s.char_key, s.char, role, note, 'invited', 'offer', 0, s.snapshot, tm, tm).lastInsertRowid);
    emit(row.code);
    say(s.account_id, 'lfg_invite', notice(row, { role, name: char.name, offer: true }), `lfg:${row.code}:invite:${id}`);
    return view(row.code, accountId, admin);
  }

  // Le joueur répond à une proposition : { accept }
  function answer(code, accountId, accept) {
    const row = listingOf(code);
    const t = q.tagOf.get(row.id, accountId);
    if (!t || t.status !== 'invited') throw httpError(404, "Tu n'as pas de place proposée dans ce raid.");
    if (!accept) {
      q.setStatus.run('refused', null, 'refused', now(), t.id);
      emit(row.code);
      return view(row.code, accountId);
    }
    requireNotEnded(row);
    const tags = tagsOf(row);
    if (!roleFree(row, tags, t.role, t.id)) throw httpError(409, 'Il ne reste plus de place pour ce rôle.');
    if (busyElsewhere(accountId, row)) throw httpError(409, 'Tu es déjà dans un raid à cette heure-là.');
    tx(() => {
      q.setStatus.run('accepted', null, 'accepted', now(), t.id);
      withdrawOverlapping(accountId, row);
    });
    const char = shapeChar(t.char);
    system(row, 'joined', { name: char.name, className: char.className });
    emit(row.code);
    flush();
    for (const m of managers(row, accountId)) say(m, 'lfg_join', notice(row, { name: char.name, className: char.className, role: t.role }), `lfg:${row.code}:join:${t.id}`);
    return view(row.code, accountId);
  }

  const readMessage = (v) => {
    const m = clean(v, MESSAGE_MAX);
    if (!m) throw httpError(400, 'Écris un message : il est obligatoire.');
    return m;
  };

  // Retirer un membre du raid, avec un message obligatoire : { tag, message }
  function kick(code, accountId, body, admin = false) {
    const row = listingOf(code);
    requireManager(row, accountId, admin);
    const t = tagIn(row, body.tag);
    if (t.status !== 'accepted') throw httpError(409, "Ce joueur n'est pas dans le raid.");
    if (t.leader) throw httpError(400, 'Le leader ne peut pas être retiré.');
    if (t.co && row.account_id !== accountId && !admin) throw httpError(403, 'Seul le leader peut retirer un co-leader.');
    const message = readMessage(body.message);
    q.setStatus.run('removed', message, 'removed', now(), t.id);
    const char = shapeChar(t.char);
    system(row, 'removed', { name: char.name, className: char.className, message });
    emit(row.code);
    say(t.account_id, 'lfg_removed', notice(row, { message }), `lfg:${row.code}:removed:${t.id}`);
    return view(row.code, accountId, admin);
  }

  // Quitter le raid, avec un message obligatoire. Le leader, lui, supprime son annonce.
  function leave(code, accountId, message) {
    const row = listingOf(code);
    const t = q.tagOf.get(row.id, accountId);
    if (!t || t.status !== 'accepted') throw httpError(404, "Tu n'es pas dans ce raid.");
    if (t.leader) throw httpError(400, "Tu es le leader : supprime l'annonce pour annuler le raid.");
    const msg = readMessage(message);
    q.setStatus.run('left', msg, 'left', now(), t.id);
    const char = shapeChar(t.char);
    system(row, 'left', { name: char.name, className: char.className, message: msg });
    emit(row.code);
    for (const m of managers(row, accountId)) say(m, 'lfg_left', notice(row, { name: char.name, className: char.className, message: msg }), `lfg:${row.code}:left:${t.id}`);
    return view(row.code, accountId);
  }

  // Co-leader : seul le leader (ou un admin) le donne, à un membre du raid : { tag, on }
  function setCo(code, accountId, body, admin = false) {
    const row = listingOf(code);
    if (!admin && row.account_id !== accountId) throw httpError(403, 'Seul le leader peut nommer des co-leaders.');
    const t = tagIn(row, body.tag);
    if (t.status !== 'accepted' || t.leader) throw httpError(400, 'Choisis un membre du raid.');
    const on = body.on === true;
    if (Boolean(t.co) === on) return view(row.code, accountId, admin);
    q.setCo.run(on ? 1 : 0, now(), t.id);
    if (on) system(row, 'co', { name: shapeChar(t.char).name, className: shapeChar(t.char).className });
    emit(row.code);
    return view(row.code, accountId, admin);
  }

  /* ---------------------------------------------------------------- */
  /* Chat du raid : membres acceptés seulement                        */
  /* ---------------------------------------------------------------- */
  function post(code, accountId, text, admin = false) {
    const row = listingOf(code);
    const t = q.tagOf.get(row.id, accountId);
    if (t?.status !== 'accepted' && !admin) throw httpError(403, 'Le chat est réservé aux membres du raid.');
    const body = cleanText(text, CHAT_MAX);
    if (!body) throw httpError(400, 'Ton message est vide.');
    const author = t ? shapeChar(t.char) : null;
    const r = q.insertMessage.run(row.id, accountId, 'msg', JSON.stringify(author ? { name: author.name, className: author.className } : null), body, null, now());
    const m = publicMessage(q.message.get(Number(r.lastInsertRowid)));
    emitChat(row, 'message', m);
    return m;
  }

  function deleteMessage(code, accountId, id, admin = false) {
    const row = listingOf(code);
    requireManager(row, accountId, admin);
    const m = q.message.get(Number(id) || 0);
    if (!m || m.listing_id !== row.id) throw httpError(404, "Ce message n'existe plus.");
    q.deleteMessage.run(m.id);
    emitChat(row, 'message-deleted', { id: m.id });
    return { ok: true };
  }

  /* ---------------------------------------------------------------- */
  /* Recherche d'un joueur                                             */
  /* ---------------------------------------------------------------- */
  // Une recherche active par compte : publier une nouvelle recherche remplace l'ancienne
  function saveSearch(accountId, body, { chars, raids, snapshot = null }) {
    const d = readSearch(body, raids);
    const { start, end } = readTimes(body);
    const char = pickChar(chars, body.char);
    const t = now();
    const old = q.ownSearch.get(accountId, 'raid', t);
    // Même personnage : le profil déjà joint est gardé si aucun nouveau n'arrive
    const snap = JSON.stringify(snapshot || (old && old.char_key === char.key ? json(old.snapshot, {}) : {}));
    if (old) q.updateSearch.run(char.key, JSON.stringify(char), JSON.stringify(d), snap, start, end, t, old.id);
    else q.insertSearch.run(accountId, 'raid', char.key, JSON.stringify(char), JSON.stringify(d), snap, start, end, t, t);
    return publicSearch(q.ownSearch.get(accountId, 'raid', t), accountId);
  }

  function closeSearch(accountId) {
    const s = q.ownSearch.get(accountId, 'raid', now());
    if (s) q.deleteSearch.run(s.id);
    return { ok: true };
  }

  function searchOf(id) {
    const s = q.search.get(Number(id) || 0);
    if (!s || s.ends_at <= now()) throw httpError(404, 'Ce joueur ne cherche plus de raid.');
    return { row: s, id: s.id, accountId: s.account_id, char: shapeChar(s.char), data: json(s.data, {}), snapshot: json(s.snapshot, {}) };
  }
  function ownSearch(accountId) {
    const s = q.ownSearch.get(accountId, 'raid', now());
    if (!s) throw httpError(404, "Tu n'as pas de recherche en cours.");
    return searchOf(s.id);
  }
  function saveSearchSnapshot(id, snapshot) {
    q.setSearchSnapshot.run(JSON.stringify(snapshot || {}), now(), Number(id));
  }

  /* ---------------------------------------------------------------- */
  /* Ménage                                                            */
  /* ---------------------------------------------------------------- */
  function purge() {
    try {
      const t = now();
      q.purgeListings.run(t - KEEP_AFTER_END);
      q.purgeSearches.run(t - SEARCH_KEEP);
    } catch (e) { console.error(e); }
  }
  purge();
  setInterval(purge, 10 * 60e3).unref?.();

  // Une annonce qui commence ou se termine change de phase sans que rien ne soit écrit :
  // ceux qui la regardent reçoivent la nouvelle vue à ce moment-là (vérifié chaque minute)
  const phases = new Map();
  setInterval(() => {
    for (const code of streams.keys()) {
      const row = q.listingByCode.get(code);
      if (!row) { closeStreams(code); continue; }
      const p = phase(row);
      if (phases.get(code) !== p) { if (phases.has(code)) emit(code); phases.set(code, p); }
    }
    for (const code of phases.keys()) if (!streams.has(code)) phases.delete(code);
  }, 60e3).unref?.();

  return {
    LANGS, CLASSES, ROLES, DIFFICULTIES, DEFAULT_COMP, REGION,
    list, view, summary, mine, searches, subscribe, exists: (code) => Boolean(q.listingByCode.get(String(code || '').toUpperCase())),
    create, edit, remove,
    tag, setNote, withdraw, ownTag, saveTagSnapshot,
    invite, decline, offer, answer, kick, leave, setCo,
    post, deleteMessage,
    saveSearch, closeSearch, searchOf, ownSearch, saveSearchSnapshot,
    purge,
  };
}

module.exports = { createGroupManager };
