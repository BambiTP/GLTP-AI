// replay.js - a run as a real TagPro replay (NDJSON lines of [ms, event, data], what TagPro's Replays
// page downloads), so it plays in the real TagPro client. The keys are played again through the room
// with a recorder attached, so the packets are exactly what a live server would send.
const { Sim, keysPerTick } = require('./sim');

function buildReplay(level, keys, name = 'GLTP-AI') {
  const lines = [];
  let t = 0, idSent = false;
  const recorder = {
    emit(ev, data) {
      lines.push(JSON.stringify([Math.round(t), ev, data === undefined ? null : data]));
      // right after the start: overtime, so the clock counts up from 0 (the run's time)
      if (ev === 'time' && data && data.state === 1) lines.push(JSON.stringify([Math.round(t), 'time', { time: 0, state: 5 }]));
      // the replay follows the first player
      if (!idSent && ev === 'p') {
        const u = (Array.isArray(data) ? data : (data && data.u) || []).find((x) => x && x.id);
        if (u) { idSent = true; lines.push(JSON.stringify([Math.round(t), 'id', u.id])); }
      }
    },
    disconnect() {},
  };
  const sim = new Sim(level, { recorder, name });
  for (const k of keysPerTick(keys)) { sim.setKeys(k); sim.step(); t = sim.t; }
  sim.setKeys(0);
  for (let i = 0; i < 120; i++) { sim.step(); t = sim.t; } // 2 s more: the cap animation
  const meta = {
    uuid: 'gltp-ai', started: 0, duration: Math.round(sim.t), finished: true,
    mapName: level.name, mapType: 'ctf', serverName: 'GLTP-AI', gameId: 'gltp-ai', gameMode: 'normal',
    private: true, maptest: false, ranked: false, minigame: false, voided: false,
    teams: { red: { name: 'Red', score: sim.room.score.r }, blue: { name: 'Blue', score: sim.room.score.b } },
    winner: 0, players: [{ id: sim.p.id, team: 1, userId: null, displayName: name, joined: 0, left: null, finished: true }],
  };
  return [JSON.stringify([0, 'recorder-metadata', meta]), JSON.stringify([0, 'connect', null])].concat(lines).join('\n') + '\n';
}

module.exports = { buildReplay };
