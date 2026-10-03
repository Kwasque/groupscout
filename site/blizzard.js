'use strict';
// API officielle de Blizzard : profils des personnages (spé, niveau d'objet, progression en raid,
// cote Mythique+), équipement, talents, journal des rencontres et liste des serveurs.
//
// Une seule clé pour tout le site (BNET_CLIENT_ID / BNET_CLIENT_SECRET, la même que la liaison
// Battle.net) : un jeton « client credentials » de 24 h, gardé en mémoire. Le jeton ne doit
// jamais arriver dans un navigateur, donc tout passe par le serveur.
//
// Limite de Blizzard, par clé : 100 requêtes par seconde et 36 000 par heure (au-delà : 429).
// D'où :
//   - un cache par personnage (PROFILE_TTL), partagé par toutes les annonces et fiches ;
//   - une cadence plafonnée à MAX_PER_SECOND, bien sous la limite ;
//   - un compteur des requêtes de l'heure (usage), montré aux admins, et un arrêt volontaire
//     juste avant le plafond (HOUR_GUARD) plutôt que des 429.
//
// Un profil : { found: true, realmSlug, name, class, spec, itemLevel, score, bestRuns, raidProgress, … }.

const HOSTS = { eu: 'eu.api.blizzard.com', us: 'us.api.blizzard.com', kr: 'kr.api.blizzard.com', tw: 'tw.api.blizzard.com' };
const LIMIT_HOUR = 36000;
const LIMIT_SECOND = 100;
const MAX_PER_SECOND = 40;          // notre cadence : marge sous les 100 de Blizzard
const HOUR_GUARD = 500;             // requêtes gardées en réserve sous les 36 000
const TIMEOUT = 8000;
const PROFILE_TTL = 15 * 60e3;      // un profil bouge peu : meilleures clés, raids, cote
const MISSING_TTL = 10 * 60e3;      // personnage introuvable
const STATIC_TTL = 6 * 3600e3;      // saison en cours, temps des donjons
const MAX_CACHE = 20000;
const RECENT_DAYS = 14;             // « clés récentes » : celles de la semaine et des 14 derniers jours
const GEAR_TTL = 10 * 60e3;         // équipement : change plus souvent qu'un profil
const MEDIA_TTL = 7 * 86400e3;      // icône d'un objet : ne change jamais
// Langue du site -> langue des textes de Blizzard (noms d'objets, statistiques, emplacements) ; le site est en français
const LOCALES = { en: 'en_US', fr: 'fr_FR', de: 'de_DE', es: 'es_ES', it: 'it_IT' };

// Rôle de chaque spécialisation (identifiants de Blizzard) ; toutes les autres sont DPS
const TANK_SPECS = new Set([250, 581, 104, 268, 66, 73]);
const HEAL_SPECS = new Set([105, 1468, 270, 65, 256, 257, 264]);
const specRole = (id) => (TANK_SPECS.has(id) ? 'tank' : HEAL_SPECS.has(id) ? 'healer' : 'dps');
// Classe de chaque spécialisation : les membres d'une clé n'ont que leur spé (Dévoreur : 1480, à vérifier)
const SPEC_CLASS = {
  250: 'Death Knight', 251: 'Death Knight', 252: 'Death Knight', 577: 'Demon Hunter', 581: 'Demon Hunter', 1480: 'Demon Hunter',
  102: 'Druid', 103: 'Druid', 104: 'Druid', 105: 'Druid', 1467: 'Evoker', 1468: 'Evoker', 1473: 'Evoker',
  253: 'Hunter', 254: 'Hunter', 255: 'Hunter', 62: 'Mage', 63: 'Mage', 64: 'Mage', 268: 'Monk', 269: 'Monk', 270: 'Monk',
  65: 'Paladin', 66: 'Paladin', 70: 'Paladin', 256: 'Priest', 257: 'Priest', 258: 'Priest', 259: 'Rogue', 260: 'Rogue', 261: 'Rogue',
  262: 'Shaman', 263: 'Shaman', 264: 'Shaman', 265: 'Warlock', 266: 'Warlock', 267: 'Warlock', 71: 'Warrior', 72: 'Warrior', 73: 'Warrior',
};
const PROFILE_ROLE = { tank: 'TANK', healer: 'HEALING', dps: 'DPS' };

