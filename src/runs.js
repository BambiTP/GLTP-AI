// runs.js - every run is a folder in runs/, so past runs can be opened and continued:
//
//   runs/<map>-<date>-<time>/
//     run.json      what was pasted, the map, how far it got, the fastest finish
//     best.json     the best run's keys and path
//     archive.json  every place the explorer remembers (to continue the run)
//     heat.json     how many places it found on each tile
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs');
const dir = (id) => path.join(RUNS, id);

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function create(level, code) {
  const name = String(level.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
  let id = `${name}-${stamp()}`;
  for (let n = 2; fs.existsSync(dir(id)); n++) id = `${name}-${stamp()}-${n}`;
  fs.mkdirSync(dir(id), { recursive: true });
  const meta = {
    id, code, map: level.name, author: level.author, version: 2,
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

module.exports = { create, save, load, list, write, read, RUNS };
