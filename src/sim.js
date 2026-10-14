// sim.js - one ball on a map, played through tagpro-local's real game room, tick by tick.
//
// Everything that makes a live room non-repeatable is pinned down, so the same keys always give the
// same run, to the last bit:
//   - time is the tick count (60 per second), and every timer the room sets (respawns, gates, boosts,
//     bombs, powerups) fires on that clock instead of setTimeout
//   - spawns and powerups come from a seeded random number generator
//   - nobody gets AFK-kicked, the clock never runs out, a cap doesn't end the game
// Keys go in through the room's own input handler, the same path a real client's keydown takes.
const tp = require('./tagpro');

const STEP_MS = 1000 / 60;
const KEY_BITS = { left: 1, right: 2, up: 4, down: 8 };

// timers handed out by Sim are plain objects; clearTimeout has to recognise them
const realClearTimeout = globalThis.clearTimeout;
if (!realClearTimeout.gltp) {
  const clear = function (h) {
    if (h && h.simTimer) { h.cancelled = true; return undefined; }
    return realClearTimeout.apply(this, arguments);
  };
  clear.gltp = true;
  globalThis.clearTimeout = clear;
}

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Sim {
  // opts: { recorder (a client that gets every packet, for replays), name, plain (no speed-ups, for tests) }
  constructor(level, opts = {}) {
    this.level = level;
    this.t = 0;
    this.tick = 0;
    this.timers = [];
    this.timerSeq = 0;
    this.keys = 0;
    this.keySeq = 0;
    this.grabTicks = [];  // ticks played when each grab happened
    this.capTicks = [];   // ... each cap
    this.pops = 0;
    const random = rng(1);
    const withRandom = (fn) => { const saved = Math.random; Math.random = random; try { return fn(); } finally { Math.random = saved; } };
    const settings = Object.assign({}, level.settings, { disableAfk: true, caps: 0, mercyRule: 0, overtime: false, time: 60 });
    const room = this.room = new tp.GameRoom({
      id: 'gltp-ai', uuid: 'gltp-ai', map: level.map, mapName: level.name, settings, isPrivate: true,
      now: () => this.t, onEnd() {}, onEmpty() {},
    });
    room.later = (ms, fn) => {
      const h = { at: this.t + ms, seq: this.timerSeq++, fn, simTimer: true, cancelled: false };
      this.timers.push(h);
      return h;
    };
    room.afkCheck = () => {};
    room.updateClock = () => {};
    room.end = () => {};
    room.checkWinConditions = () => {};
    if (!opts.recorder) {
      // nobody's listening: don't build update packets (physics never reads them)
      room.broadcast = () => {}; room.send = () => {};
      room.queue = () => {}; room.flushDirty = () => {}; room.snapshot = () => {};
    }
    const pickSpawn = room.pickSpawn.bind(room), randomPup = room.randomPup.bind(room);
    room.pickSpawn = (team) => withRandom(() => pickSpawn(team));
    room.randomPup = () => withRandom(() => randomPup());
    // what happened when, in ticks played (this.tick counts up after the step)
    const capture = room.capture.bind(room), grabFlag = room.grabFlag.bind(room), pop = room.pop.bind(room);
    room.capture = (p) => { if (p === this.p) this.capTicks.push(this.tick + 1); capture(p); };
    room.grabFlag = (p, team) => { if (p === this.p) this.grabTicks.push(this.tick + 1); grabFlag(p, team); };
    room.pop = (p, killer, o) => { if (p === this.p && !p.dead) this.pops++; pop(p, killer, o); };

    room.state = tp.C.STATES.ACTIVE;
    room.startedPlayAt = 0;
    room.stateEndsAt = settings.time * 60000;
    if (opts.recorder) room.addRecorder(opts.recorder);
    this.client = { emit() {}, disconnect() {} };
    room.addClient(this.client, { id: 'gltp-ai', name: opts.name || 'GLTP-AI' }, { team: 1 });
    this.p = room.players[this.client.playerId];
    if (!opts.plain) wallsOutOfBodyList(room.world);
    room.startPowerups();
    this.spawn = { x: this.p.body.GetPosition().x, y: this.p.body.GetPosition().y };
    this.jumpLimit = room.jumpLimit();
    this.gates = gateGroups(level.map.tiles);
  }

  // keys: bit mask (1 left, 2 right, 4 up, 8 down) held from the next tick on
  setKeys(keys) {
    const changed = keys ^ this.keys;
    if (!changed) return;
    for (const [k, bit] of Object.entries(KEY_BITS)) {
      if (!(changed & bit)) continue;
      this.keySeq++;
      this.room.handle(this.client, (keys & bit) ? 'keydown' : 'keyup', { k, t: this.keySeq });
    }
    this.keys = keys;
  }

  step() {
    this.t += STEP_MS;
    for (;;) { // timers due now, in order
      let next = null;
      for (const h of this.timers) if (!h.cancelled && h.at <= this.t + 1e-6 && (!next || h.at < next.at || (h.at === next.at && h.seq < next.seq))) next = h;
      if (!next) break;
      next.cancelled = true;
      next.fn();
    }
    if (this.timers.length > 64) this.timers = this.timers.filter((h) => !h.cancelled);
    this.room.step();
    this.tick++;
  }

  get dead() { return this.p.dead; }
  get flag() { return this.p.flag || 0; }
  get jumpsLeft() { return this.p.jumpsLeft === undefined ? this.jumpLimit : this.p.jumpsLeft; }

  // the ball in metres and m/s (null while dead)
  ball() {
    if (this.p.dead) return null;
    const pos = this.p.body.GetPosition(), v = this.p.body.GetLinearVelocity();
    return { x: pos.x, y: pos.y, vx: v.x, vy: v.y };
  }

  // every gate's current colour, one character per gate ("" on maps without gates)
  gateState() {
    let s = '';
    for (const [x, y] of this.gates) s += Math.round((Number(this.room.tiles[x][y]) - 9) * 10);
    return s;
  }
}