const hex = (c) => (c && [c.r, c.g, c.b].every((v) => Number.isFinite(v))
  ? '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
  : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Nom de serveur sans accents, espaces ni ponctuation, pour comparer « Conseil des Ombres » et « ConseildesOmbres »
const normKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

class BlizzardError extends Error {
  constructor(code) { super(code); this.code = code; }   // 'limit' | 'down' | 'unconfigured'
}

function createBlizzardClient({ clientId, clientSecret } = {}) {
  const configured = () => Boolean(clientId && clientSecret);

  /* ---------------- Jeton ---------------- */
  let token = null;
  let tokenPromise = null;
  async function getToken(renew = false) {
    if (!renew && token && token.expires > Date.now()) return token.value;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      const res = await fetch('https://oauth.battle.net/token', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new BlizzardError('down');
      const j = await res.json();
      token = { value: j.access_token, expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 300) * 1000 };
      return token.value;
    })();
    try { return await tokenPromise; } finally { tokenPromise = null; }
  }

  /* ---------------- Compteur et cadence ---------------- */
  // Requêtes par minute sur la dernière heure, et horodatages de la dernière seconde
  const minutes = new Map();
  const lastSecond = [];
  const stats = { limited: 0, lastLimitedAt: 0, errors: 0 };
  const minuteOf = (t) => Math.floor(t / 60e3);
  function usedThisHour(now = Date.now()) {
    const from = minuteOf(now) - 59;
    let n = 0;
    for (const [m, c] of minutes) {
      if (m < from) minutes.delete(m);
      else n += c;
    }
    return n;
  }
  function count() {
    const m = minuteOf(Date.now());
    minutes.set(m, (minutes.get(m) || 0) + 1);
  }
  async function slot() {
    for (;;) {
      const now = Date.now();
      while (lastSecond.length && now - lastSecond[0] >= 1000) lastSecond.shift();
      if (lastSecond.length < MAX_PER_SECOND) { lastSecond.push(now); return; }
      await sleep(1000 - (now - lastSecond[0]) + 5);
    }
  }

  function usage() {
    const now = Date.now();
    while (lastSecond.length && now - lastSecond[0] >= 1000) lastSecond.shift();
    return {
      used: usedThisHour(now),
      limit: LIMIT_HOUR,
      perSecond: lastSecond.length,
      perSecondLimit: LIMIT_SECOND,
      limited: stats.limited,
      lastLimitedAt: stats.lastLimitedAt || null,
      cached: cache.size,
      configured: configured(),
      at: now,
    };
  }

  // Une requête à l'API : { status, body }. Compte chaque appel, respecte la cadence, et
  // refuse d'elle-même juste avant le plafond de l'heure.
  async function request(region, path, namespace, locale = 'en_US') {
    if (!configured()) throw new BlizzardError('unconfigured');
    const host = HOSTS[region] || HOSTS.eu;
    if (usedThisHour() >= LIMIT_HOUR - HOUR_GUARD) { stats.limited++; stats.lastLimitedAt = Date.now(); throw new BlizzardError('limit'); }
    const url = `https://${host}${path}${path.includes('?') ? '&' : '?'}namespace=${namespace}-${HOSTS[region] ? region : 'eu'}&locale=${locale}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const bearer = await getToken(attempt > 0);
      await slot();
      count();
      let res;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
      } catch {
        stats.errors++;
        throw new BlizzardError('down');
      }
      if (res.status === 401 && attempt === 0) continue;   // jeton expiré ou révoqué : un nouveau
      if (res.status === 429) { stats.limited++; stats.lastLimitedAt = Date.now(); throw new BlizzardError('limit'); }
      if (res.status >= 500) { stats.errors++; throw new BlizzardError('down'); }
      const body = res.status === 200 ? await res.json().catch(() => null) : null;
      return { status: res.status, body };
    }
    throw new BlizzardError('down');
  }

  /* ---------------- Cache ---------------- */
  const cache = new Map();
  const inflight = new Map();
  async function cached(key, ttl, fn, force = false) {
    const hit = cache.get(key);
    if (!force && hit && hit.expires > Date.now()) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const { value, ttl: own } = await fn();
        if (cache.size >= MAX_CACHE) {
          const now = Date.now();
          for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
          // Encore plein : les plus anciennes entrées partent (une Map garde l'ordre d'ajout)
          for (const k of cache.keys()) { if (cache.size < MAX_CACHE * 0.9) break; cache.delete(k); }
        }
        cache.set(key, { value, expires: Date.now() + (own ?? ttl) });
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  /* ---------------- Données de la saison ---------------- */
  const seasonId = (region) => cached(`season:${region}`, STATIC_TTL, async () => {
    const r = await request(region, '/data/wow/mythic-keystone/season/index', 'dynamic');
    return { value: r.body?.current_season?.id ?? null };
  });

  // Temps à battre de chaque palier (+1, +2, +3) d'un donjon, en millisecondes
  const dungeonTimes = (region, id) => cached(`dungeon:${region}:${id}`, STATIC_TTL, async () => {
    const r = await request(region, `/data/wow/mythic-keystone/dungeon/${id}`, 'dynamic');
    const times = (r.body?.keystone_upgrades || [])
      .map((u) => ({ level: u.upgrade_level, ms: u.qualifying_duration }))
      .filter((u) => Number.isFinite(u.ms))
      .sort((a, b) => a.level - b.level);
    return { value: times };
  });

  /* ---------------- Profil d'un personnage ---------------- */
  // realms : serveurs à essayer (slugs), dans l'ordre. Renvoie { found: true, realmSlug, … },
  // { found: false } ou lève BlizzardError('limit' | 'down' | 'unconfigured').
  async function profile({ region = 'eu', realms, name, force = false }) {
    const slugs = [...new Set((realms || []).map((r) => String(r || '').trim().toLowerCase()).filter((r) => r && !/\s/.test(r)))];
    const lower = String(name || '').trim().toLowerCase();
    if (!lower || !slugs.length) return { found: false };
    for (const realm of slugs) {
      const found = await cached(`profile:${region}:${realm}:${lower}`, PROFILE_TTL, async () => {
        const value = await loadProfile(region, realm, lower);
        return { value, ttl: value.found ? PROFILE_TTL : MISSING_TTL };
      }, force);
      if (found.found) return found;
    }
    return { found: false };
  }

  async function loadProfile(region, realm, name) {
    const base = `/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`;
    const summary = await request(region, base, 'profile');
    if (summary.status !== 200 || !summary.body) return { found: false };
    const season = await seasonId(region).catch(() => null);
    const [keystone, seasonRuns, raids] = await Promise.all([
      request(region, `${base}/mythic-keystone-profile`, 'profile'),
      season ? request(region, `${base}/mythic-keystone-profile/season/${season}`, 'profile') : { status: 404 },
      request(region, `${base}/encounters/raids`, 'profile'),
    ]);
    const all = [...(seasonRuns.body?.best_runs || []), ...(keystone.body?.current_period?.best_runs || [])];
    const times = new Map();
    await Promise.all([...new Set(all.map((r) => r.dungeon?.id).filter(Boolean))].map(async (id) => {
      times.set(id, await dungeonTimes(region, id).catch(() => []));
    }));
    return shapeProfile({
      region, realm, summary: summary.body,
      keystone: keystone.status === 200 ? keystone.body : null,
      season: seasonRuns.status === 200 ? seasonRuns.body : null,
      raids: raids.status === 200 ? raids.body : null,
      times, seasonId: season,
    });
  }

  /* ---------------- Équipement d'un personnage ---------------- */
  // Demande de l'utilisateur (septembre 2026) : voir le stuff d'un joueur, avec une info-bulle par
  // objet. Chargé à la demande seulement (bloc « Équipement »), jamais avec le profil : 2 requêtes
  // par personnage, plus une par icône jamais vue (gardée une semaine, partagée par tout le site).
  // lang : langue du site (en, fr, de, es, it), pour les noms d'objets et de statistiques.
  async function equipment({ region = 'eu', realms, name, lang = 'en', force = false }) {
    const slugs = [...new Set((realms || []).map((r) => String(r || '').trim().toLowerCase()).filter((r) => r && !/\s/.test(r)))];
    const lower = String(name || '').trim().toLowerCase();
    const locale = LOCALES[lang] || LOCALES.en;
    if (!lower || !slugs.length) return { found: false };
    for (const realm of slugs) {
      const found = await cached(`gear:${region}:${realm}:${lower}:${locale}`, GEAR_TTL, async () => {
        const value = await loadEquipment(region, realm, lower, locale);
        return { value, ttl: value.found ? GEAR_TTL : MISSING_TTL };
      }, force);
      if (found.found) return found;
    }
    return { found: false };
  }

  // Icône d'un objet (ou d'une gemme) : adresse sur render.worldofwarcraft.com, ou null
  const itemIcon = (region, id) => (id ? cached(`media:item:${id}`, MEDIA_TTL, async () => {
    const r = await request(region, `/data/wow/media/item/${id}`, 'static');
    const icon = (r.body?.assets || []).find((a) => a.key === 'icon')?.value || null;
    return { value: icon, ttl: icon ? MEDIA_TTL : MISSING_TTL };
  }).catch(() => null) : Promise.resolve(null));

  async function loadEquipment(region, realm, name, locale) {
    const base = `/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`;
    const [eq, st] = await Promise.all([
      request(region, `${base}/equipment`, 'profile', locale),
      request(region, `${base}/statistics`, 'profile', locale).catch(() => ({ status: 0 })),
    ]);
    if (eq.status !== 200 || !eq.body) return { found: false };
    const items = (eq.body.equipped_items || []).map((x) => shapeItem(x, locale)).filter(Boolean);
    // Icônes des objets et des gemmes, en parallèle (la cadence est tenue par request)
    await Promise.all(items.flatMap((it) => [
      itemIcon(region, it.mediaId).then((u) => { it.icon = u; }),
      ...it.sockets.filter((g) => g.mediaId).map((g) => itemIcon(region, g.mediaId).then((u) => { g.icon = u; })),
    ]));
    for (const it of items) {
      delete it.mediaId;
      for (const g of it.sockets) delete g.mediaId;
    }
    return {
      found: true,
      name: eq.body.character?.name || name,
      realmSlug: eq.body.character?.realm?.slug || realm,
      items,
      stats: st.status === 200 && st.body ? shapeStats(st.body) : null,
      at: Date.now(),
    };
  }

  /* ---------------- Talents d'un personnage ---------------- */
  // Onglet « Talents » du bloc Équipement (demande de l'utilisateur, 28 septembre 2026) : demandés
  // seulement à l'ouverture de l'onglet. Une requête pour le personnage (ses configurations de
  // chaque spé, avec le code d'export du jeu), puis l'arbre de la spé montrée (données du jeu,
  // gardées une semaine et partagées par tout le site), et l'icône de chaque talent à part
  // (spellIcon, demandée par le navigateur au fil de l'affichage).
  async function talents({ region = 'eu', realms, name, lang = 'en', force = false }) {
    const slugs = [...new Set((realms || []).map((r) => String(r || '').trim().toLowerCase()).filter((r) => r && !/\s/.test(r)))];
    const lower = String(name || '').trim().toLowerCase();
    const locale = LOCALES[lang] || LOCALES.en;
    if (!lower || !slugs.length) return { found: false };
    for (const realm of slugs) {
      const found = await cached(`talents:${region}:${realm}:${lower}:${locale}`, GEAR_TTL, async () => {
        const base = `/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(lower)}`;
        const r = await request(region, `${base}/specializations`, 'profile', locale);
        const value = r.status === 200 && r.body ? { found: true, ...shapeTalents(r.body), at: Date.now() } : { found: false };
        return { value, ttl: value.found ? GEAR_TTL : MISSING_TTL };
      }, force);
      if (found.found) return found;
    }
    return { found: false };
  }

  // Arbre complet d'une spé (classe, spé, héros), dans la langue de la page, ou null
  const talentTree = ({ region = 'eu', treeId, specId, lang = 'en' }) => {
    const locale = LOCALES[lang] || LOCALES.en;
    if (!Number.isInteger(treeId) || !Number.isInteger(specId)) return Promise.resolve(null);
    return cached(`talent-tree:${region}:${treeId}:${specId}:${locale}`, MEDIA_TTL, async () => {
      const r = await request(region, `/data/wow/talent-tree/${treeId}/playable-specialization/${specId}`, 'static', locale);
      const value = r.status === 200 && r.body ? shapeTree(r.body, specId) : null;
      return { value, ttl: value ? MEDIA_TTL : MISSING_TTL };
    });
  };

  // Icône d'un sort (talent) : nom du fichier chez Blizzard (…/icons/56/<nom>.jpg), ou null
  const spellIcon = (region, id) => cached(`media:spell:${id}`, MEDIA_TTL, async () => {
    const r = await request(region, `/data/wow/media/spell/${id}`, 'static');
    const u = (r.body?.assets || []).find((a) => a.key === 'icon')?.value || '';
    const icon = String(u).match(/\/icons\/\d+\/([A-Za-z0-9_.-]{1,120})\.jpg$/)?.[1] || null;
    return { value: icon, ttl: icon ? MEDIA_TTL : MISSING_TTL };
  });

  /* ---------------- Journal des rencontres : raids et donjons de la saison ---------------- */
  // Progression de la fiche joueur : pour chaque raid, ses boss dans l'ordre du journal (leurs
  // identifiants sont ceux des kills du profil), et l'identifiant de chaque instance, qui sert à
  // trouver ses images dans les tables du jeu (journal.js). Les images elles-mêmes ne viennent plus
  // d'ici : les rendus « zoom » des créatures étaient des modèles en pied de tailles très inégales,
  // et la vignette d'une instance était parfois annoncée mais absente (The Tidebound Grotto).
  const journalIndex = (region) => cached(`journal:index:${region}`, MEDIA_TTL, async () => {
    const r = await request(region, '/data/wow/journal-instance/index', 'static');
    const list = (r.body?.instances || []).map((i) => ({ id: i.id, name: i.name }));
    return { value: list, ttl: list.length ? MEDIA_TTL : MISSING_TTL };
  });
  const journalRaid = (region, id) => cached(`journal:raid:${region}:${id}`, MEDIA_TTL, async () => {
    const inst = await request(region, `/data/wow/journal-instance/${id}`, 'static');
    const bosses = (inst.body?.encounters || []).filter((e) => e.id).map((e) => ({ id: e.id, name: e.name }));
    return { value: { id, bosses }, ttl: bosses.length ? MEDIA_TTL : MISSING_TTL };
  });
  const findInstance = (index, name) => index.find((i) => slugify(i.name) === slugify(name)) || null;
  // names : noms anglais des raids du palier (ceux des listes du site). { raids: [{ name, slug, id, bosses: [{ id, name }] }] }
  async function raidArt({ region = 'eu', names = [] }) {
    const index = await journalIndex(region);
    const raidsOut = await Promise.all(names.map(async (name) => {
      const hit = findInstance(index, name);
      const art = hit ? await journalRaid(region, hit.id).catch(() => null) : null;
      return { name, slug: slugify(name), id: hit?.id ?? null, bosses: art?.bosses || [] };
    }));
    return { raids: raidsOut };
  }
  // names : noms anglais des donjons de la saison. { dungeons: [{ name, slug, id }] }
  async function dungeonArt({ region = 'eu', names = [] }) {
    const index = await journalIndex(region);
    return { dungeons: names.map((name) => ({ name, slug: slugify(name), id: findInstance(index, name)?.id ?? null })) };
  }

  /* ---------------- Serveurs d'une région ---------------- */
  // Nom d'un serveur tel qu'on le tape ou que Raider.IO l'écrit (« Conseil des Ombres »,
  // « ConseildesOmbres », « conseil-des-ombres ») -> son slug chez Blizzard. La liste des
  // serveurs (une requête) est gardée une semaine ; inconnu : null.
  const realmIndex = (region) => cached(`realms:${region}`, MEDIA_TTL, async () => {
    const r = await request(region, '/data/wow/realm/index', 'dynamic', 'fr_FR');
    const map = new Map();
    for (const x of r.body?.realms || []) {
      if (!x.slug) continue;
      const names = [x.slug, typeof x.name === 'string' ? x.name : null].filter(Boolean);
      for (const n of names) map.set(normKey(n), x.slug);
    }
    return { value: map, ttl: map.size ? MEDIA_TTL : MISSING_TTL };
  });
  async function realmSlug(region, input) {
    const key = normKey(input);
    if (!key) return null;
    const map = await realmIndex(region).catch(() => null);
    return map?.get(key) || null;
  }

  return { configured, profile, equipment, talents, talentTree, spellIcon, raidArt, dungeonArt, realmSlug, usage, BlizzardError };
}

/* ---------------- Mise en forme des talents ---------------- */
// Description d'un talent : les paragraphes du jeu sont gardés (\n), le reste nettoyé comme ailleurs
const APEX_RANKS = 4;
const cleanDesc = (v) => String(v ?? '').split(/\r?\n/).map((l) => cleanText(l)).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);

// Configuration équipée de la spé active : { active (spé), specs: [{ id, name, active, loadouts:
// [{ active, code, tree, hero: { id, name }, picks: [[nœud, rang, talent choisi, parts?]] }] }] }.
// code : le texte d'export du jeu (fenêtre des talents › Importer). Un nœud peut revenir plusieurs
// fois (talent apex, en bas de l'arbre de spé : un talent par palier, 4 points en tout) : ses
// rangs s'additionnent et parts garde chaque palier (nom, rang, texte), que l'arbre ne donne pas.
function groupPicks(list) {
  const byNode = new Map();
  for (const t of list) {
    if (!Number.isInteger(t.id)) continue;
    const rank = Number.isInteger(t.rank) ? t.rank : 1;
    const part = t.tooltip?.talent?.id
      ? { talent: t.tooltip.talent.id, name: cleanText(t.tooltip.talent.name), rank, desc: cleanDesc(t.tooltip.spell_tooltip?.description) }
      : null;
    const p = byNode.get(t.id);
    if (!p) byNode.set(t.id, { rank, talent: part?.talent ?? null, parts: part ? [part] : [] });
    else { p.rank += rank; if (part) p.parts.push(part); }
  }
  return [...byNode].map(([id, p]) => [id, p.rank, p.talent, ...(p.parts.length > 1 ? [p.parts] : [])]);
}

function shapeTalents(b) {
  const active = b.active_specialization?.id ?? null;
  const treeOf = (l) => {
    const m = String(l.selected_spec_talent_tree?.key?.href || l.selected_class_talent_tree?.key?.href || '').match(/talent-tree\/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  // Seule la configuration équipée de la spé active est gardée (la seule montrée) : Blizzard n'a pas
  // de requête pour elle seule, la réponse contient toutes les spés et configurations, mais c'est
  // une seule requête de toute façon (le quota compte les requêtes, pas leur taille)
  const all = b.specializations || [];
  const mine = all.filter((s) => s.specialization?.id === active);
  const specs = (mine.length ? mine : all.slice(0, 1)).map((s) => ({
    id: s.specialization?.id ?? null,
    name: cleanText(s.specialization?.name),
    active: s.specialization?.id === active,
    loadouts: (s.loadouts || []).filter((l, i, list) => l.is_active || (i === 0 && !list.some((x) => x.is_active))).map((l) => ({
      active: Boolean(l.is_active),
      code: /^[A-Za-z0-9+/=]{16,2000}$/.test(l.talent_loadout_code || '') ? l.talent_loadout_code : null,
      tree: treeOf(l),
      hero: l.selected_hero_talent_tree?.id ? { id: l.selected_hero_talent_tree.id, name: cleanText(l.selected_hero_talent_tree.name) } : null,
      picks: groupPicks([...(l.selected_class_talents || []), ...(l.selected_spec_talents || []), ...(l.selected_hero_talents || [])]),
    })).filter((l) => l.picks.length || l.code),
  })).filter((s) => s.id && s.loadouts.length);
  return { active, specs };
}

// Arbre d'une spé : nœuds placés sur la grille du jeu (display_row / display_col), ce qu'ils
// débloquent (les traits entre eux), et le contenu de leur info-bulle. Les arbres de héros sont
// ceux de la spé seulement.
function shapeTree(b, specId) {
  const entry = (t) => (t ? {
    talent: t.talent?.id ?? null,
    spell: t.spell_tooltip?.spell?.id ?? null,
    name: cleanText(t.talent?.name || t.spell_tooltip?.spell?.name),
    desc: cleanDesc(t.spell_tooltip?.description),
    cast: cleanText(t.spell_tooltip?.cast_time) || null,
    cost: cleanText(t.spell_tooltip?.power_cost) || null,
    range: cleanText(t.spell_tooltip?.range) || null,
    cd: cleanText(t.spell_tooltip?.cooldown) || null,
  } : null);
  const node = (n, hero = false) => {
    const choice = n.node_type?.type === 'CHOICE';
    const ranks = n.ranks || [];
    const entries = (choice ? ranks[0]?.choice_of_tooltips || [] : [ranks[0]?.tooltip]).map(entry).filter((e) => e?.name);
    const descs = choice || ranks.length < 2 ? null : ranks.map((r) => cleanDesc(r.tooltip?.spell_tooltip?.description));
    // Arbres de héros : la position brute du jeu (pas de 600), qui centre le premier et le dernier
    // talent entre deux colonnes ; ailleurs la grille du jeu (display_row / display_col)
    const raw = hero && Number.isFinite(n.raw_position_x) && Number.isFinite(n.raw_position_y);
    return {
      id: n.id,
      row: raw ? n.raw_position_y / 600 : n.display_row,
      col: raw ? n.raw_position_x / 600 : n.display_col,
      type: choice ? 'choice' : n.node_type?.type === 'ACTIVE' ? 'active' : 'passive',
      max: Math.max(1, ranks.length),
      unlocks: (n.unlocks || []).filter(Number.isInteger),
      entries,
      // Un texte par rang, quand il change d'un rang à l'autre
      ...(descs && descs.slice(1).some((d) => d && d !== descs[0]) ? { descs } : {}),
    };
  };
  // Blizzard range aussi les nœuds des arbres de héros (et le choix entre eux, sans info-bulle)
  // dans ceux de la classe et de la spé : ils en sont retirés, chaque arbre de héros a les siens
  const heroIds = new Set((b.hero_talent_trees || []).flatMap((h) => (h.hero_talent_nodes || []).map((n) => n.id)));
  const nodes = (list, own = false) => (list || []).filter((n) => own || !heroIds.has(n.id)).map((n) => node(n, own))
    .filter((n) => Number.isFinite(n.row) && Number.isFinite(n.col) && n.entries.length);
  // Talent apex : seul sur la dernière rangée de l'arbre de spé, montré à part (sous l'arbre de
  // héros) ; ses 4 points ne sont pas dans les rangs de l'arbre (un seul chez Blizzard)
  const specNodes = nodes(b.spec_talent_nodes);
  const last = Math.max(...specNodes.map((n) => n.row));
  const bottom = specNodes.filter((n) => n.row === last);
  const apex = bottom.length === 1 && specNodes.length > 1 ? { ...bottom[0], max: APEX_RANKS } : null;
  return {
    className: cleanText(b.playable_class?.name) || null,
    specName: cleanText(b.playable_specialization?.name) || null,
    classNodes: nodes(b.class_talent_nodes),
    specNodes: apex ? specNodes.filter((n) => n !== bottom[0]) : specNodes,
    apex,
    heroes: (b.hero_talent_trees || [])
      .filter((h) => !h.playable_specializations?.length || h.playable_specializations.some((p) => p.id === specId))
      .map((h) => ({ id: h.id, name: cleanText(h.name), nodes: nodes(h.hero_talent_nodes, true) })),
  };
}

/* ---------------- Mise en forme de l'équipement ---------------- */
// Textes de Blizzard : on retire les codes d'affichage du jeu (couleurs |c…|r, textures |T…|t,
// atlas |A…|a) ; le rang d'un enchantement (atlas « Professions-ChatIcon-Quality-Tier3 ») est gardé à part
const QUALITY_RANK = /\|A:Professions-(?:ChatIcon-)?Quality-(?:\d+-)?Tier(\d)[^|]*\|a/i;
const cleanText = (v) => String(v ?? '')
  .replace(/\|c[0-9a-fA-F]{8}|\|cn[^:|]*:|\|r/g, '')
  .replace(/\|[TA][^|]*\|[ta]/g, '')
  .replace(/\|n/g, ' ')
  .replace(/\|/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 400);
const textOf = (x) => cleanText(x?.display_string ?? x?.display?.display_string ?? '');
const colorOf = (x) => hex(x?.color ?? x?.display?.color);

// Palier d'amélioration (« Héros 6/6 »), que l'API ne donne pas en clair (demande de
// l'utilisateur, septembre 2026) : il est dans les codes `bonus_list`. Chaque rang de chaque
// palier est un code à lui (tables du jeu ItemBonusListGroupEntry, groupes 614 à 618, lues sur
// wago.tools) : 8 codes qui se suivent par palier, rang = position, dont 6 accessibles.
// Codes de Midnight saison 1 : À REPRENDRE À CHAQUE SAISON (un code inconnu = pas de palier
// affiché, jamais un faux). Vérifié sur de vrais personnages : 12846 = Héros 6/6 (321),
// 12852 = Mythe 4/6 (328), 12854 = Mythe 6/6 (334).
const UPGRADE_TRACKS = [
  { id: 'adventurer', first: 12817 },
  { id: 'veteran', first: 12825 },
  { id: 'champion', first: 12833 },
  { id: 'hero', first: 12841 },
  { id: 'myth', first: 12849 },
];
const UPGRADE_MAX = 6;
const TRACK_NAMES = {
  en_US: { adventurer: 'Adventurer', veteran: 'Veteran', champion: 'Champion', hero: 'Hero', myth: 'Myth' },
  fr_FR: { adventurer: 'Aventurier', veteran: 'Vétéran', champion: 'Champion', hero: 'Héros', myth: 'Mythe' },
  de_DE: { adventurer: 'Abenteurer', veteran: 'Veteran', champion: 'Champion', hero: 'Held', myth: 'Mythos' },
  es_ES: { adventurer: 'Aventurero', veteran: 'Veterano', champion: 'Campeón', hero: 'Héroe', myth: 'Mito' },
  it_IT: { adventurer: 'Avventuriero', veteran: 'Veterano', champion: 'Campione', hero: 'Eroe', myth: 'Mito' },
};

function upgradeOf(x, locale) {
  for (const b of x.bonus_list || []) {
    const t = UPGRADE_TRACKS.find((u) => b >= u.first && b < u.first + 8);
    if (t) return { track: t.id, name: (TRACK_NAMES[locale] || TRACK_NAMES.en_US)[t.id], rank: b - t.first + 1, max: UPGRADE_MAX };
  }
  return null;
}

// Objet obtenu en héroïque puis passé au palier Mythe avec une breloque : c'est en fait un objet
// mythique, mais Blizzard garde « Héroïque » sous son nom (comme le jeu). On le renomme.
// Le bonus 13334 marque un objet obtenu en héroïque (vérifié sur de vrais personnages).
const HEROIC_BONUS = 13334;
const MYTHIC_WORD = {
  en_US: [/\bHeroic\b/i, () => 'Mythic'],
  fr_FR: [/H[ée]ro[iï]que/i, () => 'Mythique'],
  de_DE: [/Heroisch/i, () => 'Mythisch'],
  es_ES: [/Heroic([oa])/i, (m) => `Mític${m[1]}`],
  it_IT: [/Eroic([oa])/i, (m) => `Mitic${m[1]}`],
};

function mythicTrack(track, x, locale, upgrade) {
  if (!track || upgrade?.track !== 'myth' || !(x.bonus_list || []).includes(HEROIC_BONUS)) return track;
  const [re, to] = MYTHIC_WORD[locale] || MYTHIC_WORD.en_US;
  const m = track.text.match(re);
  return { ...track, text: m ? track.text.replace(re, to(m)) : to([null, 'o']) };
}

function shapeItem(x, locale = 'en_US') {
  if (!x?.slot?.type) return null;
  const rank = (s) => { const m = String(s || '').match(QUALITY_RANK); return m ? Number(m[1]) : null; };
  const upgrade = upgradeOf(x, locale);
  return {
    slot: x.slot.type,
    slotName: cleanText(x.slot.name),
    id: x.item?.id ?? null,
    mediaId: x.media?.id ?? x.item?.id ?? null,
    icon: null,
    name: cleanText(x.name),
    quality: String(x.quality?.type || 'COMMON').toLowerCase(),
    level: x.level?.value ?? null,
    levelText: textOf(x.level),
    // Mention sous le nom : la provenance de l'objet (« Héroïque », « Mythique + », « Artisanat
    // des marées »), corrigée par mythicTrack pour un objet héroïque passé au palier Mythe
    track: mythicTrack(x.name_description ? { text: textOf(x.name_description), color: colorOf(x.name_description) } : null, x, locale, upgrade),
    upgrade,
    // Objet d'artisanat : seuls les objets fabriqués portent les stats choisies à la fabrication
    // (vu sur de vrais personnages, avec context 13 = artisanat)
    crafted: Boolean(x.modified_crafting_stat?.length) || x.context === 13,
    binding: cleanText(x.binding?.name) || null,
    unique: cleanText(x.unique_equipped) || cleanText(x.limit_category) || null,
    type: cleanText(x.inventory_type?.name) || null,
    subclass: cleanText(x.item_subclass?.name) || null,
    armor: textOf(x.armor) || null,
    weapon: x.weapon ? { damage: textOf(x.weapon.damage), speed: textOf(x.weapon.attack_speed), dps: textOf(x.weapon.dps) } : null,
    stats: (x.stats || []).map((s) => ({
      text: textOf(s),
      type: s.type?.type || null,
      color: colorOf(s),
      equip: Boolean(s.is_equip_bonus),
      off: Boolean(s.is_negated),
    })).filter((s) => s.text),
    enchants: (x.enchantments || []).map((e) => ({
      // « Enchanté : +150 Critique » -> « +150 Critique » (le préfixe dépend de la langue)
      text: cleanText(e.display_string).replace(/^[^:+]{1,24}:\s*/, ''),
      rank: rank(e.display_string),
      temp: e.enchantment_slot?.type === 'TEMPORARY',
    })).filter((e) => e.text),
    sockets: (x.sockets || []).map((g) => ({
      type: cleanText(g.socket_type?.name) || null,
      gem: cleanText(g.item?.name) || null,
      text: cleanText(g.display_string) || null,
      mediaId: g.media?.id ?? g.item?.id ?? null,
      icon: null,
    })),
    spells: (x.spells || []).map((s) => ({ name: cleanText(s.spell?.name), text: cleanText(s.description), color: hex(s.display_color) })).filter((s) => s.text),
    set: x.set ? {
      name: cleanText(x.set.item_set?.name),
      items: (x.set.items || []).map((i) => ({ name: cleanText(i.item?.name), on: Boolean(i.is_equipped) })),
      effects: (x.set.effects || []).map((e) => ({ text: cleanText(e.display_string), count: e.required_count ?? null, on: Boolean(e.is_active) })),
    } : null,
    requires: textOf(x.requirements?.level) || null,
    durability: textOf(x.durability) || null,
    description: cleanText(x.description) || null,
    transmog: cleanText(x.transmog?.display_string) || null,
  };
}

// Statistiques du personnage : principale, endurance et secondaires (en % et en score)
function shapeStats(s) {
  const eff = (x) => x?.effective ?? null;
  const primary = [['str', eff(s.strength)], ['agi', eff(s.agility)], ['int', eff(s.intellect)]]
    .filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1])[0] || null;
  const best = (...xs) => xs.filter((x) => Number.isFinite(x?.value)).sort((a, b) => b.value - a.value)[0] || null;
  const crit = best(s.melee_crit, s.ranged_crit, s.spell_crit);
  const haste = best(s.melee_haste, s.ranged_haste, s.spell_haste);
  const pct = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const rating = (x) => (Number.isFinite(x?.rating_normalized) ? x.rating_normalized : Number.isFinite(x?.rating) ? x.rating : null);
  return {
    health: s.health ?? null,
    primary: primary ? { stat: primary[0], value: primary[1] } : null,
    stamina: eff(s.stamina),
    crit: pct(crit?.value), critRating: rating(crit),
    haste: pct(haste?.value), hasteRating: rating(haste),
    mastery: pct(s.mastery?.value), masteryRating: rating(s.mastery),
    vers: pct(s.versatility_damage_done_bonus), versRating: Number.isFinite(s.versatility) ? s.versatility : null,
  };
}

/* ---------------- Mise en forme (celle de shapeRio) ---------------- */
function shapeProfile({ region, realm, summary: p, keystone, season, raids, times, seasonId }) {
  const charId = p.id;
  const run = (r) => {
    const me = (r.members || []).find((m) => m.character?.id === charId);
    const specId = me?.specialization?.id;
    const par = times.get(r.dungeon?.id) || [];
    const timed = Boolean(r.is_completed_within_time);
    // Paliers gagnés : chaque temps à battre passé sous la durée ; timée sans temps connu = +1
    const upgrades = timed ? Math.max(1, par.filter((t) => r.duration <= t.ms).length) : 0;
    return {
      dungeon: r.dungeon?.name ?? null,
      mapId: r.dungeon?.id ?? null,
      short: null,
      spec: me?.specialization?.name ?? null,
      role: specId ? specRole(specId) : null,
      level: r.keystone_level,
      upgrades,
      timed,
      clearMs: r.duration ?? null,
      parMs: par.find((t) => t.level === 1)?.ms ?? null,
      completedAt: r.completed_timestamp ? new Date(r.completed_timestamp).toISOString() : null,
      score: r.map_rating?.rating ?? r.mythic_rating?.rating ?? null,
      url: null,
      // Composition du groupe : info-bulle d'une clé dans « Donjons de la saison » (spé, classe
      // déduite de la spé, niveau d'objet du joueur au moment de la clé)
      members: (r.members || []).map((m) => ({
        name: m.character?.name,
        realmSlug: m.character?.realm?.slug,
        spec: m.specialization?.name ?? null,
        className: SPEC_CLASS[m.specialization?.id] || null,
        role: m.specialization?.id ? specRole(m.specialization.id) : null,
        ilvl: Number.isFinite(m.equipped_item_level) ? m.equipped_item_level : null,
      })).filter((m) => m.name),
    };
  };
  const seasonRuns = (season?.best_runs || []).map(run);
  // Blizzard donne, par donjon, la meilleure clé timée et la plus haute hors temps si elle est
  // au-dessus : la meilleure (cote la plus haute) fait bestRuns, l'autre alternateRuns
  const byDungeon = new Map();
  for (const r of seasonRuns) {
    const k = r.mapId ?? r.dungeon;
    if (!byDungeon.has(k)) byDungeon.set(k, []);
    byDungeon.get(k).push(r);
  }
  const bestRuns = [];
  const alternateRuns = [];
  for (const list of byDungeon.values()) {
    list.sort((a, b) => (b.score || 0) - (a.score || 0) || b.level - a.level);
    bestRuns.push(list[0]);
    alternateRuns.push(...list.slice(1));
  }
  bestRuns.sort((a, b) => (b.score || 0) - (a.score || 0));
  // Pas d'historique chez Blizzard : les « clés récentes » sont les meilleures de la semaine et
  // celles de la saison terminées ces RECENT_DAYS derniers jours
  const since = Date.now() - RECENT_DAYS * 86400e3;
  const seen = new Set();
  const recentRuns = [...(keystone?.current_period?.best_runs || []).map(run), ...seasonRuns.filter((r) => Date.parse(r.completedAt) >= since)]
    .filter((r) => {
      const id = `${r.mapId}|${r.level}|${r.completedAt}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, 10);
  const highestRuns = [...seasonRuns].sort((a, b) => b.level - a.level || (b.upgrades - a.upgrades)).slice(0, 10);

  // Raids : boss tués par difficulté, rangés par nom de raid en slug (celui des listes du site)
  const raidProgress = {};
  const DIFF = { NORMAL: 'normal', HEROIC: 'heroic', MYTHIC: 'mythic' };
  for (const exp of raids?.expansions || []) {
    for (const inst of exp.instances || []) {
      const slug = slugify(inst.instance?.name);
      if (!slug || raidProgress[slug]) continue;
      const x = { summary: null, total: 0, normal: 0, heroic: 0, mythic: 0 };
      for (const m of inst.modes || []) {
        const d = DIFF[m.difficulty?.type];
        if (!d) continue;
        x[d] = m.progress?.completed_count ?? 0;
        x.total = Math.max(x.total, m.progress?.total_count ?? 0);
      }
      const top = x.mythic ? 'M' : x.heroic ? 'H' : x.normal ? 'N' : null;
      if (top) x.summary = `${x[{ M: 'mythic', H: 'heroic', N: 'normal' }[top]]}/${x.total} ${top}`;
      raidProgress[slug] = x;
    }
  }
  // Kills boss par boss, pour les raids de la saison seulement (progression de la fiche joueur,
  // demande de l'utilisateur) : Blizzard range ces raids dans une extension « Current Season »,
  // sinon on prend l'extension la plus récente. Seuls les boss tués au moins une fois y figurent.
  // bosses : [{ id (journal-encounter), name, l, n, h, m (kills en LFR, normal, héroïque, mythique), at }]
  const exps = raids?.expansions || [];
  const current = exps.find((e) => e.expansion?.name === 'Current Season')
    || exps.reduce((best, e) => ((e.expansion?.id || 0) > (best?.expansion?.id || 0) ? e : best), null);
  const KILL = { LFR: 'l', NORMAL: 'n', HEROIC: 'h', MYTHIC: 'm' };
  for (const inst of current?.instances || []) {
    const x = raidProgress[slugify(inst.instance?.name)];
    if (!x) continue;
    const bosses = new Map();
    for (const m of inst.modes || []) {
      const d = KILL[m.difficulty?.type];
      if (!d) continue;
      for (const e of m.progress?.encounters || []) {
        const id = e.encounter?.id;
        if (!id) continue;
        if (!bosses.has(id)) bosses.set(id, { id, name: e.encounter.name ?? null, l: 0, n: 0, h: 0, m: 0, at: null });
        const b = bosses.get(id);
        b[d] = e.completed_count ?? 0;
        if (e.last_kill_timestamp && e.last_kill_timestamp > (b.at || 0)) b.at = e.last_kill_timestamp;
      }
    }
    x.id = inst.instance?.id ?? null;
    x.lfr = (inst.modes || []).find((m) => m.difficulty?.type === 'LFR')?.progress?.completed_count ?? 0;
    x.bosses = [...bosses.values()];
  }

  const rating = keystone?.current_mythic_rating || season?.mythic_rating || null;
  const specId = p.active_spec?.id;
  return {
    found: true,
    realmSlug: p.realm?.slug || realm,
    name: p.name,
    realm: p.realm?.name ?? null,
    region,
    class: p.character_class?.name ?? null,
    spec: p.active_spec?.name ?? null,
    role: specId ? PROFILE_ROLE[specRole(specId)] : null,
    race: p.race?.name ?? null,
    thumbnail: null,
    // Simple lien vers la page publique du personnage chez Raider.IO (aucun appel à leur API)
    profileUrl: `https://raider.io/characters/${encodeURIComponent(region)}/${encodeURIComponent(p.realm?.slug || realm)}/${encodeURIComponent(p.name)}`,
    itemLevel: p.equipped_item_level ?? null,
    season: seasonId ? String(seasonId) : null,
    score: rating?.rating || 0,
    scoreColor: hex(rating?.color),
    roleScores: null,
    ranks: null,
    lastLogin: p.last_login_timestamp ?? null,
    bestRuns,
    alternateRuns,
    recentRuns,
    highestRuns,
    raidProgress,
    raidCurve: {},
  };
}

module.exports = { createBlizzardClient, shapeProfile, specRole, LIMIT_HOUR };
