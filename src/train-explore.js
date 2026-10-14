// train-explore.js - Go-Explore (Ecoffet et al., 2019): remember every distinct place the ball has
// been (a "cell"), keep the fastest keys that get there, then over and over pick a cell, replay its
// keys exactly, and press random keys from there. New cells join the archive; a faster way to a known
// cell replaces the old one. Once the plan is finished, the map is proven possible, and the archive
// keeps shortening that route for as long as it runs.
//
// Every batch of explorations is one "generation" on the dashboard.
const EventEmitter = require('events');
const { WorkerPool } = require('./pool');
const { Run } = require('./store');
const { Sim, sliceKeys, concatKeys, rng } = require('./sim');
const { Plan, resolvePlan, stepsText } = require('./goals');
const { cellKey } = require('./episodes');

const DEFAULTS = {
  exploreTicks: 90,   // random keys for 1.5 s from the chosen cell
  holdMean: 6,        // keys are held ~6 ticks on average before picking new ones
  batch: 0,           // explorations per generation (0 = 8 per worker)
  frontier: 4,        // how strongly picks favour cells further along the plan
  stall: 25,          // after this many generations without getting further (or faster), picks
                      // fade from "furthest along" to "least visited" over as many again: the walking
                      // distance can point the wrong way (portals, gates, climbs), curiosity can't
  maxTicks: 3 * 60 * 60, // cells reached after 3 minutes aren't explored from
  seed: 1,
  maxGens: Infinity,
  workers: 0,
  plan: null,         // { steps, timeFrom } (null: the map's saved plan, else its GLTP rules)
};

class ExploreTrainer extends EventEmitter {
  constructor(level, opts = {}) {
    super();
    this.level = level;
    this.cfg = Object.assign({}, DEFAULTS, opts);
    this.stopped = false;
  }

  async start() {
    const c = this.cfg;
    const planSpec = resolvePlan(this.level, c.plan);
    this.run = Run.create(this.level, 'explore', { ...c, plan: undefined, maxGens: Number.isFinite(c.maxGens) ? c.maxGens : null });
    this.run.meta.plan = { ...planSpec, text: stepsText(planSpec.steps) };
    this.run.save();
    this.workers = new WorkerPool({ level: this.level.key, plan: planSpec }, c.workers || undefined);
    this.batch = c.batch || this.workers.size * 8;
    this.random = rng(c.seed);
    const sim = new Sim(this.level);
    this.plan = new Plan(this.level, planSpec.steps, sim.spawn, { timeFrom: planSpec.timeFrom });
    this.archive = new Map();
    const state = this.plan.update(this.plan.start(), sim);
    const b = sim.ball();
    this.add({ key: cellKey(sim, state, false), keys: [], ticks: 0, progress: this.plan.progress(state, sim), x: Math.round(b.x * 100), y: Math.round(b.y * 100), flag: 0, step: state.step }, 0);
    this.gen = 0;
    this.lastGain = 0;      // the last generation that got further, or finished faster
    this.bestSeen = -Infinity;
    this.emit('start', this.run.meta);
    try {
      while (!this.stopped && this.gen < c.maxGens) await this.generation();
      this.run.meta.status = this.stopped ? 'stopped' : 'finished';
    } catch (e) {
      this.run.meta.status = 'crashed';
      this.run.meta.error = String(e.stack || e);
      throw e;
    } finally {
      this.run.save();
      await this.workers.close();
      this.emit('end', this.run.meta);
    }
  }

  stop() { this.stopped = true; }

  add(cell, gen) {
    this.archive.set(cell.key, Object.assign({ chosen: 0, seen: 1, found: gen }, cell));
  }

  // 0 while progress keeps coming; rises to 1 once it has stalled long enough (see DEFAULTS.stall)
  curiosity() {
    const k = this.cfg.stall, stalled = this.gen - this.lastGain;
    return k > 0 ? Math.max(0, Math.min(1, (stalled - k) / k)) : 0;
  }

  // weighted pick: cells picked less often, cells found lately, and (unless progress has stalled)
  // cells further along come up more
  choose(n) {
    const cells = [...this.archive.values()].filter((c) => c.key !== 'done' && c.ticks < this.cfg.maxTicks);
    let lo = Infinity, hi = -Infinity;
    for (const c of cells) { lo = Math.min(lo, c.progress); hi = Math.max(hi, c.progress); }
    const span = hi - lo || 1;
    const pull = this.cfg.frontier * (1 - this.curiosity());
    const w = cells.map((c) => {
      const p = (c.progress - lo) / span;
      const fresh = this.gen - c.found < 5 ? 2 : 1;
      return (1 / Math.sqrt(c.chosen + 1) + 0.5 / Math.sqrt(c.seen + 1)) * fresh * (0.1 + pull * p * p * p);
    });
    const total = w.reduce((a, b) => a + b, 0);
    const out = [];
    for (let k = 0; k < n; k++) {
      let r = this.random() * total, i = 0;
      while (i < w.length - 1 && (r -= w[i]) > 0) i++;
      out.push(cells[i]);
    }
    return out;
  }

