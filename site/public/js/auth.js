'use strict';
/* ================================================================== */
/* Comptes : connexion, inscription, mon compte, contact, pages légales */
/* ================================================================== */
// Statuts : tout le monde est « normal », sauf les VIP (un badge à côté de leurs personnages
// Battle.net, rien d'autre) et les admins. Le bloc Statut de /account ne se montre qu'aux deux derniers.
const STATUS_LABEL = { normal: 'Normal', vip: 'VIP', admin: 'Admin' };
const STATUS_HELP = {
  vip: 'Un badge VIP apparaît à côté de tes personnages liés avec Battle.net.',
  admin: 'Tous les droits, y compris sur les annonces des autres, et le backoffice.',
};

/* ---------------- Page de connexion et d'inscription -------------- */
// back : page où revenir après la connexion (`?back=`)
// `note` : message qui reste d'un mode à l'autre (Battle.net en attente d'un compte)
const authView = { mode: 'login', token: '', busy: false, message: '', error: '', back: null, note: '', bnetTag: '' };

const AUTH_MODES = {
  login: {
    kicker: 'Connexion', title: 'Content de te revoir', lead: 'Connecte-toi pour postuler à un raid ou poster ton annonce.',
    submit: 'Se connecter', fields: ['email', 'password'],
  },
  register: {
    kicker: 'Inscription', title: 'Crée ton compte', lead: 'Trente secondes, et tu peux trouver ton prochain raid.',
    submit: 'Créer mon compte', fields: ['name', 'email', 'password'],
  },
  forgot: {
    kicker: 'Mot de passe oublié', title: 'On va te renvoyer un lien', lead: 'Entre ton adresse : tu recevras un lien pour choisir un nouveau mot de passe.',
    submit: 'Envoyer le lien', swap: 'Revenir à la connexion', fields: ['email'],
  },
  reset: {
    kicker: 'Nouveau mot de passe', title: 'Choisis ton mot de passe', lead: 'Au moins 10 caractères.',
    submit: 'Enregistrer', swap: 'Revenir à la connexion', fields: ['password'],
  },
  // Battle.net lié à aucun compte : Blizzard ne donne pas d'adresse, on la demande et le compte
  // est créé avec (sans mot de passe). `lead` : bnetLead()
  bnet: {
    kicker: 'Battle.net', title: "Plus qu'une étape", lead: '',
    submit: 'Créer mon compte', swap: "J'ai déjà un compte GroupScout", fields: ['email'],
  },
};
// BattleTag du Battle.net en attente (lu par /api/auth/pending), ou ''
const bnetLead = () => (authView.bnetTag
  ? tr('Battle.net ne nous transmet pas ton adresse e-mail. Entre-la pour créer ton compte : ton Battle.net {tag} y sera lié, avec tes personnages.', { tag: authView.bnetTag })
  : 'Battle.net ne nous transmet pas ton adresse e-mail. Entre-la pour créer ton compte : ton Battle.net y sera lié, avec tes personnages.');

/* ---------------- Google, Discord et Battle.net -------------------- */
const OAUTH_LABEL = { google: 'Google', discord: 'Discord' };
// Battle.net sert aussi à se connecter, mais se lie dans son propre bloc du compte
const oauthLabel = (p) => (p === 'bnet' ? 'Battle.net' : OAUTH_LABEL[p] || 'ce service');
// Résultats renvoyés par le serveur dans l'adresse (?oauth=…&p=…) : [texte, ton]
const OAUTH_RESULTS = {
  'signed-in': ['Connecté avec {p}.', 'ok'],
  welcome: ['Compte créé avec {p}. Bienvenue !', 'ok'],
  attached: ["{p} est maintenant rattaché à ton compte : tu peux t'en servir pour te connecter.", 'ok'],
  linked: ["{p} est lié à ton compte : tu peux t'en servir pour te connecter.", 'ok'],
  denied: ['Connexion avec {p} annulée.', ''],
  expired: ['Cette connexion a pris trop de temps. Recommence.', 'err'],
  email: ["{p} ne nous a pas transmis d'adresse e-mail confirmée. Confirme ton adresse chez {p}, puis recommence.", 'err'],
  taken: ['Ce compte {p} est déjà rattaché à un autre compte GroupScout.', 'err'],
  already: ["Un autre compte {p} est déjà lié au tien : délie-le d'abord.", 'err'],
  provider: ["{p} n'a pas répondu comme prévu. Réessaie dans un moment.", 'err'],
  unavailable: ["La connexion avec {p} n'est pas disponible pour l'instant.", 'err'],
  impersonation: ["Impossible de changer les connexions de ce compte quand tu es connecté en tant que quelqu'un d'autre.", 'err'],
  login: ['Connecte-toi, puis recommence.', 'err'],
};
const oauthText = (code, p) => {
  const [texte, ton] = OAUTH_RESULTS[code] || OAUTH_RESULTS.provider;
  return [tr(texte, { p: oauthLabel(p) }), ton];
};

// Lit puis retire ?oauth=&p= de l'adresse : un rechargement ne doit pas redire le message
function takeOAuthResult() {
  const u = new URL(location.href);
  const code = u.searchParams.get('oauth');
  if (!code) return null;
  const provider = u.searchParams.get('p');
  u.searchParams.delete('oauth');
  u.searchParams.delete('p');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  routedPath = currentPath();
  return { code, provider };
}

