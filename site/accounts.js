'use strict';
/*
 * GroupScout — comptes
 *
 * Base SQLite intégrée à Node (`node:sqlite`, Node 22.5+), donc toujours zéro dépendance npm.
 * Un compte a un statut : "normal", "vip" ou "admin". Seul "admin" donne des droits en plus
 * (backoffice, et tous les droits sur les annonces des autres) ; "vip" ne donne qu'un badge.
 *
 * Les adresses de ADMIN_EMAILS deviennent admin et vérifiées automatiquement : c'est le filet
 * de sécurité du propriétaire du serveur, qui ne peut donc jamais se retrouver enfermé dehors.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const STATUSES = ['normal', 'vip', 'admin'];
const MIN_PASSWORD = 10;
const LOGIN_DAYS = 30;                   // durée du cookie de connexion
// Vérification d'adresse par code à 6 chiffres (demande de l'utilisateur, septembre 2026) :
// un code n'a qu'un million de valeurs, donc il vit peu, se tente peu, et s'envoie peu.
const CODE_TTL = 15 * 60e3;              // durée de vie d'un code
const CODE_TRIES = 5;                    // essais par code, puis il faut en demander un autre
const CODE_GAP = 30e3;                   // délai entre deux envois au même compte
const CODE_SENDS_PER_DAY = 8;            // envois par compte et par 24 h
const RESET_TTL = 3600e3;                // lien de mot de passe oublié
// Anti-force brute : essais libres par compteur, puis attente doublée à chaque échec
const FREE_FAILS = { pair: 5, email: 20, ip: 10 };
const BACKOFF_BASE = 60e3;               // première attente : 1 minute
const BACKOFF_MAX = 3600e3;              // plafond : 1 heure
const FAIL_MEMORY = 24 * 3600e3;         // un compteur sans nouvel échec depuis 24 h est oublié
const MAX_FAIL_ENTRIES = 50000;          // borne la mémoire face à une attaque massive
const COOKIE = 'groupscout_login';

// scrypt : paramètres volontairement explicites, ils sont écrits dans le hachage stocké
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// `code` : raison courte que le front sait lire (retours de Google et Discord).
// `vars` remplit les {variables} du message (server.js le met en forme au moment de répondre).
function httpError(status, message, code, vars) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  if (vars) e.vars = vars;
  return e;
}

const now = () => Date.now();
const normEmail = (value) => String(value || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Jeton opaque envoyé au navigateur ou dans un lien ; seul son haché est gardé en base
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// scrypt en version ASYNCHRONE : le calcul (~20 ms et 16 Mo par mot de passe) part sur les
// fils de travail de Node au lieu de geler le fil principal. Avec `scryptSync`, 40 connexions
// simultanées gelaient tout le site environ 0,8 s pour tout le monde. Les hachés déjà en base restent valables : seul l'appel change.
//
// Au plus 2 calculs à la fois : Node n'a que 4 fils de travail, et il s'en sert AUSSI pour
// lire les fichiers du site et résoudre les adresses des API. Sans
// cette limite, 40 connexions simultanées les occupaient tous, et la page d'accueil attendait
// 230 ms un fil libre (mesuré). Les calculs en trop attendent leur tour dans une file.
const SCRYPT_SLOTS = 2;
let scryptBusy = 0;
const scryptQueue = [];

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    const run = () => {
      scryptBusy += 1;
      crypto.scrypt(password, salt, keylen, opts, (err, key) => {
        scryptBusy -= 1;
        scryptQueue.shift()?.();
        if (err) reject(err); else resolve(key);
      });
    };
    if (scryptBusy < SCRYPT_SLOTS) run(); else scryptQueue.push(run);
  });
}

const formatHash = (salt, key) =>
  `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return formatHash(salt, key);
}

// Seulement pour le haché factice, calculé une fois au démarrage
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  return formatHash(salt, crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }));
}

async function checkPasswordHash(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, key] = parts;
  const expected = Buffer.from(key, 'base64');
  let got;
  try {
    got = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */
