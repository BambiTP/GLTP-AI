// runs.js - every run is a folder in runs/, so past runs can be opened and continued:
//
//   runs/<map>-<date>-<time>/
//     run.json      what was pasted, the map, its checkpoints, how far it got, the fastest finish
//     best.json     the best run's keys and path
//     archive.ndjson  every place the explorer remembers (to continue the run), one per line
//                   (archive.json in older runs and runs seeded from another run's best)
//     heat.json     how many places it found on each tile
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs');
const dir = (id) => path.join(RUNS, id);

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// checkpoints: [{ x, y, flag }] tiles a run has to pass in order (flag: holding the flag)
// permadeath: a pop ends the run, so no route the explorer keeps ever dies
// redZones: [{ x, y }] tiles the ball's centre must never go in
function create(level, code, checkpoints = [], permadeath = false, redZones = []) {
  const name = String(level.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
  let id = `${name}-${stamp()}`;
  for (let n = 2; fs.existsSync(dir(id)); n++) id = `${name}-${stamp()}-${n}`;
  fs.mkdirSync(dir(id), { recursive: true });
  const meta = {
    id, code, map: level.name, author: level.author, version: 2, checkpoints, permadeath, redZones, splits: checkpoints.map(() => null),
    started: new Date().toISOString(), updated: null, status: 'running',
    gen: 0, cells: 0, progress: 0, time: null, provenAt: null, fastestAt: null, ticks: 0, seconds: 0,
  };
  save(meta);
  return meta;
}

function save(meta) {
  meta.updated = new Date().toISOString();
  write(meta.id, 'run.json', meta);
}

function load(id) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error('no such run');
  return read(id, 'run.json');
}

// newest first; skips folders from older versions of GLTP-AI
function list() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).map((id) => { try { return load(id); } catch (e) { return null; } })
    .filter((m) => m && m.version === 2)
    .sort((a, b) => b.started.localeCompare(a.started));
}

function write(id, file, data) {
  const f = path.join(dir(id), file);
  fs.writeFileSync(f + '.tmp', JSON.stringify(data));
  fs.renameSync(f + '.tmp', f);
}

function read(id, file) {
  const f = path.join(dir(id), file);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

// one JSON value per line, written and read a piece at a time: a big archive doesn't fit in one string
function writeLines(id, file, items) {
  const f = path.join(dir(id), file), fd = fs.openSync(f + '.tmp', 'w');
  let chunk = '';
  for (const item of items) {
    chunk += JSON.stringify(item) + '\n';
    if (chunk.length > 1 << 20) { fs.writeSync(fd, chunk); chunk = ''; }
  }
  fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  fs.renameSync(f + '.tmp', f);
}

function* readLines(id, file) {
  const f = path.join(dir(id), file);
  if (!fs.existsSync(f)) return;
  const buf = fs.readFileSync(f);
  for (let a = 0; a < buf.length;) {
    let b = buf.indexOf(10, a);
    if (b < 0) b = buf.length;
    if (b > a) yield JSON.parse(buf.toString('utf8', a, b));
    a = b + 1;
  }
}

const exists = (id, file) => fs.existsSync(path.join(dir(id), file));
const remove = (id, file) => fs.rmSync(path.join(dir(id), file), { force: true });

module.exports = { create, save, load, list, write, read, writeLines, readLines, exists, remove, RUNS };