// Départ vers Google, Discord ou Battle.net (le serveur redirige). `link` : depuis la page du compte
function startOAuth(provider, link = false) {
  const q = new URLSearchParams();
  if (link) q.set('link', '1');
  else if (authView.back) q.set('back', authView.back);
  const qs = q.toString();
  location.href = `/api/auth/${provider}/start${qs ? `?${qs}` : ''}`;
}

// Arrivée par Google ou Discord avec l'adresse d'un compte qui existe déjà : il faut y entrer une
// fois par son moyen habituel pour rattacher le service. Le serveur garde la demande 15 min.
async function showPendingLink() {
  openAuth('login');
  try {
    const { pending } = await api('/api/auth/pending');
    if (!pending) { openAuth('login', { error: 'Cette connexion a pris trop de temps. Recommence.' }); return; }
    $('#authEmail').value = pending.email;
    openAuth('login', {
      message: tr("Un compte GroupScout existe déjà avec l'adresse {email}. Connecte-toi comme d'habitude, une seule fois : {p} y sera rattaché, et tu pourras ensuite t'en servir pour entrer.", { email: pending.email, p: oauthLabel(pending.provider) }),
    });
    $('#authPassword').focus();
  } catch (e) { openAuth('login', { error: e.message }); }
}

// Connexion par un Battle.net lié à aucun compte : la page demande l'adresse et crée le compte
// avec (mode `bnet`). « J'ai déjà un compte » mène à la connexion, et le compte ouvert ensuite
// dans ce navigateur reçoit le Battle.net, quel que soit le moyen.
const bnetNote = () => (authView.bnetTag
  ? tr('Connecte-toi à ton compte : ton Battle.net {tag} y sera lié, avec tes personnages.', { tag: authView.bnetTag })
  : 'Connecte-toi à ton compte : ton Battle.net y sera lié, avec tes personnages.');
async function showBnetPending() {
  authView.bnetTag = '';
  authView.note = bnetNote();
  openAuth('bnet');
  try {
    const { pending } = await api('/api/auth/pending');
    if (pending?.provider !== 'bnet') { openAuth('login', { error: 'Cette connexion a pris trop de temps. Recommence.' }); return; }
    authView.bnetTag = pending.battletag || '';
    authView.note = bnetNote();
    if (authView.mode === 'bnet') renderAuth({ focus: false });
  } catch { /* la phrase sans BattleTag reste */ }
}

// Boutons « Continuer avec… » : seulement pour les services configurés sur le site
function renderAuthProviders() {
  const av = state.status?.oauth || {};
  let any = false;
  for (const b of document.querySelectorAll('#authProviders [data-oauth]')) {
    b.hidden = !av[b.dataset.oauth];
    if (!b.hidden) any = true;
  }
  $('#authProviders').hidden = !any || !AUTH_TABS.includes(authView.mode);
}

function openAuth(mode = 'login', { token = '', message = '', error = '', focus = true } = {}) {
  authView.mode = AUTH_MODES[mode] ? mode : 'login';
  authView.token = token;
  authView.message = message || (mode === 'login' ? authView.note : '');
  authView.error = error;
  showView('login');
  document.title = `${AUTH_MODES[authView.mode].kicker} · GroupScout`;
  renderAuth({ focus });
}

// Onglets Connexion / Inscription. Mot de passe oublié et nouveau mot de passe n'en ont pas :
// le petit titre revient, avec « Revenir à la connexion ».
const AUTH_TABS = ['login', 'register'];