  // Workers never wait for each other: every result is folded into the archive the moment it comes
  // in and the next exploration goes out right away. A generation is just every `batch` results.
  // (So a seed no longer pins down the exact run, but every route found still replays exactly.)
  fill() {
    const c = this.cfg;
    while (!this.stopped && this.inflight < this.workers.size * 2) {
      const [cell] = this.choose(1);
      cell.chosen++;
      this.inflight++;
      const task = { prefix: cell.keys, exploreTicks: c.exploreTicks, holdMean: c.holdMean, seed: Math.floor(this.random() * 2 ** 31) };
      this.workers.run('explore', task).then((r) => {
        this.inflight--;
        this.collect(cell, r);
        this.fill();
      }, (e) => { this.failed = e; if (this.wake) this.wake(); });
    }
  }

  collect(from, r) {
    const g = this.cur, total = this.plan.total || 1;
    g.ticks += r.ticks;
    let best = from.progress;
    for (const f of r.cells) {
      best = Math.max(best, f.progress);
      const at = r.start + f.at;
      const had = this.archive.get(f.key);
      // the finished cell is ranked by the plan's clock, every other cell by ticks from spawn
      const better = had && (f.key === 'done' ? f.time < had.time : at < had.ticks);
      if (had && !better) { had.seen++; continue; }
      const keys = concatKeys(from.keys, sliceKeys(r.explored, f.at));
      if (had) { had.seen++; Object.assign(had, { keys, ticks: at, time: f.time, progress: f.progress, x: f.x, y: f.y }); g.faster++; }
      else { this.add({ key: f.key, keys, ticks: at, time: f.time, progress: f.progress, x: f.x, y: f.y, flag: f.flag, step: f.step }, this.gen); g.added++; }
    }
    g.runs.push({
      from: from.key, start: r.start, ticks: r.ticks, progress: Math.max(0, best) / total, time: r.time,
      steps: r.steps, grabTick: r.grabTick, capTick: r.capTick, pops: r.pops, path: r.path,
    });
    if (g.runs.length % 8 === 0) this.emit('progress', { gen: this.gen, done: Math.min(g.runs.length, this.batch), of: this.batch });
    if (g.runs.length >= this.batch && this.wake) this.wake();
  }

  async generation() {
    const gen = this.gen, t0 = Date.now();
    if (!this.cur) { this.cur = { added: 0, faster: 0, ticks: 0, runs: [] }; this.inflight = 0; }
    this.fill();
    while (this.cur.runs.length < this.batch && !this.failed) await new Promise((res) => { this.wake = res; });
    this.wake = null;
    if (this.failed) throw this.failed;
    const { added, faster, ticks, runs } = this.cur;
    this.cur = { added: 0, faster: 0, ticks: 0, runs: [] };
    const total = this.plan.total || 1;

    const best = this.bestCell();
    const fin = this.archive.get('done');
    // getting further, or finishing faster, resets the stall clock
    const score = fin ? 1e6 - fin.time : best.progress;
    if (score > this.bestSeen + 1e-6) { this.bestSeen = score; this.lastGain = gen; }
    const summary = {
      gen, at: new Date().toISOString(), seconds: (Date.now() - t0) / 1000,
      cells: this.archive.size, added, faster,
      progress: Math.max(0, best.progress) / total, time: fin ? fin.time : null,
      steps: best.key === 'done' ? this.plan.steps.length : best.step,
      grabbed: [...this.archive.values()].some((x) => x.flag),
      stalled: gen - this.lastGain, curiosity: this.curiosity(),
      explorations: runs.length, ticks,
      best: Math.max(0, best.progress) / total, mean: runs.reduce((a, r) => a + r.progress, 0) / runs.length,
    };
    const detail = {
      gen, algo: 'explore', runs,
      best: { key: best.key, progress: summary.progress, ticks: best.ticks, time: fin ? fin.time : null, keys: best.keys },
      heat: this.heat(),
    };
    const m = this.run.meta;
    m.cells = this.archive.size;
    m.best = { gen, progress: summary.progress, time: summary.time, keys: best.keys, ticks: best.ticks };
    if (fin && !m.solved) m.solved = { gen, time: fin.time };
    if (fin && (!m.fastest || fin.time < m.fastest.time)) m.fastest = { gen, time: fin.time };
    this.run.addGeneration(summary, detail);
    this.emit('generation', summary);
    this.gen++;
  }

  // the finished cell if there is one, else the cell furthest along (fastest to get there on a tie)
  bestCell() {
    const fin = this.archive.get('done');
    if (fin) return fin;
    let best = null;
    for (const c of this.archive.values()) if (!best || c.progress > best.progress + 1e-9 || (Math.abs(c.progress - best.progress) <= 1e-9 && c.ticks < best.ticks)) best = c;
    return best;
  }

  // per tile: how many cells and the earliest tick any cell there was reached
  heat() {
    const W = this.level.map.tiles.length, H = this.level.map.tiles[0].length;
    const cells = new Array(W * H).fill(0), first = new Array(W * H).fill(-1);
    for (const c of this.archive.values()) {
      if (c.key === 'done') continue;
      const x = Math.round(c.x / 40), y = Math.round(c.y / 40);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      cells[i]++;
      if (first[i] < 0 || c.ticks < first[i]) first[i] = c.ticks;
    }
    return { W, H, cells, first };
  }
}

module.exports = { ExploreTrainer, DEFAULTS };
