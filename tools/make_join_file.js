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
// --hostname allows a DNS name for the backend endpoints (HTTP, matchmaking and stream sockets). The game
// servers' own address always comes from the backend as an IPv4 (PUBLIC_HOST), so only the backend name is
// looked up by the client. Verify with a real join before handing such a file out.
const allowName = args.includes('--hostname') && /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
if (!(net.isIPv4(host) || allowName) || !/^\d+$/.test(port) || +port < 1 || +port > 65535) {
  console.error('Pass --server <IPv4>:<port>, for example --server 203.0.113.5:7781 (or a DNS name with --hostname).');
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