function renderAuth({ focus = true } = {}) {
  const m = AUTH_MODES[authView.mode];
  const tabbed = AUTH_TABS.includes(authView.mode);
  $('#authTabs').hidden = !tabbed;
  if (tabbed) {
    $('#authTabs').dataset.active = authView.mode;
    for (const t of document.querySelectorAll('#authTabs [data-auth-tab]')) {
      const on = t.dataset.authTab === authView.mode;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
  }
  $('#authKicker').hidden = tabbed;
  $('#authKicker').textContent = m.kicker;
  $('#authTitle').textContent = m.title;
  $('#authLead').textContent = authView.mode === 'bnet' ? bnetLead() : m.lead;
  $('#authSubmit').textContent = m.submit;
  $('#authSwap').hidden = tabbed;
  if (m.swap) $('#authSwap').textContent = m.swap;
  $('#authNameField').hidden = !m.fields.includes('name');
  $('#authEmailField').hidden = !m.fields.includes('email');
  $('#authPasswordField').hidden = !m.fields.includes('password');
  // « Se souvenir de moi » : connexion seulement, adresse préremplie
  $('#authRememberField').hidden = authView.mode !== 'login';
  if (authView.mode === 'login') {
    const kept = rememberedEmail();
    $('#authRemember').checked = Boolean(kept);
    if (kept && !$('#authEmail').value) $('#authEmail').value = kept;
  }
  renderAuthProviders();
  $('#authForgot').hidden = authView.mode !== 'login';
  $('#authFoot').hidden = $('#authSwap').hidden && $('#authForgot').hidden;
  $('#authLegal').hidden = authView.mode !== 'register' && authView.mode !== 'bnet';
  $('#authPassword').autocomplete = authView.mode === 'login' ? 'current-password' : 'new-password';
  $('#authMessage').textContent = authView.message;
  $('#authError').textContent = authView.error;
  // Le premier champ visible prend le focus ; adresse déjà remplie : le mot de passe
  if (!focus) return;
  const first = m.fields[0] === 'name' ? '#authName' : m.fields[0] === 'email' ? '#authEmail' : '#authPassword';
  const el = $(first);
  if (el && !el.value) el.focus();
  else if (first === '#authEmail' && m.fields.includes('password') && !$('#authPassword').value) $('#authPassword').focus();
}

// Adresse gardée par « Se souvenir de moi » : dans ce navigateur seulement, jamais envoyée
const REMEMBER_KEY = 'groupscout.email.v1';
function rememberedEmail() {
  try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch { return ''; }
}
function rememberEmail(email) {
  try {
    if (email) localStorage.setItem(REMEMBER_KEY, email);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch { /* navigateur sans stockage */ }
}

async function submitAuth(ev) {
  ev.preventDefault();
  if (authView.busy) return;
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const name = $('#authName').value.trim();
  authView.busy = true;
  authView.error = '';
  authView.message = '';
  const submit = $('#authSubmit');
  submit.disabled = true;
  submit.classList.add('is-loading');
  submit.setAttribute('aria-busy', 'true');
  try {
    if (authView.mode === 'login') {
      const r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
      rememberEmail($('#authRemember').checked ? email : '');
      await afterLogin(r?.attached);
    } else if (authView.mode === 'register') {
      const r = await api('/api/auth/register', { method: 'POST', body: { email, password, name } });
      await afterLogin(r?.attached);
    } else if (authView.mode === 'bnet') {
      const r = await api('/api/auth/bnet/register', { method: 'POST', body: { email } });
      // Adresse déjà inscrite : on s'y connecte, et le Battle.net y est lié à ce moment-là
      if (r.exists) {
        openAuth('login', { message: tr("Un compte existe déjà avec l'adresse {email}. Connecte-toi : ton Battle.net y sera lié, avec tes personnages.", { email }) });
        $('#authPassword').focus();
        return;
      }
      await afterLogin(null, oauthText('welcome', 'bnet')[0]);
    } else if (authView.mode === 'forgot') {
      await api('/api/auth/forgot', { method: 'POST', body: { email } });
      authView.message = 'Si un compte existe avec cette adresse, le lien vient de partir. Regarde tes spams.';
      $('#authEmail').value = '';
    } else {
      const r = await api('/api/auth/reset', { method: 'POST', body: { token: authView.token, password } });
      await afterLogin(r?.attached);
    }
  } catch (e) {
    authView.error = e.message;
  } finally {
    authView.busy = false;
    submit.disabled = false;
    submit.classList.remove('is-loading');
    submit.removeAttribute('aria-busy');
    if (currentView === 'login') renderAuth();
  }
}

// Connexion réussie : on relit le statut puis on repart sur la page d'avant. `attached` : le
// service rattaché à cette connexion, s'il y en avait un en attente. `welcome` : message à la
// place du « Connecté. » (compte créé par Battle.net)
async function afterLogin(attached = null, welcome = '') {
  $('#authPassword').value = '';
  authView.note = '';
  authView.bnetTag = '';
  await loadStatus();
  const back = authView.back;
  authView.back = null;
  if (welcome) toast(welcome, 'ok');
  else if (attached) toast(oauthText('attached', attached)[0], 'ok');
  else toast('Connecté.');
  goTo(back || '/');
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* déjà déconnecté */ }
  await loadStatus();
  goTo('/');
}

// Retour sur son compte d'admin : la connexion en cours garde l'identifiant de l'admin qui l'a
// ouverte, donc le navigateur n'a rien à retenir
async function stopImpersonation() {
  try {
    await api('/api/auth/unimpersonate', { method: 'POST' });
    await loadStatus();
    toast('Te revoilà sur ton compte.');
    goTo('/admin');
  } catch (e) { toast(e.message, 'err'); }
}

function bindAuth() {
  $('#authForm').addEventListener('submit', submitAuth);
  $('#authSwap').addEventListener('click', () => openAuth('login'));
  // Onglets : un clic ouvre le mode et met le curseur dans le premier champ ; au clavier (flèches,
  // Début, Fin), le focus reste sur les onglets
  const tabs = $('#authTabs');
  tabs.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-auth-tab]');
    if (!t || t.dataset.authTab === authView.mode) return;
    openAuth(t.dataset.authTab, { focus: ev.detail > 0 });
    if (ev.detail === 0) t.focus();
  });
  tabs.addEventListener('keydown', (ev) => {
    const i = AUTH_TABS.indexOf(authView.mode);
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: AUTH_TABS.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    const mode = AUTH_TABS[(to + AUTH_TABS.length) % AUTH_TABS.length];
    openAuth(mode, { focus: false });
    tabs.querySelector(`[data-auth-tab="${mode}"]`).focus();
  });
  $('#authForgot').addEventListener('click', () => openAuth('forgot'));
  for (const b of document.querySelectorAll('#authProviders [data-oauth]')) {
    b.addEventListener('click', () => { b.disabled = true; startOAuth(b.dataset.oauth); });
  }
  // Liens internes vers les pages de compte (Ctrl+clic : nouvel onglet, comme un lien ordinaire)
  document.addEventListener('click', (ev) => {
    const link = ev.target.closest('a[data-view="login"], a[data-view="account"], a[data-view="admin"], a[data-view="legal"], a[data-view="contact"]');
    if (link && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0)) return;
    if (link) { ev.preventDefault(); const u = new URL(link.href); goTo(u.pathname + u.search + u.hash); return; }
    const out = ev.target.closest('[data-action="logout"]');
    if (out) { ev.preventDefault(); logout(); }
    const back = ev.target.closest('[data-action="stop-impersonation"]');
    if (back) { ev.preventDefault(); stopImpersonation(); }
  });
}

