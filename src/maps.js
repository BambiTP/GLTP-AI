// maps.js - finds a map and the settings GLTP plays it with.
//
// A map is named by:
//   - a group preset ("gZMefGzCgg...", or a ".../groups/create?preset=..." link): the map it picks
//     (downloaded like an id below), played with exactly the preset's settings
//   - a Fortunate Maps id ("88528"): maps/88528.png + .json, downloaded through your CORS proxy
//     the first time (see fetchMap), with its GLTP leaderboard preset's settings if it has one
//   - a practice map in maps/ written as text ("climb" -> maps/climb.txt, see fromText)
//   - a path to a map .png (its .json next to it)
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const tp = require('./tagpro');

const MAP_DIR = path.join(__dirname, '..', 'maps');
const FM = 'https://fortunatemaps.herokuapp.com';

// ---------- downloading ----------

// The proxy comes from --proxy, the FM_PROXY environment variable, or "proxy" in config.json, and by
// default is BamBall's Cloudflare Worker (worker/src/index.js in BambiTP/BamBall), which relays
// Fortunate Maps with CORS headers. In a proxy URL:
//   {id} and {kind} (png or json) are filled in: ".../api/fortunatemaps/{id}/{kind}"
//   {url} is replaced by the encoded Fortunate Maps URL: "https://proxy.example/?url={url}"
//   otherwise the Fortunate Maps URL is appended (encoded after "=", as is for prefix proxies)
const DEFAULT_PROXY = 'https://api.bamball.workers.dev/api/fortunatemaps/{id}/{kind}';

function proxyUrl(proxy, url) {
  if (!proxy) return url;
  const m = /\/(png|json)\/(\d+)$/.exec(url);
  if (m && (proxy.includes('{id}') || proxy.includes('{kind}'))) return proxy.replace('{id}', m[2]).replace('{kind}', m[1]);
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(url));
  if (proxy.endsWith('=')) return proxy + encodeURIComponent(url);
  return proxy + url;
}

function configuredProxy(cli) {
  if (cli) return cli;
  if (process.env.FM_PROXY) return process.env.FM_PROXY;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    if (c.proxy) return c.proxy;
  } catch (e) { /* no config.json */ }
  return DEFAULT_PROXY;
}

async function fetchMap(id, proxy) {
  id = String(id);
  if (!/^\d{1,9}$/.test(id)) throw new Error('not a Fortunate Maps id: ' + id);
  const png = path.join(MAP_DIR, id + '.png'), json = path.join(MAP_DIR, id + '.json');
  if (fs.existsSync(png) && fs.existsSync(json)) return false;
  const got = {};
  for (const ext of ['png', 'json']) {
    const url = proxyUrl(proxy, `${FM}/${ext}/${id}`);
    let r;
    try { r = await fetch(url, { signal: AbortSignal.timeout(30000) }); } catch (e) {
      throw new Error(`map ${id}: couldn't reach ${new URL(url).host} (${(e.cause && e.cause.message) || e.message})`);
    }
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
//   1-9 portals: the two tiles with the same digit send the ball to each other
//   o  a portal; "portal 3,6 > 20,6" sends the one at 3,6 to 20,6. A portal nothing is linked from
//      is exit-only (TagPro's grey portal)
//
// Optional settings go on lines starting with "set ", e.g. "set jumpLimit 3".
const TEXT_TILES = {
  '#': 1, '◣': 1.1, '◤': 1.2, '◥': 1.3, '◢': 1.4, '.': 2, ' ': 0,
  S: 2, B: 4, R: 3, Y: 16, E: 17, '*': 7, '+': 5, '!': 10, G: 22,
};

function fromText(text, name) {
  const settings = {}, links = [];
  const rows = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = /^set (\w+) (.+)$/.exec(line);
    if (m) { settings[m[1]] = JSON.parse(m[2]); continue; }
    const pm = /^portal (\d+),(\d+)\s*>\s*(\d+),(\d+)\s*$/.exec(line);
    if (pm) { links.push([+pm[1], +pm[2], +pm[3], +pm[4]]); continue; }
    if (line.trim()) rows.push([...line]);
  }
  const W = Math.max(...rows.map((r) => r.length)), H = rows.length;
  const tiles = [], red = [], pairs = {}, portals = {};
  for (let x = 0; x < W; x++) {
    tiles[x] = [];
    for (let y = 0; y < H; y++) {
      const ch = rows[y][x] ?? ' ';
      if (/[1-9]/.test(ch)) { tiles[x][y] = 13; (pairs[ch] = pairs[ch] || []).push({ x, y }); continue; }
      if (ch === 'o') { tiles[x][y] = 13; continue; }
      if (!(ch in TEXT_TILES)) throw new Error(`${name}: unknown map character "${ch}" at ${x},${y}`);
      tiles[x][y] = TEXT_TILES[ch];
      if (ch === 'S') red.push({ x, y, radius: 0, weight: 1 });
    }
  }
  for (const [d, ends] of Object.entries(pairs)) {
    if (ends.length !== 2) throw new Error(`${name}: portal ${d} needs exactly two ends (has ${ends.length})`);
    portals[ends[0].x + ',' + ends[0].y] = { destination: ends[1], cooldown: 0 };
    portals[ends[1].x + ',' + ends[1].y] = { destination: ends[0], cooldown: 0 };
  }
  for (const [x, y, dx, dy] of links) {
    if (!tiles[x] || tiles[x][y] !== 13) throw new Error(`${name}: portal ${x},${y} isn't a portal tile`);
    portals[x + ',' + y] = { destination: { x: dx, y: dy }, cooldown: 0 };
  }
  // portals with nowhere to go are exit-only: the real server sends them as "13.1"
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (tiles[x][y] === 13 && !portals[x + ',' + y]) tiles[x][y] = '13.1';
  return {
    map: {
      tiles, info: { name, author: 'GLTP-AI practice' }, switches: {}, fields: {}, portals,
      marsballs: [], spawnPoints: red.length ? { red } : {}, gravity: true,
    },
    settings,
  };
}

// ---------- presets ----------

// the preset in a preset code or a group link, or null
function presetOf(name) {
  let s = String(name || '').trim();
  try { s = decodeURIComponent(s); } catch (e) { /* not encoded */ }
  const m = /(?:^|[?&]preset=)(gZ[A-Za-z]+)\s*$/.exec(s);
  return m ? m[1] : null;
}

// the map a preset picks: { id } (Fortunate Maps) or { file } (one of tagpro-local's own maps)
function presetMap(preset) {
  const parsed = tp.presets.parse(preset);
  if (!parsed) throw new Error("that isn't a valid map preset");
  const m = parsed.map;
  if (!m || m === 'random') throw new Error("this preset doesn't pick a map (its map is random)");
  const fm = /^fm_id\/(\d+)$/.exec(m);
  if (fm) return { id: fm[1] };
  const dir = path.join(tp.ROOT, 'maps');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.json') || !fs.existsSync(path.join(dir, f.replace(/\.json$/, '.png')))) continue;
    try { if (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).info.name === m) return { file: path.join(dir, f.replace(/\.json$/, '.png')), name: m }; } catch (e) { /* skip */ }
  }
  throw new Error(`this preset's map "${m}" isn't a Fortunate Maps map GLTP-AI can load`);
}

