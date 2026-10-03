'use strict';
/*
 * GroupScout — liaison d'un compte Battle.net
 *
 * Le Battle.net donne la liste des personnages du compte, et c'est elle qui prouve qu'un
 * personnage est bien à toi quand tu postes une annonce ou que tu postules à un raid. Il sert
 * AUSSI à se connecter : un Battle.net déjà lié ouvre son compte
 * GroupScout et relit la liste au passage. Blizzard ne donne pas d'adresse e-mail, donc un
 * Battle.net inconnu ne crée pas de compte : server.js le garde en attente et le lie au
 * compte créé ou ouvert juste après dans ce navigateur.
 *
 *   - OAuth « authorization code » de Blizzard, scopes `openid wow.profile`, région EU
 *     seulement pour l'instant. Un seul couple identifiant / secret pour tout le site
 *     (BNET_CLIENT_ID / BNET_CLIENT_SECRET du .env).
 *   - Blizzard ne donne pas de jeton de rafraîchissement : la liste est lue au moment de
 *     la liaison, puis le jeton est oublié. « Mettre à jour » repasse par Battle.net.
 *   - `state` à usage unique, gardé 10 min en mémoire, lié au compte qui a cliqué (liaison)
 *     ou au navigateur par un nonce en cookie (connexion, comme oauth.js) : un autre site ne
 *     peut ni lancer la liaison à ta place avec SON Battle.net, ni te connecter à son compte,
 *     ni rejouer un retour. Un redémarrage du serveur oublie les liaisons en cours, sans
 *     conséquence. Une seule adresse de retour pour les deux (BNET_REDIRECT_URI) : le
 *     `state` dit ce qu'on fait au retour.
 *   - Un Battle.net ne peut être lié qu'à un seul compte GroupScout, sinon deux comptes se
 *     partageraient les mêmes personnages.
 *
 * Les personnages sont désignés par la même clé que partout ailleurs : "eu:pseudo-serveur"
 * normalisés. Blizzard donne le slug du serveur (`conseil-des-ombres`) et son nom localisé
 * (`Conseil des Ombres`) ; on garde les deux clés, qui retombent en principe sur la même.
 */
const crypto = require('crypto');
const { norm } = require('./public/shared.js');

const OAUTH_BASE = 'https://oauth.battle.net';
const STATE_TTL = 10 * 60e3;
const MAX_STATES = 10000;
const MAX_CHARACTERS = 300;
// Alts affichés sous ton personnage sur l'accueil, choisis dans la modale Battle.net (demande de l'utilisateur)
const MAX_ALTS = 8;
const TIMEOUT = 10e3;

// playable_class.id de Blizzard -> nom anglais (celui de Raider.IO et de CLASS_FILES)
const CLASS_BY_ID = {
  1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 6: 'Death Knight', 7: 'Shaman',
  8: 'Mage', 9: 'Warlock', 10: 'Monk', 11: 'Druid', 12: 'Demon Hunter', 13: 'Evoker',
};

// `message` : texte français, clé de traduction ; `vars` remplit ses {variables} (traduit par server.js)
function httpError(status, message, code, vars) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  if (vars) e.vars = vars;
  return e;
}

// Blizzard renvoie un texte, ou un objet par langue si la requête n'a pas précisé la langue
const localized = (v) => (v && typeof v === 'object' ? v.fr_FR || v.en_US || v.en_GB || Object.values(v)[0] : v) || '';