/* ---------------- Mon compte -------------------------------------- */
// Résultat de la liaison Battle.net, renvoyé par le serveur dans l'adresse
const BNET_RESULTS = {
  ok: ['Battle.net lié : ta liste de personnages est à jour.', 'ok'],
  denied: ['Liaison annulée sur Battle.net.', ''],
  expired: ['Ce lien de liaison a expiré. Recommence depuis le bloc Battle.net.', 'err'],
  taken: ['Ce Battle.net est déjà lié à un autre compte GroupScout.', 'err'],
  blizzard: ["Battle.net n'a pas répondu comme prévu. Réessaie dans un moment.", 'err'],
  impersonation: ["Impossible de changer le Battle.net de ce compte quand tu es connecté en tant que quelqu'un d'autre.", 'err'],
  login: ['Connecte-toi, puis recommence la liaison.', 'err'],
  unavailable: ["La liaison avec Battle.net n'est pas encore disponible.", 'err'],
};

// Lit puis retire ?bnet= de l'adresse (retour sur le compte, ou sur la page d'où est partie la liaison)
function takeBnetResult() {
  const u = new URL(location.href);
  const retour = u.searchParams.get('bnet');
  if (!retour) return;
  u.searchParams.delete('bnet');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  routedPath = currentPath();
  const [texte, ton] = BNET_RESULTS[retour] || BNET_RESULTS.blizzard;
  setTimeout(() => toast(texte, ton), 400);
}

// Dernier compte reçu du serveur : la fenêtre Battle.net se redessine avec lui sans le redemander
let accountData = null;
let accountPayload = null;

async function openAccountPage() {
  showView('account');
  document.title = 'Ton compte · GroupScout';
  if (!$('#accountCard').dataset.html) setHtml($('#accountCard'), '<p class="note">Chargement…</p>');
  try {
    const d = await api('/api/account');
    renderAccountPage(d);
  } catch (e) {
    if (e.status === 401) { openAuth('login', { error: 'Connecte-toi pour voir ton compte.' }); return; }
    setHtml($('#accountCard'), `<p class="error">${esc(e.message)}</p>`);
  }
}

// Battle.net : une phrase, l'état, un bouton ; la liste des personnages est dans la fenêtre
function bnetBox(b) {
  if (!b) return '';
  const etat = b.linked
    ? `${b.battletag || 'Lié'} · ${tr('{n, plural, one {# personnage} other {# personnages}}', { n: b.characters.length })}`
    : b.available ? 'Pas encore lié' : 'Bientôt disponible';
  return `<section class="acc-box acc-api acc-wide">
    <h2>Battle.net</h2>
    <p class="note">Lie ton Battle.net pour poster une annonce ou postuler à un raid : tu choisis ensuite avec lequel de tes personnages. GroupScout n'y lit que la liste de tes personnages.</p>
    <p class="acc-api-foot">
      <span class="acc-dot ${b.linked ? 'on' : 'off'}" aria-hidden="true"></span>
      <span class="note">${esc(etat)}</span>
      <button class="btn glass small" type="button" data-modal="bnet"${!b.linked && !b.available ? ' disabled' : ''}>${b.linked ? 'Gérer' : 'Lier'}</button>
    </p>
  </section>`;
}

function bnetModal(b) {
  if (!b.linked) {
    return `
      <ol class="modal-steps">
        <li>Clique sur le bouton ci-dessous : tu arrives sur la page de connexion de Battle.net.</li>
        <li>Connecte-toi si besoin, puis autorise GroupScout à voir tes personnages World of Warcraft.</li>
        <li>Tu reviens ici avec ta liste de personnages, prête à servir.</li>
      </ol>
      <p class="note">GroupScout ne voit ni ton adresse, ni ton mot de passe Battle.net, et ne peut rien modifier sur ton compte. Seuls tes personnages européens sont lus pour l'instant.</p>
      <p class="modal-actions"><button class="btn primary" type="button" data-action="bnet-link">Lier mon Battle.net</button></p>`;
  }
  // Personnage principal : un bouton « Main » par ligne, allumé sur celui choisi ; recliquer
  // dessus l'enlève
  const lignes = b.characters.map((c) => {
    const color = CLASS_COLORS[c.className];
    const on = c.key === b.main;
    const label = on ? tr('Ne plus faire de {name} ton personnage principal', { name: c.name }) : tr('Faire de {name} ton personnage principal', { name: c.name });
    return `<li class="bnet-char${on ? ' is-main' : ''}"><span class="bc-name"${color ? ` style="color:${color}"` : ''}>${esc(c.name)}</span>
      <span class="bc-realm">${esc(c.realm)}</span><span class="bc-level">${c.level ? tr('niv. {n}', { n: esc(c.level) }) : ''}</span>
      <button class="bc-main${on ? ' on' : ''}" type="button" data-bnet-main="${esc(c.key)}" aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(label)}" data-track="compte › ${on ? 'retirer le main' : 'choisir le main'}">Main</button></li>`;
  }).join('');
  return `
    <p class="note">${tr('Compte lié : {tag}, liste mise à jour {when}.', { tag: `<b>${esc(b.battletag || 'Battle.net')}</b>`, when: esc(timeAgo(b.updatedAt)) })}</p>
    ${lignes
      ? `<p class="note bnet-main-help">Choisis ton personnage principal : il est proposé en premier quand tu postules, et la fiche de tes autres personnages mène à lui.</p>
        <ul class="bnet-chars">${lignes}</ul>`
      : "<p class=\"note\">Aucun personnage européen sur ce compte.</p>"}
    <p class="note">Nouveau personnage, transfert ou changement de nom : mets la liste à jour, elle ne se met pas à jour toute seule.</p>
    <p class="note">Tu peux aussi te connecter à GroupScout avec ce Battle.net : ta liste est relue à chaque fois.</p>
    <p class="modal-actions">
      <button class="btn primary" type="button" data-action="bnet-link">Mettre à jour ma liste</button>
      <button class="linkish" type="button" data-action="bnet-unlink">Délier mon Battle.net</button>
    </p>`;
}

