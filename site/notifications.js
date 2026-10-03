'use strict';
// Notifications d'un compte : la cloche de la barre du haut. Pour l'instant, tout vient de la
// recherche de groupe (groups.js), mais le mécanisme est fait pour en accueillir d'autres : un
// type (`kind`), des données en JSON, lue ou non.
//
// Gardées en base (table `notifications`, supprimées avec le compte), 50 au plus par compte et
// 30 jours au plus. Chaque onglet connecté en reçoit le direct (SSE, `stream`) : une notification
// nouvelle, lue ou effacée arrive dans tous les onglets du compte en même temps.
//
// `ref` évite les doublons : une même chose ne fait qu'une notification. Elle ne revient (en
// tête, non lue) qu'après 12 h.

const KEEP = 50;                      // par compte
const MAX_AGE = 30 * 24 * 3600e3;     // 30 jours
const LIST = 30;                      // envoyées au navigateur
const MAX_STREAMS = 10;               // onglets ouverts par compte
const HEARTBEAT_MS = 25e3;
const DEDUPE_MS = 12 * 3600e3;        // même `ref` : ignorée pendant 12 h
// lfg_* : recherche de groupe (groups.js) : nouveau tag (leader), place proposée (joueur), place
// acceptée (leader), retiré du raid (joueur), départ d'un membre (leader), annonce supprimée
const KINDS = new Set(['lfg_tag', 'lfg_invite', 'lfg_join', 'lfg_removed', 'lfg_left', 'lfg_deleted']);

function createNotifier({ db }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS notifications_account ON notifications(account_id, created_at DESC);
  `);

  const q = {
    insert: db.prepare('INSERT INTO notifications (account_id, kind, ref, data, created_at) VALUES (?, ?, ?, ?, ?)'),
    byRef: db.prepare('SELECT id, created_at FROM notifications WHERE account_id = ? AND ref = ?'),
    refresh: db.prepare('UPDATE notifications SET data = ?, created_at = ?, read_at = NULL WHERE id = ?'),
    get: db.prepare('SELECT * FROM notifications WHERE id = ?'),
    list: db.prepare('SELECT * FROM notifications WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read_at IS NULL'),
    readAll: db.prepare('UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL'),
    readOne: db.prepare('UPDATE notifications SET read_at = ? WHERE account_id = ? AND id = ? AND read_at IS NULL'),
    removeAll: db.prepare('DELETE FROM notifications WHERE account_id = ?'),
    removeOne: db.prepare('DELETE FROM notifications WHERE account_id = ? AND id = ?'),
    trim: db.prepare(`DELETE FROM notifications WHERE account_id = ? AND id NOT IN
      (SELECT id FROM notifications WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`),
    purge: db.prepare('DELETE FROM notifications WHERE created_at < ?'),
  };

  const shape = (row) => {
    let data = {};
    try { data = JSON.parse(row.data) || {}; } catch { /* ligne abîmée : sans données */ }
    return { id: row.id, kind: row.kind, data, createdAt: row.created_at, read: row.read_at != null };
  };
  const unreadOf = (accountId) => q.unread.get(accountId).n;

  // Direct : compte → onglets ouverts
  const streams = new Map();
  function emit(accountId, event, payload) {
    const set = streams.get(accountId);
    if (!set) return;
    const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) { try { res.write(chunk); } catch { /* onglet fermé entre-temps */ } }
  }

  // `decorate(item)` : ce que le serveur sait au moment de l'envoi (annonce encore en ligne…)
  let decorate = (item) => item;
  const out = (row) => decorate(shape(row));

  function list(accountId) {
    return { items: q.list.all(accountId, LIST).map(out), unread: unreadOf(accountId) };
  }

  function add(accountId, kind, data = {}, ref = null) {
    if (!accountId || !KINDS.has(kind)) return null;
    const now = Date.now();
    const json = JSON.stringify(data);
    const found = ref ? q.byRef.get(accountId, ref) : null;
    if (found && now - found.created_at < DEDUPE_MS) return null;
    let id;
    if (found) { q.refresh.run(json, now, found.id); id = found.id; }
    else {
      id = Number(q.insert.run(accountId, kind, ref, json, now).lastInsertRowid);
      q.trim.run(accountId, accountId, KEEP);
    }
    const item = out(q.get.get(id));
    emit(accountId, 'notification', { item, unread: unreadOf(accountId) });
    return item;
  }

  // ids absent = toutes
  function markRead(accountId, ids) {
    const now = Date.now();
    if (Array.isArray(ids)) for (const id of ids.slice(0, 100)) q.readOne.run(now, accountId, Number(id) || 0);
    else q.readAll.run(now, accountId);
    const unread = unreadOf(accountId);
    emit(accountId, 'read', { ids: Array.isArray(ids) ? ids.map(Number) : null, unread });
    return { unread };
  }

  function remove(accountId, ids) {
    if (Array.isArray(ids)) for (const id of ids.slice(0, 100)) q.removeOne.run(accountId, Number(id) || 0);
    else q.removeAll.run(accountId);
    const unread = unreadOf(accountId);
    emit(accountId, 'removed', { ids: Array.isArray(ids) ? ids.map(Number) : null, unread });
    return { unread };
  }

  function stream(accountId, req, res) {
    let set = streams.get(accountId);
    if (!set) streams.set(accountId, (set = new Set()));
    // Trop d'onglets : le plus ancien est coupé (il se reconnectera s'il est encore ouvert)
    if (set.size >= MAX_STREAMS) {
      const oldest = set.values().next().value;
      set.delete(oldest);
      try { oldest.end(); } catch { /* déjà fermé */ }
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify(list(accountId))}\n\n`);
    set.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (!set.size) streams.delete(accountId);
    });
  }

  // Ménage : plus de 30 jours, au démarrage puis chaque jour
  const purge = () => { try { q.purge.run(Date.now() - MAX_AGE); } catch (e) { console.error(e); } };
  purge();
  setInterval(purge, 24 * 3600e3).unref?.();

  return {
    add, list, markRead, remove, stream,
    setDecorator(fn) { decorate = fn; },
  };
}

module.exports = { createNotifier };
