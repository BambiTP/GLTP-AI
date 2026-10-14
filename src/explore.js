// explore.js - Go-Explore, exploration first.
//
// The explorer remembers every distinct place the ball has reached (see placeKey in progress.js) with
// the fastest keys that get there. Over and over it picks a place, mostly ones it has picked least,
// replays the keys exactly, and presses random keys from there. New places join the memory; a faster
// way to a known place replaces the old one. Once a place is "done" (the map finished), the map is
// proven possible, and the explorer keeps finding faster ways for as long as it runs.
//
// With checkpoints, a run has to pass them in order. Most picks go to places past the furthest
// checkpoint reached, so it carries on from there; the rest go to earlier stages, which keep finding
// faster ways to each checkpoint ("cp:<n>" remembers the fastest arrival at checkpoint n).
//
// meta.focus (a checkpoint number, set from the page while it runs) sends every pick to places just
// past that checkpoint, before the next one, to work on that part of the route alone.
//
// With permadeath, a pop ends an exploration: nothing after it is remembered, so no route dies.
// Going into a red zone (level.redZones, tiles the creator marked) ends it the same way.
//
// A place's keys aren't stored whole: its "trail" is the keys from the place it was explored from,
// plus a link to that place's trail (see keysOf). Copying every route from spawn, 190k places used
// 1.4 GB and ran out of memory.
//
// Every core always has work: results are folded in as they arrive. A "generation" is just every
// `batch` explorations; that's when the run is saved and the page updates.
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const runs = require('./runs');
const { Sim, sliceKeys, keysPerTick, play, rng } = require('./sim');
const { Goal, placeKey } = require('./progress');

const SETTINGS = {
  ticks: 90,        // random keys for 1.5 s from each picked place
  hold: 6,          // a random key combination is held ~6 ticks
  pull: 1,          // places further along are picked up to (1 + pull) times as often: a light lean
  back: 0.25,       // with checkpoints, this share of picks goes to stages before the furthest one
  maxTicks: 3 * 60 * 60, // places reached after 3 minutes aren't explored from
  saveEvery: 60,    // seconds between saves of the memory (and on stop)
};

class Explorer {
  // run: a run's meta (runs.js); a run with a saved archive picks up where it left off.
  // level.checkpoints: the run's checkpoints, if any; level.permadeath: a pop ends a run
  constructor(meta, level) {
    this.meta = meta;
    this.level = level;
    this.goal = new Goal(level, new Sim(level).spawn);
    this.random = rng(Date.now() >>> 0);
    this.places = new Map();
    for (const p of readArchive(meta.id) || [{ key: 'start', trail: null, ticks: 0, progress: 0, x: 0, y: 0 }]) {
      this.places.set(p.key, Object.assign({ chosen: 0, found: -Infinity, stage: 0 }, p));
    }
    this.best = runs.read(meta.id, 'best.json');
    this.recent = [];   // the last generation's explorations (paths), for the page
    this.version = 0;   // bumps every generation, so the page knows when to refetch
    this.stopped = false;
  }

  async start() {
    const n = Math.max(1, os.availableParallelism ? os.availableParallelism() : os.cpus().length);
    this.workers = Array.from({ length: n }, () => new Worker(path.join(__dirname, 'worker.js'), { workerData: { level: this.level.key, checkpoints: this.level.checkpoints, permadeath: this.level.permadeath, redZones: this.level.redZones } }));
    this.batch = 8 * n;
    this.meta.status = 'running';
    runs.save(this.meta);
    this.batchResults = [];
    this.genStart = Date.now();
    this.lastSave = Date.now();
    await new Promise((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
      this.workers.forEach((w) => { w.on('error', reject); this.next(w); this.next(w); }); // two tasks queued per core
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.saveMemory();
    this.meta.status = 'stopped';
    runs.save(this.meta);
    for (const w of this.workers || []) w.terminate();
    if (this.finish) this.finish();
  }

  // give a worker its next exploration
  next(w) {
    if (this.stopped) return;
    const place = this.pick();
    place.chosen++;
    const trail = place.trail; // the place may get a faster trail before this one comes back
    const task = { prefix: keysOf(trail), ticks: SETTINGS.ticks, hold: SETTINGS.hold, seed: Math.floor(this.random() * 2 ** 31) };
    const id = Math.random();
    const onMessage = (msg) => {
      if (msg.id !== id) return;
      w.off('message', onMessage);
      if (this.stopped) return;
      if (msg.error) return this.fail(new Error(msg.error));
      this.learn(trail, msg.result);
      this.next(w);
    };
    w.on('message', onMessage);
    w.postMessage({ id, task });
  }

  // mostly the places picked least; newly found ones and ones further along a little more. The
  // weights are worked out once a generation (every place, every pick would starve the workers).
  pick() {
    if (!this.table || this.table.gen !== this.meta.gen) this.weigh();
    const { places, sums } = this.table;
    const r = this.random() * sums[sums.length - 1];
    let lo = 0, hi = sums.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sums[mid] < r) lo = mid + 1; else hi = mid; }
    return places[lo];
  }