function renderAccountPage(payload) {
  const { account: a } = payload;
  accountPayload = payload;
  accountData = a;
  setHtml($('#accountCard'), `
    <span class="card-kicker">Ton compte</span>
    <h1 class="auth-title">${esc(a.name)}</h1>
    <p class="auth-lead">${esc(a.email)}</p>
    <div class="acc-grid">
      ${STATUS_HELP[a.status] || !a.verified ? `<section class="acc-box acc-wide">
        <h2>Statut</h2>
        ${STATUS_HELP[a.status] ? `<p class="acc-status">
          ${a.status === 'vip' ? `<span class="vip-badge vip-big">${VIP_ICON}<b>VIP</b></span>` : a.status === 'admin' ? ADMIN_BADGE(' vip-big') : `<span class="chip s-${esc(a.status)}">${esc(STATUS_LABEL[a.status])}</span>`}
          <span class="note">${esc(STATUS_HELP[a.status])}</span>
        </p>` : ''}
        ${a.verified ? '' : '<p class="note">Ton adresse n\'est pas encore confirmée. <button class="linkish" type="button" data-action="verify-code">Entrer mon code</button></p>'}
      </section>` : ''}
      ${bnetBox(payload.bnet)}
      <section class="acc-box acc-api">
        <h2>Ton pseudo</h2>
        <form class="acc-fields" data-form="name">
          <input type="text" name="name" maxlength="40" value="${esc(a.name)}" spellcheck="false" aria-label="Ton pseudo">
          <p class="acc-api-foot"><button class="btn glass small" type="submit">Enregistrer</button></p>
        </form>
      </section>
      ${passwordBox(a)}
      ${loginsBox(a)}
      <section class="acc-box acc-wide acc-danger">
        <h2>Supprimer ton compte</h2>
        <p class="note">Définitif : ton compte, ton annonce, tes candidatures et ta recherche disparaissent.</p>
        <button class="btn ghost small" type="button" data-action="delete-account">Supprimer mon compte</button>
      </section>
    </div>`);
}

// Mot de passe : le changer, ou en choisir un pour un compte créé par Google, Discord ou Battle.net
// (lien par e-mail, le même que « mot de passe oublié »)
function passwordBox(a) {
  if (a.hasPassword !== false) {
    return `<section class="acc-box acc-api">
        <h2>Mot de passe</h2>
        <form class="acc-fields" data-form="password">
          <input type="password" name="current" placeholder="Mot de passe actuel" autocomplete="current-password" aria-label="Mot de passe actuel">
          <input type="password" name="password" placeholder="Nouveau mot de passe" autocomplete="new-password" aria-label="Nouveau mot de passe">
          <p class="acc-api-foot"><button class="btn glass small" type="submit">Changer</button></p>
        </form>
      </section>`;
  }
  const via = (a.identities || []).map((i) => oauthLabel(i.provider)).join(' et ') || 'Battle.net';
  return `<section class="acc-box acc-api">
      <h2>Mot de passe</h2>
      <p class="note">${tr("Tu te connectes avec {via}. Tu peux aussi choisir un mot de passe : on t'envoie un lien par e-mail pour le faire.", { via: esc(via) })}</p>
      <p class="acc-api-foot"><button class="btn glass small" type="button" data-action="password-link">Recevoir le lien</button></p>
    </section>`;
}

// Google et Discord : lier ou délier. Un service non configuré sur le site n'apparaît que s'il
// était déjà lié (pour pouvoir le délier).
function loginsBox(a) {
  const av = state.status?.oauth || {};
  const rows = Object.keys(OAUTH_LABEL).map((p) => {
    const link = (a.identities || []).find((i) => i.provider === p);
    if (!link && !av[p]) return '';
    const etat = link ? (link.email ? tr('Lié : {email}', { email: link.email }) : 'Lié') : 'Pas lié';
    const btn = link
      ? `<button class="btn ghost small" type="button" data-action="oauth-unlink" data-provider="${p}">Délier</button>`
      : `<button class="btn glass small" type="button" data-action="oauth-link" data-provider="${p}">Lier</button>`;
    return `<li class="acc-login"><span class="oauth-ico oauth-${p}" aria-hidden="true"></span>
      <span class="acc-login-main"><span class="acc-login-name">${OAUTH_LABEL[p]}</span><span class="acc-login-state">${esc(etat)}</span></span>
      ${btn}</li>`;
  }).join('');
  if (!rows) return '';
  return `<section class="acc-box acc-wide">
      <h2>Se connecter avec Google ou Discord</h2>
      <p class="note">Lie ces comptes pour entrer sur GroupScout en un clic. Ton compte reste le même, quel que soit le moyen utilisé.</p>
      <ul class="acc-logins">${rows}</ul>
    </section>`;
}

