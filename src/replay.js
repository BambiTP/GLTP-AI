// replay.js - turns a run into a real TagPro replay (tagpro-local's format: NDJSON lines of
// [ms, event, data]), so it plays in the real TagPro client with the real graphics.
//
// The best run is played again through the room with a recorder attached, so its packets are exactly
// what a live server sends. Other runs of the same generation can ride along as "ghosts": extra blue
// balls driven by their recorded paths (the runs were played alone, so they don't touch each other).
const { Sim, keysPerTick } = require('./sim');
const { PATH_EVERY } = require('./episodes');

const LINGER_TICKS = 120; // keep recording 2 s after the cap (the cap animation)
const GHOST_ID = 1000;

class Recorder {
  constructor() { this.lines = []; this.t = 0; this.idSent = false; }
  emit(ev, data) {
    this.lines.push(JSON.stringify([Math.round(this.t), ev, data === undefined ? null : data]));
    // right after the start, overtime: the clock then counts up from 0 (the run's time)
    if (ev === 'time' && data && data.state === 1) this.lines.push(JSON.stringify([Math.round(this.t), 'time', { time: 0, state: 5 }]));
    // like tagpro-local's recorder: the replay follows the first player
    if (!this.idSent && ev === 'p') {
      const u = (Array.isArray(data) ? data : (data && data.u) || []).find((x) => x && x.id);
      if (u) { this.idSent = true; this.lines.push(JSON.stringify([Math.round(this.t), 'id', u.id])); }
    }
  }
  disconnect() {}
}

// keys: the run to record. ghosts: [{ name, path }] (paths every PATH_EVERY ticks, in pixels, -1 = dead)
function buildReplay(level, keys, { ghosts = [], name = 'GLTP-AI' } = {}) {
  const rec = new Recorder();
  const sim = new Sim(level, { recorder: rec, name, settings: ghosts.length ? { ghostMode: 'noPlayerCollisions' } : {} });
  const room = sim.room;
  rec.t = sim.t;

  // ghosts join as blue players
  const base = room.fullPlayer(sim.p);
  const gs = ghosts.map((g, i) => ({ id: GHOST_ID + i, name: g.name, path: g.path, dead: false }));
  if (gs.length) {
    rec.emit('p', { u: gs.map((g) => Object.assign({}, base, {
      id: g.id, name: g.name, team: 2, flag: null, auth: undefined, degree: undefined, flair: undefined,
      rx: g.path[0] / 100, ry: g.path[1] / 100, lx: 0, ly: 0, draw: true, dead: false,
    })), t: 0 });
  }
  const ghostPackets = (tick) => {
    if (tick % PATH_EVERY) return;
    const i = (tick / PATH_EVERY) * 2, u = [];
    for (const g of gs) {
      if (g.dead || i >= g.path.length) continue;
      const x = g.path[i], y = g.path[i + 1];
      if (x < 0) {
        g.dead = true;
        const px = g.path[i - 2], py = g.path[i - 1];
        if (px >= 0) rec.emit('splat', { x: px, y: py, t: 2, temp: false });
        u.push({ id: g.id, dead: true, draw: false });
        continue;
      }
      const nx = i + 2 < g.path.length && g.path[i + 2] >= 0 ? g.path[i + 2] : x;
      const ny = i + 3 < g.path.length && g.path[i + 3] >= 0 ? g.path[i + 3] : y;
      const k = 60 / PATH_EVERY / 100; // pixels per PATH_EVERY ticks -> m/s
      u.push({ id: g.id, rx: x / 100, ry: y / 100, lx: (nx - x) * k, ly: (ny - y) * k });
    }
    if (u.length) rec.emit('p', { u, t: tick });
  };

  ghostPackets(0);
  let linger = 0;
  for (const k of keysPerTick(keys)) {
    sim.setKeys(k);
    sim.step();
    rec.t = sim.t;
    ghostPackets(sim.tick);
  }
  sim.setKeys(0);
  while (linger++ < LINGER_TICKS) { sim.step(); rec.t = sim.t; ghostPackets(sim.tick); }

  const duration = Math.round(sim.t);
  const meta = {
    uuid: 'gltp-ai', started: 0, duration, finished: true,
    mapName: level.name, mapType: 'ctf', serverName: 'GLTP-AI', gameId: 'gltp-ai', gameMode: 'normal',
    private: true, maptest: false, ranked: false, minigame: false, voided: false,
    teams: { red: { name: 'Red', score: room.score.r }, blue: { name: 'Blue', score: room.score.b } },
    winner: 0, players: [{ id: sim.p.id, team: 1, userId: null, displayName: name, joined: 0, left: null, finished: true }],
  };
  return {
    text: [JSON.stringify([0, 'recorder-metadata', meta]), JSON.stringify([0, 'connect', null])].concat(rec.lines).join('\n') + '\n',
    capTick: sim.capTick, ticks: sim.tick,
  };
}

module.exports = { buildReplay };