function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAccountManager(deps = {}) {
  const file = deps.file || path.join(__dirname, 'data', 'groupscout.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'normal',
      verified INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      email TEXT,
      PRIMARY KEY (provider, subject)
    );
    CREATE TABLE IF NOT EXISTS logins (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      agent TEXT,
      impersonator_id INTEGER      -- l'admin qui s'est connecté en tant que ce compte
    );
    CREATE TABLE IF NOT EXISTS tokens (
      hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_logins_account ON logins(account_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_account ON tokens(account_id, kind);
  `);


  const adminEmails = new Set((deps.adminEmails || []).map(normEmail).filter(Boolean));
  const sendMail = deps.sendMail || (async () => ({ sent: false }));
  // Textes des e-mails : t(texte, variables), qui remplit les {variables} et les pluriels (lang.js)
  const t = deps.t || ((key, vars) => (vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m) : key));
  const publicUrl = String(deps.publicUrl || '').replace(/\/+$/, '');
  // Cookie "Secure" seulement en https : sinon le navigateur le refuse en développement local
  const secureCookie = deps.secureCookie ?? publicUrl.startsWith('https://');

  const q = {
    byId: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM accounts WHERE email = ?'),
    insert: db.prepare('INSERT INTO accounts (email, password_hash, status, verified, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    setPassword: db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE accounts SET status = ? WHERE id = ?'),
    setVerified: db.prepare('UPDATE accounts SET verified = 1 WHERE id = ?'),
    setName: db.prepare('UPDATE accounts SET name = ? WHERE id = ?'),
    touchLogin: db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM accounts WHERE id = ?'),
    all: db.prepare('SELECT * FROM accounts ORDER BY created_at DESC'),
    count: db.prepare('SELECT COUNT(*) AS n FROM accounts'),

    addLogin: db.prepare('INSERT INTO logins (id, account_id, secret_hash, created_at, expires_at, agent, impersonator_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    getLogin: db.prepare('SELECT * FROM logins WHERE id = ?'),
    dropLogin: db.prepare('DELETE FROM logins WHERE id = ?'),
    dropLoginsOf: db.prepare('DELETE FROM logins WHERE account_id = ?'),
    sweepLogins: db.prepare('DELETE FROM logins WHERE expires_at < ?'),

    addToken: db.prepare('INSERT OR REPLACE INTO tokens (hash, account_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    getToken: db.prepare('SELECT * FROM tokens WHERE hash = ?'),
    dropToken: db.prepare('DELETE FROM tokens WHERE hash = ?'),
    dropTokensOf: db.prepare('DELETE FROM tokens WHERE account_id = ? AND kind = ?'),
    sweepTokens: db.prepare('DELETE FROM tokens WHERE expires_at < ?'),
    tokenOf: db.prepare('SELECT * FROM tokens WHERE account_id = ? AND kind = ?'),
    bumpToken: db.prepare('UPDATE tokens SET attempts = attempts + 1 WHERE hash = ?'),

    identity: db.prepare('SELECT * FROM identities WHERE provider = ? AND subject = ?'),
    identitiesOf: db.prepare('SELECT provider, email, created_at FROM identities WHERE account_id = ? ORDER BY provider'),
    identityOf: db.prepare('SELECT * FROM identities WHERE account_id = ? AND provider = ?'),
    addIdentity: db.prepare('INSERT INTO identities (provider, subject, account_id, created_at, email) VALUES (?, ?, ?, ?, ?)'),
    touchIdentity: db.prepare('UPDATE identities SET email = ? WHERE provider = ? AND subject = ?'),
    dropIdentity: db.prepare('DELETE FROM identities WHERE account_id = ? AND provider = ?'),
  };

  /* ---------------------------------------------------------------- */
  /* Anti-force brute (demande de l'utilisateur)                       */
  /* ---------------------------------------------------------------- */
  // Trois compteurs d'échecs, chacun avec quelques essais libres puis une attente qui double
  // à chaque nouvel échec (1 min, 2, 4, 8… jusqu'à 1 h) :
  //  - adresse + IP (5 libres) : celui qui s'acharne sur un compte est freiné tout de suite ;
  //  - adresse seule, toutes IP confondues (20 libres) : freine une attaque répartie sur
  //    beaucoup d'IP, mais plus tard, pour que le vrai propriétaire ne soit pas enfermé
  //    dehors par le premier venu qui tape des mots de passe au hasard depuis chez lui ;
  //  - IP seule, toutes adresses (10 libres) : freine celui qui essaie UN mot de passe
  //    courant sur beaucoup de comptes à la fois.
  // Au plafond, un compte ne s'essaie plus qu'une fois par heure depuis une même IP : 24
  // fois par jour, contre un mot de passe d'au moins 10 caractères. Une connexion réussie
  // efface les compteurs du compte, mais pas celui de l'IP : sinon un attaquant qui a son
  // propre compte se remettrait à zéro entre deux salves.
  // Tout est en mémoire, volontairement : un redémarrage remet à zéro, mais un attaquant ne
  // peut pas redémarrer le serveur. Les clés sont indépendantes de l'existence du compte :
  // une adresse inconnue se bloque exactement comme une vraie, rien ne trahit qui est inscrit.
  const fails = new Map();   // clé -> { n, last, until }

  const failKeys = (email, ip) => [
    ['pair', `pair:${email}|${ip}`],
    ['email', `email:${email}`],
    ['ip', `ip:${ip}`],
  ];

  // Appelée AVANT de vérifier le mot de passe : un essai refusé ici ne coûte aucun calcul
  // et n'apprend rien, même s'il est juste.
  function checkFails(email, ip) {
    let wait = 0;
    for (const [, key] of failKeys(email, ip)) {
      const cur = fails.get(key);
      if (cur && cur.until > now()) wait = Math.max(wait, cur.until - now());
    }
    if (wait <= 0) return;
    const min = Math.ceil(wait / 60e3);
    throw httpError(429, "Trop d'essais ratés. Réessaie dans {n, plural, one {# minute} other {# minutes}}.", null, { n: min });
  }

  function noteFail(email, ip) {
    for (const [kind, key] of failKeys(email, ip)) {
      const cur = fails.get(key);
      const n = !cur || now() - cur.last > FAIL_MEMORY ? 1 : cur.n + 1;
      const over = n - FREE_FAILS[kind];
      const until = over >= 0 ? now() + Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** over) : 0;
      fails.delete(key);                      // réinsérée à la fin : la Map reste triée par ancienneté
      fails.set(key, { n, last: now(), until });
    }
    // Attaque massive (adresses et IP toutes différentes) : on oublie les plus anciens
    // plutôt que de laisser la mémoire grossir sans fin.
    if (fails.size > MAX_FAIL_ENTRIES) {
      let drop = fails.size - MAX_FAIL_ENTRIES * 0.9;
      for (const key of fails.keys()) { if (drop-- <= 0) break; fails.delete(key); }
    }
  }

  // Pour le backoffice : les compteurs d'échecs en cours, décodés (adresse, IP, attente)
  function lockouts() {
    const out = [];
    for (const [key, cur] of fails) {
      if (now() - cur.last > FAIL_MEMORY) continue;
      const kind = key.slice(0, key.indexOf(':'));
      const rest = key.slice(kind.length + 1);
      const [email, ip] = kind === 'pair' ? rest.split('|') : kind === 'email' ? [rest, null] : [null, rest];
      out.push({ kind, email, ip, fails: cur.n, free: FREE_FAILS[kind], last: cur.last, until: cur.until || 0 });
    }
    return out.sort((a, b) => b.last - a.last);
  }

  // Le mot de passe a été prouvé : les compteurs de ce compte repartent à zéro (pas l'IP)
  function clearFails(email) {
    fails.delete(`email:${email}`);
    const prefix = `pair:${email}|`;
    for (const key of fails.keys()) if (key.startsWith(prefix)) fails.delete(key);
  }

  // Retire UN échec d'un compteur (l'essai réservé par `beginAttempt` a réussi)
  function undoFail(kind, key) {
    const cur = fails.get(key);
    if (!cur) return;
    if (cur.n <= 1) { fails.delete(key); return; }
    cur.n -= 1;
    const over = cur.n - FREE_FAILS[kind];
    cur.until = over >= 0 ? cur.last + Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** over) : 0;
  }

  // L'essai est compté comme raté AVANT de vérifier le mot de passe. Indispensable depuis que
  // le calcul est asynchrone : cent requêtes envoyées d'un coup passeraient sinon TOUTES
  // `checkFails` avant que la première ne soit notée, et le frein ne servirait plus à rien.
  // Si le mot de passe était bon, la fonction renvoyée efface les compteurs du compte et
  // retire cet essai-là (et lui seul) du compteur de l'IP.
  function beginAttempt(email, ip) {
    checkFails(email, ip);
    noteFail(email, ip);
    return () => {
      clearFails(email);
      undoFail('ip', `ip:${ip}`);
    };
  }

  const sweepFails = () => {
    for (const [key, cur] of fails) if (now() - cur.last > FAIL_MEMORY) fails.delete(key);
  };

  // L'IP vient du serveur (`clientIp`) ; à défaut, celle du socket
  const ipOf = (req, ip) => ip || String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'inconnue';

  // Haché factice : une adresse inconnue coûte le même calcul qu'une vraie. Sans lui, la
  // réponse arrivait ~20 ms plus vite pour une adresse sans compte, et le temps de réponse
  // suffisait à savoir qui est inscrit.
  const DUMMY_HASH = hashPasswordSync(crypto.randomBytes(16).toString('hex'));

  /* ---------------------------------------------------------------- */
  /* Lecture                                                           */
  /* ---------------------------------------------------------------- */
  // Ce que le navigateur a le droit de savoir d'un compte
  const publicAccount = (row) => (row ? {
    id: row.id,
    email: row.email,
    name: row.name || row.email.split('@')[0],
    status: row.status,
    verified: Boolean(row.verified),
    createdAt: row.created_at,
    admin: row.status === 'admin',
    // Connexion : mot de passe (ou non, compte créé par Google ou Discord) et fournisseurs liés
    hasPassword: Boolean(row.password_hash),
    identities: q.identitiesOf.all(row.id).map((i) => ({ provider: i.provider, email: i.email || null, linkedAt: i.created_at })),
    // Chercher un joueur, poster une annonce, postuler : tout compte à l'adresse vérifiée
    canSearch: Boolean(row.verified),
  } : null);

  const getById = (id) => q.byId.get(Number(id)) || null;
  const getByEmail = (email) => q.byEmail.get(normEmail(email)) || null;

  /* ---------------------------------------------------------------- */
  /* Création et connexion                                             */
  /* ---------------------------------------------------------------- */
  function statusFor(email) {
    return adminEmails.has(normEmail(email)) ? 'admin' : 'normal';
  }

  async function register({ email, password, name }) {
    const mail = normEmail(email);
    if (!EMAIL_RE.test(mail)) throw httpError(400, 'Cette adresse e-mail ne ressemble à rien.');
    if (String(password || '').length < MIN_PASSWORD) {
      throw httpError(400, 'Ton mot de passe doit faire au moins {n} caractères.', null, { n: MIN_PASSWORD });
    }
    const taken = () => httpError(409, 'Un compte existe déjà avec cette adresse. Connecte-toi plutôt.');
    if (getByEmail(mail)) throw taken();          // refus immédiat, sans calcul
    const hash = await hashPassword(password);
    // Revérifié après le calcul : pendant ces 20 ms, la même adresse a pu s'inscrire ailleurs.
    // Entre ce test et l'insertion il n'y a plus d'attente, donc plus de place pour un doublon.
    if (getByEmail(mail)) throw taken();
    const admin = adminEmails.has(mail);
    const info = q.insert.run(
      mail,
      hash,
      statusFor(mail),
      admin ? 1 : 0,          // l'admin du serveur est vérifié d'office (sinon il ne peut pas démarrer)
      String(name || '').trim().slice(0, 40) || null,
      now(),
    );
    const row = getById(info.lastInsertRowid);
    if (!admin) await sendVerification(row);
    return row;
  }

  // Connexion par un Battle.net lié à aucun compte (demande de l'utilisateur) : Blizzard ne
  // donne pas d'adresse, la personne tape la sienne et le compte est créé sans mot de passe
  // (Battle.net sert à entrer), adresse à confirmer par le code comme une inscription.
  // L'appelant (server.js) lie le Battle.net en attente juste après.
  async function registerWithoutPassword({ email, name }) {
    const mail = normEmail(email);
    if (!EMAIL_RE.test(mail)) throw httpError(400, 'Cette adresse e-mail ne ressemble à rien.');
    if (getByEmail(mail)) throw httpError(409, 'Un compte existe déjà avec cette adresse. Connecte-toi plutôt.', 'existe');
    const admin = adminEmails.has(mail);
    const info = q.insert.run(mail, null, statusFor(mail), admin ? 1 : 0, String(name || '').trim().slice(0, 40) || null, now());
    const row = getById(info.lastInsertRowid);
    if (!admin) await sendVerification(row);
    return row;
  }

  async function login({ email, password }, req, ip) {
    const mail = normEmail(email);
    const from = ipOf(req, ip);
    const succeeded = beginAttempt(mail, from);
    const row = getByEmail(mail);
    // Même message et même calcul dans les deux cas : on ne dit pas si l'adresse existe
    const good = await checkPasswordHash(String(password || ''), row?.password_hash || DUMMY_HASH);
    // Relu après le calcul : pendant ces 20 ms le compte a pu être supprimé, ou son mot de
    // passe changé — l'ancien ne doit pas ouvrir la porte.
    const fresh = row && getById(row.id);
    if (!good || !fresh?.password_hash || fresh.password_hash !== row.password_hash) {
      throw httpError(401, 'Adresse ou mot de passe incorrect.');
    }
    succeeded();
    return promote(fresh);
  }

  /* ---------------------------------------------------------------- */
  /* Google et Discord (table identities)                              */
  /* ---------------------------------------------------------------- */
  // Une adresse passée admin dans le .env après coup est promue à la connexion, quel que soit
  // le moyen de se connecter
  function promote(row) {
    if (!row || !adminEmails.has(row.email) || row.status === 'admin') return row;
    q.setStatus.run('admin', row.id);
    q.setVerified.run(row.id);
    return getById(row.id);
  }

  // Le compte déjà rattaché à ce compte Google / Discord, ou null
  function accountForIdentity(provider, subject, email) {
    const link = q.identity.get(String(provider), String(subject));
    if (!link) return null;
    if (email) q.touchIdentity.run(email, String(provider), String(subject));
    return promote(getById(link.account_id));
  }

  // Rattache un compte Google / Discord à un compte GroupScout. `code` sert au front
  // (page du compte) pour dire ce qui s'est passé.
  function addIdentity(accountId, provider, subject, email) {
    const other = q.identity.get(String(provider), String(subject));
    if (other && other.account_id === Number(accountId)) return getById(accountId);
    if (other) throw httpError(409, 'Ce compte est déjà rattaché à un autre compte GroupScout.', 'pris');
    if (q.identityOf.get(Number(accountId), String(provider))) {
      throw httpError(409, "Un autre compte de ce service est déjà lié : délie-le d'abord.", 'deja');
    }
    q.addIdentity.run(String(provider), String(subject), Number(accountId), now(), email || null);
    return getById(accountId);
  }

  // Refusé si c'est le dernier moyen d'entrer : sans mot de passe ni autre service lié, le
  // compte deviendrait inaccessible. `bnetLinked` : un Battle.net lié sert aussi à entrer
  // (bnet.js tient sa propre table, server.js le dit).
  function removeIdentity(accountId, provider, { bnetLinked = false } = {}) {
    const row = getById(accountId);
    if (!row) throw httpError(404, 'Compte introuvable.');
    if (!q.identityOf.get(row.id, String(provider))) return row;
    const others = q.identitiesOf.all(row.id).filter((i) => i.provider !== provider);
    if (!row.password_hash && !others.length && !bnetLinked) {
      throw httpError(400, "C'est ta seule façon de te connecter : choisis d'abord un mot de passe.");
    }
    q.dropIdentity.run(row.id, String(provider));
    return getById(row.id);
  }

  // Premier passage par Google ou Discord avec une adresse inconnue : le compte est créé
  // sans mot de passe, adresse vérifiée (le service l'a vérifiée pour nous).
  function createFromIdentity({ provider, subject, email, name }) {
    const mail = normEmail(email);
    if (!EMAIL_RE.test(mail)) throw httpError(400, 'Adresse e-mail illisible.', 'adresse');
    if (getByEmail(mail)) throw httpError(409, 'Un compte existe déjà avec cette adresse.', 'existe');
    db.exec('BEGIN');
    try {
      const info = q.insert.run(mail, null, statusFor(mail), 1, String(name || '').trim().slice(0, 40) || null, now());
      q.addIdentity.run(String(provider), String(subject), Number(info.lastInsertRowid), now(), mail);
      db.exec('COMMIT');
      return getById(info.lastInsertRowid);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Cookie de connexion                                               */
  /* ---------------------------------------------------------------- */
  // `impersonatorId` : un admin ouvre cette connexion pour regarder le site avec les yeux
  // de ce compte. On ne touche alors pas à sa date de dernière connexion — ce n'est pas lui
  // qui s'est connecté, et la colonne du panneau admin mentirait.
  function openSession(account, req, impersonatorId = null) {
    const id = crypto.randomBytes(12).toString('base64url');
    const secret = randomToken();
    const expires = now() + LOGIN_DAYS * 24 * 3600e3;
    const agent = String(req?.headers?.['user-agent'] || '').slice(0, 120) || null;
    q.addLogin.run(id, account.id, hashToken(secret), now(), expires, agent, impersonatorId ? Number(impersonatorId) : null);
    if (!impersonatorId) q.touchLogin.run(now(), account.id);
    return { value: `${id}.${secret}`, expires };
  }

  function cookieHeader({ value, expires }) {
    const bits = [
      `${COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Expires=${new Date(expires).toUTCString()}`,
    ];
    if (secureCookie) bits.push('Secure');
    return bits.join('; ');
  }

  const clearCookieHeader = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? '; Secure' : ''}`;

  // La ligne `logins` derrière le cookie, ou null. `current` en tire le compte, et
  // l'usurpation d'identité a besoin de la ligne elle-même pour retrouver l'admin d'origine.
  function loginRow(req) {
    const raw = readCookies(req)[COOKIE];
    if (!raw) return null;
    const dot = raw.indexOf('.');
    if (dot < 0) return null;
    const row = q.getLogin.get(raw.slice(0, dot));
    if (!row) return null;
    if (row.expires_at < now()) { q.dropLogin.run(row.id); return null; }
    const got = Buffer.from(hashToken(raw.slice(dot + 1)));
    const expected = Buffer.from(row.secret_hash);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    return row;
  }

  // Compte connecté, ou null. Ne lève jamais : une requête sans cookie est simplement anonyme.
  function current(req) {
    const login = loginRow(req);
    return login ? getById(login.account_id) : null;
  }

  function closeSession(req) {
    const raw = readCookies(req)[COOKIE];
    if (!raw) return;
    const dot = raw.indexOf('.');
    if (dot > 0) q.dropLogin.run(raw.slice(0, dot));
  }

  /* ---------------------------------------------------------------- */
  /* Vérification d'adresse et mot de passe oublié                     */
  /* ---------------------------------------------------------------- */
  function makeToken(account, kind, ttl) {
    q.dropTokensOf.run(account.id, kind);            // un seul lien valable à la fois
    const token = randomToken();
    q.addToken.run(hashToken(token), account.id, kind, now(), now() + ttl);
    return token;
  }

  // Bas commun des e-mails (mail.js) : pourquoi on le reçoit, mention de fan, pages légales
  const mailFoot = (reason) => ({
    reason,
    legal: 'GroupScout · site de fan, sans lien avec Blizzard Entertainment.',
    privacy: 'Confidentialité',
    terms: "Conditions d'utilisation",
  });

  const linkFor = (kind, token) => `${publicUrl || ''}/${kind === 'verify' ? 'api/auth/verify' : 'reset-password'}?token=${encodeURIComponent(token)}`;

  // Code de vérification : 6 chiffres tirés par crypto.randomInt, dont seul le haché est
  // gardé (salé par l'identifiant du compte, sinon un même code aurait le même haché
  // partout). Un seul code valable à la fois : en demander un nouveau annule l'ancien.
  // Les envois sont comptés en mémoire, comme les échecs de connexion.
  const codeSends = new Map();   // id du compte -> dates des derniers envois
  const codeHash = (accountId, code) => hashToken(`code:${accountId}:${code}`);

  async function sendVerification(account) {
    const recent = (codeSends.get(account.id) || []).filter((t) => now() - t < 24 * 3600e3);
    if (recent.length && now() - recent[recent.length - 1] < CODE_GAP) {
      throw httpError(429, 'Un code vient de partir : attends quelques secondes avant d\'en demander un autre.');
    }
    if (recent.length >= CODE_SENDS_PER_DAY) {
      throw httpError(429, 'Trop de codes demandés aujourd\'hui. Réessaie demain.');
    }
    recent.push(now());
    codeSends.set(account.id, recent);
    if (codeSends.size > MAX_FAIL_ENTRIES) codeSends.delete(codeSends.keys().next().value);

    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    q.dropTokensOf.run(account.id, 'verify');       // un ancien lien ne sert plus
    q.dropTokensOf.run(account.id, 'code');
    q.addToken.run(codeHash(account.id, code), account.id, 'code', now(), now() + CODE_TTL);
    const name = account.name || account.email.split('@')[0];
    await sendMail({
      to: account.email,
      subject: t('{code} est ton code GroupScout', { code }),
      mail: {
        preheader: t('Ton code de confirmation : {code}', { code }),
        badge: 'Bienvenue',
        title: t('Confirme ton adresse, {name}', { name }),
        intro: 'Ton compte est presque prêt. Entre ce code sur GroupScout pour confirmer ton adresse :',
        code,
        steps: [
          { label: '1. Battle.net', title: 'Lie ton Battle.net', text: 'Une fois, depuis ton compte : tu choisis ensuite avec quel personnage tu postules.' },
          { label: '2. Trouve', title: 'Des raids qui recrutent', text: "Postule à une annonce, ou publie ton créneau pour qu'un raid leader te propose une place." },
          { label: '3. Organise', title: 'Ton propre raid', text: 'Poste ton annonce, invite les joueurs qui te conviennent et parle avec ton raid.' },
        ],
        notice: "Ce code expire dans 15 minutes. Tu n'as pas créé de compte ? Ignore cet e-mail.",
        foot: mailFoot('Tu reçois cet e-mail car un compte GroupScout a été créé avec cette adresse.'),
      },
      kind: 'verify',
      code,
    });
    return code;
  }

  // Le code se saisit connecté (l'inscription connecte aussitôt) : pas besoin de dire à
  // quel compte il appartient, et il ne vaut que pour celui-là.
  function verifyCode(account, input) {
    if (account.verified) return account;
    const code = String(input || '').replace(/\D/g, '');
    if (code.length !== 6) throw httpError(400, 'Le code fait 6 chiffres.');
    const row = q.tokenOf.get(account.id, 'code');
    if (!row) throw httpError(400, 'Aucun code en cours : demande-en un nouveau.');
    if (row.expires_at < now() || row.attempts >= CODE_TRIES) {
      q.dropToken.run(row.hash);
      throw httpError(400, row.expires_at < now() ? 'Ce code a expiré : demande-en un nouveau.' : 'Trop d\'essais : demande un nouveau code.');
    }
    const got = Buffer.from(codeHash(account.id, code));
    const expected = Buffer.from(row.hash);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      q.bumpToken.run(row.hash);
      const left = CODE_TRIES - row.attempts - 1;
      if (left <= 0) {
        q.dropToken.run(row.hash);
        throw httpError(400, 'Code incorrect. Demande un nouveau code.');
      }
      throw httpError(400, 'Code incorrect. Encore {n, plural, one {# essai} other {# essais}}.', null, { n: left });
    }
    q.dropTokensOf.run(account.id, 'code');
    q.setVerified.run(account.id);
    codeSends.delete(account.id);
    return getById(account.id);
  }

  async function forgot(email) {
    const row = getByEmail(email);
    // On répond pareil dans tous les cas : sinon on révèle quelles adresses ont un compte
    if (!row) return null;
    const token = makeToken(row, 'reset', RESET_TTL);
    const link = linkFor('reset', token);
    const name = row.name || row.email.split('@')[0];
    await sendMail({
      to: row.email,
      subject: 'Réinitialiser ton mot de passe GroupScout',
      mail: {
        badge: 'Mot de passe',
        title: t('Choisis ton mot de passe, {name}', { name }),
        intro: 'Tu as demandé un lien pour choisir le mot de passe de ton compte GroupScout. Clique sur le bouton, ça prend une minute.',
        button: { label: 'Choisir mon mot de passe', href: link },
        notice: "Ce lien expire dans une heure. Tu n'as rien demandé ? Ignore cet e-mail : ton mot de passe actuel reste valable.",
        fallback: 'Le bouton ne marche pas ? Copie ce lien dans ton navigateur :',
        foot: mailFoot('Tu reçois cet e-mail car un lien de mot de passe a été demandé pour ton compte GroupScout.'),
      },
      kind: 'reset',
      link,
    });
    return link;
  }

  function useToken(token, kind) {
    const row = q.getToken.get(hashToken(token || ''));
    if (!row || row.kind !== kind) throw httpError(400, 'Ce lien est invalide.');
    if (row.expires_at < now()) {
      q.dropToken.run(row.hash);
      throw httpError(400, kind === 'verify' ? 'Ce lien a expiré. Demande-en un nouveau depuis la page de connexion.' : 'Ce lien a expiré. Refais une demande de mot de passe oublié.');
    }
    q.dropToken.run(row.hash);
    const account = getById(row.account_id);
    if (!account) throw httpError(400, 'Ce compte n\'existe plus.');
    return account;
  }

  function verify(token) {
    const account = useToken(token, 'verify');
    q.setVerified.run(account.id);
    return getById(account.id);
  }

  async function resetPassword(token, password) {
    if (String(password || '').length < MIN_PASSWORD) {
      throw httpError(400, 'Ton mot de passe doit faire au moins {n} caractères.', null, { n: MIN_PASSWORD });
    }
    // Le lien est consommé AVANT le calcul : deux clics simultanés ne l'utilisent qu'une fois
    const account = useToken(token, 'reset');
    const hash = await hashPassword(password);
    if (!getById(account.id)) throw httpError(404, 'Ce compte n\'existe plus.');
    q.setPassword.run(hash, account.id);
    q.setVerified.run(account.id);                   // recevoir le mail prouve l'adresse
    q.dropLoginsOf.run(account.id);                  // toutes les autres sessions tombent
    clearFails(account.email);
    return getById(account.id);
  }

  // Même frein qu'à la connexion : quelqu'un qui a volé une session ouverte ne doit pas
  // pouvoir y deviner le mot de passe (pour le réutiliser ailleurs) à coups d'essais.
  async function changePassword(account, current_, next, ip) {
    if (!account.password_hash) throw httpError(400, 'Ce compte n\'a pas de mot de passe : il se connecte par Google ou Discord.');
    // Vérifié d'abord : un nouveau mot de passe trop court ne doit pas coûter un essai
    if (String(next || '').length < MIN_PASSWORD) {
      throw httpError(400, 'Ton nouveau mot de passe doit faire au moins {n} caractères.', null, { n: MIN_PASSWORD });
    }
    const succeeded = beginAttempt(account.email, ip);
    if (!(await checkPasswordHash(String(current_ || ''), account.password_hash))) {
      throw httpError(403, 'Mot de passe actuel incorrect.');
    }
    succeeded();
    q.setPassword.run(await hashPassword(next), account.id);
  }

  /* ---------------------------------------------------------------- */
  /* Se connecter en tant que quelqu'un (admin)                        */
  /* ---------------------------------------------------------------- */
  // Le retour en arrière est porté par la ligne de connexion (`impersonator_id`) et non
  // par un second cookie : le navigateur n'a donc jamais deux identités en même temps, et
  // une connexion usurpée volée ne donne rien de plus que le compte visité.
  function impersonate(req, admin, targetId) {
    if (!admin || admin.status !== 'admin') throw httpError(403, 'Réservé aux administrateurs.');
    const login = loginRow(req);
    if (login?.impersonator_id) throw httpError(400, "Tu es déjà connecté en tant que quelqu'un d'autre : reviens à ton compte d'abord.");
    const target = getById(targetId);
    if (!target) throw httpError(404, 'Compte introuvable.');
    if (target.id === admin.id) throw httpError(400, "C'est déjà ton compte.");
    // Le cookie va être remplacé : sans ça, la connexion admin resterait en base sans cookie
    if (login) q.dropLogin.run(login.id);
    return { target, cookie: openSession(target, req, admin.id) };
  }

  // Retour à son propre compte. Autorisé par la ligne de connexion elle-même : le compte
  // visité n'est pas forcément admin, donc on ne peut pas exiger le statut ici.
  function stopImpersonating(req) {
    const login = loginRow(req);
    if (!login?.impersonator_id) throw httpError(400, "Tu n'es connecté en tant que personne.");
    const admin = getById(login.impersonator_id);
    if (!admin) throw httpError(404, "Ton compte admin n'existe plus.");
    q.dropLogin.run(login.id);
    return { admin, cookie: openSession(admin, req) };
  }

  // L'admin derrière la connexion en cours, ou null si personne n'usurpe rien
  function impersonator(req) {
    const login = loginRow(req);
    if (!login?.impersonator_id) return null;
    const row = getById(login.impersonator_id);
    return row ? { id: row.id, name: row.name || row.email.split('@')[0], email: row.email } : null;
  }

  /* ---------------------------------------------------------------- */
  /* Administration                                                    */
  /* ---------------------------------------------------------------- */
  function listAccounts() {
    return q.all.all().map((row) => ({
      ...publicAccount(row),
      lastLoginAt: row.last_login_at || null,
      hasPassword: Boolean(row.password_hash),
      protected: adminEmails.has(row.email),         // admin par le .env : ni rétrogradable ni supprimable
    }));
  }

  function setStatus(id, status) {
    if (!STATUSES.includes(status)) throw httpError(400, 'Statut inconnu.');
    const row = getById(id);
    if (!row) throw httpError(404, 'Compte introuvable.');
    if (adminEmails.has(row.email) && status !== 'admin') {
      throw httpError(400, 'Cette adresse est admin dans le fichier .env : retire-la de ADMIN_EMAILS d\'abord.');
    }
    q.setStatus.run(status, row.id);
    return getById(row.id);
  }

  function removeAccount(id) {
    const row = getById(id);
    if (!row) throw httpError(404, 'Compte introuvable.');
    if (adminEmails.has(row.email)) throw httpError(400, 'Cette adresse est admin dans le fichier .env : retire-la de ADMIN_EMAILS d\'abord.');
    q.remove.run(row.id);
    return row;
  }

  // Ménage des jetons et connexions expirés
  const sweeper = setInterval(() => {
    sweepFails();
    q.sweepLogins.run(now());
    q.sweepTokens.run(now());
  }, 3600e3);
  sweeper.unref?.();
  q.sweepLogins.run(now());
  q.sweepTokens.run(now());

  return {
    STATUSES, MIN_PASSWORD, COOKIE,
    register, login, verify, verifyCode, sendVerification, forgot, resetPassword, changePassword,
    openSession, closeSession, cookieHeader, clearCookieHeader, current,
    accountForIdentity, addIdentity, removeIdentity, createFromIdentity, registerWithoutPassword, promote, markVerified: (id) => q.setVerified.run(Number(id)),
    impersonate, stopImpersonating, impersonator,
    getById, getByEmail, publicAccount, listAccounts, setStatus, removeAccount,
    setName: (id, name) => q.setName.run(String(name || '').trim().slice(0, 40) || null, id),
    count: () => q.count.get().n,
    lockouts,
    adminEmails: () => [...adminEmails],
    // Même base pour Battle.net, les notifications et la recherche de groupe : leurs tables pointent sur `accounts`
    db,
    close: () => db.close(),
  };
}

module.exports = { createAccountManager, STATUSES, MIN_PASSWORD };