function openBnetModal() {
  if (!accountPayload) return;
  openModalWith('Battle.net', bnetModal(accountPayload.bnet || { linked: false }));
  ($('#modal').querySelector('.modal-body button') || $('#modal .modal-x'))?.focus();
}

/* ---------------- Adresse à confirmer ------------------------------ */
// Adresse pas confirmée : la fenêtre du code s'ouvre en arrivant sur la fiche joueur, une fois par
// arrivée (`verifyAskedIn` est remis à zéro par showView)
const VERIFY_VIEWS = ['player'];
let verifyAskedIn = null;

function askToVerify() {
  if (!VERIFY_VIEWS.includes(currentView) || verifyAskedIn === currentView) return;
  const acc = state.status?.account;
  if (acc && !acc.verified && !state.status?.impersonatedBy) {
    if (!$('#modal').hidden) return;
    verifyAskedIn = currentView;
    openVerifyModal();
  }
}

// Code à 6 chiffres reçu par e-mail. Six chiffres tapés ou collés = envoi tout seul.
function openVerifyModal() {
  const a = state.status?.account;
  if (!a || a.verified) return;
  openModalWith('Confirme ton adresse', `<p class="modal-text">${tr("On t'a envoyé un code à 6 chiffres à {email}. Il est valable 15 minutes. Pense à regarder tes spams.", { email: `<b>${esc(a.email)}</b>` })}</p>
    <form class="verify-form" data-verify-form novalidate>
      <label class="visually-hidden" for="verifyCode">Code à 6 chiffres</label>
      <div class="code-field">
        <input id="verifyCode" class="code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" spellcheck="false">
        <div class="code-boxes" aria-hidden="true">${'<span class="code-box"></span>'.repeat(6)}</div>
      </div>
      <p class="auth-error" data-verify-error role="alert"></p>
      <button class="btn primary" type="submit">Confirmer mon adresse</button>
    </form>
    <p class="verify-resend">Rien reçu ? <button class="linkish" type="button" data-verify-resend>Envoyer un nouveau code</button></p>`);
  $('#verifyCode').focus();
  renderCodeBoxes($('#verifyCode'));
}

// Six cases dessinées sous un seul vrai champ, transparent : le collage du code et le
// remplissage automatique des téléphones (one-time-code) marchent d'un coup
function renderCodeBoxes(input, { error = false } = {}) {
  const field = input?.closest('.code-field');
  if (!field) return;
  const v = input.value.replace(/\D/g, '').slice(0, 6);
  const focused = document.activeElement === input;
  field.querySelectorAll('.code-box').forEach((b, i) => {
    b.textContent = v[i] || '';
    b.classList.toggle('filled', i < v.length);
    b.classList.toggle('active', focused && i === Math.min(v.length, 5));
  });
  field.classList.toggle('is-error', error);
  if (error) { field.classList.remove('shake'); void field.offsetWidth; field.classList.add('shake'); }
}
function codeCaretToEnd(input) {
  const end = input.value.length;
  if (input.selectionStart !== end || input.selectionEnd !== end) input.setSelectionRange(end, end);
}

let verifying = false;
async function submitVerifyCode(form) {
  if (verifying) return;
  const input = form.querySelector('.code-input');
  const error = form.querySelector('[data-verify-error]');
  const code = input.value.replace(/\D/g, '');
  if (code.length !== 6) { error.textContent = 'Le code fait 6 chiffres.'; input.focus(); renderCodeBoxes(input, { error: true }); return; }
  verifying = true;
  form.querySelector('button[type="submit"]').disabled = true;
  error.textContent = '';
  try {
    await api('/api/auth/verify', { method: 'POST', body: { code } });
    modalOpener = null;
    closeModal();
    toast('Adresse confirmée.', 'ok');
    await loadStatus();
    if (currentView === 'account') openAccountPage();
  } catch (e) {
    error.textContent = e.message;
    // Code faux : les cases passent en rouge et tremblent, on retape par-dessus
    input.value = '';
    input.focus();
    renderCodeBoxes(input, { error: true });
  } finally {
    verifying = false;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = false;
  }
}

