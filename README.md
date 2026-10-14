# GLTP-AI

Bots that learn TagPro gravity maps, to beat them as fast as possible or at least prove they can be beaten.

Everything runs on [tagpro-local](https://github.com/BambiTP/tagpro-local)'s real game room: the same
Box2D build, gravity, jumps, gates, buttons, portals, bombs and boosts as the server. Runs can be watched
in the **real TagPro client** with the real graphics.

Two algorithms:

- **Go-Explore** proves a map possible. It remembers every distinct place the ball has been, replays the
  fastest keys that reach one, then presses random keys from there. When the plan's last step is done,
  the map is proven possible, and it keeps getting faster for as long as it runs.
- **NEAT** works like SethBling's MarI/O. A population of neural networks sees the tiles around the ball
  and presses keys. The best ones breed, mutate and split into species.

## Setup

```sh
npm install            # Node 18+; installs tagpro-local from GitHub
node cli.js view       # http://localhost:8080
```

The page has a **map preset** box and a **pen**:

1. Paste a group preset (`gZMefGzCggtaiaaaJraaksaaamaaaE`) or a group link with `?preset=` and press
   Load. The bot plays the preset's map with the preset's settings (jumps, acceleration, respawn times…).
   A Fortunate Maps id or a practice map (`steps`, `tower`, `spikes`, `slopes`) works too.
2. Drag on the map to draw a rough path: from spawn to the flag, and back if you like. Undo with ↶ or
   Ctrl+Z. No path is fine too.
3. Press **Go**. The bot plays the map live: the best route so far in red, the current generation in
   blue. When it finishes, the bar says **Possible ✓** with its time, and it keeps getting faster until
   you press Stop. **Watch in TagPro** plays the best route in the real TagPro client, and **⬇ Replay**
   saves it as a replay file (`.ndjson`, the format TagPro's Replays page downloads). To watch a saved
   file, open the Replays page, choose **Upload**, pick the file and press **Play**.

The drawn line becomes `via` waypoints every 3 tiles (see Goals), with the grab where the line passes
the flag and the cap at the end. Charts, every generation and NEAT's network are at **/dashboard**.

Maps come from Fortunate Maps through BamBall's CORS proxy, `api.bamball.workers.dev` (the Cloudflare
Worker in [BamBall](https://github.com/BambiTP/BamBall)'s `worker/`). Nothing to set up. To use another
proxy, set it in `config.json`, `FM_PROXY=...` or `--proxy ...`. In the URL, `{id}` and `{kind}`
(`png` or `json`) are filled in, or `{url}` becomes the encoded Fortunate Maps URL:

```json
{ "proxy": "https://api.bamball.workers.dev/api/fortunatemaps/{id}/{kind}" }
```

## Use

```sh
node cli.js explore gZMefGzCggtaiaaaJraaksaaamaaaE   # Go-Explore on a preset's map, with its settings
node cli.js explore 88528                 # Go-Explore on GLTP map 88528 (downloads it), dashboard live
node cli.js neat tower --population 300   # NEAT on the "tower" practice map
node cli.js explore steps --goal "reach 2,2; grab; cap"   # a custom path
node cli.js verify                        # replay the latest run's best keys in a fresh room: the proof
node cli.js maps climb                    # GLTP maps matching "climb", easiest first
node cli.js help                          # every command and option
```

The detailed dashboard (`/dashboard`) has **New run** with the GLTP map list, exact goals and every
strategy setting.

### The dashboard (/dashboard)

- **The map** in the real texture pack. Every run of the selected generation plays at once: the best in
  red with its trail, the rest as blue ghosts. The plan's steps are drawn on top, and Go-Explore runs can
  show the archive as a heat map.
- **Generations**: best and mean progress, and the fastest finish time (yellow; dots mark new records).
  Click anywhere on it to look at that generation.
- **Species** (NEAT) or **Archive** (Go-Explore) over time.
- **Best network** (NEAT), drawn like MarI/O: the box of tiles it sees, its links, and the keys it holds.
- **▶ Watch in TagPro** opens the generation in the real TagPro client: the best run plus 30 more of the
  generation as blue balls, with the clock counting the run's time.

## Goals and paths

A run follows a **plan**: an ordered list of steps. Finishing the last one is the win, and the tick it
happens on is the run's time.

| step | done when |
|---|---|
| `reach x,y [rN]` | the ball's centre is within N tiles (default 1) of tile x,y: a checkpoint |
| `via x,y [rN]` | the same within N tiles (default 2), but reaching any later `via` in a row counts for this one too: a rough-path guide the bot can cut corners on |
| `grab` | a flag (blue or yellow) is grabbed |
| `cap` | a cap (blue flag on the red flag, yellow flag on a red endzone) |
| `button x,y` | the button on tile x,y is touched |

A **custom path** is a list of `reach` steps. Progress is measured along it, step by step, as walking
distance (around walls, through portals), not as a straight line. That steers both algorithms: drawing
the route you think works is the strongest hint you can give them. In the dashboard, click the map to
add waypoints after the highlighted step.

By default a map's plan is its GLTP rules: `grab; cap`, repeated on maps that need 3 caps. **Save as this
map's plan** stores it in `plans/<map>.json`, and new runs on that map use it. `--time-from N` (or
"Clock starts" in the dashboard) starts the clock when step N is done instead of at spawn.

## Strategy settings

| | setting | default | what it does |
|---|---|---|---|
| Go-Explore | `--explore-ticks` | 90 | random keys for this long from each picked cell |
| | `--hold-mean` | 6 | average ticks a random key combination is held |
| | `--frontier` | 4 | how strongly picks favour cells further along the plan |
| | `--batch` | 8 per CPU | explorations per generation |
| NEAT | `--population` | 300 | networks per generation |
| | `--think-every` | 2 | ticks between key choices (MarI/O: 5 frames) |
| | `--patience` | 180 | a run ends after this many ticks without progress |
| | `--max-ticks` | 3600 | longest run |
| | `--end-on-pop` | true | popping ends the run |
| both | `--max-gens`, `--seed`, `--workers` | | |

## How exact is it

Runs are deterministic. Time is the tick count, every room timer (respawns, gates, boosts, bombs) fires
on it, spawns are seeded, and keys go in through the room's own input handler. So a run's keys replay to
the same tick, bit for bit (`node cli.js verify`), and that replay is the proof.

How close that is to the live server is tagpro-local's accuracy: its replay checks match about 99.7% of
quarter-second segments of real games, and the jump strength is fitted from real gravity replays. A
route that depends on a single tick could still go differently on the real server.

The bot plays one red ball alone. Buddy maps (2+ balls) need moves no single ball can make.

## Files

```
cli.js                commands
src/sim.js            one ball in tagpro-local's room, tick by tick
src/goals.js          plans: steps, progress along them, saved plans
src/progress.js       walking-distance fields over a map
src/maps.js           Fortunate Maps (through the proxy), practice maps, GLTP settings
src/episodes.js       one NEAT run / one Go-Explore exploration
src/neat.js           NEAT, ported from MarI/O
src/train-neat.js     NEAT training loop
src/train-explore.js  Go-Explore
src/replay.js         runs -> real TagPro replays
src/server.js         dashboard + the real TagPro client from tagpro-local
ui/                   dashboard
maps/*.txt            practice maps (text: # wall, . floor, S spawn, B blue flag, R red flag, * spike, ◣◤◥◢ 45° walls)
plans/                saved plans
runs/                 training runs (every generation)
```
