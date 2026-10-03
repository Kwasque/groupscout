'use strict';
/*
 * GroupScout — mesure d'audience maison
 *
 * Combien de monde passe sur le site (connecté ou non), combien postent ou postulent, où
 * ils cliquent, combien de temps ils restent, d'où ils viennent, sur quel appareil.
 *
 * Pensée pour rester dans l'exemption de consentement de la CNIL (« cookies de mesure
 * d'audience exemptés »), donc SANS bandeau :
 *   - statistiques anonymes, pour l'admin seulement : jamais revendues ni croisées ;
 *   - AUCUN lien avec les comptes : on ne garde qu'un drapeau « connecté ou non » par
 *     visite, jamais l'identifiant du compte (sinon il faudrait un consentement) ;
 *   - l'adresse IP n'est jamais écrite : le visiteur est une empreinte
 *     sha256(sel du jour + IP + navigateur), et le sel change chaque jour puis est effacé,
 *     donc personne n'est reconnaissable d'un jour à l'autre (méthode de Plausible) ;
 *   - côté navigateur, une seule chose est stockée : la date de première venue
 *     (`groupscout.seen.v1`, pour « nouveau » ou « revenant »), 13 mois au plus ;
 *   - données brutes effacées après 13 mois (la CNIL tolère 25) ;
 *   - refus possible depuis la fenêtre « Confidentialité » du pied de page, et le signal
 *     Global Privacy Control du navigateur est respecté (en-tête `Sec-GPC`).
 *
 * Les visites des comptes admin (et d'un admin « connecté en tant que ») ne sont pas
 * comptées : le propriétaire fausserait ses propres chiffres.
 *
 * Tables dans la même base que les comptes : `stat_visits` (une ligne par chargement de
 * page), `stat_events` (pages vues, clics, temps, défilement, erreurs, actions du serveur)
 * et `stat_salt` (le sel du jour, pour survivre à un redémarrage).
 */

const crypto = require('node:crypto');

const DAY = 24 * 3600e3;
const RETENTION = 395 * DAY;           // 13 mois
const LIVE_MS = 40e3;                  // « en ce moment » : signe de vie depuis 40 s (le front en envoie toutes les 15 s)
const MAX_BATCH = 60;                  // événements par envoi
const MAX_PER_VISIT = 1500;            // au-delà, une visite n'enregistre plus rien (script fou ou abus)
const VIEWS = ['home', 'player', 'login', 'account', 'admin', 'legal', 'contact', 'groups'];
const KINDS = ['page', 'click', 'time', 'scroll', 'error', 'search'];
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl|wget|python|node-fetch|undici|axios|go-http|java\/|okhttp|scrapy|phantom|selenium|playwright|puppeteer/i;

// Actions comptées par le serveur (plus fiables qu'un clic : elles ont réussi)
const SERVER_EVENTS = [
  'inscription', 'connexion', 'connexion_ratee', 'verification', 'bnet', 'deconnexion',
  'recherche_joueur', 'joueur_introuvable', 'annonce', 'candidature', 'recherche_raid', 'place_proposee', 'place_acceptee',
];

const clip = (v, n) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const int = (v, min, max) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : null; };

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Appareil, navigateur et système, rangés en quelques catégories : rien de plus fin n'est gardé
function parseAgent(ua) {
  const s = String(ua || '');
  const device = /iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobi/i.test(s)) ? 'tablette'
    : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(s) ? 'mobile' : 'ordinateur';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /Vivaldi/.test(s) ? 'Vivaldi' : /YaBrowser/.test(s) ? 'Yandex'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Autre';
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Android/.test(s) ? 'Android' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'Autre';
  return { device, browser, os };
}