function bindVerify() {
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('[data-action="verify-code"]')) return;
    ev.preventDefault();
    openVerifyModal();
  });
  const m = $('#modal');
  m.addEventListener('submit', (ev) => {
    const form = ev.target.closest('form[data-verify-form]');
    if (!form) return;
    ev.preventDefault();
    submitVerifyCode(form);
  });
  m.addEventListener('input', (ev) => {
    if (!ev.target.matches('.code-input')) return;
    const digits = ev.target.value.replace(/\D/g, '').slice(0, 6);
    if (ev.target.value !== digits) ev.target.value = digits;
    const error = m.querySelector('[data-verify-error]');
    if (error) error.textContent = '';
    renderCodeBoxes(ev.target);
    if (digits.length === 6) submitVerifyCode(ev.target.form);
  });
  // Case allumée : seulement quand le champ a le focus ; curseur réel toujours en bout de champ
  for (const type of ['focusin', 'focusout']) {
    m.addEventListener(type, (ev) => { if (ev.target.matches?.('.code-input')) renderCodeBoxes(ev.target); });
  }
  for (const type of ['click', 'keyup', 'select']) {
    m.addEventListener(type, (ev) => { if (ev.target.matches?.('.code-input')) codeCaretToEnd(ev.target); });
  }
  m.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-verify-resend]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await api('/api/auth/resend', { method: 'POST' });
      toast('Nouveau code envoyé.', 'ok');
      const input = m.querySelector('.code-input');
      if (input) { input.value = ''; input.focus(); renderCodeBoxes(input); }
      const error = m.querySelector('[data-verify-error]');
      if (error) error.textContent = '';
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- Actions de la page du compte -------------------- */
// Délégation : le contenu est réécrit souvent, et la fenêtre Battle.net est hors de #account
function bindAccountPages() {
  const envoi = async (ev) => {
    const form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      if (form.dataset.form === 'name') {
        await api('/api/account/name', { method: 'POST', body: { name: data.name } });
        await loadStatus();
        toast('Pseudo enregistré.');
      } else {
        await api('/api/account/password', { method: 'POST', body: data });
        toast('Mot de passe changé.');
      }
      openAccountPage();
    } catch (e) { toast(e.message, 'err'); }
  };

  const clic = async (ev) => {
    if (ev.target.closest('[data-modal="bnet"]')) { openBnetModal(); return; }
    // Personnage principal : la fenêtre se redessine sur place, le focus reste sur la même ligne
    const mainBtn = ev.target.closest('[data-bnet-main]');
    if (mainBtn) {
      const key = mainBtn.dataset.bnetMain;
      const off = mainBtn.getAttribute('aria-pressed') === 'true';
      mainBtn.disabled = true;
      try {
        const d = await api('/api/account/bnet', { method: 'POST', body: { action: 'main', key: off ? null : key } });
        if (accountPayload) accountPayload.bnet = d.bnet;
        const list = $('#modalBody .bnet-chars');
        const top = list?.scrollTop || 0;
        setHtml($('#modalBody'), bnetModal(d.bnet));
        const again = $('#modalBody .bnet-chars');
        if (again) again.scrollTop = top;
        $(`#modalBody [data-bnet-main="${CSS.escape(key)}"]`)?.focus();
        lfg.chars = null;   // la liste des personnages de la recherche de groupe sera relue
        toast(off ? 'Plus de personnage principal.' : 'Personnage principal enregistré.');
      } catch (e) { mainBtn.disabled = false; toast(e.message, 'err'); }
      return;
    }
    const lier = ev.target.closest('[data-action="bnet-link"]');
    if (lier) {
      lier.disabled = true;
      try {
        // Depuis la recherche de groupe, on y revient ; sinon sur la page du compte
        const back = currentView === 'groups' ? location.pathname : null;
        const d = await api('/api/account/bnet', { method: 'POST', body: { action: 'lier', back } });
        location.href = d.url;
      } catch (e) { lier.disabled = false; toast(e.message, 'err'); }
      return;
    }
    if (ev.target.closest('[data-action="bnet-unlink"]')) {
      if (!(await askConfirm({ title: 'Délier ton Battle.net ?', text: "Tu ne pourras plus poster d'annonce ni postuler à un raid tant que tu ne l'auras pas relié.", ok: 'Délier' }))) return;
      try {
        await api('/api/account/bnet', { method: 'POST', body: { action: 'supprimer' } });
        closeModal();
        lfg.chars = null;
        toast('Battle.net délié.');
        openAccountPage();
      } catch (e) { toast(e.message, 'err'); }
      return;
    }
    const olink = ev.target.closest('[data-action="oauth-link"]');
    if (olink) { olink.disabled = true; startOAuth(olink.dataset.provider, true); return; }
    const ounlink = ev.target.closest('[data-action="oauth-unlink"]');
    if (ounlink) {
      const prov = ounlink.dataset.provider;
      if (!(await askConfirm({ title: tr('Délier {p} ?', { p: oauthLabel(prov) }), text: tr('Tu ne pourras plus te connecter avec {p}. Tu pourras le relier quand tu veux.', { p: oauthLabel(prov) }), ok: 'Délier' }))) return;
      try {
        await api('/api/account/identities', { method: 'POST', body: { provider: prov, action: 'supprimer' } });
        await loadStatus();
        toast(tr('{p} délié.', { p: oauthLabel(prov) }));
        openAccountPage();
      } catch (e) { toast(e.message, 'err'); }
      return;
    }
    const plink = ev.target.closest('[data-action="password-link"]');
    if (plink) {
      plink.disabled = true;
      try {
        await api('/api/auth/forgot', { method: 'POST', body: { email: accountData.email } });
        toast(tr('Lien envoyé à {email}. Regarde aussi tes indésirables.', { email: accountData.email }));
      } catch (e) { plink.disabled = false; toast(e.message, 'err'); }
      return;
    }
    if (ev.target.closest('[data-action="delete-account"]')) {
      if (!(await askConfirm({ title: 'Supprimer ton compte ?', text: 'Ton compte, ton annonce, tes candidatures et ta recherche seront supprimés définitivement.', ok: 'Supprimer mon compte' }))) return;
      try {
        await api('/api/account', { method: 'POST', body: { action: 'supprimer' } });
        await loadStatus();
        toast('Compte supprimé.');
        goTo('/');
      } catch (e) { toast(e.message, 'err'); }
    }
  };

  for (const el of [$('#account'), $('#modal')]) {
    el.addEventListener('submit', envoi);
    el.addEventListener('click', clic);
  }
}

