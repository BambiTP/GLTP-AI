// worker.js - a worker thread for the explorer (explore.js). For each task it replays a remembered
// place's keys exactly, presses random keys from there, and reports every place it passes.
const { parentPort, workerData } = require('worker_threads');
const { loadLevel } = require('./maps');
const { Sim, keysPerTick, encodeKeys, rng } = require('./sim');
const { Goal } = require('./progress');

const level = loadLevel(workerData.level);
const goal = new Goal(level, new Sim(level).spawn);
const TILE = 0.4;

// What makes two moments "the same place": tile, rough speed, jumps left, flag, caps done, gates.
function placeKey(sim) {
  if (goal.done(sim)) return 'done';
  const b = sim.ball();
  if (!b) return null;
  const vx = Math.max(-2, Math.min(2, Math.round(b.vx / 1.25)));
  const vy = b.vy < -1.5 ? 'u' : b.vy > 1.5 ? 'd' : 's';
  return `${Math.round(b.x / TILE)},${Math.round(b.y / TILE)},${vx}${vy},${Math.min(sim.jumpsLeft, 3)},${sim.flag},${sim.capTicks.length},${sim.gateState()}`;
}

// left/right/none x up/down/none; down half as often (it rarely helps)
const ACTIONS = [0, 1, 2, 4, 5, 6, 8, 9, 10];
const WEIGHTS = [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5];
const WSUM = WEIGHTS.reduce((a, b) => a + b, 0);

// task: { prefix (keys that reach the place), ticks (how long to explore), hold (mean ticks a random
// key combination is held), seed }
function explore(task) {
  const sim = new Sim(level);
  for (const k of keysPerTick(task.prefix)) { sim.setKeys(k); sim.step(); }
  const start = sim.tick, random = rng(task.seed), seen = new Set(), places = [], keys = [], path = [];
  const where = () => { const b = sim.ball(); path.push(b ? Math.round(b.x * 100) : -1, b ? Math.round(b.y * 100) : -1); };
  where();
  let action = sim.keys, hold = 0;
  // a pop doesn't end it: respawning is a way back to spawn
  while (sim.tick - start < task.ticks && !goal.done(sim)) {
    if (hold <= 0) {
      let r = random() * WSUM, i = 0;
      while ((r -= WEIGHTS[i]) > 0) i++;
      action = ACTIONS[i];
      hold = 1 + Math.floor(-Math.log(1 - random()) * task.hold);
    }
    hold--;
    sim.setKeys(action);
    sim.step();
    keys.push(action);
    if ((sim.tick - start) % 4 === 0) where();
    const key = placeKey(sim);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const b = sim.ball();
    places.push({
      key, at: sim.tick - start, progress: goal.progress(sim), finish: goal.finishTick(sim),
      x: b ? Math.round(b.x * 100) : 0, y: b ? Math.round(b.y * 100) : 0,
    });
  }
  return { places, keys: encodeKeys(keys), start, ticks: sim.tick, path };
}

parentPort.on('message', ({ id, task }) => {
  try { parentPort.postMessage({ id, result: explore(task) }); } catch (e) { parentPort.postMessage({ id, error: e.stack || String(e) }); }
});
