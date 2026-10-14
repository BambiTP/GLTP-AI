// store.js - training runs on disk, so the dashboard can show every generation of every run.
//
//   runs/<map>-<neat|explore>-<date>-<time>/
//     run.json            what was trained, settings, best run so far
//     generations.ndjson  one summary line per generation (the charts)
//     gens/<n>.json       one generation in full: every run's path, the best runs' keys, the best network
//     replays/            real TagPro replays, made when first watched
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs');

const slug = (s) => String(s).replace(/\.[a-z]+$/i, '').split(/[\\/]/).pop().replace(/[^\w-]+/g, '-').toLowerCase();

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

class Run {
  static create(level, algo, config) {
    fs.mkdirSync(RUNS, { recursive: true });
    const name = slug(level.slug || level.key);
    let id = `${name}-${algo}-${stamp()}`, n = 2;
    while (fs.existsSync(path.join(RUNS, id))) id = `${name}-${algo}-${stamp()}-${n++}`;
    const run = new Run(id);
    fs.mkdirSync(path.join(run.dir, 'gens'), { recursive: true });
    run.meta = {
      id, algo, map: { key: level.key, name: level.name, author: level.author, difficulty: level.difficulty },
      config, startedAt: new Date().toISOString(), updatedAt: null, status: 'running',
      generations: 0, best: null, solved: null,
    };
    run.save();
    return run;
  }

  static open(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('bad run id');
    const run = new Run(id);
    run.meta = JSON.parse(fs.readFileSync(path.join(run.dir, 'run.json'), 'utf8'));
    return run;
  }

  static list() {
    if (!fs.existsSync(RUNS)) return [];
    return fs.readdirSync(RUNS)
      .filter((d) => fs.existsSync(path.join(RUNS, d, 'run.json')))
      .map((d) => { try { return JSON.parse(fs.readFileSync(path.join(RUNS, d, 'run.json'), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  }

  constructor(id) {
    this.id = id;
    this.dir = path.join(RUNS, id);
  }

  save() {
    this.meta.updatedAt = new Date().toISOString();
    const f = path.join(this.dir, 'run.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(this.meta, null, 1));
    fs.renameSync(f + '.tmp', f);
  }

  addGeneration(summary, detail) {
    fs.writeFileSync(path.join(this.dir, 'gens', summary.gen + '.json'), JSON.stringify(detail));
    fs.appendFileSync(path.join(this.dir, 'generations.ndjson'), JSON.stringify(summary) + '\n');
    this.meta.generations = summary.gen + 1;
    this.save();
  }

  summaries() {
    const f = path.join(this.dir, 'generations.ndjson');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  generation(n) {
    const f = path.join(this.dir, 'gens', Number(n) + '.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
}

module.exports = { Run, RUNS };
