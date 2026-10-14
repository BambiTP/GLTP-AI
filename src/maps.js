// maps.js - what you paste becomes a level: a map plus the settings it's played with.
//
//   a group preset (gZMef...) or a group link with ?preset=  ->  the preset's map, with exactly its settings
//   a Fortunate Maps id (88528)                              ->  that map, with its GLTP preset's settings
//   a .txt file (the tests' maps)                            ->  see fromText
//
// Fortunate Maps files are downloaded once into maps/ through a CORS proxy: BamBall's by default
// (api.bamball.workers.dev), or FM_PROXY / "proxy" in config.json. In the proxy URL, {id} and {kind}
// (png or json) are filled in, or {url} becomes the encoded Fortunate Maps URL.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const tp = require('./tagpro');

const MAP_DIR = path.join(__dirname, '..', 'maps');
const DEFAULT_PROXY = 'https://api.bamball.workers.dev/api/fortunatemaps/{id}/{kind}';

function proxy() {
  if (process.env.FM_PROXY) return process.env.FM_PROXY;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).proxy || DEFAULT_PROXY; } catch (e) { return DEFAULT_PROXY; }
}

function proxyUrl(template, id, kind) {
  const url = `https://fortunatemaps.herokuapp.com/${kind}/${id}`;
  if (template.includes('{id}')) return template.replace('{id}', id).replace('{kind}', kind);
  if (template.includes('{url}')) return template.replace('{url}', encodeURIComponent(url));
  return template + url;
}

async function download(id) {
  const png = path.join(MAP_DIR, id + '.png'), json = path.join(MAP_DIR, id + '.json');
  if (fs.existsSync(png) && fs.existsSync(json)) return;
  const got = {};
  for (const kind of ['png', 'json']) {
    const url = proxyUrl(proxy(), id, kind);
    let r;
    try { r = await fetch(url, { signal: AbortSignal.timeout(30000) }); } catch (e) {
      throw new Error(`couldn't reach ${new URL(url).host} to download map ${id} (${(e.cause && e.cause.message) || e.message})`);
    }
    if (!r.ok) throw new Error(`map ${id} not found (${new URL(url).host} said ${r.status})`);
    got[kind] = Buffer.from(await r.arrayBuffer());
  }
  if (got.png.toString('latin1', 1, 4) !== 'PNG') throw new Error(`map ${id} not found`);
  JSON.parse(got.json.toString('utf8'));
  fs.mkdirSync(MAP_DIR, { recursive: true });
  fs.writeFileSync(json, got.json);
  fs.writeFileSync(png, got.png); // the png last: it marks the map downloaded
}

// ---------- what was pasted ----------

function presetOf(code) {
  let s = String(code || '').trim();
  try { s = decodeURIComponent(s); } catch (e) { /* not encoded */ }
  const m = /(?:^|[?&]preset=)(gZ[A-Za-z]+)\s*$/.exec(s);
  return m ? m[1] : null;
}

let gltp = null;
function gltpInfo(id) {
  gltp = gltp || tp.gltpMetadata();
  return gltp[id] || Object.values(gltp).find((m) => (m.equivalent_map_ids || []).map(String).includes(String(id))) || null;
}

// { key (what to load it by), id (Fortunate Maps id), preset, file }
function resolve(code) {
  code = String(code || '').trim();
  const preset = presetOf(code);
  if (preset) {
    const parsed = tp.presets.parse(preset);
    if (!parsed) throw new Error("that isn't a valid map preset");
    const m = /^fm_id\/(\d+)$/.exec(parsed.map || '');
    if (m) return { key: preset, id: m[1], preset };
    if (!parsed.map || parsed.map === 'random') throw new Error("that preset doesn't pick a map (its map is random)");
    // a rotation map, by name: one of tagpro-local's own
    const dir = path.join(tp.ROOT, 'maps');
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try { if (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).info.name === parsed.map) return { key: preset, preset, file: path.join(dir, f.replace(/\.json$/, '.png')) }; } catch (e) { /* skip */ }
    }
    throw new Error(`can't load that preset's map ("${parsed.map}")`);
  }
  if (/^\d{1,9}$/.test(code)) {
    const info = gltpInfo(code);
    return { key: code, id: code, preset: info ? info.preset : null };
  }
  if (code.endsWith('.txt') && fs.existsSync(code)) return { key: path.resolve(code), file: path.resolve(code) };
  throw new Error('paste a map preset (gZ...), a group link with ?preset=, or a Fortunate Maps id');
}

