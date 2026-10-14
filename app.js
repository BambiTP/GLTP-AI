// GLTP-AI: paste a TagPro map preset, press Go, and watch a bot explore the map until it beats it.
//   node app.js                                  then open http://localhost:8080
//   node app.js --host 100.106.58.111 --port 8092   (e.g. to open it from another computer over Tailscale)
const { listen } = require('./src/server');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const host = arg('host', process.env.HOST || '127.0.0.1'), port = Number(arg('port', process.env.PORT || 8080));

listen(port, host).then(() => console.log(`GLTP-AI: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
