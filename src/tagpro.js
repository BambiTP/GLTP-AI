// tagpro.js - everything GLTP-AI uses from tagpro-local (the real physics, map loader, presets,
// client files and page templates), in one place.
const path = require('path');

const ROOT = path.dirname(require.resolve('tagpro-local/package.json'));
const lib = (p) => require(path.join(ROOT, p));

const { GameRoom, T } = lib('engine/game');
const C = lib('engine/constants');
const Box2D = lib('engine/box2d');
const { loadMap, trimPng } = lib('engine/mapLoader');
const presets = lib('server/preset');
const groupDefaults = lib('server/groupDefaults.json');

module.exports = {
  ROOT,
  PUBLIC: path.join(ROOT, 'public'),
  GameRoom, T, C, Box2D, loadMap, trimPng, presets, groupDefaults,
  V: Box2D.Common.Math.b2Vec2,
  gltpMetadata: () => lib('tools/repro/gltp/map_metadata.json'),
  texturePacks: () => lib('ref-data/texture-packs.json'),
  pages: () => lib('server/pages'),
};
