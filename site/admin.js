'use strict';
/*
 * GroupScout — backoffice de l'admin (lecture seule)
 *
 * Tout ce que la base sait des comptes, des Battle.net liés et de la recherche de groupe, plus
 * ce qui ne vit qu'en mémoire dans server.js (verrous anti-force brute, limites de débit,
 * état du serveur), passé par `live`. Les actions (statut d'un compte, suppression, se
 * connecter en tant que) restent dans server.js et accounts.js.
 *
 * À créer après le gestionnaire de groupes : ses tables (lfg_*) doivent déjà exister.
 */

const PAGE = 50;
const n = (v) => Number(v) || 0;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Recherche « contient », insensible à la casse, sans jokers venus de l'utilisateur
const like = (v) => `%${String(v || '').trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const json = (raw, fallback) => { try { return JSON.parse(raw) ?? fallback; } catch { return fallback; } };

function createAdminReport({ db, accounts, now = () => Date.now(), live = {} }) {
  const q = (sql) => db.prepare(sql);
  const DAY = 24 * 3600e3;

  // Un compte en une ligne, pour citer qui a fait quoi
  const who = (id, name, email) => (id == null ? null : { id, name: name || (email ? email.split('@')[0] : `#${id}`), email: email || null, deleted: !email });

  const s = {
    // ---------- vue d'ensemble
    accountStats: q(`SELECT COUNT(*) AS total,
        SUM(status = 'normal') AS normal, SUM(status = 'vip') AS vip, SUM(status = 'admin') AS admin,
        SUM(verified) AS verified, SUM(password_hash IS NULL) AS nopass,
        SUM(created_at > ?) AS new24, SUM(created_at > ?) AS new7, SUM(last_login_at > ?) AS seen24, SUM(last_login_at > ?) AS seen7
      FROM accounts`),
    bnetStats: q('SELECT (SELECT COUNT(*) FROM bnet_links) AS links, (SELECT COUNT(*) FROM bnet_characters) AS characters'),
    groupStats: q(`SELECT
        (SELECT COUNT(*) FROM lfg_listings WHERE ends_at > ?) AS listings,
        (SELECT COUNT(*) FROM lfg_listings WHERE starts_at <= ? AND ends_at > ?) AS live,
        (SELECT COUNT(*) FROM lfg_listings WHERE created_at > ?) AS new24,
        (SELECT COUNT(*) FROM lfg_tags t JOIN lfg_listings l ON l.id = t.listing_id WHERE l.ends_at > ? AND t.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM lfg_tags t JOIN lfg_listings l ON l.id = t.listing_id WHERE l.ends_at > ? AND t.status = 'accepted' AND t.leader = 0) AS members,
        (SELECT COUNT(*) FROM lfg_searches WHERE ends_at > ?) AS searches,
        (SELECT COUNT(*) FROM lfg_messages WHERE kind = 'msg' AND created_at > ?) AS messages24`),
    loginStats: q(`SELECT COUNT(*) AS total, SUM(impersonator_id IS NOT NULL) AS impersonated, COUNT(DISTINCT account_id) AS accounts
      FROM logins WHERE expires_at > ?`),
    tokenStats: q("SELECT SUM(kind = 'code') AS code, SUM(kind = 'reset') AS reset FROM tokens WHERE expires_at > ?"),
    // Fil d'activité : inscriptions, connexions, Battle.net liés, annonces postées
    feed: q(`SELECT * FROM (
        SELECT 'inscription' AS type, a.created_at AS at, a.id AS account_id, a.name, a.email, NULL AS label, NULL AS code FROM accounts a
        UNION ALL SELECT 'connexion', a.last_login_at, a.id, a.name, a.email, NULL, NULL FROM accounts a WHERE a.last_login_at IS NOT NULL
        UNION ALL SELECT 'battlenet', b.updated_at, b.account_id, a.name, a.email, b.battletag, NULL FROM bnet_links b LEFT JOIN accounts a ON a.id = b.account_id
        UNION ALL SELECT 'annonce', l.created_at, l.account_id, a.name, a.email, l.data, l.code FROM lfg_listings l LEFT JOIN accounts a ON a.id = l.account_id
        UNION ALL SELECT 'recherche', r.created_at, r.account_id, a.name, a.email, r.char, NULL FROM lfg_searches r LEFT JOIN accounts a ON a.id = r.account_id
      ) WHERE at IS NOT NULL ORDER BY at DESC LIMIT ?`),

    // ---------- comptes
    accounts: q(`SELECT a.*, b.bnet_id, b.battletag, b.linked_at AS bnet_linked_at, b.updated_at AS bnet_updated_at,
        (SELECT COUNT(*) FROM bnet_characters c WHERE c.account_id = a.id) AS characters,
        (SELECT COUNT(*) FROM lfg_listings l WHERE l.account_id = a.id AND l.ends_at > ?) AS listings,
        (SELECT COUNT(*) FROM lfg_tags t JOIN lfg_listings l ON l.id = t.listing_id WHERE t.account_id = a.id AND t.leader = 0 AND l.ends_at > ?) AS tags,
        (SELECT COUNT(*) FROM logins l WHERE l.account_id = a.id AND l.expires_at > ? AND l.impersonator_id IS NULL) AS logins,
        (SELECT COUNT(*) FROM logins l WHERE l.account_id = a.id AND l.expires_at > ? AND l.impersonator_id IS NOT NULL) AS impersonations
      FROM accounts a LEFT JOIN bnet_links b ON b.account_id = a.id
      ORDER BY a.created_at DESC`),
    account: q('SELECT a.* FROM accounts a WHERE a.id = ?'),
    logins: q(`SELECT l.*, i.name AS imp_name, i.email AS imp_email
      FROM logins l LEFT JOIN accounts i ON i.id = l.impersonator_id WHERE l.account_id = ? AND l.expires_at > ? ORDER BY l.created_at DESC`),
    tokens: q('SELECT kind, created_at, expires_at FROM tokens WHERE account_id = ? AND expires_at > ? ORDER BY created_at DESC'),
    bnetLink: q('SELECT * FROM bnet_links WHERE account_id = ?'),
    characters: q('SELECT * FROM bnet_characters c WHERE c.account_id = ? ORDER BY c.level DESC, c.name'),
    listingsOf: q('SELECT * FROM lfg_listings WHERE account_id = ? ORDER BY starts_at DESC'),
    tagsOf: q(`SELECT t.*, l.code, l.data AS listing_data, l.starts_at, l.ends_at FROM lfg_tags t JOIN lfg_listings l ON l.id = t.listing_id
      WHERE t.account_id = ? AND t.leader = 0 ORDER BY l.starts_at DESC`),
    searchOf: q('SELECT * FROM lfg_searches WHERE account_id = ? ORDER BY ends_at DESC'),

    // ---------- recherche de groupe
    listings: q(`SELECT l.*, a.name, a.email,
        (SELECT COUNT(*) FROM lfg_tags t WHERE t.listing_id = l.id AND t.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM lfg_tags t WHERE t.listing_id = l.id AND t.status = 'invited') AS invited,
        (SELECT COUNT(*) FROM lfg_tags t WHERE t.listing_id = l.id AND t.status = 'accepted') AS accepted,
        (SELECT COUNT(*) FROM lfg_messages m WHERE m.listing_id = l.id AND m.kind = 'msg') AS messages,
        (SELECT t.char FROM lfg_tags t WHERE t.listing_id = l.id AND t.leader = 1) AS leader_char
      FROM lfg_listings l LEFT JOIN accounts a ON a.id = l.account_id ORDER BY l.starts_at`),
    searches: q(`SELECT r.*, a.name, a.email FROM lfg_searches r LEFT JOIN accounts a ON a.id = r.account_id ORDER BY r.starts_at`),

    // ---------- Battle.net
    bnetLinks: q(`SELECT b.*, a.name, a.email, a.status,
        (SELECT COUNT(*) FROM bnet_characters c WHERE c.account_id = b.account_id) AS characters
      FROM bnet_links b LEFT JOIN accounts a ON a.id = b.account_id ORDER BY b.updated_at DESC`),
    allCharacters: q(`SELECT c.*, a.name AS acc_name, a.email FROM bnet_characters c LEFT JOIN accounts a ON a.id = c.account_id
      WHERE (? = '%%' OR lower(c.name) LIKE ? ESCAPE '\\' OR lower(c.realm) LIKE ? ESCAPE '\\' OR lower(c.key) LIKE ? ESCAPE '\\') ORDER BY c.name LIMIT 300`),
  };

  // Annonce en une ligne : « Reclear · Manaforge Omega H » et son créneau
  function listingShape(row) {
    const d = json(row.data, {});
    const leader = json(row.leader_char, null);
    return {
      code: row.code,
      title: d.title || '',
      goal: d.goal || 'reclear',
      raid: d.raid || '',
      raidName: d.raidName || '',
      difficulty: d.difficulty || null,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      createdAt: row.created_at,
      phase: now() >= row.ends_at ? 'ended' : now() >= row.starts_at ? 'live' : 'open',
      comp: d.comp || null,
      owner: row.email !== undefined ? who(row.account_id, row.name, row.email) : null,
      leader: leader ? { name: leader.name, realm: leader.realm, className: leader.className || null } : null,
      pending: n(row.pending),
      invited: n(row.invited),
      accepted: n(row.accepted),
      messages: n(row.messages),
    };
  }

  /* ---------------------------------------------------------------- */
  function overview() {
    const t = now();
    const acc = s.accountStats.get(t - DAY, t - 7 * DAY, t - DAY, t - 7 * DAY);
    const bn = s.bnetStats.get();
    const gr = s.groupStats.get(t, t, t, t - DAY, t, t, t, t - DAY);
    const lo = s.loginStats.get(t);
    const to = s.tokenStats.get(t);
    const feed = s.feed.all(80).map((r) => {
      let label = r.label;
      if (r.type === 'annonce') { const d = json(r.label, {}); label = d.title || [d.raidName, d.difficulty].filter(Boolean).join(' · '); }
      if (r.type === 'recherche') { const c = json(r.label, {}); label = c.name ? `${c.name}-${c.realm || ''}` : null; }
      return { type: r.type, at: r.at, account: who(r.account_id, r.name, r.email), label: label || null, code: r.code || null };
    });
    return {
      accounts: {
        total: n(acc.total), normal: n(acc.normal), vip: n(acc.vip), admin: n(acc.admin), verified: n(acc.verified),
        noPassword: n(acc.nopass), new24: n(acc.new24), new7: n(acc.new7),
        seen24: n(acc.seen24), seen7: n(acc.seen7), bnet: n(bn.links), characters: n(bn.characters),
      },
      groups: {
        listings: n(gr.listings), live: n(gr.live), new24: n(gr.new24), pending: n(gr.pending),
        members: n(gr.members), searches: n(gr.searches), messages24: n(gr.messages24),
      },
      logins: { total: n(lo.total), impersonated: n(lo.impersonated), accounts: n(lo.accounts) },
      tokens: { code: n(to.code), reset: n(to.reset) },
      lockouts: live.lockouts ? live.lockouts().filter((l) => l.until > t).length : 0,
      blizzard: live.blizzard ? live.blizzard() : null,
      server: live.server ? live.server() : null,
      feed,
    };
  }

  /* ---------------------------------------------------------------- */
  function listAccounts(meId) {
    const t = now();
    const base = new Map(accounts.listAccounts().map((a) => [a.id, a]));
    return s.accounts.all(t, t, t, t).map((r) => {
      const a = base.get(r.id) || {};
      return {
        id: r.id,
        email: r.email,
        name: r.name || r.email.split('@')[0],
        status: r.status,
        verified: Boolean(r.verified),
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at || null,
        hasPassword: Boolean(r.password_hash),
        protected: Boolean(a.protected),
        self: r.id === meId,
        bnet: r.bnet_id ? { battletag: r.battletag, linkedAt: r.bnet_linked_at, updatedAt: r.bnet_updated_at, characters: n(r.characters) } : null,
        listings: n(r.listings),
        tags: n(r.tags),
        logins: n(r.logins),
        impersonations: n(r.impersonations),
      };
    });
  }

  /* ---------------------------------------------------------------- */
  function accountDetail(id, meId) {
    const row = s.account.get(Number(id));
    if (!row) throw httpError(404, 'Compte introuvable.');
    const t = now();
    const summary = listAccounts(meId).find((a) => a.id === row.id);
    const link = s.bnetLink.get(row.id);
    const lockouts = live.lockouts ? live.lockouts().filter((l) => l.email === row.email) : [];
    return {
      account: summary,
      logins: s.logins.all(row.id, t).map((l) => ({
        id: l.id.slice(0, 6),
        createdAt: l.created_at,
        expiresAt: l.expires_at,
        agent: l.agent,
        impersonatedBy: l.impersonator_id ? who(l.impersonator_id, l.imp_name, l.imp_email) : null,
      })),
      tokens: s.tokens.all(row.id, t).map((k) => ({ kind: k.kind, createdAt: k.created_at, expiresAt: k.expires_at })),
      bnet: link ? {
        bnetId: link.bnet_id, battletag: link.battletag, region: link.region, linkedAt: link.linked_at, updatedAt: link.updated_at,
        characters: s.characters.all(row.id).map((c) => ({ key: c.key, name: c.name, realm: c.realm, className: c.class, level: c.level })),
      } : null,
      listings: s.listingsOf.all(row.id).map((l) => listingShape(l)),
      tags: s.tagsOf.all(row.id).map((x) => {
        const d = json(x.listing_data, {});
        const c = json(x.char, {});
        return {
          code: x.code, title: d.title || [d.raidName, d.difficulty].filter(Boolean).join(' · '), startsAt: x.starts_at, endsAt: x.ends_at,
          status: x.status, role: x.role, char: { name: c.name, realm: c.realm, className: c.className || null },
        };
      }),
      searches: s.searchOf.all(row.id).map((x) => {
        const c = json(x.char, {});
        return { startsAt: x.starts_at, endsAt: x.ends_at, char: { name: c.name, realm: c.realm, className: c.className || null }, data: json(x.data, {}) };
      }),
      lockouts,
    };
  }

  /* ---------------------------------------------------------------- */
  // Annonces encore en mémoire (un raid est effacé 24 h après sa fin), et recherches en cours
  function groups() {
    const t = now();
    return {
      listings: s.listings.all().map(listingShape),
      searches: s.searches.all().filter((r) => r.ends_at > t).map((r) => {
        const c = json(r.char, {});
        const d = json(r.data, {});
        return {
          id: r.id, owner: who(r.account_id, r.name, r.email), startsAt: r.starts_at, endsAt: r.ends_at,
          char: { name: c.name, realm: c.realm, className: c.className || null },
          roles: d.roles || [], difficulties: d.difficulties || [], raid: d.raid || '',
        };
      }),
    };
  }

  /* ---------------------------------------------------------------- */
  function battlenet({ q: search } = {}) {
    const l = like(search);
    return {
      links: s.bnetLinks.all().map((b) => ({
        account: who(b.account_id, b.name, b.email), status: b.status, bnetId: b.bnet_id, battletag: b.battletag, region: b.region,
        linkedAt: b.linked_at, updatedAt: b.updated_at, characters: n(b.characters),
      })),
      characters: s.allCharacters.all(l, l, l, l).map((c) => ({ key: c.key, name: c.name, realm: c.realm, className: c.class, level: c.level, account: who(c.account_id, c.acc_name, c.email) })),
    };
  }

  /* ---------------------------------------------------------------- */
  function security() {
    const t = now();
    return {
      lockouts: live.lockouts ? live.lockouts() : [],
      logins: db.prepare(`SELECT l.id, l.account_id, a.name, a.email, l.created_at, l.expires_at, l.agent, l.impersonator_id, i.name AS imp_name, i.email AS imp_email
        FROM logins l LEFT JOIN accounts a ON a.id = l.account_id LEFT JOIN accounts i ON i.id = l.impersonator_id
        WHERE l.expires_at > ? ORDER BY l.created_at DESC LIMIT 300`).all(t).map((l) => ({
        id: l.id.slice(0, 6), account: who(l.account_id, l.name, l.email), createdAt: l.created_at, expiresAt: l.expires_at, agent: l.agent,
        impersonatedBy: l.impersonator_id ? who(l.impersonator_id, l.imp_name, l.imp_email) : null,
      })),
      tokens: db.prepare(`SELECT t.kind, t.created_at, t.expires_at, t.account_id, a.name, a.email FROM tokens t
        LEFT JOIN accounts a ON a.id = t.account_id WHERE t.expires_at > ? ORDER BY t.created_at DESC`).all(t).map((k) => ({
        kind: k.kind, createdAt: k.created_at, expiresAt: k.expires_at, account: who(k.account_id, k.name, k.email),
      })),
      adminEmails: accounts.adminEmails(),
      rateLimits: live.rateLimits ? live.rateLimits() : [],
    };
  }

  return { overview, listAccounts, accountDetail, groups, battlenet, security, PAGE };
}

module.exports = { createAdminReport };