/* ---------------- Contact ------------------------------------------ */
// Le message part par le serveur (POST /api/contact) sans jamais afficher l'adresse. Pseudo et
// adresse remplis d'office pour un compte connecté.
const CONTACT_MAX = 3000;
function openContact() {
  showView('contact');
  document.title = 'Contact · GroupScout';
  const a = state.status?.account;
  if (a) {
    if (!$('#contactName').value) $('#contactName').value = a.name || '';
    if (!$('#contactEmail').value) $('#contactEmail').value = a.email || '';
  }
  renderContactCount();
}

function renderContactCount() {
  const n = $('#contactMessage').value.length;
  const el = $('#contactCount');
  el.textContent = n ? `${n} / ${CONTACT_MAX}` : '';
  el.classList.toggle('warn', n > CONTACT_MAX - 200);
}

async function sendContact(ev) {
  ev.preventDefault();
  const submit = $('#contactSubmit');
  if (submit.disabled) return;
  const body = {
    name: $('#contactName').value.trim(),
    email: $('#contactEmail').value.trim(),
    topic: $('#contactTopic').value,
    message: $('#contactMessage').value.trim(),
    website: $('#contactWebsite').value,
  };
  const error = $('#contactError');
  error.textContent = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) { error.textContent = 'Cette adresse e-mail ne ressemble à rien.'; $('#contactEmail').focus(); return; }
  if (body.message.length < 10) { error.textContent = 'Ton message est un peu court : dis-nous en un peu plus.'; $('#contactMessage').focus(); return; }
  submit.disabled = true;
  submit.classList.add('is-loading');
  submit.setAttribute('aria-busy', 'true');
  try {
    await api('/api/contact', { method: 'POST', body });
    $('#contactDoneLead').innerHTML = tr('On te répond à {email}, en général sous quelques jours.', { email: `<b>${esc(body.email)}</b>` });
    $('#contactFormBox').hidden = true;
    $('#contactDone').hidden = false;
    $('#contactMessage').value = '';
    renderContactCount();
    window.GSStats?.event?.('click', 'contact › message envoyé');
  } catch (e) {
    error.textContent = e.message;
  } finally {
    submit.disabled = false;
    submit.classList.remove('is-loading');
    submit.removeAttribute('aria-busy');
  }
}

function bindContact() {
  $('#contactForm').addEventListener('submit', sendContact);
  $('#contactMessage').addEventListener('input', () => { renderContactCount(); $('#contactError').textContent = ''; });
  $('#contactEmail').addEventListener('input', () => { $('#contactError').textContent = ''; });
  $('#contactAgain').addEventListener('click', () => {
    $('#contactDone').hidden = true;
    $('#contactFormBox').hidden = false;
    $('#contactMessage').focus();
  });
}

/* --- Confidentialité et conditions d'utilisation (/privacy, /terms) --- */
// Les deux textes sont statiques dans index.html (#legal) ; on n'affiche que le demandé. La
// mesure d'audience (stats.js) est anonyme : le refus est dans la section « Mesure d'audience »
// (#analytics) de la confidentialité.
const LEGAL_PAGES = { '/privacy': 'privacy', '/terms': 'terms' };
const LEGAL_TITLES = { privacy: 'Confidentialité', terms: "Conditions d'utilisation" };
let legalPage = null;

function openLegal(page) {
  const fromOther = currentView !== 'legal';
  showView('legal');
  const changed = fromOther || legalPage !== page;
  legalPage = page;
  document.title = `${LEGAL_TITLES[page]} · GroupScout`;
  for (const doc of document.querySelectorAll('#legal [data-legal]')) doc.hidden = doc.dataset.legal !== page;
  for (const tab of document.querySelectorAll('#legal [data-legal-tab]')) {
    if (tab.dataset.legalTab === page) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  renderPrivacyChoice();
  // Ancre (/privacy#analytics) : la section, une fois le document affiché
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id && document.getElementById(id);
  if (target && !target.closest('[hidden]')) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  else if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderPrivacyChoice() {
  const el = $('#privacyChoice');
  if (!el) return;
  const s = window.GSStats;
  const off = !s || s.optedOut();
  setHtml(el, s?.gpc
    ? '<p class="privacy-state off">Ton navigateur demande à ne pas être suivi : tes visites ne sont pas comptées.</p>'
    : off
      ? '<p class="privacy-state off">Tes visites ne sont pas comptées.</p><button class="btn glass" type="button" data-privacy="on">Compter mes visites</button>'
      : '<p class="privacy-state on">Tes visites sont comptées, anonymement.</p><button class="btn glass" type="button" data-privacy="off">Ne plus compter mes visites</button>');
}

function bindLegal() {
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('#privacyChoice [data-privacy]');
    if (!b || !window.GSStats) return;
    window.GSStats.setOptOut(b.dataset.privacy === 'off');
    renderPrivacyChoice();
    $('#privacyChoice [data-privacy]')?.focus();
    toast(b.dataset.privacy === 'off' ? 'Tes visites ne seront plus comptées.' : 'Merci ! Tes visites seront comptées, anonymement.');
  });
}
