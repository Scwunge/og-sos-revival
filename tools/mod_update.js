#!/usr/bin/env node
'use strict';
// Release tool for the SOS: Classic client mod self-update (docs/CLIENT_MOD.md, "Self-update").
//
//   node tools/mod_update.js keygen
//       Creates an Ed25519 signing key at %USERPROFILE%\.ogsos\update-signing.key (never inside a repo; refuses to
//       overwrite) and writes the PUBLIC key to mod/sos_client/update_pubkey.h (commit that file, nothing else).
//   node tools/mod_update.js sign <core.dll> <version> [outDir] [notes]
//       Writes outDir/manifest.json, outDir/manifest.sig (hex, signs the exact bytes of manifest.json) and
//       outDir/core-<version>.dll. Copy the three files into the backend's mod directory (data/mod).
//   node tools/mod_update.js verify <manifestFile> <sigFile>
//       Checks a manifest against the committed public key (what the loader does).
//
// The key path can be overridden with OGSOS_UPDATE_KEY (for tests only).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KEY = process.env.OGSOS_UPDATE_KEY || path.join(process.env.USERPROFILE || os.homedir(), '.ogsos', 'update-signing.key');
const HDR = path.join(__dirname, '..', 'mod', 'sos_client', 'update_pubkey.h');

function pubHexOf(pubObj) {
  const der = pubObj.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('hex');   // SPKI for Ed25519 ends with the raw 32-byte key
}
function loadPriv() { return crypto.createPrivateKey(fs.readFileSync(KEY)); }

function writeHeader(hex) {
  const bytes = hex.match(/../g).map((b) => '0x' + b).join(', ');
  fs.writeFileSync(HDR,
    '/* Public half of the update signing key (tools/mod_update.js keygen). The private key lives outside every repo. */\n' +
    '/* Slot 1 is the active key; slot 2 is for rotation (all zero = unused). */\n' +
    `static const unsigned char UPDATE_PUBKEY[2][32] = {\n    { ${bytes} },\n    { 0 }\n};\n`);
}

const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'keygen') {
  if (fs.existsSync(KEY)) { console.error('refusing to overwrite ' + KEY); process.exit(1); }
  const abs = path.resolve(KEY).toLowerCase();
  const repo = path.resolve(__dirname, '..').toLowerCase();
  if (abs.startsWith(repo)) { console.error('key path is inside the repo: ' + KEY); process.exit(1); }
  fs.mkdirSync(path.dirname(KEY), { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const hex = pubHexOf(publicKey);
  writeHeader(hex);
  console.log('private key written to ' + KEY + ' (keep it out of every repo)');
  console.log('public key ' + hex + ' written to ' + HDR);
} else if (cmd === 'sign') {
  const [core, ver, outDir = 'dist-mod', notes = ''] = a;
  const version = parseInt(ver, 10);
  if (!core || !(version > 0)) { console.error('usage: sign <core.dll> <version> [outDir] [notes]'); process.exit(1); }
  const bin = fs.readFileSync(core);
  const file = `core-${version}.dll`;
  const manifest = JSON.stringify({
    product: 'sos_client', version,
    core: { file, size: bin.length, sha256: crypto.createHash('sha256').update(bin).digest('hex') },
    notes: String(notes).slice(0, 200),
  });
  const sig = crypto.sign(null, Buffer.from(manifest), loadPriv());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(outDir, 'manifest.sig'), sig.toString('hex'));
  fs.writeFileSync(path.join(outDir, file), bin);
  console.log(`signed v${version}: ${path.join(outDir, 'manifest.json')} (${bin.length} bytes core)`);
} else if (cmd === 'verify') {
  const m = fs.readFileSync(a[0]);
  const sig = Buffer.from(fs.readFileSync(a[1], 'utf8').trim(), 'hex');
  const src = fs.readFileSync(HDR, 'utf8');
  const hex = (src.match(/\{ ((?:0x[0-9a-f]{2}(?:, )?){32}) \}/) || [])[1];
  if (!hex) { console.error('no key in header'); process.exit(1); }
  const raw = Buffer.from(hex.split(', ').map((h) => parseInt(h, 16)));
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  const ok = crypto.verify(null, m, crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig);
  console.log(ok ? 'signature OK' : 'signature BAD');
  process.exit(ok ? 0 : 1);
} else {
  console.error('commands: keygen | sign <core.dll> <version> [outDir] [notes] | verify <manifest> <sig>');
  process.exit(1);
}
