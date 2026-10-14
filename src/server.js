// server.js - the dashboard, plus the real TagPro client from tagpro-local for watching replays.
//
//   /                          draw a path on a map and let the bot loose (ui/index.html)
//   /dashboard                 every run and generation in detail (ui/dashboard.html)
//   /api/runs/<id>/route       the run's best route so far, replayed: { path, time, ... }
//   /api/runs                  every saved run
//   /api/runs/<id>             a run: settings, every generation's summary, the map
//   /api/runs/<id>/gens/<n>    one generation in full
//   /api/runs/<id>/replay/<n>  makes generation n's best run into a TagPro replay -> { url }
//   /api/events                live updates (server-sent events)
//   /api/level?map=<map>       a map, its settings and the plan runs on it would use
//   /api/plan                  PUT { map, steps, timeFrom } saves a map's plan, DELETE ?map= removes it
//   /api/train                 POST { map, algo, options, plan } starts training; /api/stop stops it
//   /game?replay=<key>         the real TagPro replay page (tagpro-local's), everything else it
//                              needs comes from tagpro-local's public/ folder
const fs = require('fs');
const http = require('http');
const path = require('path');
const tp = require('./tagpro');
const { Run } = require('./store');
const { loadLevel, fetchMap, configuredProxy, listGltp, practiceMaps } = require('./maps');
const { buildReplay } = require('./replay');
const { Plan, resolvePlan, savePlan, deletePlan, defaultSteps, stepsText } = require('./goals');
const { Sim, play } = require('./sim');

