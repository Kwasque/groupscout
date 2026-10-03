'use strict';
// Images du Journal des rencontres du jeu (demande de l'utilisateur, 28 septembre 2026) : portrait
// de chaque boss (celui de la liste des boss en jeu, cadré sur le buste, 128 × 64) et images de
// chaque instance (bouton du journal, fond de l'histoire), pour la progression de la fiche joueur.
// *Avant : les rendus « zoom » de l'API Blizzard, des modèles en pied de tailles très inégales
// (petits, pas centrés), et des vignettes d'instance parfois annoncées mais absentes.*
//
// D'où ça vient : les tables du jeu publiées par wago.tools (JournalEncounterCreature : boss ->
// fichier du portrait ; JournalInstance : instance -> fichiers de ses images), puis le fichier
// lui-même (texture BLP du jeu), lu une seule fois sur wago.tools, décodé ici (DXT1/3/5, palette,
// BGRA) et gardé en PNG dans `dir`. Aucune dépendance. Les tables sont relues une fois par semaine.
// Seuls les fichiers cités par ces tables peuvent être demandés (pas de téléchargement arbitraire).

const fs = require('fs');
const path = require('path');
const { encodePng } = require('./icons.js');

const WAGO = 'https://wago.tools';
const TABLES_TTL = 7 * 86400e3;
const FAIL_TTL = 10 * 60e3;
const MAX_ACTIVE = 3;
const TIMEOUT = 15000;

