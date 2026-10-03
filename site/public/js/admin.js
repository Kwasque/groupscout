'use strict';
/* ================================================================== */
/* Backoffice de l'admin (/admin)                                      */
/* ================================================================== */
// Tout se lit en lecture seule depuis /api/admin/* ; l'état de la page est dans l'adresse
// (/admin?view=groups&q=…, /admin?account=12, /admin?visit=…), donc le bouton précédent du
// navigateur marche et un lien se partage. Les actions : statut d'un compte, suppression, et se
// connecter en tant que quelqu'un.
const ADM_TABS = [
  ['overview', "Vue d'ensemble"], ['audience', 'Audience'], ['accounts', 'Comptes'], ['groups', 'Annonces'],
  ['bnet', 'Battle.net'], ['security', 'Sécurité'],
];
const ADM_API = { overview: 'overview', audience: 'audience', accounts: 'accounts', groups: 'groups', bnet: 'bnet', security: 'security' };
// Valeurs de filtre de l'adresse (en anglais) -> valeurs attendues par l'API
const ADM_VALUES = { kind: { new: 'nouveau', returning: 'revenant', 'logged-in': 'connecte', clicks: 'clics', long: 'longue' } };
let admLoad = 0;   // requête la plus récente : une réponse plus ancienne arrivée après est ignorée
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const counted = (n, one, many) => `${n} ${n > 1 ? many : one}`;

const admHref = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null && !(k === 'page' && Number(v) === 1)) sp.set(k, v);
  const s = sp.toString();
  return `/admin${s ? `?${s}` : ''}`;
};
const admA = (params, html, extra = '') => `<a href="${esc(admHref(params))}" data-adm${extra}>${html}</a>`;

function admWhen(ts) {
  if (!ts) return '<span class="dim">—</span>';
  const full = new Date(ts).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  const s = (ts - Date.now()) / 1000;
  let txt;
  if (s > 60) txt = s < 3600 ? `dans ${Math.round(s / 60)} min` : s < 86400 ? `dans ${Math.round(s / 3600)} h` : `dans ${Math.round(s / 86400)} j`;
  else txt = timeAgo(ts) || 'à l\'instant';
  return `<span title="${esc(full)}">${esc(txt)}</span>`;
}
const admYes = (ok, yes = 'oui', no = 'non') => (ok ? `<span class="bo-yes">${esc(yes)}</span>` : `<span class="bo-no">${esc(no)}</span>`);
const admNum = (n) => Number(n || 0).toLocaleString('fr-FR');
const admZero = (n) => (n ? admNum(n) : '<span class="dim">0</span>');
function admBytes(b) {
  if (b == null) return '—';
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} Mo`;
  return `${Math.max(1, Math.round(b / 1e3))} ko`;
}
function admWho(w, { mail = true } = {}) {
  if (!w) return '<span class="dim">—</span>';
  if (w.deleted) return `<span class="dim" title="Compte supprimé">compte supprimé #${esc(w.id)}</span>`;
  return `${admA({ account: w.id }, `<b>${esc(w.name)}</b>`)}${mail ? `<span class="adm-mail">${esc(w.email)}</span>` : ''}`;
}
// Un personnage, vers sa fiche GroupScout
function admChar(c) {
  if (!c?.name) return '<span class="dim">—</span>';
  const color = c.className && CLASS_COLORS[c.className];
  return `<a href="${esc(playerPath(c.name, c.realm))}" data-player-link><span${color ? ` style="color:${color}"` : ''}>${esc(c.name)}</span></a> <span class="dim">${esc(c.realm || '')}</span>`;
}
// Une annonce, vers sa page
const admListing = (code, label) => `<a href="/groups/${esc(code)}" data-lf-go="/groups/${esc(code)}">${label ? esc(label) : `<span class="bo-code">${esc(code)}</span>`}</a>`;
const ADM_PHASE = { open: 'recrute', live: 'en cours', ended: 'terminé' };
const ADM_TAG = { pending: 'candidature', invited: 'place proposée', accepted: 'dans le raid', declined: 'refusée', refused: 'proposition refusée', withdrawn: 'retirée', removed: 'retiré du raid', left: 'a quitté le raid' };