  weigh() {
    let lo = Infinity, hi = -Infinity, top = 0;
    for (const p of this.places.values()) { lo = Math.min(lo, p.progress); hi = Math.max(hi, p.progress); top = Math.max(top, p.stage); }
    const span = hi - lo || 1, gen = this.meta.gen, places = [], weights = [], sums = [];
    // focused on a checkpoint it has reached: only that stage, all of it counted as "ahead"
    const focus = this.meta.focus != null && this.meta.focus <= top ? this.meta.focus : null;
    if (focus != null) top = focus;
    let ahead = 0, behind = 0; // total weight past the furthest checkpoint, and before it
    for (const p of this.places.values()) {
      if (p.key === 'done' || p.ticks >= SETTINGS.maxTicks) continue;
      if (focus != null && p.stage !== focus) continue;
      const f = (p.progress - lo) / span;
      const w = (1 / Math.sqrt(p.chosen + 1)) * (gen - p.found < 5 ? 2 : 1) * (1 + SETTINGS.pull * f * f);
      if (p.stage === top) ahead += w; else behind += w;
      places.push(p); weights.push(w);
    }
    // earlier stages get `back` of the picks between them, however many places they hold
    const scale = behind && ahead ? (SETTINGS.back / (1 - SETTINGS.back)) * (ahead / behind) : 1;
    let total = 0;
    places.forEach((p, i) => { total += p.stage === top ? weights[i] : weights[i] * scale; sums.push(total); });
    this.table = { gen, places, sums };
  }

  // focus on checkpoint n (null: back to normal); takes effect on the next pick
  focus(n) {
    this.meta.focus = n;
    this.table = null;
    runs.save(this.meta);
  }

  // fold one exploration (from the place at the end of `from`) into the memory
  learn(from, r) {
    for (const f of r.places) {
      const ticks = r.start + f.at, had = this.places.get(f.key);
      const better = !had || (f.key === 'done' ? f.finish < had.finish : ticks < had.ticks);
      if (!better) continue;
      const p = { key: f.key, trail: { up: from, keys: sliceKeys(r.keys, f.at) }, ticks, progress: f.progress, finish: f.finish, stage: f.stage, x: f.x, y: f.y };
      if (had) Object.assign(had, p); else this.places.set(f.key, Object.assign({ chosen: 0, found: this.meta.gen }, p));
    }
    this.meta.ticks += r.ticks;
    this.batchResults.push(r);
    if (this.batchResults.length >= this.batch) this.generation();
  }

  // every `batch` explorations: update the stats and the best run, save, tell the page
  generation() {
    const m = this.meta, done = this.places.get('done');
    let top = done;
    if (!top) for (const p of this.places.values()) if (!top || p.progress > top.progress || (p.progress === top.progress && p.ticks < top.ticks)) top = p;
    const key = done ? 'done:' + done.finish : 'top:' + top.key + ':' + top.ticks;
    if (!this.best || this.best.tag !== key) this.best = this.route(top, key);
    if (done && m.provenAt == null) m.provenAt = m.gen;
    if (done && done.finish !== m.time) { m.time = done.finish; m.fastestAt = m.gen; }
    m.splits = (this.level.checkpoints || []).map((c, i) => { const p = this.places.get('cp:' + (i + 1)); return p ? p.ticks : null; });
    m.cells = this.places.size;
    m.progress = this.goal.total ? Math.min(1, top.progress / this.goal.total) : 0;
    m.seconds += (Date.now() - this.genStart) / 1000;
    m.gen++;
    this.recent = this.batchResults.map((r) => r.path);
    this.batchResults = [];
    this.genStart = Date.now();
    runs.save(m);
    if (Date.now() - this.lastSave > SETTINGS.saveEvery * 1000) this.saveMemory();
    this.version++;
  }

  // the best place's keys, played again for the path the page draws
  route(place, tag) {
    const path = [];
    const keys = keysOf(place.trail);
    const sim = play(this.level, keys, {}, (s) => {
      if (s.tick % 4 === 0) { const b = s.ball(); path.push(b ? Math.round(b.x * 100) : -1, b ? Math.round(b.y * 100) : -1); }
    });
    const best = { tag, keys, ticks: place.ticks, finish: place.finish ?? null, path, grabs: sim.grabTicks, caps: sim.capTicks, checkpoints: sim.cpTicks };
    runs.write(this.meta.id, 'best.json', best);
    return best;
  }

