// server.js - the page, a small API it polls, and the real TagPro client (from tagpro-local) for
// watching runs.
//
//   GET  /                        the page (ui/)
//   GET  /api/runs                past runs, newest first, and which one is running
//   POST /api/map {code}          paste a preset: download its map, to place checkpoints before Go
//   POST /api/go {code, checkpoints, permadeath, redZones}  paste a preset: download its map, start exploring -> { id }
//   GET  /api/runs/<id>           a run's stats; with ?since=<version>, its view too if it changed
//   GET  /api/runs/<id>/map       the run's map tiles and spawn
//   POST /api/runs/<id>/continue  pick a past run up where it stopped
//   POST /api/runs/<id>/checkpoints {checkpoints, permadeath, redZones}  a new run on the same map with these,
//                                 starting from this run's best -> { id }
//   POST /api/runs/<id>/focus {checkpoint}  every pick from just past this checkpoint (null: normal)
//   POST /api/stop                stop the running run
//   GET  /api/runs/<id>/download  the best run as a TagPro replay file
//   GET  /game?replay=<id>        the best run in the real TagPro client
const fs = require('fs');
const http = require('http');
const path = require('path');
const tp = require('./tagpro');
const runs = require('./runs');
const { prepare, loadLevel } = require('./maps');
const { Explorer, seedPlaces } = require('./explore');
const { buildReplay } = require('./replay');
const { Sim } = require('./sim');

const UI = path.join(__dirname, '..', 'ui');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.ndjson': 'text/plain; charset=utf-8',
};

let explorer = null;   // the running run, if any
const levels = new Map();
const level = (key) => { if (!levels.has(key)) levels.set(key, loadLevel(key)); return levels.get(key); };
// a run's level: its map, with the run's checkpoints and whether death is permanent
const levelOf = (meta) => Object.assign({}, level(meta.code), { checkpoints: meta.checkpoints || [], permadeath: !!meta.permadeath, redZones: meta.redZones || [] });

// what the page sent, checked: in-bounds tiles, at most 20, the ones without the flag first (they come
// before the grab)
function checkpoints(list, L) {
  const W = L.map.tiles.length, H = L.map.tiles[0].length;
  if (!Array.isArray(list) || list.length > 20) throw new Error('up to 20 checkpoints');
  const out = list.map((c) => ({ x: Number(c && c.x), y: Number(c && c.y), flag: !!(c && c.flag) }));
  if (!out.every((c) => Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0 && c.x < W && c.y < H)) throw new Error('a checkpoint is off the map');
  return [...out.filter((c) => !c.flag), ...out.filter((c) => c.flag)];
}

// red zones the page sent: tiles on the map or up to 30 outside it (where a ball can fly off an open
// edge), each once
function redZones(list, L) {
  const M = 30;
  const W = L.map.tiles.length, H = L.map.tiles[0].length;
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 10000) throw new Error('up to 10000 red zone tiles');
  const seen = new Set(), out = [];
  for (const c of list) {
    const x = Number(c && c.x), y = Number(c && c.y);
    if (!(Number.isInteger(x) && Number.isInteger(y) && x >= -M && y >= -M && x < W + M && y < H + M)) throw new Error('a red zone is too far off the map');
    if (!seen.has(`${x},${y}`)) { seen.add(`${x},${y}`); out.push({ x, y }); }
  }
  return out;
}

// a run left "running" by a server that was closed is stopped
for (const m of runs.list()) if (m.status === 'running') { m.status = 'stopped'; runs.save(m); }

async function run(meta) {
  if (explorer) explorer.stop();
  const e = explorer = new Explorer(meta, levelOf(meta));
  e.start().catch((err) => { console.error('exploring stopped:', err.message); e.stop(); });
  return meta.id;
}

function view(id) {
  if (explorer && explorer.meta.id === id) {
    const e = explorer;
    if (!e.heatCache || e.heatCache.v !== e.version) e.heatCache = { v: e.version, heat: e.heat() };
    return { best: e.best, recent: e.recent, heat: e.heatCache.heat };
  }
  return { best: runs.read(id, 'best.json'), recent: [], heat: runs.read(id, 'heat.json') };
}

function mapInfo(L) {
  return { name: L.name, author: L.author, tiles: L.map.tiles, spawn: new Sim(L).spawn, settings: { jumpLimit: L.settings.jumpLimit, mode: L.settings.mode } };
}

