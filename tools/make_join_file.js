// Makes the double-click file friends use to join a Classic server (no Node or commands on their side).
//   node tools/make_join_file.js --server 203.0.113.5:7781 [--out "dist/Join OG SOS Classic.cmd"]
// Send the resulting .cmd to friends. dist/ is git-ignored.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const server = opt('--server');
const [host, port = '7781'] = String(server || '').split(':');
if (!net.isIPv4(host) || !/^\d+$/.test(port) || +port < 1 || +port > 65535) {
  console.error('Pass --server <IPv4>:<port>, for example --server 203.0.113.5:7781 (the game does no DNS).');
  process.exit(1);
}
const repo = path.resolve(__dirname, '..');
const out = path.resolve(opt('--out') || path.join(repo, 'dist', 'Join OG SOS Classic.cmd'));
const tpl = fs.readFileSync(path.join(__dirname, 'join_classic.template.cmd'), 'utf8');
// cmd.exe needs CRLF line endings.
const text = tpl.replace(/__SERVER__/g, `${host}:${port}`).replace(/\r?\n/g, '\r\n');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text);
console.log(`Wrote ${out}\nSend it to your friends: they double-click it to play on ${host}:${port}.`);