// gets whatever a map name, id or preset needs (downloads), and returns the name to load it by
async function prepare(name, proxy) {
  name = String(name || '').trim();
  const preset = presetOf(name);
  if (preset) {
    const pm = presetMap(preset);
    if (pm.id) await fetchMap(pm.id, proxy);
    return preset;
  }
  if (/^\d+$/.test(name)) await fetchMap(name, proxy);
  return name;
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
const readPng = (file) => PNG.sync.read(tp.trimPng(fs.readFileSync(file)));

function loadLevel(name) {
  name = String(name).trim();
  let map, settings, info = null, key = name, slug = name, fromPreset = false;
  const preset = presetOf(name);
  if (preset) {
    const pm = presetMap(preset);
    if (pm.id) {
      const png = path.join(MAP_DIR, pm.id + '.png');
      if (!fs.existsSync(png)) throw new Error(`map ${pm.id} isn't downloaded yet: run "node cli.js fetch ${preset}"`);
      map = tp.loadMap(readPng(png), JSON.parse(fs.readFileSync(path.join(MAP_DIR, pm.id + '.json'), 'utf8')));
      info = gltpInfo(pm.id);
      slug = pm.id;
    } else {
      map = tp.loadMap(readPng(pm.file), JSON.parse(fs.readFileSync(pm.file.replace(/\.png$/, '.json'), 'utf8')));
      slug = pm.name;
    }
    key = preset;
    settings = groupSettings(preset); // exactly what the preset says, mode included
    fromPreset = true;
  } else if (/^\d+$/.test(name)) {
    const png = path.join(MAP_DIR, name + '.png');
    if (!fs.existsSync(png)) throw new Error(`map ${name} isn't downloaded yet: run "node cli.js fetch ${name}"`);
    map = tp.loadMap(readPng(png), JSON.parse(fs.readFileSync(path.join(MAP_DIR, name + '.json'), 'utf8')));
    info = gltpInfo(name);
    settings = groupSettings(info && info.preset);
  } else if (name.endsWith('.png')) {
    const json = name.replace(/\.png$/, '.json');
    map = tp.loadMap(readPng(name), fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : {});
    key = path.resolve(name);
    slug = path.basename(name, '.png');
    settings = groupSettings(null);
  } else {
    const file = fs.existsSync(name) ? name : path.join(MAP_DIR, name.replace(/\.txt$/, '') + '.txt');
    if (!fs.existsSync(file)) throw new Error(`no map called "${name}" (not an id, a .png or a practice map in maps/)`);
    const t = fromText(fs.readFileSync(file, 'utf8'), path.basename(file, '.txt'));
    map = t.map;
    key = fs.existsSync(name) ? path.resolve(name) : path.basename(file, '.txt');
    settings = Object.assign(groupSettings(null), t.settings);
  }
  // everything is played in gravity mode except the few GLTP maps listed as Classic (a preset says
  // its own mode)
  if (!fromPreset && !(info && info.grav_or_classic === 'Classic')) settings.mode = 'gravity';
  return {
    key, slug, preset: preset || (info && info.preset) || null,
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

module.exports = { loadLevel, prepare, presetOf, fetchMap, configuredProxy, proxyUrl, DEFAULT_PROXY, listGltp, practiceMaps, fromText, MAP_DIR };
