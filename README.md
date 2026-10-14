# GLTP-AI

Paste a TagPro gravity map preset, press **Go**, and a bot explores the map until it beats it, then
keeps finding faster ways. It runs on [tagpro-local](https://github.com/BambiTP/tagpro-local)'s real
game room (the same Box2D, gravity, jumps, gates, portals, bombs and boosts as the server), and you can
watch any run in the real TagPro client.

## Run it

```sh
npm install          # Node 18+, and git (tagpro-local comes from GitHub)
npm start            # then open http://localhost:8080
```

From another computer (e.g. over Tailscale): `node app.js --host 100.106.58.111 --port 8092`.

## Use it

- **Go**: paste a map preset (`gZMefGzC...`), a group link with `?preset=`, or a Fortunate Maps id, and
  press Go. The map downloads (through BamBall's proxy, `api.bamball.workers.dev`) and is played with
  the preset's settings.
- **Watch**: the red ball is the best run so far; the blue balls are what it's exploring right now; the
  colours under them are everywhere it has been.
- **Possible ✓** with a time means it beat the map. That run's keys replay to the same tick every time,
  so it's proof. It keeps getting faster until you press **Stop**.
- **Past runs** (top right): open any earlier run, watch it, and press **Continue** to pick it up where
  it stopped.
- **⚑ Checkpoints**: press **⚑** next to Go to load the pasted map without starting, or **⚑
  Checkpoints** on a run. Click tiles in the order the bot must pass them (click again for one passed
  holding the flag, a third time to remove it), then **Start with these**. On a run, that starts a new
  run that begins from the current best. A cap only counts once every checkpoint is passed. The bot mostly
  explores on from the furthest checkpoint it has reached, but keeps a quarter of its effort on
  getting to each checkpoint faster. The status line shows the fastest time to each one (⚑1, ⚑2…).
- **☠** (next to Go): death is permanent for the runs you start while it's on. A pop ends that try,
  and nothing after a pop is remembered, so the best run never dies.
- **▶ Watch in TagPro** plays the best run in the real TagPro client; **⬇ Replay** saves it as a TagPro
  replay file (TagPro's Replays page, Upload tab, plays it).

## How it works

Go-Explore, exploration first. The bot remembers every distinct place the ball has been (tile, rough
speed, jumps left, flag, gates) with the fastest keys that reach it. Over and over it picks a place,
mostly the ones it has picked least, replays its keys exactly, and presses random keys from there. New
places join the memory; a faster way to a known place replaces the old one. Places further along (by
walking distance to the flag and back) get only a light extra pull, so portals, gates and ledges can't
fool it for long.

```
app.js             starts the server
src/sim.js         one ball in tagpro-local's game room, tick by tick, exactly repeatable
src/maps.js        presets / ids -> maps (downloaded once into maps/) and their settings
src/progress.js    walking distance to the flag and back: how far along a run is
src/explore.js     Go-Explore: the memory, picking places, saving runs
src/worker.js      one exploration, on a worker thread (one per CPU core)
src/runs.js        runs/<map>-<date>/: stats, best run, memory (for Continue)
src/replay.js      a run -> a real TagPro replay
src/server.js      the page's API and the real TagPro client
ui/                the page
test/              npm test (test/maps: small text maps)
```

Another Fortunate Maps proxy can be set with `FM_PROXY` (`{id}` and `{kind}` are filled in, or `{url}`
becomes the Fortunate Maps URL).
