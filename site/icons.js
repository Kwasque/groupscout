'use strict';
// Icônes d'objets : celles de « Clean Icons - Mechagnome Edition » (AcidWeb), à la demande (demande
// de l'utilisateur, septembre 2026). Le paquet est un zip de 1,1 Go sur GitHub (33 000 icônes en
// TGA de 128 px, dossier ICONS/) : on n'en télécharge jamais le tout. La table des matières est lue
// une fois par requêtes HTTP partielles (~4 Mo, gardée dans <dir>/index.json), puis chaque icône
// demandée est lue seule dans le zip (~40 Ko), convertie en PNG de 64 px et gardée dans <dir>.
// Les icônes de classes et de spés, elles, sont livrées avec le site (public/icons/).
// Aucune dépendance : zlib (intégré à Node) décompresse le zip et compresse le PNG.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 64;                  // les icônes d'équipement s'affichent en 42 px au plus
const MAX_ACTIVE = 4;             // lectures dans le zip en même temps
const RETRY_INDEX_MS = 10 * 60e3; // table des matières illisible : nouvel essai 10 min plus tard
const NAME_RE = /^[a-z0-9_.-]{1,120}$/;

function createIconStore({ dir, url, fetch = global.fetch, log = console }) {
  let index = null;               // Map nom (minuscules, sans .tga) -> [offset, taille compressée, méthode]
  let indexing = null;
  let indexFailedAt = 0;
  const pending = new Map();      // nom -> promesse en cours
  let active = 0;
  const queue = [];

  const file = (name) => path.join(dir, `${name}.png`);
  const cleanName = (name) => {
    const n = String(name || '').toLowerCase();
    return NAME_RE.test(n) && !n.includes('..') ? n : null;
  };

  async function range(start, end) {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'GroupScout' }, redirect: 'follow' });
    if (res.status !== 206) throw new Error(`lecture partielle refusée (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Table des matières du zip (fin de fichier, puis répertoire central)
  async function readIndex() {
    // Taille du zip d'abord : le CDN de GitHub refuse « les N derniers octets » (501)
    const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'GroupScout' }, redirect: 'follow' });
    const size = Number(head.headers.get('content-length'));
    if (!head.ok || !(size > 22)) throw new Error(`taille du paquet inconnue (${head.status})`);
    const tail = await range(Math.max(0, size - 65536), size - 1);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('fin du zip introuvable');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 non géré');
    const cd = await range(cdOffset, cdOffset + cdSize - 1);
    const entries = {};
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      const m = name.match(/^ICONS\/(.+)\.tga$/i);
      if (m) entries[m[1].toLowerCase()] = [offset, csize, method];
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function loadIndex() {
    if (index) return index;
    if (indexFailedAt && Date.now() - indexFailedAt < RETRY_INDEX_MS) return null;
    if (!indexing) {
      indexing = (async () => {
        const saved = path.join(dir, 'index.json');
        try {
          const j = JSON.parse(fs.readFileSync(saved, 'utf8'));
          if (j.url === url && j.entries) return new Map(Object.entries(j.entries));
        } catch { /* pas encore lue, ou pour une autre version du paquet */ }
        const entries = await readIndex();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(saved, JSON.stringify({ url, entries }));
        log.log?.(`[icônes] table des matières du paquet lue : ${Object.keys(entries).length} icônes`);
        return new Map(Object.entries(entries));
      })().then((m) => { index = m; return m; }, (e) => {
        indexFailedAt = Date.now();
        log.error?.('[icônes] table des matières illisible :', e.message);
        return null;
      }).finally(() => { indexing = null; });
    }
    return indexing;
  }

  // Une icône du zip, décompressée (TGA)
  async function readEntry([offset, csize, method]) {
    const buf = await range(offset, offset + 30 + 512 + csize - 1);
    if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('en-tête local invalide');
    const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
    const data = start + csize <= buf.length ? buf.subarray(start, start + csize) : await range(offset + start, offset + start + csize - 1);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`compression ${method} non gérée`);
  }

  async function build(name) {
    const entries = await loadIndex();
    const entry = entries?.get(name);
    if (!entry) return null;
    while (active >= MAX_ACTIVE) await new Promise((resolve) => queue.push(resolve));
    active++;
    try {
      const { width, height, rgba } = readTga(await readEntry(entry));
      const png = encodePng(downscale(width, height, rgba, SIZE));
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file(name)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, file(name));
      return file(name);
    } finally {
      active--;
      queue.shift()?.();
    }
  }

  // Chemin du PNG de cette icône (créé au besoin), ou null (inconnue du paquet, paquet injoignable)
  async function get(rawName) {
    const name = cleanName(rawName);
    if (!name) return null;
    if (fs.existsSync(file(name))) return file(name);
    if (!pending.has(name)) {
      pending.set(name, build(name).catch((e) => {
        log.error?.(`[icônes] ${name} :`, e.message);
        return null;
      }).finally(() => pending.delete(name)));
    }
    return pending.get(name);
  }

  // Déjà sur le disque (sans rien télécharger)
  const cached = (rawName) => {
    const name = cleanName(rawName);
    return name && fs.existsSync(file(name)) ? file(name) : null;
  };

  /* Icônes de Blizzard (demande de l'utilisateur, 28 septembre 2026 : tout sur le disque) : celles
   * que le paquet n'a pas (objets d'un patch plus récent) et celles des talents (l'API ne donne
   * qu'un numéro de fichier pour un sort, inconnu du paquet). Téléchargées une fois sur
   * render.worldofwarcraft.com, gardées telles quelles (JPEG de 56 px) dans <dir>/blizzard. */
  const bFile = (name) => path.join(dir, 'blizzard', `${name}.jpg`);
  const bPending = new Map();
  const bMissing = new Map();     // nom -> date : inconnue chez Blizzard, pas redemandée pendant une heure
  const blizzardCached = (rawName) => {
    const name = cleanName(rawName);
    return name && fs.existsSync(bFile(name)) ? bFile(name) : null;
  };
  async function fetchBlizzard(name) {
    const res = await fetch(`https://render.worldofwarcraft.com/eu/icons/56/${name}.jpg`, { headers: { 'User-Agent': 'GroupScout' } });
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 256 * 1024) return null;
    fs.mkdirSync(path.dirname(bFile(name)), { recursive: true });
    const tmp = `${bFile(name)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, bFile(name));
    return bFile(name);
  }
  // Chemin du JPEG (téléchargé au besoin), ou null (inconnue chez Blizzard, injoignable)
  async function blizzard(rawName) {
    const name = cleanName(rawName);
    if (!name) return null;
    if (fs.existsSync(bFile(name))) return bFile(name);
    if (Date.now() - (bMissing.get(name) || 0) < 3600e3) return null;
    if (!bPending.has(name)) {
      bPending.set(name, fetchBlizzard(name).then((f) => {
        if (!f) {
          if (bMissing.size > 5000) bMissing.clear();
          bMissing.set(name, Date.now());
        }
        return f;
      }, (e) => {
        log.error?.(`[icônes] ${name} (Blizzard) :`, e.message);
        return null;
      }).finally(() => bPending.delete(name)));
    }
    return bPending.get(name);
  }

  return { get, cached, cleanName, blizzard, blizzardCached };
}

// TGA non compressé ou RLE, 24 ou 32 bits -> RGBA de haut en bas
function readTga(data) {
  const idLen = data[0], cmType = data[1], type = data[2];
  const width = data.readUInt16LE(12), height = data.readUInt16LE(14);
  const bpp = data[16], desc = data[17];
  if (cmType || (type !== 2 && type !== 10) || (bpp !== 24 && bpp !== 32)) throw new Error(`TGA non géré (type ${type}, ${bpp} bits)`);
  const px = bpp / 8;
  const n = width * height;
  let raw;
  let pos = 18 + idLen;
  if (type === 2) raw = data.subarray(pos, pos + n * px);
  else {
    raw = Buffer.alloc(n * px);
    let o = 0;
    while (o < raw.length) {
      const c = data[pos++];
      const count = (c & 0x7f) + 1;
      if (c & 0x80) {
        for (let i = 0; i < count; i++) { data.copy(raw, o, pos, pos + px); o += px; }
        pos += px;
      } else {
        data.copy(raw, o, pos, pos + count * px);
        o += count * px;
        pos += count * px;
      }
    }
  }
  const rgba = Buffer.alloc(n * 4);
  const topDown = Boolean(desc & 0x20);
  for (let y = 0; y < height; y++) {
    const src = (topDown ? y : height - 1 - y) * width * px;
    for (let x = 0; x < width; x++) {
      const s = src + x * px, d = (y * width + x) * 4;
      rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = px === 4 ? raw[s + 3] : 255;
    }
  }
  return { width, height, rgba };
}

// Réduction par moyenne des pixels (128 -> 64 : 4 pixels pour 1)
function downscale(width, height, rgba, size) {
  if (width <= size && height <= size) return { width, height, rgba };
  const fx = width / size, fy = height / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      const sum = [0, 0, 0, 0];
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * width + xx) * 4;
          for (let c = 0; c < 4; c++) sum[c] += rgba[s + c];
        }
      }
      const count = (x1 - x0) * (y1 - y0);
      for (let c = 0; c < 4; c++) out[(y * size + x) * 4 + c] = Math.round(sum[c] / count);
    }
  }
  return { width: size, height: size, rgba: out };
}

// PNG : RGB si l'icône est opaque partout (plus léger), sinon RGBA
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePng({ width, height, rgba }) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const px = opaque ? 3 : 4;
  const raw = Buffer.alloc((width * px + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * px + 1);
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      for (let c = 0; c < px; c++) raw[row + 1 + x * px + c] = rgba[s + c];
    }
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { createIconStore, readTga, downscale, encodePng };
