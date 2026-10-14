// sim.js - one ball on a map, played through tagpro-local's real game room, tick by tick.
//
// Everything that makes a live room non-repeatable is pinned down, so the same keys always give the
// same run (to the last bit):
//   - time is the tick count (60 per second), and every timer the room sets (respawns, gate timers,
//     boost and bomb respawns, powerups) fires on that clock instead of setTimeout
//   - spawns and powerups pick from a seeded random number generator
//   - nobody gets AFK-kicked, the clock never runs out, a cap doesn't end the game
// Keys go in through the room's own input handler (the same path a real client's keydown takes),
// so jumps happen exactly as on the server.
const tp = require('./tagpro');

const STEP_MS = 1000 / 60;
const KEY_BITS = { left: 1, right: 2, up: 4, down: 8 };
const KEY_NAMES = Object.keys(KEY_BITS);

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

function withRandom(random, fn) {
  const saved = Math.random;
  Math.random = random;
  try { return fn(); } finally { Math.random = saved; }
}

class Sim {
  // opts: { seed, recorder (a client that receives every packet, see replay.js), name, settings }
  constructor(level, opts = {}) {
    this.level = level;
    this.opts = opts;
    this.gateGroups = gateGroups(level.map.tiles);
    this.reset();
  }

  reset() {
    const { level, opts } = this;
    this.t = 0;
    this.tick = 0;
    this.timers = [];
    this.timerSeq = 0;
    this.keys = 0;
    this.keySeq = 0;
    this.grabTick = null;
    this.capTick = null;
    this.pops = 0;
    this.grabCount = 0;
    this.capCount = 0;
    const random = rng(opts.seed || 1);
    const settings = Object.assign({}, level.settings, {
      disableAfk: true, caps: 0, mercyRule: 0, overtime: false, time: 60,
    }, opts.settings || {});
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
      // nobody's listening while training: don't build update packets (queue, flushDirty and
      // snapshot only make packets; physics never reads them)
      room.broadcast = () => {}; room.send = () => {};
      room.queue = () => {}; room.flushDirty = () => {}; room.snapshot = () => {};
    }
    const pickSpawn = room.pickSpawn.bind(room), randomPup = room.randomPup.bind(room);
    room.pickSpawn = (team) => withRandom(random, () => pickSpawn(team));
    room.randomPup = () => withRandom(random, () => randomPup());
    // what happened when (ticks)
    const capture = room.capture.bind(room), grabFlag = room.grabFlag.bind(room), pop = room.pop.bind(room);
    // (in ticks played when it happened: this.tick counts up once the step is over)
    room.capture = (p) => { if (p === this.p) { this.capCount++; if (this.capTick == null) this.capTick = this.tick + 1; } capture(p); };
    room.grabFlag = (p, team) => { if (p === this.p) { this.grabCount++; if (this.grabTick == null) this.grabTick = this.tick + 1; } grabFlag(p, team); };
    room.pop = (p, killer, o) => { if (p === this.p && !p.dead) this.pops++; pop(p, killer, o); };

    room.state = tp.C.STATES.ACTIVE;
    room.startedPlayAt = 0;
    room.stateEndsAt = settings.time * 60000;
    if (opts.recorder) room.addRecorder(opts.recorder);
    this.client = { emit() {}, disconnect() {} };
    room.addClient(this.client, { id: 'gltp-ai', name: opts.name || 'GLTP-AI' }, { team: 1 });
    this.p = room.players[this.client.playerId];
    wallsOutOfBodyList(room.world);
    room.startPowerups();
    this.spawn = { x: this.p.body.GetPosition().x, y: this.p.body.GetPosition().y };
    this.jumpLimit = room.jumpLimit();
  }

  // keys: bit mask (1 left, 2 right, 4 up, 8 down) held from the next tick on
  setKeys(keys) {
    const changed = keys ^ this.keys;
    if (!changed) return;
    for (const k of KEY_NAMES) {
      const bit = KEY_BITS[k];
      if (!(changed & bit)) continue;
      this.keySeq++;
      this.room.handle(this.client, (keys & bit) ? 'keydown' : 'keyup', { k, t: this.keySeq });
    }
    this.keys = keys;
  }

  step() {
    this.t += STEP_MS;
    this.runTimers();
    this.room.step();
    this.tick++;
  }

  runTimers() {
    for (;;) {
      let next = null;
      for (const h of this.timers) if (!h.cancelled && h.at <= this.t + 1e-6 && (!next || h.at < next.at || (h.at === next.at && h.seq < next.seq))) next = h;
      if (!next) break;
      next.cancelled = true;
      next.fn();
    }
    if (this.timers.length > 64) this.timers = this.timers.filter((h) => !h.cancelled);
  }

  get dead() { return this.p.dead; }
  get capped() { return this.capTick != null; }
  get flag() { return this.p.flag || 0; }
  get jumpsLeft() { return this.p.jumpsLeft === undefined ? this.jumpLimit : this.p.jumpsLeft; }

  // the ball in metres and m/s (null while dead)
  ball() {
    const p = this.p;
    if (p.dead) return null;
    const pos = p.body.GetPosition(), v = p.body.GetLinearVelocity();
    return { x: pos.x, y: pos.y, vx: v.x, vy: v.y };
  }

  // gates' current colours, one character per gate group ("" if the map has none)
  gateState() {
    let s = '';
    for (const [x, y] of this.gateGroups) s += Math.round((Number(this.room.tiles[x][y]) - 9) * 10);
    return s;
  }
}

// Speed, with exactly the same results. Every step Box2D walks its whole body list (thousands of wall
// tiles) to clear each body's island marker and, in SolveTOI, its sweep time, then skips the walls
// because they never move. A wall's island marker is already cleared after every island it joins, and
// its sweep time only matters while it touches something. So walls leave the body list, and SolveTOI
// resets the sweep of walls in a contact, which is everything the full walk did that can change a result.
// (Contacts, the broadphase and the ball's own place in the list are untouched.)
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
      const a = c.m_fixtureA.m_body, b = c.m_fixtureB.m_body;
      if (a.GetType() === STATIC) { a.m_flags &= ~ISLAND; a.m_sweep.t0 = 0; }
      if (b.GetType() === STATIC) { b.m_flags &= ~ISLAND; b.m_sweep.t0 = 0; }
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

function keysLength(rle) { let n = 0; for (let i = 1; i < rle.length; i += 2) n += rle[i]; return n; }

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

// play a key sequence from the start; onTick(sim) is called after every tick
function play(level, rle, opts = {}, onTick) {
  const sim = new Sim(level, opts);
  for (const k of keysPerTick(rle)) {
    sim.setKeys(k);
    sim.step();
    if (onTick && onTick(sim) === false) break;
  }
  return sim;
}

module.exports = { Sim, KEY_BITS, STEP_MS, encodeKeys, keysPerTick, keysLength, sliceKeys, concatKeys, play, rng };
