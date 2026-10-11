// herramienta.ts
import fs from "node:fs";
import path from "node:path";
import crypto2 from "node:crypto";
import zlib from "node:zlib";

// ../voyporahi-web/src/routing/osmData.ts
var DETAILED_HIGHWAYS = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
  "living_street",
  "service",
  "track",
  "pedestrian",
  "footway",
  "path",
  "cycleway",
  "steps",
  "road",
  "bridleway"
];
var MAIN_HIGHWAYS = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link"
];
var FOOT_ONLY = /* @__PURE__ */ new Set(["pedestrian", "footway", "path", "cycleway", "steps", "bridleway"]);
var DRIVE_HIGHWAYS = DETAILED_HIGHWAYS.filter((h) => !FOOT_ONLY.has(h));
var KEEP_TAGS = [
  "highway",
  "name",
  "ref",
  "oneway",
  "junction",
  "maxspeed",
  "access",
  "foot",
  "bicycle",
  "motor_vehicle",
  "motorcar",
  "vehicle",
  "oneway:bicycle",
  "cycleway",
  "service",
  "motorroad",
  "area",
  "surface",
  "route",
  "duration",
  "tracktype",
  "smoothness",
  "4wd_only"
];
var TURN_NO = 0;
var TURN_ONLY = 8;
var TURN_DIR = /* @__PURE__ */ new Map([["left_turn", 1], ["right_turn", 2], ["straight_on", 3], ["u_turn", 4]]);
function carRestriction(tags) {
  if (!tags) return null;
  const specific = tags["restriction:motorcar"] ?? tags["restriction:motor_vehicle"] ?? tags["restriction:vehicle"];
  const v = specific ?? tags.restriction ?? timedRestriction(tags["restriction:conditional"]);
  if (!v) return null;
  if (specific == null && /(^|[;,\s])(motorcar|motor_vehicle|vehicle)($|[;,\s])/.test(tags.except ?? "")) return null;
  const m = /^(no|only)_(.+)$/.exec(v.trim());
  if (!m) return null;
  return (m[1] === "only" ? TURN_ONLY : TURN_NO) + (TURN_DIR.get(m[2]) ?? 0);
}
function timedRestriction(c) {
  const m = c ? /^\s*((?:no|only)_[a-z_]+)\s*@\s*\(?([^();]*)\)?\s*$/.exec(c) : null;
  if (!m) return void 0;
  const cond = m[2];
  const isTime = /\d{1,2}:\d{2}|\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b/.test(cond) && !/[<>=]|weight|height|length|width|hgv|bus|wheel|axle|trailer|occupants|destination|delivery/i.test(cond);
  return isTime ? m[1] : void 0;
}
function packRestrictions(elements, wayIds) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const r of elements) {
    if (r.type !== "relation" || r.tags?.type !== "restriction" || !r.members) continue;
    const code = carRestriction(r.tags);
    if (code == null) continue;
    const via = r.members.filter((m) => m.role === "via");
    if (via.length !== 1 || via[0].type !== "node") continue;
    const from = r.members.filter((m) => m.role === "from" && m.type === "way" && wayIds.has(m.ref)).map((m) => m.ref);
    const to = r.members.filter((m) => m.role === "to" && m.type === "way" && wayIds.has(m.ref)).map((m) => m.ref);
    if (!from.length || !to.length) continue;
    if (code >= TURN_ONLY && (from.length > 1 || to.length > 1)) continue;
    for (const f of from) for (const t of to) {
      const k = `${code}:${f}:${via[0].ref}:${t}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(code, f, via[0].ref, t);
    }
  }
  return Float64Array.from(out);
}
function packOverpass(json) {
  const ways = (json.elements ?? []).filter((e) => e.type === "way" && e.nodes && e.geometry && e.nodes.length === e.geometry.length && e.nodes.length >= 2);
  let total = 0;
  for (const w of ways) total += w.nodes.length;
  const wayStart = new Uint32Array(ways.length + 1);
  const wayTag = new Uint32Array(ways.length);
  const nodeIds = new Float64Array(total);
  const lats = new Float64Array(total);
  const lons = new Float64Array(total);
  const tagIndex = /* @__PURE__ */ new Map();
  const tagTable = [];
  let k = 0;
  ways.forEach((w, i) => {
    wayStart[i] = k;
    const t = {};
    for (const key of KEEP_TAGS) if (w.tags?.[key] != null) t[key] = w.tags[key];
    const s = JSON.stringify(t);
    let ti = tagIndex.get(s);
    if (ti == null) {
      ti = tagTable.length;
      tagTable.push(s);
      tagIndex.set(s, ti);
    }
    wayTag[i] = ti;
    for (let j = 0; j < w.nodes.length; j++) {
      const g = w.geometry[j];
      nodeIds[k] = w.nodes[j];
      lats[k] = g ? g.lat : NaN;
      lons[k] = g ? g.lon : NaN;
      k++;
    }
  });
  wayStart[ways.length] = k;
  const wayIds = Float64Array.from(ways, (w) => w.id);
  const restrictions = packRestrictions(json.elements ?? [], new Set(ways.map((w) => w.id)));
  return { wayCount: ways.length, wayStart, wayTag, nodeIds, lats, lons, tagTable, wayIds, restrictions };
}

// ../voyporahi-web/src/routing/cells.ts
var DETAIL_Z = 11;
var MAIN_Z = 8;
var DETAIL_MAX_Z = 13;
var MAIN_MAX_Z = 10;
var SPLIT_BYTES = 768 * 1024;
var MAGIC = [86, 80, 67, 1];
var SPLIT_MARK = Uint8Array.of(86, 80, 83, 1);
var isSplit = (b) => b.length === 4 && b[0] === 86 && b[1] === 80 && b[2] === 83 && b[3] === 1;
var isDetailZoom = (z) => z >= DETAIL_Z;
var maxZoomOf = (z) => isDetailZoom(z) ? DETAIL_MAX_Z : MAIN_MAX_Z;
var CellError = class extends Error {
};
var zz = (n) => n >= 0 ? n * 2 : -n * 2 - 1;
var unzz = (n) => n % 2 === 0 ? n / 2 : -(n + 1) / 2;
var Writer = class {
  buf = new Uint8Array(1 << 16);
  n = 0;
  byte(x) {
    if (this.n === this.buf.length) {
      const b = new Uint8Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.n++] = x;
  }
  u(v) {
    if (!Number.isSafeInteger(v) || v < 0) throw new CellError(`N\xFAmero fuera de rango: ${v}`);
    while (v >= 128) {
      this.byte(v % 128 | 128);
      v = Math.floor(v / 128);
    }
    this.byte(v);
  }
  s(v) {
    this.u(zz(v));
  }
  done() {
    return this.buf.slice(0, this.n);
  }
};
var Reader = class {
  constructor(b) {
    this.b = b;
  }
  i = 0;
  u() {
    let r = 0, mul = 1;
    for (let k = 0; k < 8; k++) {
      if (this.i >= this.b.length) throw new CellError("Celda de calles cortada.");
      const x = this.b[this.i++];
      r += (x & 127) * mul;
      if (!(x & 128)) return r;
      mul *= 128;
    }
    throw new CellError("Celda de calles da\xF1ada.");
  }
  s() {
    return unzz(this.u());
  }
  bytesOf(n) {
    if (this.i + n > this.b.length) throw new CellError("Celda de calles cortada.");
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
};
var E7 = 1e7;
function encodeCell(p) {
  if (!p.wayIds || p.wayIds.length !== p.wayCount) throw new CellError("Faltan los ids de las v\xEDas.");
  const w = new Writer();
  for (const m of MAGIC) w.byte(m);
  w.u(p.wayCount);
  w.u(p.tagTable.length);
  const enc = new TextEncoder();
  for (const t of p.tagTable) {
    const b = enc.encode(t);
    w.u(b.length);
    for (const x of b) w.byte(x);
  }
  for (let i = 0; i < p.wayCount; i++) w.u(p.wayTag[i]);
  for (let i = 0; i < p.wayCount; i++) w.u(p.wayStart[i + 1] - p.wayStart[i]);
  const total = p.wayStart[p.wayCount];
  let last = 0;
  for (let k = 0; k < total; k++) {
    w.s(p.nodeIds[k] - last);
    last = p.nodeIds[k];
  }
  for (const arr of [p.lats, p.lons]) {
    last = 0;
    for (let k = 0; k < total; k++) {
      if (!Number.isFinite(arr[k])) throw new CellError("Una v\xEDa sin coordenadas no puede ir en una celda.");
      const v = Math.round(arr[k] * E7);
      w.s(v - last);
      last = v;
    }
  }
  last = 0;
  for (let i = 0; i < p.wayCount; i++) {
    w.s(p.wayIds[i] - last);
    last = p.wayIds[i];
  }
  const r = p.restrictions ?? new Float64Array(0);
  w.u(r.length / 4);
  let pf = 0, pv = 0, pt = 0;
  for (let k = 0; k < r.length; k += 4) {
    w.u(r[k]);
    w.s(r[k + 1] - pf);
    w.s(r[k + 2] - pv);
    w.s(r[k + 3] - pt);
    pf = r[k + 1];
    pv = r[k + 2];
    pt = r[k + 3];
  }
  return w.done();
}
function decodeCell(b) {
  if (b.length < 4 || MAGIC.some((m, i) => b[i] !== m)) throw new CellError("No es una celda de calles de esta versi\xF3n.");
  const r = new Reader(b);
  r.i = 4;
  const wayCount = r.u();
  const tags = r.u();
  if (wayCount * 3 > b.length || tags > b.length) throw new CellError("Celda de calles da\xF1ada.");
  const dec = new TextDecoder();
  const tagTable = [];
  for (let i = 0; i < tags; i++) tagTable.push(dec.decode(r.bytesOf(r.u())));
  const wayTag = new Uint32Array(wayCount);
  for (let i = 0; i < wayCount; i++) {
    wayTag[i] = r.u();
    if (wayTag[i] >= tags) throw new CellError("Celda de calles da\xF1ada.");
  }
  const wayStart = new Uint32Array(wayCount + 1);
  for (let i = 0; i < wayCount; i++) wayStart[i + 1] = wayStart[i] + r.u();
  const total = wayStart[wayCount];
  if (total * 3 > b.length) throw new CellError("Celda de calles da\xF1ada.");
  const nodeIds = new Float64Array(total), lats = new Float64Array(total), lons = new Float64Array(total);
  let last = 0;
  for (let k = 0; k < total; k++) {
    last += r.s();
    nodeIds[k] = last;
  }
  last = 0;
  for (let k = 0; k < total; k++) {
    last += r.s();
    lats[k] = last / E7;
  }
  last = 0;
  for (let k = 0; k < total; k++) {
    last += r.s();
    lons[k] = last / E7;
  }
  const wayIds = new Float64Array(wayCount);
  last = 0;
  for (let i = 0; i < wayCount; i++) {
    last += r.s();
    wayIds[i] = last;
  }
  const nr = r.u();
  if (nr * 4 > b.length) throw new CellError("Celda de calles da\xF1ada.");
  const restrictions = new Float64Array(nr * 4);
  let pf = 0, pv = 0, pt = 0;
  for (let k = 0; k < nr * 4; k += 4) {
    restrictions[k] = r.u();
    pf += r.s();
    pv += r.s();
    pt += r.s();
    restrictions[k + 1] = pf;
    restrictions[k + 2] = pv;
    restrictions[k + 3] = pt;
  }
  return { wayCount, wayStart, wayTag, nodeIds, lats, lons, tagTable, wayIds, restrictions };
}

// ../voyporahi-web/src/lib/inflate.ts
var InflateTooBig = class extends Error {
  constructor(limit) {
    super(`El contenido comprimido supera el m\xE1ximo permitido (${limit} bytes).`);
    this.limit = limit;
  }
};
async function inflateLimited(data, format, maxBytes) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {
      });
      throw new InflateTooBig(maxBytes);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ../voyporahi-web/src/lib/pmtiles.ts
var PmtilesError = class extends Error {
};
var HEADER_BYTES = 127;
var FIRST_READ = 16384;
var TZ = [0];
for (let z = 1; z <= 27; z++) TZ.push(TZ[z - 1] + 4 ** (z - 1));
function zxyToTileId(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > 26) throw new PmtilesError(`Nivel de detalle fuera de rango: ${z}`);
  const n = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) throw new PmtilesError(`Tesela fuera de rango: ${z}/${x}/${y}`);
  let d = 0, px = x, py = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (px & s) > 0 ? 1 : 0, ry = (py & s) > 0 ? 1 : 0;
    d += s * s * (3 * rx ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        px = s - 1 - px;
        py = s - 1 - py;
      }
      const t = px;
      px = py;
      py = t;
    }
  }
  return TZ[z] + d;
}
function readVarint(buf, pos) {
  let result = 0, mul = 1;
  for (let k = 0; k < 8; k++) {
    if (pos.i >= buf.length) throw new PmtilesError("Directorio cortado.");
    const b = buf[pos.i++];
    result += (b & 127) * mul;
    if (!(b & 128)) return result;
    mul *= 128;
  }
  throw new PmtilesError("N\xFAmero demasiado largo en el directorio.");
}
function decodeDirectory(buf) {
  const pos = { i: 0 };
  const n = readVarint(buf, pos);
  if (n * 4 > buf.length - pos.i) throw new PmtilesError("Directorio da\xF1ado.");
  const ids = new Float64Array(n), runs = new Uint32Array(n), lengths = new Uint32Array(n), offsets = new Float64Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last += readVarint(buf, pos);
    ids[i] = last;
  }
  for (let i = 0; i < n; i++) runs[i] = readVarint(buf, pos);
  for (let i = 0; i < n; i++) lengths[i] = readVarint(buf, pos);
  for (let i = 0; i < n; i++) {
    const v = readVarint(buf, pos);
    if (v === 0 && i > 0) offsets[i] = offsets[i - 1] + lengths[i - 1];
    else offsets[i] = v - 1;
  }
  return { ids, runs, lengths, offsets };
}
function findEntry(d, id) {
  let lo = 0, hi = d.ids.length - 1;
  while (lo <= hi) {
    const k = lo + hi >> 1;
    if (id > d.ids[k]) lo = k + 1;
    else if (id < d.ids[k]) hi = k - 1;
    else return k;
  }
  if (hi >= 0 && (d.runs[hi] === 0 || id - d.ids[hi] < d.runs[hi])) return hi;
  return -1;
}
function decodeHeader(b) {
  if (b.length < HEADER_BYTES) throw new PmtilesError("El archivo es demasiado chico para ser un PMTiles.");
  if (String.fromCharCode(...b.subarray(0, 7)) !== "PMTiles") throw new PmtilesError("No es un archivo PMTiles.");
  if (b[7] !== 3) throw new PmtilesError(`Versi\xF3n de PMTiles no compatible: ${b[7]}.`);
  const v = new DataView(b.buffer, b.byteOffset, HEADER_BYTES);
  const u64 = (o) => {
    const x = v.getBigUint64(o, true);
    if (x > BigInt(Number.MAX_SAFE_INTEGER)) throw new PmtilesError("Encabezado da\xF1ado.");
    return Number(x);
  };
  const deg = (o) => v.getInt32(o, true) / 1e7;
  return {
    rootOffset: u64(8),
    rootLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafOffset: u64(40),
    leafLength: u64(48),
    dataOffset: u64(56),
    dataLength: u64(64),
    addressedTiles: u64(72),
    tileEntries: u64(80),
    tileContents: u64(88),
    clustered: b[96] === 1,
    internalCompression: b[97],
    tileCompression: b[98],
    tileType: b[99],
    minZoom: b[100],
    maxZoom: b[101],
    bounds: [deg(102), deg(106), deg(110), deg(114)],
    center: { zoom: b[118], lon: deg(119), lat: deg(123) }
  };
}
var PmtilesReader = class {
  constructor(src, o = {}) {
    this.src = src;
    this.maxTile = o.maxTileBytes ?? 8 * 1024 * 1024;
    this.maxDir = o.maxDirBytes ?? 32 * 1024 * 1024;
    this.dirCache = o.dirCache ?? 64;
  }
  first = null;
  leaves = /* @__PURE__ */ new Map();
  maxTile;
  maxDir;
  dirCache;
  async inflate(data, compression, max) {
    if (compression === 2) return inflateLimited(data, "gzip", max);
    if (compression === 0 || compression === 1) {
      if (data.length > max) throw new PmtilesError("Contenido m\xE1s grande que el m\xE1ximo permitido.");
      return data;
    }
    throw new PmtilesError(`Compresi\xF3n no compatible (${compression}).`);
  }
  async readExact(offset, length) {
    const b = await this.src.read(offset, length);
    if (b.length !== length) throw new PmtilesError("El archivo est\xE1 cortado.");
    return b;
  }
  start() {
    if (!this.first) {
      const p = (async () => {
        const b = await this.src.read(0, FIRST_READ);
        const header = decodeHeader(b);
        const { rootOffset: o, rootLength: l } = header;
        if (o + l > b.length) throw new PmtilesError(o + l > FIRST_READ ? "Directorio ra\xEDz fuera de lugar: el archivo est\xE1 da\xF1ado." : "El archivo est\xE1 cortado.");
        const root = decodeDirectory(await this.inflate(b.subarray(o, o + l), header.internalCompression, this.maxDir));
        return { header, root };
      })();
      p.catch(() => {
        if (this.first === p) this.first = null;
      });
      this.first = p;
    }
    return this.first;
  }
  async header() {
    return (await this.start()).header;
  }
  async metadata() {
    const { header: h } = await this.start();
    if (!h.metadataLength) return {};
    if (h.metadataLength > this.maxDir) throw new PmtilesError("Metadatos m\xE1s grandes que el m\xE1ximo permitido.");
    const raw = await this.readExact(h.metadataOffset, h.metadataLength);
    return JSON.parse(new TextDecoder().decode(await this.inflate(raw, h.internalCompression, this.maxDir)));
  }
  leaf(h, offset, length) {
    const key = h.leafOffset + offset;
    let p = this.leaves.get(key);
    if (p) {
      this.leaves.delete(key);
      this.leaves.set(key, p);
      return p;
    }
    if (length > this.maxDir) return Promise.reject(new PmtilesError("Directorio m\xE1s grande que el m\xE1ximo permitido."));
    p = this.readExact(h.leafOffset + offset, length).then((raw) => this.inflate(raw, h.internalCompression, this.maxDir)).then(decodeDirectory);
    p.catch(() => this.leaves.delete(key));
    this.leaves.set(key, p);
    while (this.leaves.size > this.dirCache) this.leaves.delete(this.leaves.keys().next().value);
    return p;
  }
  /** Bytes de la tesela tal como están guardados (comprimidos), o null si el archivo no la tiene. */
  async rawTile(z, x, y) {
    const { header: h, root } = await this.start();
    if (z < h.minZoom || z > h.maxZoom) return null;
    const id = zxyToTileId(z, x, y);
    let dir = root;
    for (let depth = 0; depth <= 3; depth++) {
      const k = findEntry(dir, id);
      if (k < 0) return null;
      if (dir.runs[k] > 0) {
        if (dir.lengths[k] > this.maxTile) throw new PmtilesError("Tesela m\xE1s grande que el m\xE1ximo permitido.");
        if (dir.offsets[k] + dir.lengths[k] > h.dataLength) throw new PmtilesError("Directorio da\xF1ado: la tesela sale del archivo.");
        return this.readExact(h.dataOffset + dir.offsets[k], dir.lengths[k]);
      }
      if (dir.offsets[k] + dir.lengths[k] > h.leafLength) throw new PmtilesError("Directorio da\xF1ado: la hoja sale del archivo.");
      dir = await this.leaf(h, dir.offsets[k], dir.lengths[k]);
    }
    throw new PmtilesError("Directorio da\xF1ado: demasiados niveles.");
  }
  /** La tesela descomprimida, o null si el archivo no la tiene. */
  async tile(z, x, y) {
    const raw = await this.rawTile(z, x, y);
    if (!raw) return null;
    return this.inflate(raw, (await this.header()).tileCompression, this.maxTile);
  }
};

// ../voyporahi-web/src/lib/tileVersions.ts
var DEFAULT_MAP_ORIGIN = "https://tiles.openfreemap.org";
var DEFAULT_STYLE_BASE = DEFAULT_MAP_ORIGIN + "/styles/";

// ../voyporahi-web/src/lib/countryPacks.ts
var CHUNK_BYTES = 8 * 1024 * 1024;
var MIN_CHUNK_BYTES = 64 * 1024;
var MAX_CHUNK_BYTES = 64 * 1024 * 1024;
var MAX_JSON_BYTES = 4 * 1024 * 1024;
var MAX_BYTES = 64 * 1024 ** 3;
function segmentHitsBox(x1, y1, x2, y2, b) {
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  const dx = x2 - x1, dy = y2 - y1;
  return clip(-dx, x1 - b.west) && clip(dx, b.east - x1) && clip(-dy, y1 - b.south) && clip(dy, b.north - y1);
}
function tileBBox(z, x, y) {
  const n = 2 ** z;
  const lat = (t) => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI;
  return { west: x / n * 360 - 180, east: (x + 1) / n * 360 - 180, north: lat(y), south: lat(y + 1) };
}
function simplifyRing(ring, tol, max) {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring : [...ring, ring[0]];
  for (let t = tol; ; t *= 2) {
    const keep = new Uint8Array(closed.length);
    keep[0] = keep[closed.length - 1] = 1;
    const stack = [[0, closed.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let far = -1, dmax = t;
      const [ax, ay] = closed[a], [bx, by] = closed[b];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = closed[i];
        const u = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
        const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
        if (d > dmax) {
          dmax = d;
          far = i;
        }
      }
      if (far >= 0) {
        keep[far] = 1;
        stack.push([a, far], [far, b]);
      }
    }
    const out = closed.filter((_, i) => keep[i]);
    if (out.length <= max || out.length <= 4) return out.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
  }
}

// ../voyporahi-web/src/routing/cellBuild.ts
var tileOf = (lat, lon, z) => {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n)));
  const y = Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)));
  return [x, y];
};
function wayTouches(w, z, x, y) {
  const b = tileBBox(z, x, y), g = w.geometry;
  for (let i = 0; i < g.length; i++) {
    const p = g[i];
    if (p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east) return true;
    if (i && segmentHitsBox(g[i - 1].lon, g[i - 1].lat, p.lon, p.lat, b)) return true;
  }
  return false;
}
function buildCell(z, x, y, ways, rels, splitAt, out) {
  const packed = packOverpass({ elements: [...ways, ...rels] });
  if (!packed.wayCount) return;
  const raw = encodeCell(packed);
  if (raw.length <= splitAt || z >= maxZoomOf(z)) {
    out({ z, x, y, data: raw, packed });
    return;
  }
  out({ z, x, y, data: SPLIT_MARK });
  const loc = /* @__PURE__ */ new Map();
  for (const w of ways) w.nodes.forEach((n, i) => loc.set(n, w.geometry[i]));
  for (const [cx, cy] of [[2 * x, 2 * y], [2 * x + 1, 2 * y], [2 * x, 2 * y + 1], [2 * x + 1, 2 * y + 1]]) {
    const rs = rels.filter((r) => {
      const v = r.members.find((m) => m.role === "via" && m.type === "node");
      const p = v && loc.get(v.ref);
      if (!p) return false;
      const [tx, ty] = tileOf(p.lat, p.lon, z + 1);
      return tx === cx && ty === cy;
    });
    buildCell(z + 1, cx, cy, ways.filter((w) => wayTouches(w, z + 1, cx, cy)), rs, splitAt, out);
  }
}

// ../voyporahi-web/src/lib/pmtilesWrite.ts
function pushVarint(out, v) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`N\xFAmero fuera de rango: ${v}`);
  while (v >= 128) {
    out.push(v % 128 | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}
function encodeDirectory(es) {
  const out = [];
  pushVarint(out, es.length);
  let last = 0;
  for (const e of es) {
    pushVarint(out, e.id - last);
    last = e.id;
  }
  for (const e of es) pushVarint(out, e.run);
  for (const e of es) pushVarint(out, e.length);
  es.forEach((e, i) => pushVarint(out, i > 0 && e.offset === es[i - 1].offset + es[i - 1].length ? 0 : e.offset + 1));
  return Uint8Array.from(out);
}
var PmtilesBuilder = class {
  constructor(o, onData) {
    this.o = o;
    this.onData = onData;
  }
  entries = [];
  size = 0;
  lastId = -1;
  /** Datos de las teselas, en orden (en memoria; para archivos grandes, guardarlos aparte con `onData`). */
  chunks = [];
  add(z, x, y, data) {
    const id = zxyToTileId(z, x, y);
    if (id <= this.lastId) throw new Error("Las teselas se agregan en orden de n\xFAmero de tesela, sin repetir.");
    this.lastId = id;
    this.entries.push({ id, run: 1, length: data.length, offset: this.size });
    this.size += data.length;
    if (this.onData) this.onData(data);
    else this.chunks.push(data);
  }
  get count() {
    return this.entries.length;
  }
  /** Directorio raíz (y hojas si no entra en 16 KB con el encabezado). */
  directories() {
    const g = this.o.gzip;
    const root = g(encodeDirectory(this.entries));
    if (HEADER_BYTES + root.length <= 16384) return { root, leaves: new Uint8Array(0) };
    for (let per = 4096; ; per *= 2) {
      const rootEntries = [];
      const parts = [];
      let off = 0;
      for (let i = 0; i < this.entries.length; i += per) {
        const leaf = g(encodeDirectory(this.entries.slice(i, i + per)));
        rootEntries.push({ id: this.entries[i].id, run: 0, length: leaf.length, offset: off });
        parts.push(leaf);
        off += leaf.length;
      }
      const r = g(encodeDirectory(rootEntries));
      if (HEADER_BYTES + r.length <= 16384) return { root: r, leaves: concat(parts) };
    }
  }
  finish() {
    const { root, leaves } = this.directories();
    const meta = this.o.gzip(new TextEncoder().encode(JSON.stringify(this.o.metadata)));
    const rootOffset = HEADER_BYTES, metaOffset = rootOffset + root.length, leafOffset = metaOffset + meta.length;
    const dataOffset = leafOffset + leaves.length;
    const h = new Uint8Array(HEADER_BYTES);
    const v = new DataView(h.buffer);
    h.set([..."PMTiles"].map((c) => c.charCodeAt(0)), 0);
    h[7] = 3;
    const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
    u64(8, rootOffset);
    u64(16, root.length);
    u64(24, metaOffset);
    u64(32, meta.length);
    u64(40, leafOffset);
    u64(48, leaves.length);
    u64(56, dataOffset);
    u64(64, this.size);
    u64(72, this.entries.length);
    u64(80, this.entries.length);
    u64(88, this.entries.length);
    h[96] = 1;
    h[97] = 2;
    h[98] = this.o.tileCompression;
    h[99] = this.o.tileType;
    h[100] = this.o.minZoom;
    h[101] = this.o.maxZoom;
    const e7 = (o, deg) => v.setInt32(o, Math.round(deg * 1e7), true);
    e7(102, this.o.bounds[0]);
    e7(106, this.o.bounds[1]);
    e7(110, this.o.bounds[2]);
    e7(114, this.o.bounds[3]);
    h[118] = this.o.center.zoom;
    e7(119, this.o.center.lon);
    e7(123, this.o.center.lat);
    const head = concat([h, root, meta, leaves]);
    return { head, data: this.chunks, bytes: head.length + this.size };
  }
};
function concat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// herramienta.ts
var [cmd, ...args] = process.argv.slice(2);
var opt = (name) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : void 0;
};
var die = (msg) => {
  console.error(msg);
  process.exit(1);
};
function fileSource(file) {
  const fd = fs.openSync(file, "r");
  return {
    async read(offset, length) {
      const b = Buffer.alloc(length);
      const n = fs.readSync(fd, b, 0, length, offset);
      return new Uint8Array(b.buffer, b.byteOffset, n);
    }
  };
}
function hashes(file, chunk) {
  const fd = fs.openSync(file, "r");
  const bytes = fs.fstatSync(fd).size;
  const all = crypto2.createHash("sha256");
  const trozos = [];
  const buf = Buffer.alloc(chunk);
  for (let off = 0; off < bytes; off += chunk) {
    const n = fs.readSync(fd, buf, 0, Math.min(chunk, bytes - off), off);
    const part = buf.subarray(0, n);
    all.update(part);
    trozos.push(crypto2.createHash("sha256").update(part).digest("hex"));
  }
  fs.closeSync(fd);
  return { bytes, sha256: all.digest("hex"), trozos };
}
function readPoly(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim());
  const rings = [];
  let cur = null, hole = false;
  for (const l of lines.slice(1)) {
    if (!l) continue;
    if (l === "END") {
      if (cur && !hole && cur.length >= 3) rings.push(cur);
      cur = null;
      continue;
    }
    if (!cur) {
      cur = [];
      hole = l.startsWith("!");
      continue;
    }
    const [lon, lat] = l.split(/\s+/).map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat)) cur.push([lon, lat]);
  }
  return rings;
}
async function calles(dbFile, outFile) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const splitAt = Number(opt("dividir") ?? SPLIT_BYTES);
  if (!Number.isInteger(splitAt) || splitAt < 1024) die("--dividir: bytes (1024 o m\xE1s)");
  const info = Object.fromEntries(db.prepare("SELECT k, v FROM info").all().map((r) => [r.k, JSON.parse(r.v)]));
  const tops = db.prepare("SELECT DISTINCT z, x, y FROM ways").all();
  const qWays = db.prepare("SELECT json FROM ways WHERE z = ? AND x = ? AND y = ?");
  const qRestr = db.prepare("SELECT json FROM restr WHERE z = ? AND x = ? AND y = ?");
  const gzip = (x) => zlib.gzipSync(x, { level: 9 });
  const cellsFile = outFile + ".celdas";
  const fd = fs.openSync(cellsFile, "w");
  const entries = [];
  let off = 0;
  const put = (z, x, y, data2) => {
    fs.writeSync(fd, data2);
    entries.push({ z, x, y, id: zxyToTileId(z, x, y), off, len: data2.length });
    off += data2.length;
  };
  const wayIds = /* @__PURE__ */ new Set(), giros = /* @__PURE__ */ new Set();
  let maxCell = 0, maxRaw = 0, ways = 0, splits = 0, data = 0;
  for (const [i, c] of tops.entries()) {
    const cw = qWays.all(c.z, c.x, c.y).map((r) => JSON.parse(r.json));
    const cr = qRestr.all(c.z, c.x, c.y).map((r) => JSON.parse(r.json));
    buildCell(c.z, c.x, c.y, cw, cr, splitAt, (cell) => {
      const gz = gzip(cell.data);
      put(cell.z, cell.x, cell.y, gz);
      if (!cell.packed) {
        splits++;
        return;
      }
      data++;
      maxCell = Math.max(maxCell, gz.length);
      maxRaw = Math.max(maxRaw, cell.data.length);
      if (isDetailZoom(cell.z)) {
        ways += cell.packed.wayCount;
        for (const id of cell.packed.wayIds) wayIds.add(id);
        const r = cell.packed.restrictions;
        for (let k = 0; k < r.length; k += 4) giros.add(`${r[k]}:${r[k + 1]}:${r[k + 2]}:${r[k + 3]}`);
      }
    });
    if (i % 500 === 499) process.stderr.write(`  ${i + 1} de ${tops.length} celdas
`);
  }
  fs.closeSync(fd);
  const metadata = {
    tipo: "voyporahi-calles",
    formato: 1,
    zoomDetalle: DETAIL_Z,
    zoomPrincipal: MAIN_Z,
    zoomDetalleMax: DETAIL_MAX_Z,
    zoomPrincipalMax: MAIN_MAX_Z,
    dividir: splitAt,
    vias: wayIds.size,
    giros: giros.size,
    centro: info.centro,
    atribucion: "\xA9 colaboradores de OpenStreetMap",
    licencia: "ODbL-1.0"
  };
  const tmp = outFile + ".datos";
  const out1 = fs.openSync(tmp, "w");
  const b = new PmtilesBuilder({
    tileType: 0,
    tileCompression: 2,
    minZoom: MAIN_Z,
    maxZoom: DETAIL_MAX_Z,
    bounds: info.bbox,
    center: { lon: info.centro[0], lat: info.centro[1], zoom: DETAIL_Z },
    metadata,
    gzip
  }, (d) => fs.writeSync(out1, d));
  entries.sort((p, q) => p.id - q.id);
  const cin = fs.openSync(cellsFile, "r");
  for (const e of entries) {
    const buf2 = Buffer.alloc(e.len);
    if (fs.readSync(cin, buf2, 0, e.len, e.off) !== e.len) die("No se pudo releer una celda");
    b.add(e.z, e.x, e.y, buf2);
  }
  fs.closeSync(cin);
  fs.closeSync(out1);
  fs.rmSync(cellsFile);
  const { head, bytes } = b.finish();
  const out = fs.openSync(outFile, "w");
  fs.writeSync(out, head);
  const dataFd = fs.openSync(tmp, "r");
  const buf = Buffer.alloc(8 << 20);
  for (let n; (n = fs.readSync(dataFd, buf, 0, buf.length, null)) > 0; ) fs.writeSync(out, buf.subarray(0, n));
  fs.closeSync(dataFd);
  fs.closeSync(out);
  fs.rmSync(tmp);
  console.log(JSON.stringify({ celdas: data, divididas: splits, bytes, celdaMaxGzip: maxCell, celdaMaxSinComprimir: maxRaw, viasConRepetidas: ways, vias: metadata.vias, giros: metadata.giros, extraccion: info }));
}
async function dataDate(mapa) {
  const meta = await new PmtilesReader(fileSource(mapa)).metadata();
  const raw = String(meta["planetiler:osm:osmosisreplicationtime"] ?? "");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw) && !raw.startsWith("1970-") ? raw : null;
}
async function manifiesto(dir) {
  const id = opt("id") ?? die("Falta --id"), nombre = opt("nombre") ?? die("Falta --nombre");
  if (!/^[a-z0-9-]{2,32}$/.test(id)) die("--id: letras min\xFAsculas, n\xFAmeros y guiones");
  const mapa = path.join(dir, "mapa.pmtiles"), callesF = path.join(dir, "calles.pmtiles");
  const mr = new PmtilesReader(fileSource(mapa)), h = await mr.header();
  const meta = await mr.metadata();
  const cr = fs.existsSync(callesF) ? new PmtilesReader(fileSource(callesF)) : null;
  const cmeta = cr ? await cr.metadata() : null;
  const when = opt("datos") ?? await dataDate(mapa) ?? die("Falta --datos: el extracto no trae la fecha de los datos");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(when)) die("--datos: AAAA-MM-DDTHH:MM:SSZ");
  const version = opt("version") ?? when.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) die("--version: AAAA-MM-DD");
  const poly = opt("poly");
  const [w, s, e, n] = h.bounds;
  const rings = poly ? readPoly(poly).map((r) => simplifyRing(r, 2e-3, 1500)) : [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
  const centro = cmeta?.centro ?? [h.center.lon, h.center.lat];
  const trozo = Number(opt("trozo") ?? CHUNK_BYTES);
  if (!Number.isInteger(trozo) || trozo < MIN_CHUNK_BYTES || trozo > MAX_CHUNK_BYTES) die(`--trozo: entre ${MIN_CHUNK_BYTES} y ${MAX_CHUNK_BYTES} bytes`);
  const file = (tipo, f) => ({ tipo, nombre: path.basename(f), trozo, ...hashes(f, trozo) });
  const m = {
    formato: 1,
    id,
    nombre,
    version,
    datos: when,
    bbox: [w, s, e, n],
    centro: [+centro[0].toFixed(6), +centro[1].toFixed(6)],
    area: rings,
    archivos: [file("mapa", mapa), ...cr ? [file("calles", callesF)] : []],
    esquema: { nombre: "openmaptiles", version: String(meta.version ?? ""), minzoom: h.minZoom, maxzoom: h.maxZoom },
    atribucion: "\xA9 OpenMapTiles \xA9 colaboradores de OpenStreetMap",
    licencia: "ODbL-1.0",
    fuente: opt("fuente") ?? "OpenStreetMap"
  };
  fs.writeFileSync(path.join(dir, "manifiesto.json"), JSON.stringify(m, null, 1));
  console.log(`${dir}/manifiesto.json: ${m.archivos.map((a) => `${a.nombre} ${(a.bytes / 1e6).toFixed(1)} MB en ${a.trozos.length} trozos`).join(", ")}`);
}
function catalogo(root) {
  const out = { formato: 1, paises: [] };
  for (const id of fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort()) {
    const versions = fs.readdirSync(path.join(root, id)).filter((v) => fs.existsSync(path.join(root, id, v, "manifiesto.json"))).sort();
    const last = versions.at(-1);
    if (!last) continue;
    const m = JSON.parse(fs.readFileSync(path.join(root, id, last, "manifiesto.json"), "utf8"));
    out.paises.push({ id: m.id, nombre: m.nombre, version: m.version, bytes: m.archivos.reduce((a, f) => a + f.bytes, 0), manifiesto: `${id}/${last}/manifiesto.json` });
  }
  fs.writeFileSync(path.join(root, "catalogo.json"), JSON.stringify(out, null, 1));
  console.log(`${root}/catalogo.json: ${out.paises.map((p) => `${p.nombre} ${p.version}`).join(", ")}`);
}
async function verificar(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifiesto.json"), "utf8"));
  let bad = 0;
  for (const f of m.archivos) {
    const h = hashes(path.join(dir, f.nombre), f.trozo);
    const ok = h.bytes === f.bytes && h.sha256 === f.sha256 && h.trozos.every((t, i) => t === f.trozos[i]);
    console.log(`${ok ? "OK   " : "FALLA"} ${f.nombre}: tama\xF1o y sumas`);
    if (!ok) bad++;
  }
  const cf = path.join(dir, "calles.pmtiles");
  if (fs.existsSync(cf)) {
    const r = new PmtilesReader(fileSource(cf));
    const h = await r.header();
    let cells = 0, ways = 0, splits = 0;
    const walk = async (z, x, y) => {
      const t = await r.tile(z, x, y);
      if (!t) return;
      if (isSplit(t)) {
        if (z >= maxZoomOf(z)) die(`FALLA calles.pmtiles: celda ${z}/${x}/${y} dividida m\xE1s all\xE1 del zoom ${maxZoomOf(z)}`);
        splits++;
        for (const [cx, cy] of [[2 * x, 2 * y], [2 * x + 1, 2 * y], [2 * x, 2 * y + 1], [2 * x + 1, 2 * y + 1]]) await walk(z + 1, cx, cy);
        return;
      }
      const p = decodeCell(t);
      cells++;
      ways += p.wayCount;
    };
    for (const z of [MAIN_Z, DETAIL_Z]) {
      const [x0, y0] = tileOf(h.bounds[3], h.bounds[0], z), [x1, y1] = tileOf(h.bounds[1], h.bounds[2], z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) await walk(z, x, y);
    }
    console.log(`OK    calles.pmtiles: ${cells} celdas (${splits} divididas), ${ways} v\xEDas (con repetidas entre celdas)`);
  }
  process.exit(bad ? 1 : 0);
}
if (cmd === "listas") fs.writeFileSync(args[0], JSON.stringify({ detalle: DETAILED_HIGHWAYS, principal: MAIN_HIGHWAYS, zoomDetalle: DETAIL_Z, zoomPrincipal: MAIN_Z }));
else if (cmd === "calles") await calles(args[0], args[1]);
else if (cmd === "manifiesto") await manifiesto(args[0]);
else if (cmd === "fecha") {
  const d = await dataDate(args[0]);
  if (!d) die("El mapa no trae la fecha de los datos");
  console.log(d.slice(0, 10));
} else if (cmd === "catalogo") catalogo(args[0]);
else if (cmd === "verificar") await verificar(args[0]);
else die("Uso: herramienta.mjs listas|calles|manifiesto|fecha|catalogo|verificar \u2026");
