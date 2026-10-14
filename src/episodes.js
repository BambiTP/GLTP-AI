// episodes.js - single runs on a map: a NEAT network playing, or a Go-Explore return-and-explore.
// Both start from a fresh room, follow the run's plan (goals.js), and give back what the dashboard
// and the trainers need: the path (ball position every PATH_EVERY ticks, in pixels), the keys held
// every tick, and what happened when. A run "finishes" when the plan's last step is done.
const { Sim, keysPerTick, encodeKeys, KEY_BITS, rng } = require('./sim');
const { Network } = require('./neat');
const inputs = require('./inputs');

const PATH_EVERY = 4;
const TILE = 0.4;

function pushPath(path, sim) {
  const b = sim.ball();
  if (b) path.push(Math.round(b.x * 100), Math.round(b.y * 100));
  else path.push(-1, -1);
}

function outcome(sim, plan, state) {
  return {
    finishTick: plan.finished(state) ? state.done[state.done.length - 1] : null,
    time: plan.time(state), steps: state.step, stepTicks: state.done,
    grabTick: sim.grabTick, capTick: sim.capTick, pops: sim.pops,
  };
}

// ---------- NEAT ----------

function networkInputs(sim, plan, state, out) {
  const b = sim.ball();
  if (!b) return out.fill(0);
  inputs.grid(sim.room.tiles, Math.round(b.x / TILE), Math.round(b.y / TILE), out);
  let i = inputs.SIDE * inputs.SIDE;
  const [dx, dy] = plan.direction(state, sim);
  out[i++] = b.vx / 5;
  out[i++] = b.vy / 5;
  out[i++] = Math.min(1, sim.jumpsLeft / Math.max(1, Math.min(sim.jumpLimit, 3)));
  out[i++] = sim.flag ? 1 : 0;
  out[i++] = dx;
  out[i++] = dy;
  out[i] = 1; // bias
  return out;
}

// cfg: { maxTicks, patience, thinkEvery, endOnPop }
function runGenome(level, plan, genome, cfg) {
  const net = new Network(genome, inputs.COUNT, inputs.OUTPUTS.length);
  const sim = new Sim(level);
  const state = plan.start();
  const input = new Array(inputs.COUNT).fill(0);
  const keys = [], path = [];
  let best = 0, bestTick = 0, held = 0;
  pushPath(path, sim);
  while (sim.tick < cfg.maxTicks) {
    if (sim.tick % cfg.thinkEvery === 0) {
      const o = net.evaluate(networkInputs(sim, plan, state, input));
      held = 0;
      // opposite keys cancel out (as in MarI/O)
      if (o[0] > 0 && !(o[1] > 0)) held |= KEY_BITS.left;
      if (o[1] > 0 && !(o[0] > 0)) held |= KEY_BITS.right;
      if (o[2] > 0 && !(o[3] > 0)) held |= KEY_BITS.up;
      if (o[3] > 0 && !(o[2] > 0)) held |= KEY_BITS.down;
    }
    sim.setKeys(held);
    sim.step();
    keys.push(held);
    plan.update(state, sim);
    if (sim.tick % PATH_EVERY === 0) pushPath(path, sim);
    if (plan.finished(state)) break;
    if (sim.dead) { if (cfg.endOnPop) break; continue; }
    const p = plan.progress(state, sim);
    if (p > best + 0.01) { best = p; bestTick = sim.tick; }
    if (sim.tick - bestTick > cfg.patience) break;
  }
  const out = outcome(sim, plan, state);
  if (out.finishTick != null) { best = plan.total; bestTick = out.finishTick; }
  const frac = plan.total > 0 ? Math.max(0, best) / plan.total : (out.finishTick != null ? 1 : 0);
  // progress first (0..1000), then finishing (+1000) and the faster the better (up to +1000);
  // reaching the best spot sooner breaks ties
  const fitness = out.finishTick != null
    ? 2000 + 1000 * Math.max(0, 1 - out.time / cfg.maxTicks)
    : 1000 * frac - bestTick / 60;
  return { fitness, progress: frac, ticks: sim.tick, bestTick, ...out, keys: encodeKeys(keys), path };
}

// ---------- Go-Explore ----------

// what makes two moments "the same place": plan step, tile, rough velocity, jumps left, flag, gates
function cellKey(sim, state, finished) {
  if (finished) return 'done';
  const b = sim.ball();
  if (!b) return null;
  const tx = Math.round(b.x / TILE), ty = Math.round(b.y / TILE);
  const vx = Math.max(-2, Math.min(2, Math.round(b.vx / 1.25)));
  const vy = b.vy < -1.5 ? 'u' : b.vy > 1.5 ? 'd' : 's';
  return `${state.step}:${tx},${ty},${vx}${vy},${Math.min(sim.jumpsLeft, 3)},${sim.flag},${sim.gateState()}`;
}

// left/right/none x up/down/none; down is picked half as often (it rarely helps)
const ACTIONS = [0, 1, 2, 4, 5, 6, 8, 9, 10];
const ACTION_WEIGHT = [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5];

// task: { prefix (keys to replay), exploreTicks, seed, holdMean }
function explore(level, plan, task) {
  const sim = new Sim(level);
  const state = plan.start();
  const path = [];
  pushPath(path, sim);
  for (const k of keysPerTick(task.prefix)) {
    sim.setKeys(k);
    sim.step();
    plan.update(state, sim);
    if (sim.tick % PATH_EVERY === 0) pushPath(path, sim);
  }
  const start = sim.tick, cells = [], seen = new Set(), keys = [];
  const random = rng(task.seed);
  const wsum = ACTION_WEIGHT.reduce((a, b) => a + b, 0);
  let action = sim.keys, hold = 0;
  // popping doesn't end an exploration: respawning is a teleport back to spawn
  while (sim.tick - start < task.exploreTicks && !plan.finished(state)) {
    if (hold <= 0) {
      let r = random() * wsum, i = 0;
      while ((r -= ACTION_WEIGHT[i]) > 0) i++;
      action = ACTIONS[i];
      hold = 1 + Math.floor(-Math.log(1 - random()) * task.holdMean);
    }
    hold--;
    sim.setKeys(action);
    sim.step();
    keys.push(action);
    plan.update(state, sim);
    if (sim.tick % PATH_EVERY === 0) pushPath(path, sim);
    const finished = plan.finished(state);
    const key = cellKey(sim, state, finished);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const b = sim.ball();
    cells.push({
      key, at: sim.tick - start, // ticks into the exploration
      progress: plan.progress(state, sim), time: finished ? plan.time(state) : null,
      x: b ? Math.round(b.x * 100) : 0, y: b ? Math.round(b.y * 100) : 0, flag: sim.flag, step: state.step,
    });
  }
  return { cells, explored: encodeKeys(keys), start, ticks: sim.tick, ...outcome(sim, plan, state), path };
}

module.exports = { runGenome, explore, cellKey, networkInputs, PATH_EVERY };
