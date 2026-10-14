// explore.js - Go-Explore, exploration first.
//
// The explorer remembers every distinct place the ball has reached (see placeKey in worker.js) with
// the fastest keys that get there. Over and over it picks a place, mostly ones it has picked least,
// replays the keys exactly, and presses random keys from there. New places join the memory; a faster
// way to a known place replaces the old one. Once a place is "done" (the map finished), the map is
// proven possible, and the explorer keeps finding faster ways for as long as it runs.
//
// Every core always has work: results are folded in as they arrive. A "generation" is just every
// `batch` explorations; that's when the run is saved and the page updates.
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const runs = require('./runs');
const { Sim, sliceKeys, concatKeys, play, rng } = require('./sim');
const { Goal } = require('./progress');

const SETTINGS = {
  ticks: 90,        // random keys for 1.5 s from each picked place
  hold: 6,          // a random key combination is held ~6 ticks
  pull: 1,          // places further along are picked up to (1 + pull) times as often: a light lean
  maxTicks: 3 * 60 * 60, // places reached after 3 minutes aren't explored from
  saveEvery: 60,    // seconds between saves of the memory (and on stop)
};

class Explorer {
  // run: a run's meta (runs.js); a run with a saved archive picks up where it left off
  constructor(meta, level) {
    this.meta = meta;
    this.level = level;
    this.goal = new Goal(level, new Sim(level).spawn);
    this.random = rng(Date.now() >>> 0);
    this.places = new Map();
    for (const p of runs.read(meta.id, 'archive.json') || [{ key: 'start', keys: [], ticks: 0, progress: 0, x: 0, y: 0 }]) {
      this.places.set(p.key, Object.assign({ chosen: 0, found: -Infinity }, p));
    }
    this.best = runs.read(meta.id, 'best.json');
    this.recent = [];   // the last generation's explorations (paths), for the page
    this.version = 0;   // bumps every generation, so the page knows when to refetch
    this.stopped = false;
  }

  async start() {
    const n = Math.max(1, os.availableParallelism ? os.availableParallelism() : os.cpus().length);
    this.workers = Array.from({ length: n }, () => new Worker(path.join(__dirname, 'worker.js'), { workerData: { level: this.level.key } }));
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
    const task = { prefix: place.keys, ticks: SETTINGS.ticks, hold: SETTINGS.hold, seed: Math.floor(this.random() * 2 ** 31) };
    const id = Math.random();
    const onMessage = (msg) => {
      if (msg.id !== id) return;
      w.off('message', onMessage);
      if (this.stopped) return;
      if (msg.error) return this.fail(new Error(msg.error));
      this.learn(place, msg.result);
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
    let lo = Infinity, hi = -Infinity;
    for (const p of this.places.values()) { lo = Math.min(lo, p.progress); hi = Math.max(hi, p.progress); }
    const span = hi - lo || 1, gen = this.meta.gen, places = [], sums = [];
    let total = 0;
    for (const p of this.places.values()) {
      if (p.key === 'done' || p.ticks >= SETTINGS.maxTicks) continue;
      const f = (p.progress - lo) / span;
      total += (1 / Math.sqrt(p.chosen + 1)) * (gen - p.found < 5 ? 2 : 1) * (1 + SETTINGS.pull * f * f);
      places.push(p); sums.push(total);
    }
    this.table = { gen, places, sums };
  }

  // fold one exploration into the memory
  learn(from, r) {
    for (const f of r.places) {
      const ticks = r.start + f.at, had = this.places.get(f.key);
      const better = !had || (f.key === 'done' ? f.finish < had.finish : ticks < had.ticks);
      if (!better) continue;
      const p = { key: f.key, keys: concatKeys(from.keys, sliceKeys(r.keys, f.at)), ticks, progress: f.progress, finish: f.finish, x: f.x, y: f.y };
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
    const sim = play(this.level, place.keys, {}, (s) => {
      if (s.tick % 4 === 0) { const b = s.ball(); path.push(b ? Math.round(b.x * 100) : -1, b ? Math.round(b.y * 100) : -1); }
    });
    const best = { tag, keys: place.keys, ticks: place.ticks, finish: place.finish ?? null, path, grabs: sim.grabTicks, caps: sim.capTicks };
    runs.write(this.meta.id, 'best.json', best);
    return best;
  }

  saveMemory() {
    this.lastSave = Date.now();
    runs.write(this.meta.id, 'archive.json', [...this.places.values()].map(({ key, keys, ticks, progress, finish, x, y }) => ({ key, keys, ticks, progress, finish, x, y })));
    runs.write(this.meta.id, 'heat.json', this.heat());
  }

  // how many places it has found on each tile (W x H, row by row)
  heat() {
    const W = this.level.map.tiles.length, H = this.level.map.tiles[0].length, cells = new Array(W * H).fill(0);
    for (const p of this.places.values()) {
      const x = Math.round(p.x / 40), y = Math.round(p.y / 40);
      if (p.key !== 'start' && p.key !== 'done' && x >= 0 && y >= 0 && x < W && y < H) cells[y * W + x]++;
    }
    return { W, H, cells };
  }
}

module.exports = { Explorer, SETTINGS };