// downloads what the code needs; returns the key to load the level by
async function prepare(code) {
  const r = resolve(code);
  if (r.id) await download(r.id);
  return r.key;
}

// ---------- levels ----------

function loadLevel(key) {
  const r = resolve(key);
  const settings = Object.fromEntries(tp.groupDefaults.settings.map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  let map, info = null;
  if (r.file && r.file.endsWith('.txt')) {
    map = fromText(fs.readFileSync(r.file, 'utf8'), path.basename(r.file, '.txt'));
  } else {
    const png = r.id ? path.join(MAP_DIR, r.id + '.png') : r.file;
    if (!fs.existsSync(png)) throw new Error(`map ${r.id} isn't downloaded yet`);
    map = tp.loadMap(PNG.sync.read(tp.trimPng(fs.readFileSync(png))), JSON.parse(fs.readFileSync(png.replace(/\.png$/, '.json'), 'utf8')));
    info = r.id ? gltpInfo(r.id) : null;
  }
  if (r.preset) tp.presets.apply(settings, tp.presets.parse(r.preset));
  // a pasted preset says its own mode; anything else is a gravity map unless GLTP lists it as classic
  if (!presetOf(key) && !(info && info.grav_or_classic === 'Classic')) settings.mode = 'gravity';
  return {
    key, id: r.id || null,
    name: (info && info.map_name) || (map.info && map.info.name) || String(key),
    author: (info && info.author) || (map.info && map.info.author) || '',
    caps: info && Number(info.caps_to_win) > 1 ? Number(info.caps_to_win) : 1, // caps to finish the map
    map, settings,
  };
}

// Text maps (the tests use them):
//   #  wall   .  floor   (space) nothing   ◣ ◤ ◥ ◢  45° walls (the solid half points that way)
//   S  red spawn   R  red flag   B  blue flag   Y  yellow flag   E  red endzone
//   *  spike   +  boost   !  bomb   1-9  portals: the two tiles with the same digit lead to each other
function fromText(text, name) {
  const TILES = { '#': 1, '◣': 1.1, '◤': 1.2, '◥': 1.3, '◢': 1.4, '.': 2, ' ': 0, S: 2, R: 3, B: 4, Y: 16, E: 17, '*': 7, '+': 5, '!': 10 };
  const rows = text.replace(/\r/g, '').split('\n').filter((l) => l.trim()).map((l) => [...l]);
  const W = Math.max(...rows.map((r) => r.length)), H = rows.length;
  const tiles = [], red = [], ends = {}, portals = {};
  for (let x = 0; x < W; x++) {
    tiles[x] = [];
    for (let y = 0; y < H; y++) {
      const ch = rows[y][x] ?? ' ';
      if (/[1-9]/.test(ch)) { tiles[x][y] = 13; (ends[ch] = ends[ch] || []).push({ x, y }); continue; }
      if (!(ch in TILES)) throw new Error(`${name}: unknown map character "${ch}" at ${x},${y}`);
      tiles[x][y] = TILES[ch];
      if (ch === 'S') red.push({ x, y, radius: 0, weight: 1 });
    }
  }
  for (const [d, [a, b]] of Object.entries(ends)) {
    if (!b) throw new Error(`${name}: portal ${d} needs two ends`);
    portals[a.x + ',' + a.y] = { destination: b, cooldown: 0 };
    portals[b.x + ',' + b.y] = { destination: a, cooldown: 0 };
  }
  return { tiles, info: { name, author: '' }, switches: {}, fields: {}, portals, marsballs: [], spawnPoints: red.length ? { red } : {} };
}

module.exports = { prepare, loadLevel, resolve, presetOf, proxyUrl, DEFAULT_PROXY };