  saveMemory() {
    this.lastSave = Date.now();
    writeArchive(this.meta.id, this.places.values());
    runs.write(this.meta.id, 'heat.json', this.heat());
  }

  // how many places it has found on each tile (W x H, row by row)
  heat() {
    const W = this.level.map.tiles.length, H = this.level.map.tiles[0].length, cells = new Array(W * H).fill(0);
    for (const p of this.places.values()) {
      const x = Math.round(p.x / 40), y = Math.round(p.y / 40);
      if (p.key !== 'start' && p.key !== 'done' && !p.key.startsWith('cp:') && x >= 0 && y >= 0 && x < W && y < H) cells[y * W + x]++;
    }
    return { W, H, cells };
  }
}

// a trail's keys, from spawn
function keysOf(trail) {
  const chain = [];
  for (let t = trail; t; t = t.up) chain.push(t.keys);
  let out = [];
  for (let i = chain.length - 1; i >= 0; i--) out = i === chain.length - 1 ? Array.from(chain[i]) : concatInto(out, chain[i]);
  return out;
}

function concatInto(out, b) {
  for (let i = 0; i < b.length; i += 2) {
    if (out.length && out[out.length - 2] === b[i]) out[out.length - 1] += b[i + 1];
    else out.push(b[i], b[i + 1]);
  }
  return out;
}

// archive.ndjson: the trails first, each after the one it links to ([id, up id or -1, ...keys]), then
// the places ({ key, trail: id, ... })
function writeArchive(id, places) {
  places = [...places];
  const ids = new Map(), trails = [];
  for (const p of places) {
    const chain = [];
    for (let t = p.trail; t && !ids.has(t); t = t.up) chain.push(t);
    for (let i = chain.length - 1; i >= 0; i--) { ids.set(chain[i], trails.length); trails.push(chain[i]); }
  }
  runs.writeLines(id, 'archive.ndjson', (function* () {
    for (let i = 0; i < trails.length; i++) yield [i, trails[i].up ? ids.get(trails[i].up) : -1, ...trails[i].keys];
    for (const { key, trail, ticks, progress, finish, stage, x, y } of places) yield { key, trail: trail ? ids.get(trail) : -1, ticks, progress, finish, stage, x, y };
  })());
  runs.remove(id, 'archive.json');
}

// the saved places, each with its trail (null if nothing is saved). An archive.json (older runs, and
// runs seeded by seedPlaces) holds whole keys: each becomes a trail of its own, in a typed array so
// a big old archive stays out of the JS heap.
function readArchive(id) {
  if (!runs.exists(id, 'archive.ndjson')) {
    const old = runs.read(id, 'archive.json');
    return old && old.map(({ keys, ...p }) => Object.assign(p, { trail: keys.length ? { up: null, keys: packed(keys) } : null }));
  }
  const trails = [], places = [];
  for (const line of runs.readLines(id, 'archive.ndjson')) {
    if (Array.isArray(line)) trails[line[0]] = { up: line[1] < 0 ? null : trails[line[1]], keys: packed(line.slice(2)) };
    else places.push(Object.assign(line, { trail: line.trail < 0 ? null : trails[line.trail] }));
  }
  return places;
}

// long key lists (whole routes from older archives) go in typed arrays, outside the JS heap
const packed = (keys) => (keys.length > 256 ? Uint32Array.from(keys) : keys);

// A new run's first memory: every place along `keys` (another run's best), played with this run's
// checkpoints (up to its first pop, with permadeath, or a red zone), so new settings don't throw away how far the
// old run got.
function seedPlaces(level, keys) {
  const sim = new Sim(level), goal = new Goal(level, sim.spawn), seen = new Set(), places = [];
  const keep = (key) => {
    const b = sim.ball();
    places.push({ key, keys: sliceKeys(keys, sim.tick), ticks: sim.tick, progress: goal.progress(sim), finish: goal.finishTick(sim), stage: sim.cpTicks.length, x: b ? Math.round(b.x * 100) : 0, y: b ? Math.round(b.y * 100) : 0 });
  };
  keep('start');
  for (const k of keysPerTick(keys)) {
    sim.setKeys(k);
    sim.step();
    if ((level.permadeath && sim.pops) || sim.redAt != null) break;
    const n = sim.cpTicks.length;
    if (n && sim.cpTicks[n - 1] === sim.tick) keep('cp:' + n);
    const key = placeKey(sim, goal);
    if (key && !seen.has(key)) { seen.add(key); keep(key); }
    if (goal.done(sim)) break;
  }
  return places;
}

module.exports = { Explorer, SETTINGS, seedPlaces, keysOf, readArchive };