function createBnetManager({ db, clientId, clientSecret, redirectUri, region = 'eu', now = () => Date.now(), fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const configured = Boolean(clientId && clientSecret && redirectUri);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bnet_links (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      bnet_id TEXT NOT NULL UNIQUE,     -- identifiant Battle.net (stable, contrairement au BattleTag)
      battletag TEXT,
      region TEXT NOT NULL,
      linked_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bnet_characters (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      key TEXT NOT NULL,                -- "eu:pseudo-serveur" depuis le slug du serveur
      alt_key TEXT,                     -- la même depuis le nom du serveur, si elle diffère
      name TEXT NOT NULL,
      realm TEXT NOT NULL,
      realm_slug TEXT NOT NULL,
      class TEXT,
      level INTEGER,
      PRIMARY KEY (account_id, key)
    );
  `);
  // Personnage principal choisi dans la modale Battle.net de /account (demande de l'utilisateur) :
  // clé d'un personnage du compte. Gardé quand la liste est relue, oublié quand on délie.
  const linkCols = new Set(db.prepare('PRAGMA table_info(bnet_links)').all().map((c) => c.name));
  if (!linkCols.has('main_key')) db.exec('ALTER TABLE bnet_links ADD COLUMN main_key TEXT');
  // Alts choisis dans la même modale (demande de l'utilisateur, septembre 2026) : liste JSON de clés,
  // 8 au plus, jamais le main. Gardés quand la liste est relue (ceux qui ont disparu sont ignorés).
  if (!linkCols.has('alt_keys')) db.exec('ALTER TABLE bnet_links ADD COLUMN alt_keys TEXT');

  const q = {
    // Personnages des comptes VIP ou admin (badge à côté de leur nom), parmi une liste de clés
    badgeKeys: db.prepare(`SELECT c.key, c.alt_key, a.status FROM bnet_characters c JOIN accounts a ON a.id = c.account_id
      WHERE a.status IN ('vip', 'admin') AND (c.key IN (SELECT value FROM json_each(?)) OR c.alt_key IN (SELECT value FROM json_each(?)))`),
    // Comptes dont un personnage est dans une liste de clés (membres du groupe d'une session)
    accountsOfKeys: db.prepare(`SELECT DISTINCT account_id FROM bnet_characters
      WHERE key IN (SELECT value FROM json_each(?)) OR alt_key IN (SELECT value FROM json_each(?))`),
    link: db.prepare('SELECT * FROM bnet_links WHERE account_id = ?'),
    linkByBnet: db.prepare('SELECT * FROM bnet_links WHERE bnet_id = ?'),
    upsertLink: db.prepare(`INSERT INTO bnet_links (account_id, bnet_id, battletag, region, linked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET bnet_id = excluded.bnet_id, battletag = excluded.battletag,
        region = excluded.region, updated_at = excluded.updated_at,
        linked_at = CASE WHEN bnet_links.bnet_id = excluded.bnet_id THEN bnet_links.linked_at ELSE excluded.linked_at END`),
    dropLink: db.prepare('DELETE FROM bnet_links WHERE account_id = ?'),
    characters: db.prepare('SELECT * FROM bnet_characters WHERE account_id = ? ORDER BY level DESC, name'),
    dropCharacters: db.prepare('DELETE FROM bnet_characters WHERE account_id = ?'),
    addCharacter: db.prepare(`INSERT OR IGNORE INTO bnet_characters (account_id, key, alt_key, name, realm, realm_slug, class, level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    setMain: db.prepare('UPDATE bnet_links SET main_key = ? WHERE account_id = ?'),
    setAlts: db.prepare('UPDATE bnet_links SET alt_keys = ? WHERE account_id = ?'),
    // Le compte qui possède ce personnage, et le main qu'il a choisi (s'il existe encore dans sa liste)
    mainFor: db.prepare(`SELECT c.key AS char_key, m.key, m.name, m.realm, m.realm_slug, m.class
      FROM bnet_characters c
      JOIN bnet_links l ON l.account_id = c.account_id AND l.main_key IS NOT NULL
      JOIN bnet_characters m ON m.account_id = c.account_id AND m.key = l.main_key
      WHERE c.key = ? OR c.alt_key = ? LIMIT 1`),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  /* ---------------------------------------------------------------- */
  /* Lecture                                                           */
  /* ---------------------------------------------------------------- */
  function linkOf(accountId) {
    const row = accountId ? q.link.get(Number(accountId)) : null;
    return row ? { bnetId: row.bnet_id, battletag: row.battletag, region: row.region, linkedAt: row.linked_at, updatedAt: row.updated_at, mainKey: row.main_key || null, altKeys: readAlts(row.alt_keys) } : null;
  }

  const characters = (accountId) => (accountId ? q.characters.all(Number(accountId)) : []);

  function readAlts(raw) {
    try {
      const list = JSON.parse(raw || '[]');
      return Array.isArray(list) ? list.filter((k) => typeof k === 'string').slice(0, MAX_ALTS) : [];
    } catch { return []; }
  }
  // Alts encore sur le Battle.net, sans le main
  const liveAlts = (link, list) => link.altKeys.filter((k) => k !== link.mainKey && list.some((c) => c.key === k));

  // Choisit (ou oublie, key = null) le personnage principal du compte : un de ses personnages
  function setMain(accountId, key) {
    const link = linkOf(accountId);
    if (!link) throw httpError(400, "Lie d'abord ton Battle.net.");
    const k = key ? String(key) : null;
    if (k && !characters(accountId).some((c) => c.key === k)) throw httpError(400, "Ce personnage n'est pas sur ton Battle.net.");
    tx(() => {
      q.setMain.run(k, Number(accountId));
      // Un alt qui devient le main quitte la liste des alts
      if (k && link.altKeys.includes(k)) q.setAlts.run(JSON.stringify(link.altKeys.filter((x) => x !== k)), Number(accountId));
    });
  }

  // Main et ordre des alts d'un coup (glisser-déposer de l'accueil : alts rangés entre eux, ou un
  // alt posé à la place du main, l'ancien main prenant sa place parmi les alts)
  function setLayout(accountId, { main, alts }) {
    const link = linkOf(accountId);
    if (!link) throw httpError(400, "Lie d'abord ton Battle.net.");
    const list = characters(accountId);
    const own = (k) => list.some((c) => c.key === k);
    const m = main ? String(main) : null;
    if (m && !own(m)) throw httpError(400, "Ce personnage n'est pas sur ton Battle.net.");
    if (!Array.isArray(alts)) throw httpError(400, 'Liste invalide.');
    const keys = [...new Set(alts.map(String))];
    if (keys.some((k) => !own(k))) throw httpError(400, "Ce personnage n'est pas sur ton Battle.net.");
    if (m && keys.includes(m)) throw httpError(400, "C'est ton personnage principal.");
    if (keys.length > MAX_ALTS) throw httpError(400, 'Tu as déjà {n} alts : retire-en un avant.', null, { n: MAX_ALTS });
    tx(() => {
      q.setMain.run(m, Number(accountId));
      q.setAlts.run(JSON.stringify(keys), Number(accountId));
    });
  }

  // Ajoute (on) ou retire un alt : un personnage du compte, pas le main, 8 au plus
  function setAlt(accountId, key, on) {
    const link = linkOf(accountId);
    if (!link) throw httpError(400, "Lie d'abord ton Battle.net.");
    const k = String(key || '');
    const list = characters(accountId);
    if (!list.some((c) => c.key === k)) throw httpError(400, "Ce personnage n'est pas sur ton Battle.net.");
    let alts = liveAlts(link, list).filter((x) => x !== k);
    if (on) {
      if (k === link.mainKey) throw httpError(400, "C'est ton personnage principal.");
      if (alts.length >= MAX_ALTS) throw httpError(400, 'Tu as déjà {n} alts : retire-en un avant.', null, { n: MAX_ALTS });
      alts = [...alts, k];
    }
    q.setAlts.run(JSON.stringify(alts), Number(accountId));
  }

  // Main choisi sur GroupScout par le compte qui possède ce personnage (fiche joueur) :
  // undefined = personnage inconnu ou pas de main choisi (on s'en remet à Raider.IO),
  // null = c'est lui le main, sinon le main au même format que le main de Raider.IO
  function declaredMain(key) {
    const k = String(key || '');
    const row = k ? q.mainFor.get(k, k) : null;
    if (!row) return undefined;
    if (row.key === row.char_key) return null;
    const region = row.key.split(':')[0];
    return {
      name: row.name,
      realm: row.realm,
      realmSlug: row.realm_slug,
      region,
      class: row.class || null,
      spec: null,
      profileUrl: `https://raider.io/characters/${encodeURIComponent(region)}/${encodeURIComponent(row.realm_slug)}/${encodeURIComponent(row.name)}`,
      source: 'site',
    };
  }

  // Toutes les clés sous lesquelles un personnage du compte peut apparaître
  function ownKeys(accountId) {
    const out = new Set();
    for (const c of characters(accountId)) {
      out.add(c.key);
      if (c.alt_key) out.add(c.alt_key);
    }
    return out;
  }

  // Ce que la page du compte affiche
  function publicLink(accountId) {
    const link = linkOf(accountId);
    if (!link) return { available: configured, linked: false };
    const list = characters(accountId);
    return {
      available: configured,
      linked: true,
      battletag: link.battletag,
      region: link.region,
      updatedAt: link.updatedAt,
      main: list.some((c) => c.key === link.mainKey) ? link.mainKey : null,
      alts: liveAlts(link, list),
      maxAlts: MAX_ALTS,
      characters: list.map((c) => ({ key: c.key, name: c.name, realm: c.realm, className: c.class, level: c.level })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Liaison                                                           */
  /* ---------------------------------------------------------------- */
  const states = new Map();   // state -> { intent, accountId, nonceHash, back, expires }
  const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

  function sweepStates() {
    const t = now();
    for (const [k, v] of states) if (v.expires < t) states.delete(k);
  }

  function authorizeUrl(entry) {
    if (!configured) throw httpError(503, "La liaison avec Battle.net n'est pas encore disponible sur ce site.", 'indisponible');
    sweepStates();
    if (states.size >= MAX_STATES) throw httpError(429, 'Trop de liaisons en cours. Réessaie dans quelques minutes.', 'blizzard');
    const state = crypto.randomBytes(24).toString('base64url');
    states.set(state, { ...entry, expires: now() + STATE_TTL });
    const u = new URL(`${OAUTH_BASE}/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'openid wow.profile');
    u.searchParams.set('state', state);
    return u.toString();
  }

  // Liaison depuis un compte connecté. `back` : page où revenir (chemin du site, vérifié par server.js)
  function startLink(accountId, { back = null } = {}) {
    return authorizeUrl({ intent: 'link', accountId: Number(accountId), back });
  }

  // Connexion par Battle.net : renvoie l'adresse et le nonce à poser en cookie
  function startLogin({ back = null } = {}) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    return { url: authorizeUrl({ intent: 'login', accountId: null, nonceHash: hash(nonce), back }), nonce };
  }

  // Le `state` du retour, consommé même en cas d'échec (un retour ne se rejoue pas).
  // Pour une connexion, `nonce` (le cookie) doit être celui du navigateur qui est parti.
  function takeState(state, nonce) {
    const pending = states.get(String(state || ''));
    if (pending) states.delete(String(state));
    if (!pending || pending.expires < now()) throw httpError(400, 'Ce lien de liaison a expiré. Recommence depuis ton compte.', 'lien');
    if (pending.intent === 'login' && (!nonce || hash(nonce) !== pending.nonceHash)) {
      throw httpError(400, 'Ce lien de liaison a expiré. Recommence depuis ton compte.', 'lien');
    }
    return pending;
  }

  async function blizzard(url, init, what) {
    let res;
    try { res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) }); }
    catch { throw httpError(502, 'Battle.net ne répond pas, réessaie dans un moment.', 'blizzard'); }
    if (res.status === 404 && what === 'profile') return { wow_accounts: [] };   // aucun personnage WoW
    if (!res.ok) throw httpError(502, 'Battle.net a refusé la demande, réessaie dans un moment.', 'blizzard');
    const j = await res.json().catch(() => null);
    if (!j) throw httpError(502, 'Battle.net a renvoyé une réponse illisible.', 'blizzard');
    return j;
  }

  function shapeCharacters(profile) {
    const out = [];
    const seen = new Set();
    for (const acc of Array.isArray(profile?.wow_accounts) ? profile.wow_accounts : []) {
      for (const c of Array.isArray(acc?.characters) ? acc.characters : []) {
        const name = String(c?.name || '').trim();
        const slug = String(c?.realm?.slug || '').trim();
        const realm = String(localized(c?.realm?.name) || slug).trim();
        if (!name || !slug || name.length > 24) continue;
        const key = `${region}:${norm(name)}-${norm(slug)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const alt = `${region}:${norm(name)}-${norm(realm)}`;
        out.push({
          key,
          altKey: alt !== key ? alt : null,
          name,
          realm,
          realmSlug: slug,
          className: CLASS_BY_ID[c?.playable_class?.id] || null,
          level: Number(c?.level) || 0,
        });
      }
    }
    // Les personnages les plus avancés d'abord, et une borne pour les comptes démesurés
    return out.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)).slice(0, MAX_CHARACTERS);
  }

  // Échange le code contre un jeton, lit l'identité et les personnages, oublie le jeton
  async function readAccount(code) {
    if (!configured) throw httpError(503, "La liaison avec Battle.net n'est pas encore disponible sur ce site.", 'indisponible');
    if (!code) throw httpError(400, 'Battle.net n\'a pas renvoyé d\'autorisation.', 'lien');

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const token = await blizzard(`${OAUTH_BASE}/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri }).toString(),
    }, 'token');
    if (!token.access_token) throw httpError(502, 'Battle.net n\'a pas donné d\'accès.', 'blizzard');
    const auth = { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } };

    const user = await blizzard(`${OAUTH_BASE}/userinfo`, auth, 'user');
    const bnetId = String(user.id ?? user.sub ?? '').trim();
    if (!bnetId) throw httpError(502, 'Battle.net n\'a pas donné l\'identité du compte.', 'blizzard');

    const profile = await blizzard(`https://${region}.api.blizzard.com/profile/user/wow?namespace=profile-${region}&locale=fr_FR`, auth, 'profile');
    return { bnetId, battletag: String(user.battletag || '').slice(0, 64) || null, characters: shapeCharacters(profile) };
  }

  // Le compte GroupScout auquel ce Battle.net est lié, ou null
  function accountOf(bnetId) {
    const row = bnetId ? q.linkByBnet.get(String(bnetId)) : null;
    return row ? row.account_id : null;
  }

  // Enregistre le lien et la liste lue par readAccount (le main choisi est gardé)
  function saveLink(accountId, data) {
    const other = q.linkByBnet.get(data.bnetId);
    if (other && other.account_id !== Number(accountId)) {
      throw httpError(409, 'Ce Battle.net est déjà lié à un autre compte GroupScout.', 'pris');
    }
    const t = now();
    tx(() => {
      q.upsertLink.run(Number(accountId), data.bnetId, data.battletag, region, t, t);
      q.dropCharacters.run(Number(accountId));
      for (const c of data.characters) q.addCharacter.run(Number(accountId), c.key, c.altKey, c.name, c.realm, c.realmSlug, c.className, c.level);
    });
    return { bnetId: data.bnetId, battletag: data.battletag, characters: data.characters.length };
  }

  // Retour d'une liaison : `code` et `state` viennent de l'adresse. Renvoie le lien créé.
  async function finishLink(accountId, code, state) {
    if (!configured) throw httpError(503, "La liaison avec Battle.net n'est pas encore disponible sur ce site.", 'indisponible');
    const pending = takeState(state);
    if (pending.intent !== 'link' || pending.accountId !== Number(accountId)) {
      throw httpError(400, 'Ce lien de liaison a expiré. Recommence depuis ton compte.', 'lien');
    }
    return saveLink(accountId, await readAccount(code));
  }

  function unlink(accountId) {
    tx(() => {
      q.dropLink.run(Number(accountId));
      q.dropCharacters.run(Number(accountId));
    });
  }

  // Clés (parmi `keys`) des personnages Battle.net d'un compte VIP ou admin, rangées par statut :
  // un badge à côté de ces personnages (demande de l'utilisateur, fin septembre 2026 ; le VIP
  // d'abord, l'admin ensuite). Pour le VIP, c'est le seul effet du statut.
  function badgeKeys(keys) {
    const list = JSON.stringify([...new Set(keys.map(String))].slice(0, 200));
    const asked = new Set(JSON.parse(list));
    const out = { vip: new Set(), admin: new Set() };
    for (const r of q.badgeKeys.all(list, list)) {
      const set = out[r.status];
      if (asked.has(r.key)) set.add(r.key);
      if (r.alt_key && asked.has(r.alt_key)) set.add(r.alt_key);
    }
    return { vip: [...out.vip], admin: [...out.admin] };
  }

  // Identifiants des comptes GroupScout qui ont un de ces personnages dans leur Battle.net lié
  function accountsOfKeys(keys) {
    const list = JSON.stringify([...new Set((keys || []).map(String))].slice(0, 60));
    if (list === '[]') return [];
    return q.accountsOfKeys.all(list, list).map((r) => r.account_id);
  }

  return {
    badgeKeys, accountsOfKeys,
    configured, region, linkOf, characters, ownKeys, publicLink, setMain, setAlt, setLayout, declaredMain,
    startLink, startLogin, takeState, readAccount, accountOf, saveLink, finishLink, unlink, shapeCharacters,
  };
}

module.exports = { createBnetManager, CLASS_BY_ID };
