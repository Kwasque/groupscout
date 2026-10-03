'use strict';
/* ================================================================== */
/* Mise en forme des textes, commune au serveur et au navigateur       */
/* ================================================================== */
// Le site est en français. Les textes s'écrivent dans le code et passent par tr() pour leurs
// variables : tr('Il reste {n} %', { n }). Pluriels et choix, à la manière d'ICU :
//   tr('{n, plural, one {# joueur} other {# joueurs}}', { n })
//   tr('{r, select, tank {le tank} other {le joueur}}', { r })
// Le français met au singulier 0 et 1.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.GroupScoutI18n = api; api.boot(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  const LANG = 'fr';
  const LOCALE = 'fr-FR';

  const pluralCategory = (n) => (n >= 0 && n < 2 ? 'one' : 'other');

  // Accolade fermante qui correspond à celle ouverte en i
  function closing(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return j;
    }
    return -1;
  }

  // « one {# joueur} other {# joueurs} » -> { one: '# joueur', other: '# joueurs' }
  function options(s) {
    const out = {};
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const name = s.slice(i, open).trim();
      const end = closing(s, open);
      if (end < 0) break;
      out[name] = s.slice(open + 1, end);
      i = end + 1;
    }
    return out;
  }

  // Remplace # par le nombre, sauf dans un bloc imbriqué (qui a son propre nombre)
  function hash(s, value) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '{') {
        const end = closing(s, i);
        if (end < 0) { out += s.slice(i); break; }
        out += s.slice(i, end + 1);
        i = end;
      } else out += s[i] === '#' ? value : s[i];
    }
    return out;
  }

  function format(s, vars) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '{') { out += s[i]; continue; }
      const end = closing(s, i);
      if (end < 0) { out += s.slice(i); break; }
      out += arg(s.slice(i + 1, end), vars);
      i = end;
    }
    return out;
  }

  function arg(inner, vars) {
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const value = vars[name];
    if (comma < 0) return value == null ? `{${inner}}` : String(value);
    const rest = inner.slice(comma + 1);
    const comma2 = rest.indexOf(',');
    const type = rest.slice(0, comma2).trim();
    const opts = options(rest.slice(comma2 + 1));
    if (type === 'plural') {
      const n = Number(value);
      const chosen = opts[`=${n}`] ?? opts[pluralCategory(n)] ?? opts.other ?? '';
      return format(hash(chosen, Number.isFinite(n) ? n.toLocaleString(LOCALE) : String(value)), vars);
    }
    if (type === 'select') return format(opts[String(value)] ?? opts.other ?? '', vars);
    return String(value ?? '');
  }

  const t = (key, vars) => (vars ? format(String(key), vars) : String(key));

  function boot(root) {
    root.I18N = { lang: LANG, locale: LOCALE };
    root.LANG = LANG;
    root.tr = t;
  }

  return { LANG, LOCALE, format, t, boot };
});
