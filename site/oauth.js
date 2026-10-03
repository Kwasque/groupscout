'use strict';
/*
 * GroupScout — se connecter avec Google ou Discord (demande de l'utilisateur, septembre 2026)
 *
 * OAuth « authorization code » classique, un seul client par fournisseur pour tout le site
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET du
 * .env). Adresse de retour : <PUBLIC_URL>/api/auth/<fournisseur>/callback, à déclarer à
 * l'identique chez Google et chez Discord.
 *
 * Ce module ne fait que le dialogue avec le fournisseur et renvoie qui s'est présenté
 * ({ subject, email, emailVerified, name }). Ce qu'on en fait (connexion, création du compte,
 * rattachement) est décidé dans server.js, les comptes dans accounts.js (table `identities`).
 *
 *   - `state` à usage unique, 10 min, en mémoire, comme pour Battle.net.
 *   - Il est aussi lié au NAVIGATEUR qui a cliqué : un nonce aléatoire part dans un cookie
 *     (`groupscout_oauth`) et seul son haché est gardé avec le `state`. Sans ça, un autre
 *     site pourrait envoyer ton navigateur finir SA connexion Google, et tu te retrouverais
 *     connecté à son compte sans le savoir (tout ce que tu y écrirais serait chez lui).
 *   - Pour lier un fournisseur depuis /account, le `state` porte aussi le compte qui a
 *     cliqué, et le retour exige le même compte connecté.
 *   - Aucun jeton n'est gardé : on lit l'identité au retour, puis on oublie le jeton.
 */
const crypto = require('crypto');

const STATE_TTL = 10 * 60e3;
const MAX_STATES = 10000;
const TIMEOUT = 10e3;
const NONCE_COOKIE = 'groupscout_oauth';

const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    extra: { prompt: 'select_account' },
    // https://developers.google.com/identity/openid-connect/openid-connect#an-id-tokens-payload
    shape: (u) => ({
      subject: String(u?.sub || ''),
      email: String(u?.email || ''),
      emailVerified: u?.email_verified === true || u?.email_verified === 'true',
      name: String(u?.name || u?.given_name || ''),
    }),
  },
  discord: {
    label: 'Discord',
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me',
    scope: 'identify email',
    extra: { prompt: 'none' },
    // https://discord.com/developers/docs/resources/user#user-object
    shape: (u) => ({
      subject: String(u?.id || ''),
      email: String(u?.email || ''),
      emailVerified: u?.verified === true,
      name: String(u?.global_name || u?.username || ''),
    }),
  },
};

// `message` : texte français, clé de traduction ; `vars` remplit ses {variables} (traduit par server.js)
function httpError(status, message, code, vars) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  if (vars) e.vars = vars;
  return e;
}

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// config : { google: { clientId, clientSecret }, discord: { … } } ; baseUrl sans / final
function createOAuthManager({ config = {}, baseUrl, now = () => Date.now(), fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const creds = {};
  for (const id of Object.keys(PROVIDERS)) {
    const c = config[id] || {};
    if (c.clientId && c.clientSecret) creds[id] = { clientId: String(c.clientId), clientSecret: String(c.clientSecret) };
  }

  const isProvider = (id) => Object.prototype.hasOwnProperty.call(PROVIDERS, id);
  const configured = (id) => Boolean(creds[id]);
  const available = () => Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, configured(id)]));
  const label = (id) => PROVIDERS[id]?.label || id;
  const redirectUri = (id) => `${base}/api/auth/${id}/callback`;

  const states = new Map();   // state -> { provider, nonceHash, intent, accountId, back, expires }
  function sweep() {
    const t = now();
    for (const [k, v] of states) if (v.expires < t) states.delete(k);
  }

  // intent : 'login' (page de connexion) ou 'link' (page du compte, accountId obligatoire).
  // Renvoie l'adresse du fournisseur et le nonce à poser en cookie.
  function start(provider, { intent = 'login', accountId = null, back = null } = {}) {
    if (!isProvider(provider) || !configured(provider)) {
      throw httpError(503, "La connexion avec {p} n'est pas disponible sur ce site.", 'indisponible', { p: label(provider) });
    }
    sweep();
    if (states.size >= MAX_STATES) throw httpError(429, 'Trop de connexions en cours. Réessaie dans quelques minutes.', 'fournisseur');
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    states.set(state, {
      provider,
      nonceHash: hash(nonce),
      intent: intent === 'link' ? 'link' : 'login',
      accountId: accountId ? Number(accountId) : null,
      back: back || null,
      expires: now() + STATE_TTL,
    });
    const p = PROVIDERS[provider];
    const u = new URL(p.authorize);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', creds[provider].clientId);
    u.searchParams.set('redirect_uri', redirectUri(provider));
    u.searchParams.set('scope', p.scope);
    u.searchParams.set('state', state);
    for (const [k, v] of Object.entries(p.extra || {})) u.searchParams.set(k, v);
    return { url: u.toString(), nonce };
  }

  // Le `state` du retour, vérifié et consommé (même en cas d'échec : un retour ne se rejoue
  // pas). Séparé de `finish` pour que server.js sache où renvoyer une erreur (page de
  // connexion ou page du compte) même quand le fournisseur a dit non.
  function takeState(provider, state, nonce) {
    const pending = states.get(String(state || ''));
    if (pending) states.delete(String(state));
    if (!pending || pending.expires < now() || pending.provider !== provider
      || !nonce || hash(nonce) !== pending.nonceHash) {
      throw httpError(400, 'Ce lien de connexion a expiré. Recommence.', 'lien');
    }
    return pending;
  }

  async function call(url, init) {
    let res;
    try { res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) }); }
    catch { throw httpError(502, 'Le service de connexion ne répond pas.', 'fournisseur'); }
    if (!res.ok) throw httpError(502, 'Le service de connexion a refusé la demande.', 'fournisseur');
    const j = await res.json().catch(() => null);
    if (!j) throw httpError(502, 'Réponse illisible du service de connexion.', 'fournisseur');
    return j;
  }

  // Échange le code contre un jeton, lit l'identité, oublie le jeton
  async function finish(provider, code) {
    if (!configured(provider)) throw httpError(503, 'Indisponible.', 'indisponible');
    if (!code) throw httpError(400, 'Aucune autorisation reçue.', 'lien');
    const p = PROVIDERS[provider];
    const c = creds[provider];
    const token = await call(p.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri(provider),
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }).toString(),
    });
    if (!token.access_token) throw httpError(502, 'Aucun jeton reçu.', 'fournisseur');
    const user = await call(p.userinfo, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } });
    const out = p.shape(user);
    if (!out.subject) throw httpError(502, 'Identité illisible.', 'fournisseur');
    out.email = out.email.trim().toLowerCase();
    out.name = out.name.trim().slice(0, 40);
    return out;
  }

  return { PROVIDERS, NONCE_COOKIE, isProvider, configured, available, label, redirectUri, start, takeState, finish };
}

module.exports = { createOAuthManager, PROVIDERS };