const api = {
  'GET /api/runs': () => ({ runs: runs.list(), live: explorer && !explorer.stopped ? explorer.meta.id : null }),
  'POST /api/map': async (b) => mapInfo(level(await prepare(b.code))),
  'POST /api/go': async (b) => {
    const key = await prepare(b.code), L = level(key);
    return { id: await run(runs.create(L, key, checkpoints(b.checkpoints || [], L), !!b.permadeath, redZones(b.redZones, L))) };
  },
  'POST /api/stop': () => { if (explorer) explorer.stop(); return { ok: true }; },
  'GET /api/runs/:id': (b, id, q) => {
    const meta = runs.load(id);
    if (!meta) throw new Error('no such run');
    const live = !!(explorer && explorer.meta.id === id && !explorer.stopped);
    const version = live ? `${id}:${explorer.version}` : `${id}:${meta.updated}`;
    return { meta: live ? explorer.meta : meta, live, version, view: q.get('since') === version ? null : view(id) };
  },
  'GET /api/runs/:id/map': (b, id) => mapInfo(level(runs.load(id).code)),
  'POST /api/runs/:id/continue': async (b, id) => {
    const meta = runs.load(id);
    await prepare(meta.code);
    return { id: await run(meta) };
  },
  'POST /api/runs/:id/focus': (b, id) => {
    const meta = runs.load(id);
    if (!meta) throw new Error('no such run');
    const n = b.checkpoint == null ? null : Number(b.checkpoint);
    if (n != null && !(Number.isInteger(n) && n >= 1 && n <= (meta.checkpoints || []).length)) throw new Error('no such checkpoint');
    if (explorer && explorer.meta.id === id && !explorer.stopped) explorer.focus(n);
    else { meta.focus = n; runs.save(meta); }
    return { ok: true };
  },
  'POST /api/runs/:id/checkpoints': async (b, id) => {
    const old = runs.load(id);
    if (!old) throw new Error('no such run');
    await prepare(old.code);
    const L = level(old.code), meta = runs.create(L, old.code, checkpoints(b.checkpoints, L), b.permadeath ?? !!old.permadeath, redZones(b.redZones ?? old.redZones, L));
    const best = (explorer && explorer.meta.id === id && explorer.best) || runs.read(id, 'best.json');
    if (best) runs.write(meta.id, 'archive.json', seedPlaces(levelOf(meta), best.keys));
    return { id: await run(meta) };
  },
};

function replayFile(id) {
  const meta = runs.load(id), best = meta && runs.read(id, 'best.json');
  if (!best) throw new Error('nothing to replay yet');
  return buildReplay(level(meta.code), best.keys);
}

// the real TagPro replay page, from tagpro-local, with its default textures and the gravity script
function replayPage(id) {
  const pages = tp.pages();
  let html = pages.render('replay.html', { REPLAY_KEY: pages.esc(id) });
  const packs = tp.texturePacks(), pack = packs.find((p) => p.name === "Muscle's Cup Gradients") || packs[0];
  const ids = { tiles: 'tiles', splats: 'splats', speedpad: 'speedpad', speedpadRed: 'speedpadred', speedpadBlue: 'speedpadblue', portal: 'portal', portalRed: 'portalred', portalBlue: 'portalblue' };
  for (const [k, img] of Object.entries(ids)) if (pack[k]) html = html.replace(new RegExp(`(<img id="${img}" src=")[^"]*(")`), `$1${pack[k]}$2`);
  const game = '<script src="/R-62bb0909b74c-z/compact/global-game.js"></script>';
  return html.replace(game, game + '\n<script src="/R-62bb0909b74c-z/scripts/gravity.js"></script>');
}

function sendFile(res, file, headers = {}) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', ...headers });
  fs.createReadStream(file).pipe(res);
}

const inside = (dir, rel) => { const f = path.normalize(path.join(dir, decodeURIComponent(rel))); return f.startsWith(dir + path.sep) ? f : null; };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  const json = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    if (p === '/') return sendFile(res, path.join(UI, 'index.html'), { 'cache-control': 'no-store' });
    if (p.startsWith('/ui/')) return sendFile(res, inside(UI, p.slice(4)), { 'cache-control': 'no-store' });
    if (p.startsWith('/api/')) {
      const m = /^\/api\/runs\/([\w-]+)(\/\w+)?$/.exec(p);
      const route = `${req.method} ${m ? '/api/runs/:id' + (m[2] || '') : p}`;
      if (route === 'GET /api/runs/:id/download') {
        const meta = runs.load(m[1]);
        res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': `attachment; filename="${String(meta.map).replace(/[^\w .-]+/g, '_')} GLTP-AI${meta.time != null ? ' ' + (meta.time / 60).toFixed(2) + 's' : ''}.ndjson"` });
        return res.end(replayFile(m[1]));
      }
      if (!api[route]) return json({ error: 'not found' }, 404);
      let body = {};
      if (req.method === 'POST') { let s = ''; for await (const c of req) s += c; body = s ? JSON.parse(s) : {}; }
      return json(await api[route](body, m && m[1], url.searchParams));
    }
    // the real TagPro client
    if (p === '/game' && url.searchParams.get('replay')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(replayPage(url.searchParams.get('replay'))); }
    if (p === '/replays/gameFile') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(replayFile(url.searchParams.get('key'))); }
    if (p === '/music') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(`${String(url.searchParams.get('callback') || 'cb').replace(/[^\w$.]/g, '')}([])`); }
    return sendFile(res, inside(tp.PUBLIC, p.slice(1)), { 'cache-control': 'max-age=3600' });
  } catch (e) {
    if (!res.headersSent) json({ error: e.message }, 400); else res.end();
  }
}

function listen(port, host) {
  const server = http.createServer(handle);
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

module.exports = { listen };
