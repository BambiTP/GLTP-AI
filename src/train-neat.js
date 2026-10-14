// train-neat.js - MarI/O-style training: a population of networks plays the map, the best breed.
const EventEmitter = require('events');
const { Pool, packGenome } = require('./neat');
const { WorkerPool } = require('./pool');
const { Run } = require('./store');
const inputs = require('./inputs');
const { resolvePlan, stepsText } = require('./goals');

const DEFAULTS = {
  population: 300,
  maxTicks: 60 * 60,  // a run is cut off after a minute
  patience: 3 * 60,   // ... or after 3 s without getting further
  thinkEvery: 2,      // the network picks keys every 2 ticks (MarI/O: every 5 frames)
  endOnPop: true,     // popping ends the run
  seed: 1,
  maxGens: Infinity,
  workers: 0,         // 0 = one per CPU
  plan: null,         // { steps, timeFrom } (null: the map's saved plan, else its GLTP rules)
};

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

class NeatTrainer extends EventEmitter {
  constructor(level, opts = {}) {
    super();
    this.level = level;
    this.cfg = Object.assign({}, DEFAULTS, opts);
    this.stopped = false;
  }

  async start() {
    const c = this.cfg;
    const plan = resolvePlan(this.level, c.plan);
    this.run = Run.create(this.level, 'neat', { ...c, plan: undefined, maxGens: Number.isFinite(c.maxGens) ? c.maxGens : null, inputs: inputs.COUNT, outputs: inputs.OUTPUTS });
    this.run.meta.plan = { ...plan, text: stepsText(plan.steps) };
    this.run.save();
    this.workers = new WorkerPool({ level: this.level.key, plan }, c.workers || undefined);
    this.pool = new Pool(inputs.COUNT, inputs.OUTPUTS.length, { population: c.population }, c.seed);
    this.emit('start', this.run.meta);
    try {
      while (!this.stopped && this.pool.generation < c.maxGens) await this.generation();
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

  async generation() {
    const c = this.cfg, gen = this.pool.generation, t0 = Date.now();
    const entries = this.pool.species.flatMap((s) => s.genomes.map((g) => ({ s, g })));
    const runCfg = { maxTicks: c.maxTicks, patience: c.patience, thinkEvery: c.thinkEvery, endOnPop: c.endOnPop };
    let done = 0;
    const results = await Promise.all(entries.map(({ g }) => this.workers.run('genome', { genome: packGenome(g), cfg: runCfg }).then((r) => {
      done++;
      if (done % 25 === 0 || done === entries.length) this.emit('progress', { gen, done, of: entries.length });
      return r;
    })));
    entries.forEach(({ g }, i) => { g.fitness = results[i].fitness; });

    // ---- what happened ----
    let bi = 0;
    results.forEach((r, i) => { if (r.fitness > results[bi].fitness) bi = i; });
    const best = results[bi];
    const times = results.filter((r) => r.time != null).map((r) => r.time);
    const summary = {
      gen, at: new Date().toISOString(), seconds: (Date.now() - t0) / 1000,
      best: best.fitness, mean: results.reduce((a, r) => a + r.fitness, 0) / results.length, median: median(results.map((r) => r.fitness)),
      progress: best.progress, meanProgress: results.reduce((a, r) => a + r.progress, 0) / results.length,
      time: times.length ? Math.min(...times) : null, finished: times.length,
      grabs: results.filter((r) => r.grabTick != null).length,
      steps: Math.max(...results.map((r) => r.steps)),
      species: this.pool.species.map((s) => ({ id: s.id, size: s.genomes.length, best: Math.max(...s.genomes.map((g) => g.fitness)) })),
      evals: results.length, ticks: results.reduce((a, r) => a + r.ticks, 0),
    };
    const detail = {
      gen, algo: 'neat',
      runs: results.map((r, i) => ({
        species: entries[i].s.id, fitness: r.fitness, progress: r.progress, ticks: r.ticks, time: r.time, steps: r.steps,
        stepTicks: r.stepTicks, grabTick: r.grabTick, capTick: r.capTick, pops: r.pops, path: r.path,
      })),
      best: { index: bi, fitness: best.fitness, progress: best.progress, ticks: best.ticks, time: best.time, steps: best.steps, stepTicks: best.stepTicks, keys: best.keys, genome: packGenome(entries[bi].g) },
    };
    const m = this.run.meta;
    if (!m.best || best.fitness > m.best.fitness) m.best = { gen, fitness: best.fitness, progress: best.progress, time: best.time, keys: best.keys };
    if (best.time != null && !m.solved) m.solved = { gen, time: best.time };
    if (best.time != null && best.time < (m.fastest ? m.fastest.time : Infinity)) m.fastest = { gen, time: best.time };
    this.run.addGeneration(summary, detail);
    this.emit('generation', summary);
    this.pool.newGeneration();
  }
}

module.exports = { NeatTrainer, DEFAULTS };