function admTiles(list) {
  return `<div class="bo-tiles">${list.map(([v, label, sub]) => `<div class="bo-tile"><b>${typeof v === 'number' ? admNum(v) : v}</b><span>${esc(label)}</span>${sub ? `<small>${sub}</small>` : ''}</div>`).join('')}</div>`;
}
function admTable(head, rows, empty = 'Rien pour l\'instant.') {
  if (!rows.length) return `<p class="note bo-empty">${esc(empty)}</p>`;
  return `<div class="table-scroll"><table class="mini adm-table"><thead><tr>${head.map((h) => {
    const [txt, cls] = Array.isArray(h) ? h : [h, ''];
    return `<th${cls ? ` class="${cls}"` : ''}>${esc(txt)}</th>`;
  }).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
const admSection = (title, body, count) => `<section class="bo-section"><h2>${esc(title)}${count != null ? ` <span class="bo-n">${admNum(count)}</span>` : ''}</h2>${body}</section>`;
function admPager(d, params) {
  if (d.pages <= 1) return '';
  return `<nav class="bo-pager">
    ${d.page > 1 ? admA({ ...params, page: d.page - 1 }, '← Précédente', ' class="btn glass small"') : ''}
    <span class="note">Page ${d.page} sur ${d.pages} · ${admNum(d.total)} au total</span>
    ${d.page < d.pages ? admA({ ...params, page: d.page + 1 }, 'Suivante →', ' class="btn glass small"') : ''}
  </nav>`;
}
// Recherche + filtre : le formulaire devient une adresse (voir l'écouteur `submit` de #admin)
function admSearch(params, placeholder, filter = null) {
  const keep = Object.entries(params).filter(([k]) => !['q', 'page'].includes(k) && k !== filter?.name);
  return `<form class="bo-search" data-adm-search>
    ${keep.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
    <input type="search" name="q" value="${esc(params.q || '')}" placeholder="${esc(placeholder)}" spellcheck="false" aria-label="Rechercher">
    <button class="btn glass small" type="submit">Chercher</button>
    ${filter ? `<input type="hidden" name="${esc(filter.name)}" value="${esc(params[filter.name] || '')}">
      <span class="segmented bo-filter" role="radiogroup">${filter.options.map(([v, label]) => `<button type="submit" name="${esc(filter.name)}" value="${esc(v)}" role="radio" aria-checked="${String((params[filter.name] || '') === v)}">${esc(label)}</button>`).join('')}</span>` : ''}
  </form>`;
}

function admShell(active, title, lead, body) {
  const tabs = ADM_TABS.map(([id, label]) => `<a href="${esc(admHref(id === 'overview' ? {} : { view: id }))}" data-adm class="bo-tab${id === active ? ' on' : ''}"${id === active ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('');
  return `<span class="card-kicker">Backoffice</span>
    <nav class="bo-tabs" aria-label="Sections du backoffice">${tabs}</nav>
    <h1 class="auth-title">${title}</h1>
    ${lead ? `<p class="auth-lead">${lead}</p>` : ''}
    ${body}`;
}

// silent : rafraîchissement automatique (onglet Audience) — ni voile de chargement, ni message
// d'erreur à la place des chiffres si une requête échoue
async function openAdminPage({ silent = false } = {}) {
  clearTimeout(audTimer);
  if (!silent) showView('admin');
  document.title = 'Backoffice · GroupScout';
  const params = Object.fromEntries(new URLSearchParams(location.search));
  const id = ++admLoad;
  const card = $('#adminCard');
  if (!card.dataset.html) setHtml(card, '<p class="note">Chargement…</p>');
  if (!silent) card.classList.add('bo-loading');
  try {
    let html;
    if (params.account) html = admAccountPage(await api(`/api/admin/account?id=${encodeURIComponent(params.account)}`));
    else if (params.visit) html = admVisitPage(await api(`/api/admin/audience?visit=${encodeURIComponent(params.visit)}`));
    else {
      const vue = ADM_API[params.view] ? params.view : 'overview';
      const qs = new URLSearchParams(params);
      qs.delete('view');
      // Le filtre des visites s'appelle `type` dans l'adresse et `kind` pour l'API
      if (qs.has('type')) { qs.set('kind', qs.get('type')); qs.delete('type'); }
      for (const [k, map] of Object.entries(ADM_VALUES)) if (map[qs.get(k)]) qs.set(k, map[qs.get(k)]);
      const d = await api(`/api/admin/${ADM_API[vue]}?${qs}`);
      html = ({ overview: admOverview, audience: admAudience, accounts: admAccounts, groups: admGroups, bnet: admBnet, security: admSecurity })[vue](d, params);
    }
    if (id !== admLoad) return;
    setHtml(card, html);
    const upd = $('#audUpdated');
    if (upd) upd.textContent = `mis à jour à ${new Date().toLocaleTimeString('fr-FR')}`;
  } catch (e) {
    if (id !== admLoad) return;
    if (e.status === 401) { openAuth('login', { error: 'Connecte-toi.' }); return; }
    if (!silent) setHtml(card, admShell('', 'Backoffice', '', `<p class="error">${esc(e.message)}</p>`));
  } finally {
    if (id === admLoad) { card.classList.remove('bo-loading'); scheduleAudienceRefresh(); }
  }
}

// Onglet Audience en direct : relu toutes les 10 s tant qu'il est affiché, en pause si l'onglet du
// navigateur est caché ou si une fenêtre est ouverte, et relu aussitôt au retour sur l'onglet
const AUD_REFRESH_MS = 10e3;
let audTimer = null;
function onAudience() {
  const sp = new URLSearchParams(location.search);
  return currentView === 'admin' && sp.get('view') === 'audience' && !sp.has('account') && !sp.has('visit');
}
function scheduleAudienceRefresh() {
  clearTimeout(audTimer);
  if (!onAudience()) return;
  audTimer = setTimeout(() => {
    if (!onAudience()) return;
    if (document.hidden || !$('#modal').hidden) { scheduleAudienceRefresh(); return; }
    openAdminPage({ silent: true });
  }, AUD_REFRESH_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && onAudience()) openAdminPage({ silent: true }); });

/* --- Vue d'ensemble --- */
const FEED_TYPE = { inscription: 'Inscription', connexion: 'Connexion', battlenet: 'Battle.net', annonce: 'Annonce', recherche: 'Recherche' };
function admOverview(d) {
  const a = d.accounts, g = d.groups, s = d.server, b = d.blizzard;
  const feedLine = (f) => {
    const what = {
      inscription: 'a créé son compte',
      connexion: 'dernière connexion',
      battlenet: `a lié le Battle.net <b>${esc(f.label || '')}</b>`,
      annonce: `a posté ${f.code ? admListing(f.code, f.label) : 'une annonce'}`,
      recherche: `cherche un raid${f.label ? ` avec <b>${esc(f.label)}</b>` : ''}`,
    }[f.type] || '';
    return `<li><span class="bo-feed-when">${admWhen(f.at)}</span><span class="bo-feed-type t-${esc(f.type)}">${esc(FEED_TYPE[f.type] || f.type)}</span><span class="bo-feed-what">${admWho(f.account, { mail: false })} ${what}</span></li>`;
  };
  const services = s ? [[s.mail, 'e-mails'], [s.bnet, 'Battle.net'], [s.publicUrl, 'adresse publique']] : [];
  const body = `
    ${admSection('Comptes', admTiles([
      [a.total, 'comptes', `${a.new24} en 24 h · ${a.new7} en 7 j`],
      [a.vip, 'VIP', `${a.normal} normaux · ${a.admin} admin`],
      [a.verified, 'adresses vérifiées', `${a.total - a.verified} en attente`],
      [a.seen24, 'connectés en 24 h', `${a.seen7} en 7 j`],
      [a.bnet, 'Battle.net liés', `${a.characters} personnages`],
      [d.logins.total, 'connexions ouvertes', `${d.logins.accounts} comptes${d.logins.impersonated ? ` · ${d.logins.impersonated} « en tant que »` : ''}`],
    ]))}
    ${admSection('Recherche de groupe', admTiles([
      [g.listings, 'annonces en ligne', `${g.live} raids en cours · ${g.new24} postées en 24 h`],
      [g.pending, 'candidatures en attente', ''],
      [g.members, 'joueurs placés', 'dans les raids à venir ou en cours'],
      [g.searches, 'joueurs qui cherchent', ''],
      [g.messages24, 'messages de chat', 'en 24 h'],
    ]))}
    ${admSection('En ce moment', admTiles([
      [d.lockouts, 'blocages actifs', admA({ view: 'security' }, 'voir le détail')],
      [d.tokens.code, 'confirmations en attente', `${d.tokens.reset} nouveaux mots de passe`],
      [b ? admNum(b.used) : '—', 'requêtes Blizzard', b ? `sur ${admNum(b.limit)} cette heure · ${admNum(b.cached)} profils en cache` : ''],
      [s ? esc(timeAgo(s.startedAt).replace('il y a ', '') || '< 1 min') : '—', 'depuis le démarrage', s ? `Node ${esc(s.node)} · ${admBytes(s.memory)} de mémoire` : ''],
      [s ? admBytes(s.dbSize) : '—', 'de données', s ? `${admNum(s.cacheEntries)} réponses en cache` : ''],
      [s ? `${services.filter(([ok]) => ok).length} / ${services.length}` : '—', 'services configurés', services.map(([ok, label]) => admYes(ok, label, label)).join(' ')],
    ]))}
    ${admSection('Activité récente', d.feed.length ? `<ul class="bo-feed">${d.feed.map(feedLine).join('')}</ul>` : '<p class="note">Rien pour l\'instant.</p>')}`;
  return admShell('overview', "Vue d'ensemble", 'Tout ce qui se passe sur GroupScout, en un coup d\'œil.', body);
}

/* --- Comptes --- */
function admStatusButtons(a) {
  return `<div class="segmented adm-seg">${Object.keys(STATUS_LABEL).map((st) => `<button class="seg-btn${a.status === st ? ' on' : ''}" type="button" data-set-status="${st}" data-id="${a.id}"${a.protected ? ' disabled title="Admin d\'office"' : ''}>${esc(STATUS_LABEL[st])}</button>`).join('')}</div>`;
}
function admAccountActions(a) {
  return `${a.self ? '<span class="note">toi</span>' : `<button class="btn glass small" type="button" data-imp-account="${a.id}" title="Voir le site avec ce compte">Se connecter</button>`}
    ${a.protected ? '<span class="note" title="Admin d\'office">protégé</span>' : `<button class="btn ghost small" type="button" data-del-account="${a.id}">Supprimer</button>`}`;
}
const ACCOUNT_FILTERS = [['', 'Tous'], ['vip', 'VIP'], ['normal', 'Normaux'], ['admin', 'Admin'], ['unverified', 'Non vérifiés'], ['no-bnet', 'Sans Battle.net']];
const ACCOUNT_STATUS_FILTER = { vip: 'vip', normal: 'normal', admin: 'admin' };
function admAccounts(d, params) {
  const q = (params.q || '').trim().toLowerCase();
  const f = params.filter || '';
  const rows = d.accounts.filter((a) => {
    if (q && !`${a.name} ${a.email} ${a.bnet?.battletag || ''}`.toLowerCase().includes(q)) return false;
    if (ACCOUNT_STATUS_FILTER[f]) return a.status === ACCOUNT_STATUS_FILTER[f];
    if (f === 'unverified') return !a.verified;
    if (f === 'no-bnet') return !a.bnet;
    return true;
  });
  const lignes = rows.map((a) => `<tr>
    <td>${admWho(a)}${a.verified ? '' : '<span class="bo-no bo-sub">adresse non confirmée</span>'}</td>
    <td>${admStatusButtons(a)}</td>
    <td>${a.bnet ? `<span class="bo-yes" title="${esc(`${a.bnet.characters} personnages, lié le ${new Date(a.bnet.linkedAt).toLocaleDateString('fr-FR')}`)}">${esc(a.bnet.battletag || 'lié')}</span>` : '<span class="bo-no">non lié</span>'}</td>
    <td class="num">${admZero(a.listings)}</td>
    <td class="num">${admZero(a.tags)}</td>
    <td class="num">${admZero(a.logins)}${a.impersonations ? ` <span class="bo-warn" title="Connexion « en tant que » ce compte">+${a.impersonations}</span>` : ''}</td>
    <td class="num">${admWhen(a.createdAt)}<span class="bo-sub">${a.lastLoginAt ? `vu ${admWhen(a.lastLoginAt)}` : 'jamais connecté'}</span></td>
    <td class="adm-actions">${admAccountActions(a)}</td>
  </tr>`);
  const body = `
    ${admSearch(params, 'Nom, adresse ou BattleTag', { name: 'filter', options: ACCOUNT_FILTERS })}
    ${admTable(['Compte', 'Statut', 'Battle.net', ['Annonce', 'num'], ['Candidatures', 'num'], ['Conn.', 'num'], ['Créé', 'num'], ''], lignes, 'Aucun compte ne correspond.')}`;
  return admShell('accounts', 'Comptes', `${plural(rows.length, 'compte')}${rows.length !== d.accounts.length ? ` sur ${d.accounts.length}` : ''}. Clique un nom pour tout voir de ce compte. « Annonce » et « Candidatures » : dans les raids encore à venir ou en cours.`, body);
}

function admAccountPage(d) {
  const a = d.account;
  const ident = `<dl class="bo-dl">
    <dt>Adresse</dt><dd>${esc(a.email)} ${admYes(a.verified, 'vérifiée', 'non confirmée')}</dd>
    <dt>Statut</dt><dd>${admStatusButtons(a)}</dd>
    <dt>Créé</dt><dd>${admWhen(a.createdAt)}</dd>
    <dt>Dernière connexion</dt><dd>${a.lastLoginAt ? admWhen(a.lastLoginAt) : 'jamais'}</dd>
    <dt>Mot de passe</dt><dd>${admYes(a.hasPassword, 'défini', 'aucun')}</dd>
    <dt>Battle.net</dt><dd>${d.bnet ? `<b>${esc(d.bnet.battletag || '?')}</b> <span class="note">n° ${esc(d.bnet.bnetId)} · ${esc(d.bnet.region.toUpperCase())} · lié ${admWhen(d.bnet.linkedAt)} · liste mise à jour ${admWhen(d.bnet.updatedAt)}</span>` : '<span class="bo-no">non lié</span>'}</dd>
    <dt>Codes en attente</dt><dd>${d.tokens.length ? d.tokens.map((t) => `${t.kind === 'reset' ? 'nouveau mot de passe' : 'confirmation d\'adresse'}, expire ${admWhen(t.expiresAt)}`).join('<br>') : '<span class="dim">aucun</span>'}</dd>
    <dt>Échecs de connexion</dt><dd>${d.lockouts.length ? d.lockouts.map((l) => `${plural(l.fails, 'échec')}${l.ip ? ` depuis <span class="bo-code">${esc(l.ip)}</span>` : ' toutes IP confondues'}${l.until > Date.now() ? ` · <span class="bo-no">bloqué, reprise ${admWhen(l.until)}</span>` : ''}`).join('<br>') : '<span class="dim">aucun</span>'}</dd>
  </dl>`;
  const body = `
    <div class="bo-bar"><span>${admA({ view: 'accounts' }, '← Tous les comptes')}</span><span class="adm-actions">${admAccountActions(a)}</span></div>
    ${admSection('Identité', ident)}
    ${admSection('Personnages Battle.net', d.bnet ? admTable(['Personnage', ['Niveau', 'num'], 'Clé'], d.bnet.characters.map((c) => `<tr>
        <td>${admChar(c)}</td><td class="num">${c.level ?? ''}</td><td class="dim">${esc(c.key)}</td></tr>`), 'Aucun personnage.') : '<p class="note bo-empty">Battle.net non lié.</p>', d.bnet?.characters.length)}
    ${admSection('Ses annonces', admListingTable(d.listings, false), d.listings.length)}
    ${admSection('Ses candidatures', admTable(['Raid', 'Personnage', 'Rôle', 'État', 'Créneau'], d.tags.map((t) => `<tr>
        <td>${admListing(t.code, t.title)}</td><td>${admChar(t.char)}</td><td>${esc(LF_ROLE_LABEL[t.role] || t.role)}</td><td>${esc(ADM_TAG[t.status] || t.status)}</td><td>${admWhen(t.startsAt)}</td></tr>`), 'Aucune candidature.'), d.tags.length)}
    ${admSection('Sa recherche', admTable(['Personnage', 'Rôles', 'Créneau'], d.searches.map((x) => `<tr>
        <td>${admChar(x.char)}</td><td>${esc((x.data.roles || []).map((r) => LF_ROLE_LABEL[r] || r).join(', '))}</td><td>${admWhen(x.startsAt)} → ${admWhen(x.endsAt)}</td></tr>`), 'Pas de recherche en cours.'), d.searches.length)}
    ${admSection('Connexions ouvertes', admTable(['Ouverte', 'Expire', 'Navigateur', 'Par'], d.logins.map((l) => `<tr>
        <td>${admWhen(l.createdAt)}</td><td>${admWhen(l.expiresAt)}</td><td class="wrap bo-agent">${esc(l.agent || '—')}</td><td>${l.impersonatedBy ? `<span class="bo-warn">en tant que</span> ${admWho(l.impersonatedBy)}` : 'lui-même'}</td></tr>`), 'Aucune connexion ouverte.'), d.logins.length)}`;
  return admShell('accounts', esc(a.name), `<span class="chip s-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span> <span class="note">compte n° ${a.id}</span>`, body);
}

/* --- Annonces --- */
function admListingTable(list, withOwner = true) {
  return admTable(['Annonce', ...(withOwner ? ['Compte'] : []), 'Leader', 'Phase', ['Membres', 'num'], ['Attente', 'num'], ['Chat', 'num'], 'Début', 'Fin'], list.map((l) => {
    const total = l.comp ? (l.comp.tank || 0) + (l.comp.heal || 0) + (l.comp.dps || 0) : null;
    const label = l.title || `${LF_GOALS[l.goal] || ''} · ${l.raidName || ''} ${l.difficulty ? lfDiff(l.difficulty).letter : ''}`;
    return `<tr>
      <td>${admListing(l.code, label)} <span class="bo-code dim">${esc(l.code)}</span></td>
      ${withOwner ? `<td>${admWho(l.owner)}</td>` : ''}
      <td>${admChar(l.leader)}</td>
      <td>${esc(ADM_PHASE[l.phase] || l.phase)}</td>
      <td class="num">${l.accepted}${total ? ` <span class="dim">/ ${total}</span>` : ''}</td>
      <td class="num">${admZero(l.pending + l.invited)}</td>
      <td class="num">${admZero(l.messages)}</td>
      <td>${admWhen(l.startsAt)}</td><td>${admWhen(l.endsAt)}</td></tr>`;
  }), 'Aucune annonce.');
}
function admGroups(d) {
  const searches = admTable(['Personnage', 'Compte', 'Rôles', 'Difficultés', 'Créneau'], d.searches.map((x) => `<tr>
    <td>${admChar(x.char)}</td><td>${admWho(x.owner)}</td><td>${esc(x.roles.map((r) => LF_ROLE_LABEL[r] || r).join(', '))}</td>
    <td>${esc(x.difficulties.map((v) => lfDiff(v).letter).join(' / '))}</td><td>${admWhen(x.startsAt)} → ${admWhen(x.endsAt)}</td></tr>`), 'Personne ne cherche de raid.');
  const body = `${admSection('Annonces', admListingTable(d.listings), d.listings.length)}
    ${admSection('Joueurs qui cherchent', searches, d.searches.length)}`;
  return admShell('groups', 'Annonces', 'Les annonces de raid en mémoire (effacées 24 h après la fin du raid), et les joueurs qui cherchent. En admin, tu gères chaque annonce comme son leader.', body);
}

/* --- Battle.net --- */
function admBnet(d, params) {
  const links = admTable(['Compte', 'BattleTag', 'N°', ['Persos', 'num'], 'Lié', 'Mis à jour'], d.links.map((b) => `<tr>
    <td>${admWho(b.account)}</td><td><b>${esc(b.battletag || '?')}</b></td><td class="bo-code">${esc(b.bnetId)}</td>
    <td class="num">${b.characters}</td><td>${admWhen(b.linkedAt)}</td><td>${admWhen(b.updatedAt)}</td></tr>`), 'Aucun Battle.net lié.');
  const chars = admTable(['Personnage', 'Compte', ['Niveau', 'num'], 'Clé'], d.characters.map((c) => `<tr>
    <td>${admChar(c)}</td><td>${admWho(c.account)}</td><td class="num">${c.level ?? ''}</td><td class="dim">${esc(c.key)}</td></tr>`), 'Aucun personnage.');
  const body = `${admSection('Comptes liés', links, d.links.length)}
    ${admSection('Personnages', `${admSearch({ ...params, view: 'bnet' }, 'Pseudo ou serveur')}${chars}`, d.characters.length)}`;
  return admShell('bnet', 'Battle.net', 'Qui a lié quoi, et leurs personnages.', body);
}

/* --- Sécurité --- */
function admSecurity(d) {
  const KIND = { pair: 'adresse + IP', email: 'adresse', ip: 'IP' };
  const lock = admTable(['Visé', 'Compteur', ['Échecs', 'num'], 'État', 'Dernier essai'], d.lockouts.map((l) => `<tr>
    <td>${l.email ? esc(l.email) : ''}${l.email && l.ip ? ' · ' : ''}${l.ip ? `<span class="bo-code">${esc(l.ip)}</span>` : ''}</td>
    <td>${esc(KIND[l.kind] || l.kind)}</td><td class="num">${l.fails} <span class="dim">/ ${l.free} libres</span></td>
    <td>${l.until > Date.now() ? `<span class="bo-no">bloqué, reprise ${admWhen(l.until)}</span>` : '<span class="dim">libre</span>'}</td>
    <td>${admWhen(l.last)}</td></tr>`), 'Aucun échec de connexion récent.');
  const logins = admTable(['Compte', 'Ouverte', 'Expire', 'Navigateur', 'Par'], d.logins.map((l) => `<tr>
    <td>${admWho(l.account)}</td><td>${admWhen(l.createdAt)}</td><td>${admWhen(l.expiresAt)}</td><td class="wrap bo-agent">${esc(l.agent || '—')}</td>
    <td>${l.impersonatedBy ? `<span class="bo-warn">en tant que</span> ${admWho(l.impersonatedBy)}` : ''}</td></tr>`), 'Aucune connexion.');
  const tokens = admTable(['Compte', 'Quoi', 'Envoyé', 'Expire'], d.tokens.map((t) => `<tr>
    <td>${admWho(t.account)}</td><td>${t.kind === 'reset' ? 'nouveau mot de passe' : 'confirmation d\'adresse'}</td><td>${admWhen(t.createdAt)}</td><td>${admWhen(t.expiresAt)}</td></tr>`), 'Rien en attente.');
  const rate = admTable(['Qui', ['Requêtes', 'num'], 'Remise à zéro'], d.rateLimits.map((r) => `<tr>
    <td class="bo-code">${esc(r.ip)}</td><td class="num">${r.count}${r.count > 60 ? ' <span class="bo-no">freinée</span>' : ''}</td><td>${admWhen(r.reset)}</td></tr>`), 'Aucune activité cette minute.');
  const body = `${admSection('Échecs de connexion', lock, d.lockouts.length)}
    ${admSection('Connexions ouvertes', logins, d.logins.length)}
    ${admSection('Codes et liens envoyés par e-mail, en attente', tokens, d.tokens.length)}
    ${admSection('Requêtes par compte ou par IP, cette minute', rate, d.rateLimits.length)}
    ${admSection('Admins d\'office', d.adminEmails.length ? `<p>${d.adminEmails.map(esc).join(', ')}</p>` : '<p class="bo-no">Aucun : personne n\'est admin d\'office.</p>')}`;
  return admShell('security', 'Sécurité', 'Essais ratés, connexions ouvertes et codes en cours. Les échecs et les compteurs repartent de zéro à chaque redémarrage.', body);
}

/* --- Audience (mesure maison, voir analytics.js) --- */
const AUD_PERIODS = [['1', '24 h'], ['7', '7 jours'], ['30', '30 jours'], ['90', '90 jours'], ['365', '1 an']];
const AUD_PATHS = {
  '/': 'Accueil', '/login': 'Connexion', '/signup': 'Inscription', '/reset-password': 'Nouveau mot de passe',
  '/account': 'Mon compte', '/player': 'Recherche de joueur', '/player/fiche': "Fiche d'un joueur",
  '/groups': 'Raids qui recrutent', '/groups/players': 'Joueurs qui cherchent', '/groups/new': 'Poster une annonce',
  '/groups/search': 'Je cherche un raid', '/groups/raid': "Page d'un raid", '/groups/edit': "Modifier une annonce",
  '/privacy': 'Confidentialité', '/terms': "Conditions d'utilisation", '/contact': 'Contact', '/admin': 'Backoffice',
};
const AUD_VIEWS = { home: 'Accueil', player: 'Fiche joueur', login: 'Connexion', account: 'Compte', admin: 'Backoffice', groups: 'Recherche de groupe', legal: 'Pages légales', contact: 'Contact', '': '?' };
const AUD_SERVER = {
  inscription: 'Inscriptions', connexion: 'Connexions', connexion_ratee: 'Connexions ratées', deconnexion: 'Déconnexions',
  verification: 'Adresses confirmées', bnet: 'Battle.net liés',
  recherche_joueur: 'Fiches joueur ouvertes', joueur_introuvable: 'Recherches sans résultat',
  annonce: 'Annonces postées', candidature: 'Candidatures envoyées', recherche_raid: 'Recherches de raid publiées',
  place_proposee: 'Places proposées à un joueur qui cherche', place_acceptee: 'Places acceptées',
};
const AUD_DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const audPath = (p) => AUD_PATHS[p] || p || '—';
const audPct = (x) => `${Math.round(x * 100).toLocaleString('fr-FR')} %`;
function audDur(ms) {
  if (!ms) return '0 s';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
// Écart avec la période précédente de même durée
function audDelta(cur, prev, lowerIsBetter = false) {
  if (!prev) return cur ? '<span class="dim">nouveau</span>' : '';
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return '<span class="dim">stable</span>';
  const good = lowerIsBetter ? d < 0 : d > 0;
  return `<span class="${good ? 'bo-yes' : 'bo-no'}">${d > 0 ? '+' : '−'}${audPct(Math.abs(d))}</span> <span class="dim">vs avant</span>`;
}
// Barres verticales d'une seule série (donc sans légende : le titre la nomme) ; le détail
// de chaque barre au survol
function audBars(items, { height = 140, label = (x) => x.label, tip = () => '', every = 1 } = {}) {
  const max = Math.max(1, ...items.map((x) => x.n));
  const cols = `grid-template-columns:repeat(${items.length},minmax(0,1fr))`;
  return `<div class="au-chart" style="--h:${height}px">
    <div class="au-bars" style="${cols}">${items.map((x) => `<div class="au-col" title="${esc(tip(x))}" aria-label="${esc(tip(x))}">
      <span class="au-bar" style="height:${x.n ? Math.max(2, (x.n / max) * 100) : 0}%"></span></div>`).join('')}</div>
    <div class="au-axis" style="${cols}">${items.map((x, i) => `<span>${i % every === 0 ? esc(label(x)) : ''}</span>`).join('')}</div>
  </div>`;
}
// Répartition en barres horizontales : libellé, barre, nombre, part
function audShares(rows, { label = (r) => esc(r.label), empty = 'Rien pour l\'instant.', total } = {}) {
  if (!rows.length) return `<p class="note bo-empty">${esc(empty)}</p>`;
  const sum = total ?? rows.reduce((a, r) => a + r.n, 0);
  const max = Math.max(1, ...rows.map((r) => r.n));
  return `<ul class="au-shares">${rows.map((r) => `<li>
    <span class="au-sl">${label(r)}</span>
    <span class="au-track"><span style="width:${(r.n / max) * 100}%"></span></span>
    <span class="au-n">${admNum(r.n)}</span><span class="au-p">${sum ? audPct(r.n / sum) : ''}</span></li>`).join('')}</ul>`;
}
const audCard = (title, body, note = '') => `<div class="au-card"><h3>${esc(title)}</h3>${note ? `<p class="note">${note}</p>` : ''}${body}</div>`;

function admAudience(d, params) {
  if (d.mode === 'visits') return admVisits(d, params);
  const t = d.totals, p = d.previous;
  const periods = `<div class="au-top"><nav class="segmented au-periods" aria-label="Période">${AUD_PERIODS.map(([v, l]) => admA(v === '7' ? { view: 'audience' } : { view: 'audience', days: v }, esc(l), ` role="radio" aria-checked="${String(String(d.days) === v)}"`)).join('')}</nav>
    <span class="au-livetag" title="La page se met à jour toute seule toutes les 10 secondes"><i aria-hidden="true"></i>En direct <span id="audUpdated" class="dim"></span></span></div>`;
  const live = d.live.total
    ? `${admTiles([[d.live.total, d.live.total > 1 ? 'personnes sur le site' : 'personne sur le site', `dont ${d.live.logged} connectée${d.live.logged > 1 ? 's' : ''}`]])}
       <div class="au-live">${audShares(d.live.views, { label: (r) => esc(AUD_VIEWS[r.label] || r.label) })}</div>`
    : '<p class="note">Personne en ce moment (à part toi, qui n\'es pas compté).</p>';

  const tiles = admTiles([
    [t.visitors, 'visiteurs', audDelta(t.visitors, p.visitors)],
    [t.visits, 'visites', audDelta(t.visits, p.visits)],
    [t.pages, 'pages vues', audDelta(t.pages, p.pages)],
    [t.pagesPerVisit.toLocaleString('fr-FR', { maximumFractionDigits: 1 }), 'pages par visite', ''],
    [esc(audDur(t.medianEngaged)), 'temps actif médian', `moyenne ${esc(audDur(t.avgEngaged))}`],
    [esc(audPct(t.bounceRate)), 'repartent aussitôt', 'une page, moins de 10 s'],
    [esc(audPct(t.returningRate)), 'revenants', `${esc(audPct(t.visits ? 1 - t.returningRate : 0))} nouveaux`],
    [esc(audPct(t.loggedRate)), 'visites connectées', `${admNum(t.logged || 0)} sur ${admNum(t.visits)}`],
    [t.searches, 'fiches joueur ouvertes', `par ${plural(t.searchers, 'personne')} · ${audDelta(t.searches, p.searches)}`],
    [t.loadMedian ? esc(audDur(t.loadMedian)) : '—', 'chargement médian', t.loadP90 ? `9 sur 10 en moins de ${esc(audDur(t.loadP90))}` : ''],
  ]);

  const day = d.days === 1;
  const timeline = audBars(d.series.map((x) => ({ ...x, n: x.visits })), {
    height: 160,
    every: day ? 3 : d.days <= 7 ? 1 : d.days <= 31 ? 5 : d.days <= 90 ? 14 : 61,
    label: (x) => (day ? x.label : new Date(x.at).toLocaleDateString('fr-FR', d.days <= 7 ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' })),
    tip: (x) => `${day ? x.label : new Date(x.at).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} : ${plural(x.visits, 'visite')}, ${plural(x.visitors, 'visiteur')}, ${counted(x.pages, 'page vue', 'pages vues')}`,
  });
  const hours = audBars(d.hours.map((x) => ({ ...x, label: `${x.h} h` })), { height: 90, every: 3, tip: (x) => `${x.h} h – ${x.h + 1} h : ${plural(x.n, 'visite')}` });
  const weekOrder = [1, 2, 3, 4, 5, 6, 0].map((i) => d.weekdays[i]);
  const week = audBars(weekOrder.map((x) => ({ ...x, label: AUD_DAYS[x.d] })), { height: 90, tip: (x) => `${AUD_DAYS[x.d]} : ${plural(x.n, 'visite')}` });

  const funnelMax = Math.max(1, d.funnel[0].n);
  const funnel = `<ol class="au-shares au-funnel">${d.funnel.map((f, i) => `<li>
    <span class="au-sl">${esc(f.label)}</span>
    <span class="au-track"><span style="width:${Math.min(100, (f.n / funnelMax) * 100)}%"></span></span>
    <span class="au-n">${admNum(f.n)}</span><span class="au-p">${i ? audPct(Math.min(1, f.n / funnelMax)) : ''}</span></li>`).join('')}</ol>`;

  const pages = admTable(['Page', ['Vues', 'num'], ['Visites', 'num'], ['Temps actif par vue', 'num']], d.pages.map((r) => `<tr>
    <td>${esc(audPath(r.path))} <span class="dim">${esc(r.path)}</span></td><td class="num">${admNum(r.views)}</td><td class="num">${admNum(r.visits)}</td>
    <td class="num">${esc(audDur(r.views ? r.time / r.views : 0))}</td></tr>`), 'Aucune page vue sur la période.');
  const landings = audShares(d.landings, { label: (r) => `${esc(audPath(r.label))}${r.n ? ` <span class="dim">· ${audPct(r.bounces / r.n)} repartent</span>` : ''}` });
  const exits = audShares(d.exits, { label: (r) => esc(audPath(r.label)) });

  const clicks = admTable(['Page', 'Élément', ['Clics', 'num'], ['Visites', 'num']], d.clicks.map((c) => `<tr>
    <td>${esc(AUD_VIEWS[c.view || ''] || c.view)}</td><td class="wrap">${esc(c.name)}</td><td class="num">${admNum(c.n)}</td><td class="num">${admNum(c.visits)}</td></tr>`), 'Aucun clic sur la période.');
  const server = admTable(['Action', ['Fois', 'num'], ['Personnes', 'num']], d.server.map((e) => `<tr>
    <td>${esc(AUD_SERVER[e.name] || e.name)}</td><td class="num">${admNum(e.n)}</td><td class="num">${admNum(e.who)}</td></tr>`), 'Aucune action sur la période.');
  const searches = audShares(d.searches, { label: (r) => `depuis ${esc(r.label)}`, empty: 'Aucune recherche.' });

  const who = (r) => (r.label ? esc(r.label) : '<span class="dim">inconnu</span>');
  const devices = `<div class="au-grid">
    ${audCard('Appareils', audShares(d.devices, { label: who, total: t.visits }))}
    ${audCard('Navigateurs', audShares(d.browsers, { label: who, total: t.visits }))}
    ${audCard('Systèmes', audShares(d.os, { label: who, total: t.visits }))}
    ${audCard("Largeur d'écran", audShares(d.widths, { label: who, total: t.visits }))}
    ${audCard('Langues', audShares(d.langs.slice(0, 10), { label: who, total: t.visits }))}
    ${audCard('Fuseaux horaires', audShares(d.tz.slice(0, 10), { label: who, total: t.visits }), 'À peu près le pays.')}
  </div>`;
  const origin = `<div class="au-grid two">
    ${audCard('Sites de provenance', audShares(d.referrers, { label: (r) => (r.label ? esc(r.label) : 'Accès direct, favori ou application'), total: t.visits }))}
    ${audCard('Liens suivis', audShares(d.sources, { label: who }), 'Ajoute <code>?ref=discord</code> (ou <code>?utm_source=</code>) à un lien que tu partages pour savoir combien de monde il amène.')}
  </div>`;
  const scroll = d.scrollVisits
    ? audShares(d.scroll.map((x) => ({ label: `${x.pct} %`, n: x.n })), { label: (r) => `jusqu'à ${esc(r.label)}`, total: d.scrollVisits })
    : '<p class="note bo-empty">Pas encore de mesure.</p>';
  const errors = admTable(['Erreur', 'Page', ['Fois', 'num'], ['Visites', 'num'], 'Dernière'], d.errors.map((e) => `<tr>
    <td class="wrap bo-code">${esc(e.name)}</td><td>${esc(AUD_VIEWS[e.view || ''] || '')}</td><td class="num">${admNum(e.n)}</td><td class="num">${admNum(e.visits)}</td><td>${admWhen(e.last)}</td></tr>`), 'Aucune erreur sur la période.');

  const body = `${periods}
    ${admSection('En ce moment', live)}
    ${admSection('Sur la période', tiles)}
    ${admSection(day ? 'Visites heure par heure' : 'Visites jour par jour', timeline)}
    <div class="au-grid two">${audCard('Heure de la journée', hours)}${audCard('Jour de la semaine', week)}</div>
    ${admSection('Parcours', `<p class="note">Personnes distinctes à chaque étape, sur la période.</p>${funnel}`)}
    ${admSection('Pages', pages, d.pages.length)}
    <div class="au-grid two">${audCard("Pages d'arrivée", landings)}${audCard('Pages de départ', exits, 'La dernière page vue avant de partir.')}</div>
    ${admSection('Temps actif par visite', `<p class="note">Onglet visible et une action dans la dernière minute.</p>${audShares(d.durations.filter((x) => x.n), { total: t.visits })}`)}
    ${admSection("Défilement de l'accueil", `<p class="note">Part des visites de l'accueil qui ont fait défiler la page jusqu'à…</p>${scroll}`)}
    ${admSection('Actions réussies', server, d.server.length)}
    ${admSection('Recherches lancées', searches)}
    ${admSection('Clics', clicks, d.clicks.length)}
    ${admSection('Provenance', origin)}
    ${admSection('Appareils', devices)}
    ${admSection('Dernières visites', `<p class="note">Une ligne par chargement de page. Clique sur l'heure pour voir tout ce que cette visite a fait.</p>
      ${audVisitRows(d.recent || [], { day: true })}
      <p class="bo-pager">${admA({ view: 'audience', visits: '1', days: String(d.days) }, 'Voir toutes les visites →', ' class="btn glass small"')}</p>`, (d.recent || []).length)}
    ${admSection('Erreurs dans le navigateur', errors, d.errors.length)}
    <p class="note au-foot">${admNum(d.storage.visits)} visites et ${admNum(d.storage.events)} événements gardés${d.storage.since ? ` depuis le ${esc(new Date(d.storage.since).toLocaleDateString('fr-FR'))}` : ''}, effacés au bout de 13 mois.
      Un visiteur est compté jour par jour : quelqu'un qui revient le lendemain compte deux fois.
      Ne sont pas comptés : les admins, les robots, et ceux qui ont refusé la mesure.</p>`;
  return admShell('audience', 'Audience', 'Qui passe sur le site, ce qu\'on y fait et combien de temps on y reste. Anonyme : aucune adresse IP gardée, aucun lien avec les comptes.', body);
}

/* --- Audience : les visites une par une (demande de l'utilisateur) --- */
// Une visite = un chargement de page. L'empreinte du visiteur ne vaut que pour la journée,
// donc on peut réunir ses visites du jour, jamais celles de la veille.
const VISIT_FILTERS = [['', 'Toutes'], ['new', 'Nouveaux'], ['returning', 'Revenants'], ['logged-in', 'Connectés'], ['mobile', 'Mobile'], ['clicks', 'Avec des clics'], ['long', 'Plus d\'une minute']];
const EVENT_LABEL = { page: 'Page', click: 'Clic', time: 'Temps', scroll: 'Défilement', error: 'Erreur', search: 'Recherche' };
const audHour = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const audDayHour = (ts) => `${new Date(ts).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} à ${new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
// Écart depuis le début de la visite : « +2 min 05 »
function audOffset(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `+${s} s`;
  return `+${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}
const audWho = (v) => `${v.returner ? '<span class="dim">revenant</span>' : '<span class="bo-yes">nouveau</span>'}${v.logged ? ' · <span class="bo-warn">connecté</span>' : ''}`;
const audFrom = (v) => (v.source ? esc(v.source) : v.referrer ? esc(v.referrer) : '<span class="dim">direct</span>');
const audDevice = (v) => `${esc(v.device)} <span class="dim">${esc(v.browser)} · ${esc(v.os)}</span>`;

function audVisitRows(list, { day = false } = {}) {
  return admTable([day ? 'Arrivée' : 'Heure', 'Visiteur', 'Entrée', ['Pages', 'num'], ['Clics', 'num'], ['Temps actif', 'num'], 'Venu de', 'Appareil'], list.map((v) => `<tr>
    <td>${admA({ visit: v.id }, esc(day ? audDayHour(v.started_at) : audHour(v.started_at)), ' class="bo-code"')}</td>
    <td>${audWho(v)}</td>
    <td>${esc(audPath(v.landing))}</td>
    <td class="num">${v.pages}</td><td class="num">${v.clicks || '<span class="dim">0</span>'}</td>
    <td class="num">${esc(audDur(v.engaged))}</td>
    <td>${audFrom(v)}</td><td>${audDevice(v)}</td></tr>`), 'Aucune visite.');
}

// Liste complète, paginée : /admin?view=audience&visits=1&type=new&q=discord
function admVisits(d, params) {
  const search = admSearch({ ...params, view: 'audience', visits: '1' }, 'Provenance, appareil, langue, page d\'entrée…', { name: 'type', options: VISIT_FILTERS });
  const body = `${admA({ view: 'audience', days: params.days || '' }, '← Retour à l\'audience', ' class="btn glass small"')}
    ${admSection('Visites', `${search}${audVisitRows(d.visits, { day: true })}${admPager(d, { ...params, view: 'audience', visits: '1' })}`, d.total)}`;
  return admShell('audience', 'Visites', 'Chaque ligne est un chargement de page. Clique sur l\'heure pour voir tout ce que cette visite a fait.', body);
}

// Le détail d'une visite : sa fiche, tout ce qu'elle a fait dans l'ordre
function admVisitPage(d) {
  if (!d.visit) return admShell('audience', 'Visite', '', '<p class="note">Cette visite n\'existe plus : les visites sont effacées au bout de 13 mois.</p>');
  const v = d.visit;
  const tiles = admTiles([
    [v.pages, 'pages vues', esc(audPath(v.landing))],
    [esc(audDur(v.engaged)), 'temps actif', `arrivée à ${esc(audHour(v.started_at))}`],
    [v.clicks, 'clics', ''],
    [v.returner ? 'Revenant' : 'Nouveau', 'visiteur', v.logged ? 'connecté pendant la visite' : 'pas connecté'],
    [audFrom(v), 'venu de', v.referrer && v.source ? esc(v.referrer) : ''],
    [esc(v.device), 'appareil', `${esc(v.browser)} · ${esc(v.os)}${v.width ? ` · ${v.width} px` : ''}`],
    [esc(v.lang || '—'), 'langue', esc(v.tz || '')],
    [v.load_ms ? esc(audDur(v.load_ms)) : '—', 'chargement', ''],
  ]);

  // Tout dans l'ordre : pages, clics, temps, défilement, recherches, erreurs, plus les
  // actions réussies vues par le serveur (inscription, recherche…), repérées à l'empreinte
  const timeline = [
    ...d.events.map((e) => ({ ...e, src: 'front' })),
    ...(d.actions || []).map((a) => ({ at: a.at, kind: 'action', name: a.name, src: 'serveur' })),
  ].sort((a, b) => a.at - b.at);
  const line = (e) => {
    const what = {
      page: `<b>${esc(audPath(e.name))}</b> <span class="dim">${esc(e.name)}</span>`,
      click: `a cliqué sur <b>${esc(e.name)}</b>`,
      time: `est resté <b>${esc(audDur(e.value))}</b> sur ${esc(audPath(e.name))}`,
      scroll: `a fait défiler l'accueil jusqu'à <b>${e.value} %</b>`,
      search: `a lancé une recherche <span class="dim">depuis ${esc(e.name)}</span>`,
      error: `<span class="bo-no">erreur</span> <span class="bo-code">${esc(e.name)}</span>`,
      action: `<span class="bo-yes">${esc(AUD_SERVER[e.name] || e.name)}</span>`,
    }[e.kind] || esc(e.name || '');
    return `<li class="au-ev k-${esc(e.kind)}">
      <span class="au-ev-t" title="${esc(audHour(e.at))}">${esc(audOffset(e.at - v.started_at))}</span>
      <span class="au-ev-k">${esc(e.kind === 'action' ? 'Action' : EVENT_LABEL[e.kind] || e.kind)}</span>
      <span class="au-ev-w">${what}${e.view && ['click', 'search', 'error'].includes(e.kind) ? ` <span class="dim">sur ${esc(AUD_VIEWS[e.view] || e.view)}</span>` : ''}</span></li>`;
  };

  const others = d.others.length
    ? admSection('Ses autres visites ce jour-là', audVisitRows(d.others), d.others.length)
    : '';
  const body = `${admA({ view: 'audience' }, '← Retour à l\'audience', ' class="btn glass small"')}
    ${admSection('La visite', tiles)}
    ${admSection('Ce qu\'elle a fait', timeline.length ? `<ol class="au-timeline">${timeline.map(line).join('')}</ol>` : '<p class="note">Rien d\'enregistré.</p>', timeline.length)}
    ${others}
    <p class="note au-foot">Visiteur <span class="bo-code">${esc(v.visitor)}</span> du ${esc(v.day)} : cette empreinte est tirée au hasard chaque jour, donc la même personne revenue demain est un autre visiteur, et rien ne la relie à un compte.</p>`;
  return admShell('audience', `Visite de ${audDayHour(v.started_at)}`, '', body);
}

// Actions du backoffice (délégation : le contenu est réécrit souvent)
function bindAdmin() {
  $('#admin').addEventListener('click', async (ev) => {
    // Liens internes du backoffice : sans recharger (Ctrl+clic ouvre toujours un onglet)
    const link = ev.target.closest('a[data-adm]');
    if (link && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.button === 0) { ev.preventDefault(); goTo(link.getAttribute('href')); return; }
    const imp = ev.target.closest('[data-imp-account]');
    if (imp) {
      try {
        const d = await api('/api/admin/impersonate', { method: 'POST', body: { id: Number(imp.dataset.impAccount) } });
        await loadStatus();
        toast(`Connecté en tant que ${d.account.name}.`);
        goTo('/');
      } catch (e) { toast(e.message, 'err'); }
      return;
    }
    const set = ev.target.closest('[data-set-status]');
    const del = ev.target.closest('[data-del-account]');
    if (!set && !del) return;
    try {
      const body = set
        ? { id: Number(set.dataset.id), status: set.dataset.setStatus }
        : { id: Number(del.dataset.delAccount), action: 'supprimer' };
      if (del && !(await askConfirm({ title: 'Supprimer ce compte ?', text: 'Son annonce, ses candidatures et sa recherche partent avec lui.', ok: 'Supprimer le compte' }))) return;
      await api('/api/admin/accounts', { method: 'POST', body });
      toast(del ? 'Compte supprimé.' : 'Statut changé.');
      if (del && new URLSearchParams(location.search).get('account')) goTo('/admin?view=accounts');
      else openAdminPage();
    } catch (e) { toast(e.message, 'err'); }
  });
  // Recherche et filtres : le formulaire devient une adresse
  $('#admin').addEventListener('submit', (ev) => {
    const form = ev.target.closest('form[data-adm-search]');
    if (!form) return;
    ev.preventDefault();
    const params = {};
    for (const [k, v] of new FormData(form)) if (String(v).trim()) params[k] = String(v).trim();
    // Un bouton de filtre remplace la valeur cachée du même nom
    if (ev.submitter?.name) {
      if (ev.submitter.value) params[ev.submitter.name] = ev.submitter.value;
      else delete params[ev.submitter.name];
    }
    goTo(admHref(params));
  });
}
