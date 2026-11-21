// Emits random Ed25519 cases as lines: pkhex sighex msghex valid(1/0)
// usage: node ed25519_gen.js [outfile] [count]
const crypto = require('crypto');
const fs = require('fs');

const out = process.argv[2] || 'ed25519_cases.txt';
const count = parseInt(process.argv[3] || '40', 10);
const lines = [];

function flip(buf, i, bit) {
  const b = Buffer.from(buf);
  b[i % b.length] ^= 1 << (bit & 7);
  return b;
}

for (let n = 0; n < count; n++) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pk = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const len = n === 0 ? 0 : crypto.randomInt(0, 400);
  const msg = crypto.randomBytes(len);
  const sig = crypto.sign(null, msg, privateKey);
  const emit = (p, s, m, v) => lines.push(`${p.toString('hex')} ${s.toString('hex')} ${m.toString('hex')} ${v}`);

  emit(pk, sig, msg, 1);
  emit(pk, sig, len ? flip(msg, crypto.randomInt(0, len), crypto.randomInt(0, 8)) : Buffer.from([0]), 0);
  emit(pk, flip(sig, crypto.randomInt(0, 64), crypto.randomInt(0, 8)), msg, 0);
  emit(flip(pk, crypto.randomInt(0, 32), crypto.randomInt(0, 8)), sig, msg, 0);
  // wrong key entirely
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  emit(other, sig, msg, 0);
  // s + L malleability: same signature with s replaced by s+L must be rejected
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]);
  const s2 = s + L;
  if (s2 < (1n << 256n)) {
    const m = Buffer.from(sig);
    let t = s2;
    for (let i = 0; i < 32; i++) { m[32 + i] = Number(t & 0xffn); t >>= 8n; }
    emit(pk, m, msg, 0);
  }
}

fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} cases to ${out}`);
