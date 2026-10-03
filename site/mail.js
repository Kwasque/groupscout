'use strict';
/*
 * GroupScout — envoi des e-mails (code de vérification d'adresse, mot de passe oublié)
 *
 * Brevo en API HTTP, appelée avec le `fetch` natif : zéro dépendance npm, contrairement
 * à un client SMTP. Sans clé configurée, le lien est simplement écrit dans la console du
 * serveur : ça permet de tout tester avant d'avoir un domaine et un compte Brevo.
 *
 * Le gabarit (septembre 2026, maquette de l'utilisateur faite sur Claude Design) reprend le
 * thème du site : fond violet sombre, carte arrondie, logo [GroupScout], bouton lavande.
 * Mise en page en tableaux et styles en ligne : les messageries ignorent les feuilles de
 * style et Outlook ne connaît ni flex ni grid. Tous les textes arrivent déjà traduits
 * (accounts.js) et passent par escapeHtml, y compris le pseudo du titre.
 */
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

// Couleurs du site (style.css), en valeurs pleines : pas de rgba fiable dans les messageries
const C = {
  bg: '#08070d', card: '#13111b', cardEdge: '#262130', box: '#181522', boxEdge: '#2a2537',
  text: '#f6f2ef', soft: '#c3bdd2', muted: '#948fa3', faint: '#6f6a80',
  violet: '#a78bfa', lavender: '#ece4ff', pill: '#1c1733', pillEdge: '#3a2f63',
};
const FONT = "Poppins,'Segoe UI',Arial,sans-serif";
const BODY_FONT = "Inter,'Segoe UI',Arial,sans-serif";

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createMailer(deps = {}) {
  const apiKey = String(deps.apiKey || '').trim();
  const from = String(deps.from || '').trim();
  const fromName = String(deps.fromName || 'GroupScout').trim();
  const publicUrl = String(deps.publicUrl || '').replace(/\/+$/, '');

  const configured = () => Boolean(apiKey && from);

  // `mail` : le contenu traduit (voir renderHtml) ; `link` (mot de passe oublié) ou `code`
  // (vérification d'adresse) sont repris tels quels dans la console sans Brevo.
  async function send({ to, subject, mail, link, code, kind, lang = 'fr' }) {
    const secret = code || link;
    if (!configured()) {
      // Repli : le lien ou le code s'affiche sur le serveur, à transmettre à la main
      console.log(`\n  [e-mail non configuré] ${kind === 'reset' ? 'Mot de passe oublié' : 'Code de vérification'} pour ${to}`);
      console.log(`  ${secret}\n`);
      return { sent: false, logged: true, link, code };
    }
    const body = {
      sender: { email: from, name: fromName },
      to: [{ email: to }],
      subject,
      textContent: renderText(mail),
      htmlContent: renderHtml(mail, { lang, subject }),
    };
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`Brevo a refusé l'envoi à ${to} (${res.status}) : ${detail.slice(0, 300)}`);
      // On ne remonte pas l'erreur au visiteur : il ne peut rien y faire, et ça révélerait
      // quelles adresses existent. Le lien reste dans la console pour le dépannage.
      console.log(`  À transmettre à la main : ${secret}`);
      return { sent: false, logged: true, link, code };
    }
    return { sent: true, logged: false };
  }

  const url = (p) => (publicUrl ? `${publicUrl}${p}` : '');

  // Version texte, pour les messageries qui n'affichent pas le HTML
  function renderText(m) {
    const out = [m.title, '', m.intro, ''];
    if (m.code) out.push(m.code, '');
    if (m.button) out.push(`${m.button.label} — ${m.button.href}`, '');
    for (const s of m.steps || []) out.push(`${s.label} — ${s.title}. ${s.text}`);
    if (m.steps?.length) out.push('');
    out.push(m.notice, '', '—', m.foot.reason, m.foot.legal);
    if (publicUrl) out.push(`${m.foot.privacy} — ${url('/privacy')}`, `${m.foot.terms} — ${url('/terms')}`);
    return out.join('\n');
  }

  /*
   * m = { preheader?, badge, title, intro, code?, button?: { label, href }, steps?: [{ label, title, text }],
   *       notice, fallback?, foot: { reason, legal, privacy, terms } }
   */
  function renderHtml(m, { lang, subject }) {
    const e = escapeHtml;
    const logo = `<a href="${e(url('/') || '#')}" style="text-decoration:none;font-family:${FONT};font-size:22px;line-height:28px;letter-spacing:-.2px;color:${C.lavender}">`
      + `<span style="color:${C.violet};font-weight:400">[</span>`
      + `<span style="font-weight:600;color:${C.lavender}">Group</span><span style="font-weight:600;color:${C.violet}">Scout</span>`
      + `<span style="color:${C.violet};font-weight:400">]</span></a>`;

    const code = m.code ? `<tr><td align="center" style="padding:0 0 28px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:${C.pill};border:1px solid ${C.pillEdge};border-radius:14px;padding:16px 26px 16px 34px;font-family:${FONT};font-size:36px;line-height:42px;font-weight:600;letter-spacing:10px;color:${C.lavender}">${e(m.code)}</td>
      </tr></table></td></tr>` : '';

    const button = m.button ? `<tr><td align="center" style="padding:0 0 32px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td bgcolor="#9b7af5" style="border-radius:12px;background:#9b7af5;background-image:linear-gradient(135deg,#b69cfc,#8b63ef)">
          <a href="${e(m.button.href)}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px">${e(m.button.label)}</a>
        </td></tr></table></td></tr>` : '';

    const steps = (m.steps || []).map((s) => `<tr><td style="padding:0 0 10px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:${C.box};border:1px solid ${C.boxEdge};border-radius:12px;padding:16px 18px">
          <div style="font-family:${BODY_FONT};font-size:12px;line-height:16px;font-weight:500;color:${C.violet};margin:0 0 6px">${e(s.label)}</div>
          <div style="font-family:${FONT};font-size:15px;line-height:21px;font-weight:600;color:${C.text};margin:0 0 4px">${e(s.title)}</div>
          <div style="font-family:${BODY_FONT};font-size:14px;line-height:20px;color:${C.muted}">${e(s.text)}</div>
        </td></tr></table></td></tr>`).join('');

    const fallback = m.fallback && m.button ? `<tr><td style="padding:24px 0 0;border-top:1px solid ${C.cardEdge};font-family:${BODY_FONT};font-size:13px;line-height:20px;color:${C.muted};text-align:center">
      ${e(m.fallback)}<br><a href="${e(m.button.href)}" style="color:${C.violet};text-decoration:underline;word-break:break-all">${e(m.button.href)}</a></td></tr>` : '';

    const legalLinks = publicUrl
      ? `<br><a href="${e(url('/privacy'))}" style="color:${C.muted};text-decoration:underline">${e(m.foot.privacy)}</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${e(url('/terms'))}" style="color:${C.muted};text-decoration:underline">${e(m.foot.terms)}</a>`
      : '';

    return `<!DOCTYPE html>
<html lang="${e(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${e(subject || m.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Poppins:wght@400;600&display=swap" rel="stylesheet">
<style>
  @media (max-width: 520px) {
    .gs-card { padding: 32px 20px !important; }
    .gs-title { font-size: 24px !important; line-height: 31px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${e(m.preheader || m.intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};background-image:linear-gradient(180deg,#2a1a50 0%,#150f27 170px,${C.bg} 420px)">
  <tr><td align="center" style="padding:32px 12px 40px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
      <tr><td align="center" style="padding:0 0 32px">${logo}</td></tr>
      <tr><td class="gs-card" style="background:${C.card};background-image:linear-gradient(180deg,${C.card} 60%,#1a1530 100%);border:1px solid ${C.cardEdge};border-radius:22px;padding:44px 44px 36px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center" style="padding:0 0 18px">
            <span style="display:inline-block;background:${C.pill};border:1px solid ${C.pillEdge};border-radius:999px;padding:5px 13px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:600;color:#b9a4f7">${e(m.badge)}</span>
          </td></tr>
          <tr><td align="center" class="gs-title" style="padding:0 0 14px;font-family:${FONT};font-size:30px;line-height:38px;font-weight:400;color:${C.text}">${e(m.title)}</td></tr>
          <tr><td align="center" style="padding:0 0 30px;font-family:${BODY_FONT};font-size:16px;line-height:25px;color:${C.soft}">${e(m.intro)}</td></tr>
          ${code}${button}${steps}
          <tr><td style="padding:${steps ? '18px' : '0'} 0 ${fallback ? '28px' : '0'}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td align="center" style="border:1px solid ${C.boxEdge};border-radius:12px;padding:16px 20px;font-family:${BODY_FONT};font-size:14px;line-height:21px;color:${C.muted}">${e(m.notice)}</td>
            </tr></table></td></tr>
          ${fallback}
        </table>
      </td></tr>
      <tr><td align="center" style="padding:28px 16px 0;font-family:${BODY_FONT};font-size:12px;line-height:19px;color:${C.faint}">
        ${e(m.foot.reason)}<br><br>${e(m.foot.legal)}${legalLinks}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
  }

  // Message du formulaire de contact, pour le propriétaire du site : texte brut (et sa copie
  // en HTML échappé), `replyTo` = l'adresse du visiteur, pour lui répondre d'un clic. Renvoie
  // vrai si Brevo l'a accepté ; sans Brevo, le message est écrit dans la console.
  async function sendMessage({ to, replyTo, subject, text }) {
    if (!configured()) {
      console.log(`\n  [e-mail non configuré] Message de contact pour ${to} (répondre à ${replyTo?.email || '?'})`);
      console.log(`  ${subject}\n${text}\n`);
      return true;
    }
    const body = {
      sender: { email: from, name: fromName },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: `<pre style="font-family:${BODY_FONT};font-size:14px;line-height:21px;white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre>`,
    };
    if (replyTo?.email) body.replyTo = { email: replyTo.email, ...(replyTo.name ? { name: replyTo.name } : {}) };
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      const detail = res ? await res.text().catch(() => '') : 'réseau';
      console.error(`Brevo a refusé le message de contact (${res?.status || '-'}) : ${detail.slice(0, 300)}`);
      return false;
    }
    return true;
  }

  return { send, sendMessage, configured, renderHtml, renderText };
}

module.exports = { createMailer };