// Speed, with exactly the same results. Every step Box2D walks its whole body list (thousands of wall
// tiles) to reset each body's island marker and, in SolveTOI, its sweep time, then skips the walls
// because they never move. A wall's island marker is already reset after every island it joins, and
// its sweep time only matters while it touches something. So walls leave the body list, and SolveTOI
// resets the sweep of walls in a contact: everything the full walk did that can change a result.
function wallsOutOfBodyList(world) {
  const Body = tp.Box2D.Dynamics.b2Body;
  const STATIC = Body.b2_staticBody, ISLAND = Body.e_islandFlag;
  let head = null, last = null;
  for (let b = world.m_bodyList; b;) {
    const next = b.m_next;
    if (b.GetType() === STATIC) { b.m_prev = null; b.m_next = null; } else {
      b.m_prev = last; b.m_next = null;
      if (last) last.m_next = b; else head = b;
      last = b;
    }
    b = next;
  }
  world.m_bodyList = head;
  const solveTOI = world.SolveTOI;
  world.SolveTOI = function (step) {
    for (let c = this.m_contactList; c; c = c.m_next) {
      for (const b of [c.m_fixtureA.m_body, c.m_fixtureB.m_body]) if (b.GetType() === STATIC) { b.m_flags &= ~ISLAND; b.m_sweep.t0 = 0; }
    }
    return solveTOI.call(this, step);
  };
}

// one tile from each 8-connected group of gate tiles
function gateGroups(tiles) {
  const W = tiles.length, H = tiles[0].length, seen = new Set(), out = [];
  const isGate = (x, y) => x >= 0 && y >= 0 && x < W && y < H && Math.floor(Number(tiles[x][y])) === 9;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    if (!isGate(x, y) || seen.has(x + ',' + y)) continue;
    out.push([x, y]);
    const stack = [[x, y]];
    while (stack.length) {
      const [a, b] = stack.pop(), k = a + ',' + b;
      if (seen.has(k) || !isGate(a, b)) continue;
      seen.add(k);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) stack.push([a + dx, b + dy]);
    }
  }
  return out;
}

// ---------- key sequences ----------
// A run's inputs are stored as runs of held keys: [keys, ticks, keys, ticks, ...]

function encodeKeys(perTick) {
  const out = [];
  for (const k of perTick) {
    if (out.length && out[out.length - 2] === k) out[out.length - 1]++;
    else out.push(k, 1);
  }
  return out;
}

function* keysPerTick(rle) {
  for (let i = 0; i < rle.length; i += 2) for (let n = 0; n < rle[i + 1]; n++) yield rle[i];
}

// the first n ticks of a key sequence
function sliceKeys(rle, n) {
  const out = [];
  for (let i = 0; i < rle.length && n > 0; i += 2) {
    const len = Math.min(rle[i + 1], n);
    out.push(rle[i], len);
    n -= len;
  }
  return out;
}

// a then b, merging the runs where they meet
function concatKeys(a, b) {
  const out = a.slice();
  for (let i = 0; i < b.length; i += 2) {
    if (out.length && out[out.length - 2] === b[i]) out[out.length - 1] += b[i + 1];
    else out.push(b[i], b[i + 1]);
  }
  return out;
}

// play a key sequence from the start; onTick(sim) runs after every tick (return false to stop)
function play(level, rle, opts = {}, onTick) {
  const sim = new Sim(level, opts);
  for (const k of keysPerTick(rle)) {
    sim.setKeys(k);
    sim.step();
    if (onTick && onTick(sim) === false) break;
  }
  return sim;
}

module.exports = { Sim, KEY_BITS, encodeKeys, keysPerTick, sliceKeys, concatKeys, play, rng };
