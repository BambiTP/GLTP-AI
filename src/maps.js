// maps.js - finds a map and the settings GLTP plays it with.
//
// A map is named by:
//   - a Fortunate Maps id ("88528"): maps/88528.png + .json, downloaded through your CORS proxy
//     the first time (see fetchMap)
//   - a practice map in maps/ written as text ("climb" -> maps/climb.txt, see fromText)
//   - a path to a map .png (its .json next to it)
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const tp = require('./tagpro');

const MAP_DIR = path.join(__dirname, '..', 'maps');
const FM = 'https://fortunatemaps.herokuapp.com';

// ---------- downloading ----------

// The proxy comes from --proxy, the FM_PROXY environment variable, or "proxy" in config.json.
// "{url}" in it is replaced by the encoded Fortunate Maps URL; without it the URL is appended
// (encoded after "=" like "...?url=", as is for prefix proxies like "https://proxy.example/").
function proxyUrl(proxy, url) {
  if (!proxy) return url;
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(url));
  if (proxy.endsWith('=')) return proxy + encodeURIComponent(url);
  return proxy + url;
}

function configuredProxy(cli) {
  if (cli) return cli;
  if (process.env.FM_PROXY) return process.env.FM_PROXY;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).proxy || null; } catch (e) { return null; }
}

async function fetchMap(id, proxy) {
  id = String(id);
  if (!/^\d{1,9}$/.test(id)) throw new Error('not a Fortunate Maps id: ' + id);
  const png = path.join(MAP_DIR, id + '.png'), json = path.join(MAP_DIR, id + '.json');
  if (fs.existsSync(png) && fs.existsSync(json)) return false;
  const got = {};
  for (const ext of ['png', 'json']) {
    const url = proxyUrl(proxy, `${FM}/${ext}/${id}`);
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`map ${id}: ${ext} download failed (HTTP ${r.status} from ${new URL(url).host})`);
    const body = Buffer.from(await r.arrayBuffer());
    if (ext === 'png' && body.toString('latin1', 1, 4) !== 'PNG') throw new Error(`map ${id}: the proxy didn't return a PNG (no such map?)`);
    if (ext === 'json') JSON.parse(body.toString('utf8'));
    got[ext] = body;
  }
  fs.mkdirSync(MAP_DIR, { recursive: true });
  fs.writeFileSync(json, got.json);
  fs.writeFileSync(png, got.png); // the png last: it marks the map as downloaded
  return true;
}

// ---------- practice maps written as text ----------
//
//   #  wall          .  floor          (space) nothing
//   ◣ ◤ ◥ ◢  45° walls (the solid half points that way)
//   S  red spawn     B  blue flag      R  red flag      Y  yellow flag    E  red endzone
//   *  spike         +  boost          !  bomb          G  gravity well
//
// Optional settings go on lines starting with "set ", e.g. "set jumpLimit 3".
const TEXT_TILES = {
  '#': 1, '◣': 1.1, '◤': 1.2, '◥': 1.3, '◢': 1.4, '.': 2, ' ': 0,
  S: 2, B: 4, R: 3, Y: 16, E: 17, '*': 7, '+': 5, '!': 10, G: 22,
};

function fromText(text, name) {
  const settings = {};
  const rows = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = /^set (\w+) (.+)$/.exec(line);
    if (m) { settings[m[1]] = JSON.parse(m[2]); continue; }
    if (line.trim()) rows.push([...line]);
  }
  const W = Math.max(...rows.map((r) => r.length)), H = rows.length;
  const tiles = [], red = [];
  for (let x = 0; x < W; x++) {
    tiles[x] = [];
    for (let y = 0; y < H; y++) {
      const ch = rows[y][x] ?? ' ';
      if (!(ch in TEXT_TILES)) throw new Error(`${name}: unknown map character "${ch}" at ${x},${y}`);
      tiles[x][y] = TEXT_TILES[ch];
      if (ch === 'S') red.push({ x, y, radius: 0, weight: 1 });
    }
  }
  return {
    map: {
      tiles, info: { name, author: 'GLTP-AI practice' }, switches: {}, fields: {}, portals: {},
      marsballs: [], spawnPoints: red.length ? { red } : {}, gravity: true,
    },
    settings,
  };
}

// ---------- levels ----------

function groupSettings(preset) {
  const s = Object.fromEntries(tp.groupDefaults.settings.map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const parsed = preset ? tp.presets.parse(preset) : null;
  if (parsed) tp.presets.apply(s, parsed);
  return s;
}

let meta = null;
function gltpInfo(id) {
  meta = meta || tp.gltpMetadata();
  if (meta[id]) return meta[id];
  return Object.values(meta).find((m) => (m.equivalent_map_ids || []).map(String).includes(String(id))) || null;
}

// A level: the map (tagpro-local's loaded form) plus the room settings to play it with.
function loadLevel(name) {
  name = String(name);
  let map, settings, info = null, key = name;
  if (/^\d+$/.test(name)) {
    const png = path.join(MAP_DIR, name + '.png');
    if (!fs.existsSync(png)) throw new Error(`map ${name} isn't downloaded yet: run "node cli.js fetch ${name}"`);
    map = tp.loadMap(PNG.sync.read(tp.trimPng(fs.readFileSync(png))), JSON.parse(fs.readFileSync(path.join(MAP_DIR, name + '.json'), 'utf8')));
    info = gltpInfo(name);
    settings = groupSettings(info && info.preset);
  } else if (name.endsWith('.png')) {
    const json = name.replace(/\.png$/, '.json');
    map = tp.loadMap(PNG.sync.read(tp.trimPng(fs.readFileSync(name))), fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : {});
    key = path.resolve(name);
    settings = groupSettings(null);
  } else {
    const file = fs.existsSync(name) ? name : path.join(MAP_DIR, name.replace(/\.txt$/, '') + '.txt');
    if (!fs.existsSync(file)) throw new Error(`no map called "${name}" (not an id, a .png or a practice map in maps/)`);
    const t = fromText(fs.readFileSync(file, 'utf8'), path.basename(file, '.txt'));
    map = t.map;
    key = fs.existsSync(name) ? path.resolve(name) : path.basename(file, '.txt');
    settings = Object.assign(groupSettings(null), t.settings);
  }
  // everything is played in gravity mode except the few GLTP maps listed as Classic
  if (!(info && info.grav_or_classic === 'Classic')) settings.mode = 'gravity';
  return {
    key,
    name: (info && info.map_name) || (map.info && map.info.name) || name,
    author: (info && info.author) || (map.info && map.info.author) || '',
    difficulty: info ? info.difficultyFinal : null,
    gltp: info,
    map,
    settings,
  };
}

// GLTP leaderboard maps: [{ id, name, author, difficulty, categories, balls, downloaded }]
function listGltp() {
  meta = meta || tp.gltpMetadata();
  return Object.values(meta).map((m) => ({
    id: m.map_id, name: m.map_name, author: m.author, difficulty: Number(m.difficultyFinal) || null,
    categories: m.categories, balls: m.balls_req, gravity: m.grav_or_classic === 'Grav',
    downloaded: fs.existsSync(path.join(MAP_DIR, m.map_id + '.png')),
  }));
}

function practiceMaps() {
  return fs.existsSync(MAP_DIR) ? fs.readdirSync(MAP_DIR).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)) : [];
}

module.exports = { loadLevel, fetchMap, configuredProxy, proxyUrl, listGltp, practiceMaps, fromText, MAP_DIR };