function createAnalytics({ db, now = () => Date.now(), ownHosts = [] }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stat_visits (
      id TEXT PRIMARY KEY,
      visitor TEXT NOT NULL,
      day TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      landing TEXT, cur_view TEXT,
      referrer TEXT, source TEXT,
      device TEXT, browser TEXT, os TEXT, lang TEXT, tz TEXT, width INTEGER,
      returning_visitor INTEGER NOT NULL DEFAULT 0,
      logged INTEGER NOT NULL DEFAULT 0,
      pages INTEGER NOT NULL DEFAULT 0,
      engaged INTEGER NOT NULL DEFAULT 0,
      load_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS stat_visits_started ON stat_visits(started_at);
    CREATE INDEX IF NOT EXISTS stat_visits_last ON stat_visits(last_at);
    CREATE TABLE IF NOT EXISTS stat_events (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      visit TEXT,
      visitor TEXT NOT NULL,
      kind TEXT NOT NULL,
      view TEXT, name TEXT, value INTEGER
    );
    CREATE INDEX IF NOT EXISTS stat_events_kind_at ON stat_events(kind, at);
    CREATE INDEX IF NOT EXISTS stat_events_visit ON stat_events(visit);
    CREATE TABLE IF NOT EXISTS stat_salt (day TEXT PRIMARY KEY, salt TEXT NOT NULL);
  `);
  const q = (sql) => db.prepare(sql);
  const st = {
    salt: q('SELECT salt FROM stat_salt WHERE day = ?'),
    addSalt: q('INSERT OR IGNORE INTO stat_salt (day, salt) VALUES (?, ?)'),
    dropSalts: q('DELETE FROM stat_salt WHERE day <> ?'),
    visit: q('SELECT id, visitor, logged FROM stat_visits WHERE id = ?'),
    addVisit: q(`INSERT OR IGNORE INTO stat_visits (id, visitor, day, started_at, last_at, referrer, source, device, browser, os, lang, tz, width, returning_visitor, logged, load_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    touch: q(`UPDATE stat_visits SET last_at = ?, logged = MAX(logged, ?), load_ms = COALESCE(load_ms, ?),
                pages = pages + ?, engaged = engaged + ?, landing = COALESCE(landing, ?), cur_view = COALESCE(?, cur_view) WHERE id = ?`),
    event: q('INSERT INTO stat_events (at, visit, visitor, kind, view, name, value) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    leave: q('UPDATE stat_visits SET last_at = ? WHERE id = ?'),
    purgeEvents: q('DELETE FROM stat_events WHERE at < ?'),
    purgeVisits: q('DELETE FROM stat_visits WHERE started_at < ?'),
  };

  // Sel du jour : tiré au hasard, gardé en base le temps de la journée (un redémarrage ne
  // doit pas compter tout le monde deux fois), puis effacé — les empreintes de la veille
  // deviennent alors impossibles à recalculer.
  let saltDay = null, saltValue = null;
  function salt() {
    const day = localDay(now());
    if (day === saltDay) return saltValue;
    st.addSalt.run(day, crypto.randomBytes(16).toString('hex'));
    st.dropSalts.run(day);
    saltDay = day;
    saltValue = st.salt.get(day).salt;
    return saltValue;
  }
  const visitorOf = (ip, ua) => crypto.createHash('sha256').update(`${salt()}|${ip}|${ua}`).digest('hex').slice(0, 16);

  // Limite à part : les envois de statistiques ne doivent pas manger le budget d'actions
  // de rateLimit (server.js), sinon un visiteur actif se ferait freiner pour rien.
  const hits = new Map();
  function allowed(ip) {
    const t = now();
    const h = hits.get(ip);
    if (!h || h.reset < t) { hits.set(ip, { count: 1, reset: t + 60e3 }); return true; }
    return ++h.count <= 120;
  }
  const perVisit = new Map();          // nombre d'événements par visite, en mémoire
  setInterval(() => {
    const t = now();
    for (const [ip, h] of hits) if (h.reset < t) hits.delete(ip);
    if (perVisit.size > 20000) perVisit.clear();
  }, 5 * 60e3).unref();

  function purge() {
    const limit = now() - RETENTION;
    st.purgeEvents.run(limit);
    st.purgeVisits.run(limit);
  }
  purge();
  setInterval(purge, DAY).unref();

  function referrerHost(v) {
    const host = clip(v, 100).toLowerCase().replace(/^www\./, '');
    if (!host || !/^[a-z0-9.-]+(:\d+)?$/.test(host)) return null;
    if (ownHosts.some((h) => h && host === h.replace(/^www\./, ''))) return null;
    return host;
  }
  const cleanPath = (v) => { const p = clip(v, 80); return /^\/[\w/:.-]*$/.test(p) ? p : null; };

  // Un envoi du navigateur : { v: id de visite, s: infos de départ, e: [événements] }.
  // ctx = { ip, ua, logged, skip } fourni par server.js. Ne lève jamais : une statistique
  // ratée ne doit rien casser.
  function collect(body, ctx) {
    try {
      if (ctx.skip || BOT_RE.test(ctx.ua || '') || !allowed(ctx.ip)) return;
      const id = String(body?.v || '');
      if (!/^[a-f0-9]{16}$/.test(id)) return;
      const events = Array.isArray(body.e) ? body.e.slice(0, MAX_BATCH) : [];
      const count = (perVisit.get(id) || 0) + events.length;
      if (count > MAX_PER_VISIT) return;
      perVisit.set(id, count);
      const t = now();
      let row = st.visit.get(id);
      if (!row) {
        const s = body.s || {};
        const agent = parseAgent(ctx.ua);
        const visitor = visitorOf(ctx.ip, ctx.ua);
        st.addVisit.run(id, visitor, localDay(t), t, t, referrerHost(s.ref), clip(s.src, 40).toLowerCase() || null,
          agent.device, agent.browser, agent.os, clip(s.lang, 12) || null, clip(s.tz, 40) || null,
          int(s.w, 0, 10000), s.ret ? 1 : 0, ctx.logged ? 1 : 0, int(s.load, 0, 120000));
        row = { id, visitor };
      }
      let pages = 0, engaged = 0, landing = null, view = null;
      for (const ev of events) {
        const kind = String(ev?.k || '');
        if (!KINDS.includes(kind)) continue;
        const v = VIEWS.includes(ev.view) ? ev.view : null;
        let name = null, value = null;
        if (kind === 'page') {
          name = cleanPath(ev.path);
          if (!name || !v) continue;
          pages++;
          landing = landing || name;
          view = v;
        } else if (kind === 'time') {
          value = int(ev.ms, 0, 35 * 60e3);   // un envoi couvre 30 s au plus ; marge pour un onglet endormi
          name = cleanPath(ev.path);
          if (!value) continue;
          engaged += value;
        } else if (kind === 'scroll') {
          value = int(ev.pct, 0, 100);
          name = cleanPath(ev.path);
          if (value == null) continue;
        } else if (kind === 'click') {
          name = clip(ev.name, 80);
          if (!name) continue;
        } else if (kind === 'error') {
          name = clip(ev.name, 160);
          if (!name) continue;
        } else if (kind === 'search') {
          name = clip(ev.name, 30);           // d'où : accueil, fiche joueur, groupe
          if (!name) continue;
        }
        st.event.run(t, id, row.visitor, kind, v, name, value);
      }
      st.touch.run(t, ctx.logged ? 1 : 0, int(body.s?.load, 0, 120000), pages, engaged, landing, view, id);
      // Page fermée : sortie immédiate de « en ce moment » (sinon elle y resterait 40 s)
      if (body.bye === true) st.leave.run(t - LIVE_MS - 1, id);
    } catch (e) {
      console.error('[stats]', e.message);
    }
  }

  // Action réussie côté serveur (inscription, recherche…) : pas de visite, juste l'empreinte
  function server(name, ctx) {
    try {
      if (ctx.skip || !SERVER_EVENTS.includes(name) || BOT_RE.test(ctx.ua || '')) return;
      st.event.run(now(), null, visitorOf(ctx.ip, ctx.ua), 'server', null, name, null);
    } catch (e) {
      console.error('[stats]', e.message);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rapport de l'admin                                                */
  /* ---------------------------------------------------------------- */
  const PERIODS = { 1: 1, 7: 7, 30: 30, 90: 90, 365: 365 };

  function share(rows, total) {
    return rows.map((r) => ({ ...r, share: total ? r.n / total : 0 }));
  }
  function quantile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[i];
  }

  function periodTotals(from, to) {
    const v = q(`SELECT COUNT(*) AS visits, COUNT(DISTINCT day || visitor) AS visitors, COALESCE(SUM(pages), 0) AS pages,
                   COALESCE(SUM(engaged), 0) AS engaged,
                   SUM(CASE WHEN pages <= 1 AND engaged < 10000 THEN 1 ELSE 0 END) AS bounces,
                   SUM(returning_visitor) AS returners, SUM(logged) AS logged
                 FROM stat_visits WHERE started_at >= ? AND started_at < ? AND pages > 0`).get(from, to);
    const searches = q(`SELECT COUNT(*) AS n, COUNT(DISTINCT visitor) AS who FROM stat_events
                        WHERE kind = 'server' AND name = 'recherche_joueur' AND at >= ? AND at < ?`).get(from, to);
    return { ...v, searches: searches.n, searchers: searches.who };
  }

  /* ---------------------------------------------------------------- */
  /* Visites une par une (demande de l'utilisateur)                     */
  /* ---------------------------------------------------------------- */
  // Voir ce qu'une visite a fait : ses pages, ses clics, son temps. Rien de plus que ce qui
  // est déjà enregistré, et toujours sans identité : une visite est un chargement de page,
  // et l'empreinte du visiteur change chaque jour — on ne suit donc personne d'un jour à
  // l'autre, ce qui est la condition pour se passer d'un bandeau de consentement.
  const VISIT_PAGE = 50;
  const VISIT_COLS = `v.id, v.visitor, v.day, v.started_at, v.last_at, v.landing, v.cur_view, v.referrer, v.source,
      v.device, v.browser, v.os, v.lang, v.tz, v.width, v.returning_visitor AS returner, v.logged, v.pages, v.engaged, v.load_ms,
      (SELECT COUNT(*) FROM stat_events e WHERE e.visit = v.id AND e.kind = 'click') AS clicks`;
  const VISIT_FILTERS = {
    nouveau: 'v.returning_visitor = 0',
    revenant: 'v.returning_visitor = 1',
    connecte: 'v.logged = 1',
    mobile: "v.device = 'mobile'",
    clics: "(SELECT COUNT(*) FROM stat_events e WHERE e.visit = v.id AND e.kind = 'click') > 0",
    longue: 'v.engaged >= 60000',
  };

  function visitWhere(params, from) {
    const where = ['v.started_at >= ?', 'v.pages > 0'];
    const args = [from];
    if (VISIT_FILTERS[params.kind]) where.push(VISIT_FILTERS[params.kind]);
    const term = String(params.q || '').trim().toLowerCase();
    if (term) {
      where.push(`(lower(COALESCE(v.referrer, '')) LIKE ? OR lower(COALESCE(v.source, '')) LIKE ?
        OR lower(v.device) LIKE ? OR lower(v.browser) LIKE ? OR lower(v.os) LIKE ?
        OR lower(COALESCE(v.landing, '')) LIKE ? OR lower(COALESCE(v.lang, '')) LIKE ? OR v.id = ? OR v.visitor = ?)`);
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like, like, like, like, like, like, term, term);
    }
    return { sql: where.join(' AND '), args };
  }

  // Liste paginée, la plus récente d'abord
  function listVisits(params = {}) {
    const days = PERIODS[params.days] || 7;
    const t = now();
    const start = new Date(t);
    start.setHours(0, 0, 0, 0);
    const from = days === 1 ? t - DAY : start.getTime() - (days - 1) * DAY;
    const page = Math.max(1, Math.floor(Number(params.page) || 1));
    const { sql, args } = visitWhere(params, from);
    const total = q(`SELECT COUNT(*) AS n FROM stat_visits v WHERE ${sql}`).get(...args).n;
    const rows = q(`SELECT ${VISIT_COLS} FROM stat_visits v WHERE ${sql} ORDER BY v.started_at DESC LIMIT ? OFFSET ?`)
      .all(...args, VISIT_PAGE, (page - 1) * VISIT_PAGE);
    return { mode: 'visits', visits: rows, page, pages: Math.max(1, Math.ceil(total / VISIT_PAGE)), total, days };
  }

  // Une visite : sa fiche, tout ce qu'elle a fait dans l'ordre, et ses autres visites du
  // même jour (l'empreinte du visiteur ne vaut que pour la journée)
  function visitDetail(id) {
    const visit = q(`SELECT ${VISIT_COLS} FROM stat_visits v WHERE v.id = ?`).get(String(id || ''));
    if (!visit) return { mode: 'visit', visit: null, events: [], others: [] };
    const events = q(`SELECT at, kind, view, name, value FROM stat_events
                      WHERE visit = ? ORDER BY id LIMIT 800`).all(visit.id);
    const others = q(`SELECT ${VISIT_COLS} FROM stat_visits v WHERE v.visitor = ? AND v.day = ? AND v.id <> ? AND v.pages > 0
                      ORDER BY v.started_at`).all(visit.visitor, visit.day, visit.id);
    // Les actions comptées par le serveur ne portent pas de visite : on retrouve celles de
    // la même empreinte pendant la visite (à une minute près), ce qui dit si elle s'est
    // inscrite, connectée, si sa recherche a abouti…
    const actions = q(`SELECT at, name FROM stat_events
                       WHERE kind = 'server' AND visitor = ? AND at >= ? AND at <= ? ORDER BY at`)
      .all(visit.visitor, visit.started_at - 60e3, visit.last_at + 60e3);
    return { mode: 'visit', visit, events, others, actions };
  }

  function report(params = {}) {
    const days = PERIODS[params.days] || 7;
    const t = now();
    // Période en jours entiers (minuit local), sauf « 24 h » qui est glissante
    const start = new Date(t);
    start.setHours(0, 0, 0, 0);
    const from = days === 1 ? t - DAY : start.getTime() - (days - 1) * DAY;
    const prevFrom = from - (t - from);
    const range = [from, t + 1];

    const totals = periodTotals(from, t + 1);
    const previous = periodTotals(prevFrom, from);

    const durations = q(`SELECT engaged FROM stat_visits WHERE started_at >= ? AND started_at < ? AND pages > 0 ORDER BY engaged LIMIT 200000`)
      .all(...range).map((r) => r.engaged);
    const loads = q(`SELECT load_ms FROM stat_visits WHERE started_at >= ? AND started_at < ? AND load_ms > 0 ORDER BY load_ms LIMIT 200000`)
      .all(...range).map((r) => r.load_ms);
    const DUR = [[10e3, 'moins de 10 s'], [30e3, '10 à 30 s'], [60e3, '30 s à 1 min'], [180e3, '1 à 3 min'], [600e3, '3 à 10 min'], [1800e3, '10 à 30 min'], [Infinity, 'plus de 30 min']];
    const durBuckets = DUR.map(([, label]) => ({ label, n: 0 }));
    for (const d of durations) durBuckets[DUR.findIndex(([max]) => d < max)].n++;

    // Par jour (ou par heure pour « 24 h »)
    let series;
    if (days === 1) {
      const rows = q(`SELECT CAST((started_at - ?) / 3600000 AS INTEGER) AS slot, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors, SUM(pages) AS pages
                      FROM stat_visits WHERE started_at >= ? AND started_at < ? AND pages > 0 GROUP BY slot`).all(from, ...range);
      const bySlot = new Map(rows.map((r) => [r.slot, r]));
      series = Array.from({ length: 24 }, (_, i) => {
        const r = bySlot.get(i) || {};
        return { at: from + i * 3600e3, label: `${new Date(from + i * 3600e3).getHours()} h`, visits: r.visits || 0, visitors: r.visitors || 0, pages: r.pages || 0 };
      });
    } else {
      const rows = q(`SELECT day, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors, SUM(pages) AS pages
                      FROM stat_visits WHERE started_at >= ? AND started_at < ? AND pages > 0 GROUP BY day`).all(...range);
      const byDay = new Map(rows.map((r) => [r.day, r]));
      series = Array.from({ length: days }, (_, i) => {
        const at = start.getTime() - (days - 1 - i) * DAY + 12 * 3600e3;   // midi : pas de piège d'heure d'été
        const day = localDay(at);
        const r = byDay.get(day) || {};
        return { at, day, visits: r.visits || 0, visitors: r.visitors || 0, pages: r.pages || 0 };
      });
    }

    const group = (col) => q(`SELECT COALESCE(${col}, '') AS label, COUNT(*) AS n FROM stat_visits
                              WHERE started_at >= ? AND started_at < ? AND pages > 0 GROUP BY label ORDER BY n DESC LIMIT 30`).all(...range);
    const visits = totals.visits;
    const hours = Array.from({ length: 24 }, (_, h) => ({ h, n: 0 }));
    for (const r of q(`SELECT CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h, COUNT(*) AS n
                       FROM stat_visits WHERE started_at >= ? AND started_at < ? AND pages > 0 GROUP BY h`).all(...range)) hours[r.h].n = r.n;
    const weekdays = Array.from({ length: 7 }, (_, d) => ({ d, n: 0 }));
    for (const r of q(`SELECT CAST(strftime('%w', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS d, COUNT(*) AS n
                       FROM stat_visits WHERE started_at >= ? AND started_at < ? AND pages > 0 GROUP BY d`).all(...range)) weekdays[r.d].n = r.n;

    const widths = q(`SELECT CASE WHEN width IS NULL THEN '' WHEN width < 400 THEN 'moins de 400 px' WHEN width < 768 THEN '400 à 767 px'
                        WHEN width < 1024 THEN '768 à 1023 px' WHEN width < 1440 THEN '1024 à 1439 px' WHEN width < 1920 THEN '1440 à 1919 px' ELSE '1920 px et plus' END AS label,
                        COUNT(*) AS n FROM stat_visits WHERE started_at >= ? AND started_at < ? AND pages > 0 GROUP BY label ORDER BY MIN(COALESCE(width, 99999))`).all(...range);

    // Pages : vues, visiteurs, temps actif moyen par vue
    const pages = q(`SELECT p.name AS path, p.view, COUNT(*) AS views, COUNT(DISTINCT p.visit) AS visits,
                       (SELECT COALESCE(SUM(value), 0) FROM stat_events t WHERE t.kind = 'time' AND t.name = p.name AND t.at >= ? AND t.at < ?) AS time
                     FROM stat_events p WHERE p.kind = 'page' AND p.at >= ? AND p.at < ? GROUP BY p.name ORDER BY views DESC LIMIT 40`).all(...range, ...range);
    const landings = q(`SELECT landing AS label, COUNT(*) AS n, SUM(CASE WHEN pages <= 1 AND engaged < 10000 THEN 1 ELSE 0 END) AS bounces
                        FROM stat_visits WHERE started_at >= ? AND started_at < ? AND pages > 0 GROUP BY landing ORDER BY n DESC LIMIT 20`).all(...range);
    // Page de sortie : la dernière page vue de chaque visite
    const exits = q(`SELECT name AS label, COUNT(*) AS n FROM stat_events e
                     WHERE e.kind = 'page' AND e.at >= ? AND e.at < ?
                       AND e.id = (SELECT MAX(id) FROM stat_events x WHERE x.visit = e.visit AND x.kind = 'page')
                     GROUP BY name ORDER BY n DESC LIMIT 20`).all(...range);

    const clicks = q(`SELECT view, name, COUNT(*) AS n, COUNT(DISTINCT visit) AS visits FROM stat_events
                      WHERE kind = 'click' AND at >= ? AND at < ? GROUP BY view, name ORDER BY n DESC LIMIT 80`).all(...range);
    const searchesFront = q(`SELECT name AS label, COUNT(*) AS n FROM stat_events WHERE kind = 'search' AND at >= ? AND at < ? GROUP BY name ORDER BY n DESC`).all(...range);
    const serverEvents = q(`SELECT name, COUNT(*) AS n, COUNT(DISTINCT visitor) AS who FROM stat_events
                            WHERE kind = 'server' AND at >= ? AND at < ? GROUP BY name ORDER BY n DESC`).all(...range);
    const errors = q(`SELECT name, view, COUNT(*) AS n, COUNT(DISTINCT visit) AS visits, MAX(at) AS last FROM stat_events
                      WHERE kind = 'error' AND at >= ? AND at < ? GROUP BY name ORDER BY n DESC LIMIT 30`).all(...range);

    // Défilement de l'accueil : part des visites qui ont atteint 25, 50, 75, 100 %
    const scrollRows = q(`SELECT visit, MAX(value) AS pct FROM stat_events WHERE kind = 'scroll' AND name = '/' AND at >= ? AND at < ? GROUP BY visit`).all(...range);
    const scroll = [25, 50, 75, 90].map((p) => ({ pct: p, n: scrollRows.filter((r) => r.pct >= p).length }));

    // Parcours : qui va jusqu'où (visiteurs distincts par étape, sur la période)
    const who = (name) => serverEvents.find((e) => e.name === name)?.who || 0;
    const viewVisitors = (path) => q(`SELECT COUNT(DISTINCT visitor) AS n FROM stat_events WHERE kind = 'page' AND name = ? AND at >= ? AND at < ?`).get(path, ...range).n;
    const funnel = [
      { label: 'Visiteurs', n: totals.visitors },
      { label: "Ont vu l'accueil", n: viewVisitors('/') },
      { label: 'Ont ouvert la page de connexion', n: viewVisitors('/login') },
      { label: 'Se sont inscrits', n: who('inscription') },
      { label: 'Ont confirmé leur adresse', n: who('verification') },
      { label: 'Ont lié leur Battle.net', n: who('bnet') },
      { label: 'Ont postulé à un raid', n: who('candidature') },
      { label: 'Ont posté une annonce', n: who('annonce') },
    ];

    const live = q(`SELECT COALESCE(cur_view, '') AS label, COUNT(*) AS n, SUM(logged) AS logged FROM stat_visits WHERE last_at >= ? AND pages > 0 GROUP BY label ORDER BY n DESC`).all(t - LIVE_MS);
    const size = q(`SELECT (SELECT COUNT(*) FROM stat_visits) AS visits, (SELECT COUNT(*) FROM stat_events) AS events, (SELECT MIN(started_at) FROM stat_visits) AS since`).get();

    return {
      days, from, to: t,
      totals: {
        ...totals,
        avgEngaged: visits ? Math.round(totals.engaged / visits) : 0,
        medianEngaged: quantile(durations, 0.5) || 0,
        pagesPerVisit: visits ? totals.pages / visits : 0,
        bounceRate: visits ? totals.bounces / visits : 0,
        returningRate: visits ? totals.returners / visits : 0,
        loggedRate: visits ? totals.logged / visits : 0,
        loadMedian: quantile(loads, 0.5),
        loadP90: quantile(loads, 0.9),
      },
      previous,
      live: { total: live.reduce((a, r) => a + r.n, 0), logged: live.reduce((a, r) => a + (r.logged || 0), 0), views: live },
      series, hours, weekdays,
      durations: durBuckets,
      pages, landings, exits, clicks, errors, scroll, scrollVisits: scrollRows.length,
      referrers: share(group('referrer'), visits),
      sources: share(group('source').filter((r) => r.label), visits),
      devices: share(group('device'), visits),
      browsers: share(group('browser'), visits),
      os: share(group('os'), visits),
      langs: share(group('lang'), visits),
      tz: share(group('tz'), visits),
      widths: share(widths, visits),
      searches: searchesFront,
      server: serverEvents,
      funnel,
      recent: listVisits({ days: params.days, page: 1 }).visits.slice(0, 20),
      storage: size,
    };
  }

  return { collect, server, report, listVisits, visitDetail, visitorOf, purge, SERVER_EVENTS };
}

module.exports = { createAnalytics, parseAgent, localDay };