/* ---------------- Tables du jeu (CSV de wago.tools) ---------------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/* ---------------- Textures BLP ---------------- */
function rgb565(v) {
  return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
}
// Bloc de couleurs DXT (4 × 4 pixels) : 2 couleurs de référence et 2 bits par pixel
function dxtColors(buf, o, dxt1) {
  const c0 = buf.readUInt16LE(o);
  const c1 = buf.readUInt16LE(o + 2);
  const a = rgb565(c0);
  const b = rgb565(c1);
  const cols = [[...a, 255], [...b, 255]];
  if (!dxt1 || c0 > c1) {
    cols.push([(2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3, (2 * a[2] + b[2]) / 3, 255]);
    cols.push([(a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3, (a[2] + 2 * b[2]) / 3, 255]);
  } else {
    cols.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 255]);
    cols.push([0, 0, 0, 0]);
  }
  const bits = buf.readUInt32LE(o + 4);
  return Array.from({ length: 16 }, (_, i) => cols[(bits >> (2 * i)) & 3]);
}
function decodeDxt(buf, off, width, height, type) {
  const rgba = Buffer.alloc(width * height * 4);
  const blockSize = type === 'dxt1' ? 8 : 16;
  let o = off;
  for (let by = 0; by < height; by += 4) {
    for (let bx = 0; bx < width; bx += 4) {
      let alpha = null;
      if (type === 'dxt3') {
        alpha = Array.from({ length: 16 }, (_, i) => ((buf[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17);
      } else if (type === 'dxt5') {
        const a0 = buf[o];
        const a1 = buf[o + 1];
        const lut = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) lut.push(((7 - i) * a0 + i * a1) / 7);
        else { for (let i = 1; i < 5; i++) lut.push(((5 - i) * a0 + i * a1) / 5); lut.push(0, 255); }
        let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(buf[o + 2 + i]) << BigInt(8 * i);
        alpha = Array.from({ length: 16 }, (_, i) => lut[Number((bits >> BigInt(3 * i)) & 7n)]);
      }
      const colors = dxtColors(buf, o + (type === 'dxt1' ? 0 : 8), type === 'dxt1');
      for (let i = 0; i < 16; i++) {
        const x = bx + (i & 3);
        const y = by + (i >> 2);
        if (x >= width || y >= height) continue;
        const p = (y * width + x) * 4;
        const c = colors[i];
        rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2];
        rgba[p + 3] = alpha ? alpha[i] : c[3];
      }
      o += blockSize;
    }
  }
  return rgba;
}
// Première image (la plus grande) d'une texture BLP2 -> { width, height, rgba }
function readBlp(buf) {
  if (buf.length < 148 || buf.toString('latin1', 0, 4) !== 'BLP2') throw new Error('not a BLP2 file');
  const enc = buf[8];
  const alphaDepth = buf[9];
  const alphaType = buf[10];
  const width = buf.readUInt32LE(12);
  const height = buf.readUInt32LE(16);
  const off = buf.readUInt32LE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error('bad size');
  if (enc === 2) {
    const type = alphaType === 7 ? 'dxt5' : alphaType === 1 ? 'dxt3' : 'dxt1';
    return { width, height, rgba: decodeDxt(buf, off, width, height, type) };
  }
  const rgba = Buffer.alloc(width * height * 4);
  const n = width * height;
  if (enc === 3) {   // BGRA
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = buf[off + i * 4 + 2]; rgba[i * 4 + 1] = buf[off + i * 4 + 1];
      rgba[i * 4 + 2] = buf[off + i * 4]; rgba[i * 4 + 3] = buf[off + i * 4 + 3];
    }
    return { width, height, rgba };
  }
  if (enc === 1) {   // palette de 256 couleurs BGRA, puis l'alpha à part (0, 1, 4 ou 8 bits)
    const a = off + n;
    for (let i = 0; i < n; i++) {
      const c = 148 + buf[off + i] * 4;
      rgba[i * 4] = buf[c + 2]; rgba[i * 4 + 1] = buf[c + 1]; rgba[i * 4 + 2] = buf[c];
      let alpha = 255;
      if (alphaDepth === 8) alpha = buf[a + i];
      else if (alphaDepth === 4) alpha = ((buf[a + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      else if (alphaDepth === 1) alpha = (buf[a + (i >> 3)] >> (i & 7)) & 1 ? 255 : 0;
      rgba[i * 4 + 3] = alpha;
    }
    return { width, height, rgba };
  }
  throw new Error(`unsupported BLP encoding ${enc}`);
}

// Recadrages : la partie utile des textures d'instance (mesurée sur celles de Midnight, identique
// d'une instance à l'autre). Bouton du journal : 170 × 92 dans une texture de 256 × 128, coins
// arrondis retirés. Fond de l'histoire : la scène à l'intérieur du cadre peint, dans 512 × 512.
const CROPS = {
  button: { x: 3, y: 3, w: 164, h: 86 },
  lore: { x: 44, y: 54, w: 312, h: 232 },
};
// Portrait d'un boss : la texture du jeu n'est pas toujours centrée (Nymrissa Wavecaller est à
// gauche, demande de l'utilisateur) ; on décale l'image pour que le milieu de ce qui est dessiné
// (pixels assez opaques) tombe au milieu, même taille, le reste transparent.
function centerBust(img) {
  const { width: w, height: h, rgba } = img;
  let min = w;
  let max = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 48) { if (x < min) min = x; if (x > max) max = x; }
    }
  }
  if (max < 0) return img;
  const shift = Math.round(w / 2 - (min + max + 1) / 2);
  if (!shift) return img;
  const out = Buffer.alloc(rgba.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - shift;
      if (sx < 0 || sx >= w) continue;
      rgba.copy(out, (y * w + x) * 4, (y * w + sx) * 4, (y * w + sx) * 4 + 4);
    }
  }
  return { width: w, height: h, rgba: out };
}
const TRANSFORMS = {
  button: (img) => crop(img, CROPS.button),
  lore: (img) => crop(img, CROPS.lore),
  boss: centerBust,
};

function crop(img, c) {
  if (!c || img.width < c.x + c.w || img.height < c.y + c.h) return img;
  const rgba = Buffer.alloc(c.w * c.h * 4);
  for (let y = 0; y < c.h; y++) img.rgba.copy(rgba, y * c.w * 4, ((c.y + y) * img.width + c.x) * 4, ((c.y + y) * img.width + c.x + c.w) * 4);
  return { width: c.w, height: c.h, rgba };
}