const UI = path.join(__dirname, '..', 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.ndjson': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// the texture pack tagpro-local shows by default
function defaultPack() {
  const packs = tp.texturePacks();
  return packs.find((p) => p.name === "Muscle's Cup Gradients") || packs[0];
}

class Dashboard {
  constructor({ port = 8080, host = '127.0.0.1', proxy } = {}) {
    this.port = port;
    this.host = host;
    this.proxy = proxy;
    this.clients = new Set();
    this.trainer = null;
    this.levels = new Map();
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) this.json(res, { error: e.message }, 500); else res.end();
    }));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(this.port, this.host, () => resolve(`http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}/`)));
  }

  close() { for (const c of this.clients) c.end(); return new Promise((r) => this.server.close(r)); }

  // ---------- live training ----------
  attach(trainer) {
    this.trainer = trainer;
    const send = (type, data) => this.broadcast({ type, run: trainer.run && trainer.run.id, ...data });
    trainer.on('start', (meta) => send('start', { meta }));
    trainer.on('progress', (p) => send('progress', p));
    trainer.on('generation', (summary) => send('generation', { summary, meta: trainer.run.meta }));
    trainer.on('end', (meta) => { send('end', { meta }); if (this.trainer === trainer) this.trainer = null; });
  }

  broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  level(key) {
    if (!this.levels.has(key)) this.levels.set(key, loadLevel(key));
    return this.levels.get(key);
  }

  // ---------- http ----------
  json(res, data, code = 200) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  file(res, f, extraHeaders = {}) {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', ...extraHeaders });
    fs.createReadStream(f).pipe(res);
  }

  // a path inside dir, or null if it would leave it
  inside(dir, rel) {
    const f = path.normalize(path.join(dir, decodeURIComponent(rel)));
    return f.startsWith(dir + path.sep) ? f : null;
  }

  async body(req) {
    let s = '';
    for await (const chunk of req) { s += chunk; if (s.length > 1e5) throw new Error('too big'); }
    return s ? JSON.parse(s) : {};
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let m;

    if (p === '/' || p === '/index.html') return this.file(res, path.join(UI, 'index.html'), { 'cache-control': 'no-store' });
    if (p === '/dashboard') return this.file(res, path.join(UI, 'dashboard.html'), { 'cache-control': 'no-store' });
    if (p.startsWith('/ui/')) { const f = this.inside(UI, p.slice(4)); return f ? this.file(res, f) : this.json(res, {}, 404); }
    if (p === '/src/inputs.js') return this.file(res, path.join(__dirname, 'inputs.js'));

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', live: this.trainer && this.trainer.run ? this.trainer.run.id : null })}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
      return;
    }
    if (p === '/api/runs') return this.json(res, { runs: Run.list(), live: this.trainer && this.trainer.run ? this.trainer.run.id : null });
    if (p === '/api/maps') {
      return this.json(res, {
        practice: practiceMaps(), gltp: listGltp(), proxy: new URL(configuredProxy(this.proxy).replace(/\{\w+\}/g, 'x')).host, pack: defaultPack(),
        defaults: { neat: require('./train-neat').DEFAULTS, explore: require('./train-explore').DEFAULTS },
      });
    }
    if ((m = /^\/api\/runs\/([\w-]+)$/.exec(p))) {
      const run = Run.open(m[1]);
      const level = this.level(run.meta.map.key);
      return this.json(res, {
        meta: run.meta, summaries: run.summaries(), map: this.mapInfo(level, run.meta.plan),
        live: !!(this.trainer && this.trainer.run && this.trainer.run.id === run.id),
      });
    }
    if (p === '/api/level') {
      const map = String(url.searchParams.get('map') || '');
      if (/^\d+$/.test(map)) await fetchMap(map, configuredProxy(this.proxy));
      this.levels.delete(map);
      return this.json(res, this.mapInfo(this.level(map), null));
    }
    if (p === '/api/plan' && req.method === 'PUT') {
      const b = await this.body(req);
      const level = this.level(String(b.map));
      savePlan(level, b);
      return this.json(res, this.mapInfo(level, null));
    }
    if (p === '/api/plan' && req.method === 'DELETE') {
      const level = this.level(String(url.searchParams.get('map')));
      deletePlan(level);
      return this.json(res, this.mapInfo(level, null));
    }
    if ((m = /^\/api\/runs\/([\w-]+)\/gens\/(\d+)$/.exec(p))) {
      const g = Run.open(m[1]).generation(m[2]);
      return g ? this.json(res, g) : this.json(res, { error: 'no such generation' }, 404);
    }
    if ((m = /^\/api\/runs\/([\w-]+)\/route$/.exec(p))) return this.json(res, this.route(m[1]));
    if ((m = /^\/api\/runs\/([\w-]+)\/replay\/(\d+)$/.exec(p))) {
      const ghosts = Math.max(0, Math.min(60, Number(url.searchParams.get('ghosts') ?? 30)));
      this.makeReplay(m[1], Number(m[2]), ghosts);
      return this.json(res, { url: `/game?replay=${m[1]}~${m[2]}~${ghosts}` });
    }
    if (p === '/api/train' && req.method === 'POST') return this.json(res, await this.train(await this.body(req)));
    if (p === '/api/stop' && req.method === 'POST') { if (this.trainer) this.trainer.stop(); return this.json(res, { ok: true }); }

    // ---- the real TagPro client ----
    if (p === '/music') { // the client asks for the music list; replays play without it
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`${String(url.searchParams.get('callback') || 'cb').replace(/[^\w$.]/g, '')}([])`);
    }
    if (p === '/game' && url.searchParams.get('replay')) return this.replayPage(res, url.searchParams.get('replay'));
    if (p === '/replays/gameFile') {
      const key = String(url.searchParams.get('key') || '');
      const k = /^([\w-]+)~(\d+)~(\d+)$/.exec(key);
      if (!k) { res.writeHead(404, { 'X-Replay-Error': 'Replay not found' }); return res.end('Replay not found'); }
      const f = this.makeReplay(k[1], Number(k[2]), Number(k[3]));
      return this.file(res, f, { 'X-Replay-Filename': `${k[1]} generation ${k[2]}` });
    }
    const f = this.inside(tp.PUBLIC, p.slice(1));
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return this.file(res, f, { 'cache-control': 'max-age=3600' });
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  // a map for the dashboard: tiles, spawn, settings, and a plan (the run's, else what a new run would
  // use) with where each step's target is and how long the plan is
  mapInfo(level, runPlan) {
    const sim = new Sim(level);
    const plan = runPlan || resolvePlan(level, null);
    const P = new Plan(level, plan.steps, sim.spawn, { timeFrom: plan.timeFrom });
    return {
      key: level.key, name: level.name, author: level.author, difficulty: level.difficulty,
      gltp: level.gltp ? { categories: level.gltp.categories, balls: level.gltp.balls_req, caps: level.gltp.caps_to_win } : null,
      tiles: level.map.tiles, spawn: sim.spawn, settings: { mode: level.settings.mode, jumpLimit: level.settings.jumpLimit },
      // where each team spawns (tiles; radius in tiles): the map's spawn points, or around its flag when it has none
      spawns: { red: sim.room.spawnTiles[1], blue: sim.room.spawnTiles[2] },
      plan: { steps: P.steps, timeFrom: plan.timeFrom, source: plan.source, text: stepsText(P.steps), total: P.total, seg: P.seg },
      gltpSteps: defaultSteps(level),
    };
  }

  // the run's best route so far (the fastest finish, else the furthest it got), played again for its
  // path; kept until the run finds a better one
  route(id) {
    const run = Run.open(id), m = run.meta;
    const src = m.fastest ? run.generation(m.fastest.gen).best : m.best;
    if (!src || !src.keys) return { path: null };
    const tag = `${id}/${m.fastest ? 'f' + m.fastest.gen : 'b' + m.best.gen}/${src.keys.length}`;
    this.routes = this.routes || new Map();
    if (!this.routes.has(tag)) {
      const level = this.level(m.map.key), path = [];
      const push = (sim) => { const b = sim.ball(); if (b) path.push(Math.round(b.x * 100), Math.round(b.y * 100)); else path.push(-1, -1); };
      const sim = play(level, src.keys, {}, (s) => { if (s.tick % 4 === 0) push(s); });
      this.routes.set(tag, { path, time: m.fastest ? m.fastest.time : null, finished: !!m.fastest, progress: m.best ? m.best.progress : 0, ticks: sim.tick, grabTick: sim.grabTick, capTick: sim.capTick, gen: m.fastest ? m.fastest.gen : m.best.gen });
    }
    return this.routes.get(tag);
  }

  // replays are made once and kept in the run's folder
  makeReplay(id, gen, ghosts) {
    const run = Run.open(id);
    const f = path.join(run.dir, 'replays', `${gen}-${ghosts}.ndjson`);
    if (fs.existsSync(f)) return f;
    const g = run.generation(gen);
    if (!g) throw new Error('no such generation');
    const level = this.level(run.meta.map.key);
    // ghosts: the generation's other runs, best first
    const order = g.runs.map((r, i) => i).filter((i) => g.algo !== 'neat' || i !== g.best.index)
      .sort((a, b) => (g.runs[b].fitness ?? g.runs[b].progress) - (g.runs[a].fitness ?? g.runs[a].progress)).slice(0, ghosts);
    const label = (r) => (r.time != null ? `done ${(r.time / 60).toFixed(2)}s` : `${Math.round(r.progress * 100)}%`);
    const out = buildReplay(level, g.best.keys, {
      name: `Gen ${gen} best`,
      ghosts: order.map((i, n) => ({ name: `#${n + 2} ${label(g.runs[i])}`, path: g.runs[i].path })),
    });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, out.text);
    return f;
  }

  replayPage(res, key) {
    let html = tp.pages().render('replay.html', { REPLAY_KEY: tp.pages().esc(String(key).slice(0, 80)) });
    const pack = defaultPack();
    const ids = { tiles: 'tiles', splats: 'splats', speedpad: 'speedpad', speedpadRed: 'speedpadred', speedpadBlue: 'speedpadblue', portal: 'portal', portalRed: 'portalred', portalBlue: 'portalblue' };
    for (const [k, id] of Object.entries(ids)) if (pack[k]) html = html.replace(new RegExp(`(<img id="${id}" src=")[^"]*(")`), `$1${pack[k]}$2`);
    // gravity maps: the client's gravity script, as on tagpro-local's game page
    const GG = '<script src="/R-62bb0909b74c-z/compact/global-game.js"></script>';
    html = html.replace(GG, GG + '\n        <script src="/R-62bb0909b74c-z/scripts/gravity.js"></script>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  async train({ map, algo, options = {}, plan = null }) {
    if (this.trainer) return { error: 'already training: stop it first' };
    if (!map) return { error: 'pick a map' };
    if (/^\d+$/.test(String(map))) await fetchMap(map, configuredProxy(this.proxy));
    this.levels.delete(String(map));
    const level = this.level(String(map));
    const opts = {};
    for (const [k, v] of Object.entries(options)) {
      if (typeof v === 'boolean') opts[k] = v;
      else if (v !== '' && v != null && Number.isFinite(Number(v))) opts[k] = Number(v);
    }
    if (plan && plan.steps) {
      opts.plan = { steps: plan.steps, timeFrom: plan.timeFrom ?? -1, source: plan.source || 'run' };
      if (Array.isArray(plan.drawn)) opts.plan.drawn = plan.drawn.slice(0, 50).map((st) => (Array.isArray(st) ? st.slice(0, 2000).map((q) => [Number(q[0]) || 0, Number(q[1]) || 0]) : []));
    }
    const Trainer = algo === 'explore' ? require('./train-explore').ExploreTrainer : require('./train-neat').NeatTrainer;
    const t = new Trainer(level, opts);
    this.attach(t);
    const started = new Promise((resolve, reject) => { t.once('start', resolve); t.once('end', () => reject(new Error(t.run ? t.run.meta.error : 'failed'))); });
    t.start().catch((e) => console.error('training stopped:', e.message));
    try { await started; } catch (e) { return { error: e.message }; }
    return { run: t.run.id };
  }
}

module.exports = { Dashboard };
