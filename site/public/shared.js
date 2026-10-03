/*
 * GroupScout — code commun au serveur (require) et au navigateur (window.GroupScoutShared)
 * Difficultés de raid, spés, noms normalisés, et la recherche de personnages de Raider.IO.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GroupScoutShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Difficultés de raid. Les numéros (3, 4, 5) sont ceux de toutes les annonces en base : ils ne
  // changent pas.
  const DIFFICULTIES = [
    { id: 3, key: 'normal', label: 'Normal', letter: 'N' },
    { id: 4, key: 'heroic', label: 'Héroïque', letter: 'H' },
    { id: 5, key: 'mythic', label: 'Mythique', letter: 'M' },
  ];
  const difficultyOf = (id) => DIFFICULTIES.find((d) => d.id === Number(id)) || DIFFICULTIES[1];

  // Spés : identifiant du jeu -> [classe, spé], noms anglais (ceux de Blizzard en en_US et des
  // icônes du site)
  const SPECS_BY_ID = {
    250: ['Death Knight', 'Blood'], 251: ['Death Knight', 'Frost'], 252: ['Death Knight', 'Unholy'],
    577: ['Demon Hunter', 'Havoc'], 581: ['Demon Hunter', 'Vengeance'], 1480: ['Demon Hunter', 'Devourer'],
    102: ['Druid', 'Balance'], 103: ['Druid', 'Feral'], 104: ['Druid', 'Guardian'], 105: ['Druid', 'Restoration'],
    1467: ['Evoker', 'Devastation'], 1468: ['Evoker', 'Preservation'], 1473: ['Evoker', 'Augmentation'],
    253: ['Hunter', 'Beast Mastery'], 254: ['Hunter', 'Marksmanship'], 255: ['Hunter', 'Survival'],
    62: ['Mage', 'Arcane'], 63: ['Mage', 'Fire'], 64: ['Mage', 'Frost'],
    268: ['Monk', 'Brewmaster'], 269: ['Monk', 'Windwalker'], 270: ['Monk', 'Mistweaver'],
    65: ['Paladin', 'Holy'], 66: ['Paladin', 'Protection'], 70: ['Paladin', 'Retribution'],
    256: ['Priest', 'Discipline'], 257: ['Priest', 'Holy'], 258: ['Priest', 'Shadow'],
    259: ['Rogue', 'Assassination'], 260: ['Rogue', 'Outlaw'], 261: ['Rogue', 'Subtlety'],
    262: ['Shaman', 'Elemental'], 263: ['Shaman', 'Enhancement'], 264: ['Shaman', 'Restoration'],
    265: ['Warlock', 'Affliction'], 266: ['Warlock', 'Demonology'], 267: ['Warlock', 'Destruction'],
    71: ['Warrior', 'Arms'], 72: ['Warrior', 'Fury'], 73: ['Warrior', 'Protection'],
  };

  // Nom comparable : sans accents, minuscules, lettres et chiffres seulement
  const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norm = (s) => stripAccents(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const slugify = (s) => stripAccents(s).toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  // « ConseildesOmbres » -> « Conseil des Ombres »
  const camelSplit = (s) => String(s || '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');

  // Erreurs du chargement d'un profil : un code, mis en texte ici
  const PROFILE_ERRORS = {
    limit: 'Trop de demandes en ce moment. Réessaie dans une minute.',
    down: 'Les données du jeu ne répondent pas pour le moment. Réessaie dans un moment.',
  };
  const PROFILE_MISSING = 'Personnage introuvable. Vérifie le pseudo et le serveur.';

  /* ---------------------------------------------------------------- */
  /* Recherche de personnages par leur nom                             */
  /* ---------------------------------------------------------------- */
  // Blizzard ne sait pas chercher un personnage par son nom : les suggestions pendant la frappe
  // viennent de la recherche du site Raider.IO (route ouverte aux navigateurs), appelée depuis le
  // navigateur de chacun. Rien d'autre ne passe par Raider.IO. Lève une erreur si elle ne répond pas.
  const RIO_BASE = 'https://raider.io';

  async function searchRioCharacters(term, { fresh = false } = {}) {
    const u = new URL(`${RIO_BASE}/api/search`);
    u.searchParams.set('term', term);
    const res = await fetch(u, { headers: { Accept: 'application/json' }, ...(fresh ? { cache: 'no-store' } : {}) });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error('search');
    return ((body && body.matches) || [])
      .filter((m) => m.type === 'character' && m.data && m.data.realm && m.data.realm.name)
      .slice(0, 12)
      .map((m) => ({
        name: m.data.name || m.name,
        realm: m.data.realm.name,
        region: (m.data.region && m.data.region.slug) || 'eu',
        regionLabel: (m.data.region && m.data.region.short_name) || '',
        class: (m.data.class && m.data.class.name) || null,
        faction: m.data.faction || null,
      }));
  }

  return {
    DIFFICULTIES, difficultyOf, SPECS_BY_ID, norm, slugify, camelSplit,
    PROFILE_ERRORS, PROFILE_MISSING, RIO_BASE, searchRioCharacters,
  };
});