/* ---------------- Magasin ---------------- */
function createJournalArt({ dir, fetch = global.fetch, log = console }) {
  fs.mkdirSync(dir, { recursive: true });
  const tablesFile = path.join(dir, 'tables.json');
  let tables = null;          // { at, bosses: { encounterId: fileId }, instances: { id: { button, small, lore, background } } }
  let tablesPromise = null;
  const allowed = () => new Set([
    ...Object.values(tables?.bosses || {}),
    ...Object.values(tables?.instances || {}).flatMap((x) => Object.values(x)),
  ].map(String));
  let allowedIds = new Set();

  try {
    tables = JSON.parse(fs.readFileSync(tablesFile, 'utf8'));
    allowedIds = allowed();
  } catch { /* première fois */ }

  async function getCsv(name) {
    const res = await fetch(`${WAGO}/db2/${name}/csv`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    return parseCsv(await res.text());
  }
  async function loadTables() {
    if (tables && Date.now() - tables.at < TABLES_TTL) return tables;
    if (tablesPromise) return tablesPromise;
    tablesPromise = (async () => {
      try {
        const [creatures, instances] = await Promise.all([getCsv('JournalEncounterCreature'), getCsv('JournalInstance')]);
        // Le portrait d'un boss : celui de sa première créature qui en a un
        const bosses = {};
        const order = {};
        for (const c of creatures) {
          const enc = Number(c.JournalEncounterID);
          const file = Number(c.FileDataID);
          const idx = Number(c.OrderIndex) || 0;
          if (!enc || !file) continue;
          if (order[enc] === undefined || idx < order[enc]) { order[enc] = idx; bosses[enc] = file; }
        }
        const inst = {};
        for (const i of instances) {
          const id = Number(i.ID);
          if (!id) continue;
          const pick = (k) => Number(i[k]) || null;
          inst[id] = Object.fromEntries(Object.entries({
            button: pick('ButtonFileDataID'), small: pick('ButtonSmallFileDataID'), lore: pick('LoreFileDataID'), background: pick('BackgroundFileDataID'),
          }).filter(([, v]) => v));
        }
        if (!Object.keys(bosses).length) throw new Error('empty tables');
        tables = { at: Date.now(), bosses, instances: inst };
        allowedIds = allowed();
        fs.writeFileSync(tablesFile, JSON.stringify(tables));
      } catch (e) {
        log.error?.('[journal] tables illisibles :', e.message);
        if (tables) tables.at = Date.now() - TABLES_TTL + FAIL_TTL;   // on garde l'ancienne, nouvel essai plus tard
      }
      return tables;
    })();
    try { return await tablesPromise; } finally { tablesPromise = null; }
  }

  // Adresse de l'image d'un fichier du jeu, servie par le site (null si inconnu) ; `variant` :
  // recadrage (CROPS)
  const url = (file, variant = '') => (file ? `/api/journal/${file}${variant ? `-${variant}` : ''}.png` : null);
  async function boss(encounterId) {
    const t = await loadTables();
    return url(t?.bosses?.[encounterId], 'boss');
  }
  async function instance(instanceId) {
    const t = await loadTables();
    const x = t?.instances?.[instanceId] || {};
    return { button: url(x.button, 'button'), lore: url(x.lore, 'lore') };
  }

  /* Fichier PNG d'une image (décodée à la première demande) */
  const inflight = new Map();
  const failed = new Map();
  let active = 0;
  const queue = [];
  const slot = () => (active < MAX_ACTIVE ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r)));
  const release = () => { active--; const next = queue.shift(); if (next) { active++; next(); } };

  // name : « 8164259 », ou « 8164259-lore » (recadré, TRANSFORMS)
  async function png(name) {
    const m = /^(\d{1,10})(?:-(button|lore|boss))?$/.exec(String(name));
    if (!m) return null;
    const [, file, variant] = m;
    const out = path.join(dir, `${name}.png`);
    if (fs.existsSync(out)) return out;
    if (!allowedIds.has(file)) { await loadTables(); if (!allowedIds.has(file)) return null; }
    if ((failed.get(file) || 0) > Date.now()) return null;
    if (inflight.has(name)) return inflight.get(name);
    const p = (async () => {
      await slot();
      try {
        const res = await fetch(`${WAGO}/api/casc/${file}?download`, { signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok) throw new Error(`casc ${res.status}`);
        const raw = readBlp(Buffer.from(await res.arrayBuffer()));
        const img = variant ? TRANSFORMS[variant](raw) : raw;
        const tmp = `${out}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, encodePng(img));
        fs.renameSync(tmp, out);
        return out;
      } catch (e) {
        log.error?.(`[journal] image ${file} :`, e.message);
        failed.set(file, Date.now() + FAIL_TTL);
        return null;
      } finally {
        release();
        inflight.delete(name);
      }
    })();
    inflight.set(name, p);
    return p;
  }

  return { boss, instance, png, loadTables };
}

module.exports = { createJournalArt, readBlp, parseCsv };
