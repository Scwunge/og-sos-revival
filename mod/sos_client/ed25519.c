/* ed25519.c - SHA-256, SHA-512 and Ed25519 verification. See ed25519.h.
 * Public domain style. Curve arithmetic is derived from TweetNaCl. */
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "ed25519.h"

/* ---------------------------------------------------------------- SHA-256 */

static const uint32_t K256[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
    0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
    0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
    0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

#define ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(uint32_t hs[8], const uint8_t *p)
{
    uint32_t w[64], a, b, d, e, f, g, h, cc, t1, t2;
    int i;
    for (i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[4 * i] << 24) | ((uint32_t)p[4 * i + 1] << 16) |
               ((uint32_t)p[4 * i + 2] << 8) | (uint32_t)p[4 * i + 3];
    for (i = 16; i < 64; i++) {
        uint32_t s0 = ROR32(w[i - 15], 7) ^ ROR32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROR32(w[i - 2], 17) ^ ROR32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = hs[0]; b = hs[1]; cc = hs[2]; d = hs[3];
    e = hs[4]; f = hs[5]; g = hs[6]; h = hs[7];
    for (i = 0; i < 64; i++) {
        t1 = h + (ROR32(e, 6) ^ ROR32(e, 11) ^ ROR32(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i];
        t2 = (ROR32(a, 2) ^ ROR32(a, 13) ^ ROR32(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc));
        h = g; g = f; f = e; e = d + t1;
        d = cc; cc = b; b = a; a = t1 + t2;
    }
    hs[0] += a; hs[1] += b; hs[2] += cc; hs[3] += d;
    hs[4] += e; hs[5] += f; hs[6] += g; hs[7] += h;
}

void sha256(const uint8_t *msg, size_t len, uint8_t out[32])
{
    uint32_t hs[8];
    uint8_t buf[64];
    size_t i;
    uint64_t bits = (uint64_t)len * 8;

    hs[0] = 0x6a09e667u; hs[1] = 0xbb67ae85u; hs[2] = 0x3c6ef372u; hs[3] = 0xa54ff53au;
    hs[4] = 0x510e527fu; hs[5] = 0x9b05688cu; hs[6] = 0x1f83d9abu; hs[7] = 0x5be0cd19u;
    while (len >= 64) {
        sha256_block(hs, msg);
        msg += 64;
        len -= 64;
    }
    memset(buf, 0, sizeof buf);
    if (len) memcpy(buf, msg, len);
    buf[len] = 0x80;
    if (len >= 56) {
        sha256_block(hs, buf);
        memset(buf, 0, sizeof buf);
    }
    for (i = 0; i < 8; i++) buf[56 + i] = (uint8_t)(bits >> (56 - 8 * i));
    sha256_block(hs, buf);
    for (i = 0; i < 8; i++) {
        out[4 * i] = (uint8_t)(hs[i] >> 24);
        out[4 * i + 1] = (uint8_t)(hs[i] >> 16);
        out[4 * i + 2] = (uint8_t)(hs[i] >> 8);
        out[4 * i + 3] = (uint8_t)hs[i];
    }
}

/* ---------------------------------------------------------------- SHA-512 */

static const uint64_t K512[80] = {
    0x428a2f98d728ae22ull, 0x7137449123ef65cdull, 0xb5c0fbcfec4d3b2full,
    0xe9b5dba58189dbbcull, 0x3956c25bf348b538ull, 0x59f111f1b605d019ull,
    0x923f82a4af194f9bull, 0xab1c5ed5da6d8118ull, 0xd807aa98a3030242ull,
    0x12835b0145706fbeull, 0x243185be4ee4b28cull, 0x550c7dc3d5ffb4e2ull,
    0x72be5d74f27b896full, 0x80deb1fe3b1696b1ull, 0x9bdc06a725c71235ull,
    0xc19bf174cf692694ull, 0xe49b69c19ef14ad2ull, 0xefbe4786384f25e3ull,
    0x0fc19dc68b8cd5b5ull, 0x240ca1cc77ac9c65ull, 0x2de92c6f592b0275ull,
    0x4a7484aa6ea6e483ull, 0x5cb0a9dcbd41fbd4ull, 0x76f988da831153b5ull,
    0x983e5152ee66dfabull, 0xa831c66d2db43210ull, 0xb00327c898fb213full,
    0xbf597fc7beef0ee4ull, 0xc6e00bf33da88fc2ull, 0xd5a79147930aa725ull,
    0x06ca6351e003826full, 0x142929670a0e6e70ull, 0x27b70a8546d22ffcull,
    0x2e1b21385c26c926ull, 0x4d2c6dfc5ac42aedull, 0x53380d139d95b3dfull,
    0x650a73548baf63deull, 0x766a0abb3c77b2a8ull, 0x81c2c92e47edaee6ull,
    0x92722c851482353bull, 0xa2bfe8a14cf10364ull, 0xa81a664bbc423001ull,
    0xc24b8b70d0f89791ull, 0xc76c51a30654be30ull, 0xd192e819d6ef5218ull,
    0xd69906245565a910ull, 0xf40e35855771202aull, 0x106aa07032bbd1b8ull,
    0x19a4c116b8d2d0c8ull, 0x1e376c085141ab53ull, 0x2748774cdf8eeb99ull,
    0x34b0bcb5e19b48a8ull, 0x391c0cb3c5c95a63ull, 0x4ed8aa4ae3418acbull,
    0x5b9cca4f7763e373ull, 0x682e6ff3d6b2b8a3ull, 0x748f82ee5defb2fcull,
    0x78a5636f43172f60ull, 0x84c87814a1f0ab72ull, 0x8cc702081a6439ecull,
    0x90befffa23631e28ull, 0xa4506cebde82bde9ull, 0xbef9a3f7b2c67915ull,
    0xc67178f2e372532bull, 0xca273eceea26619cull, 0xd186b8c721c0c207ull,
    0xeada7dd6cde0eb1eull, 0xf57d4f7fee6ed178ull, 0x06f067aa72176fbaull,
    0x0a637dc5a2c898a6ull, 0x113f9804bef90daeull, 0x1b710b35131c471bull,
    0x28db77f523047d84ull, 0x32caab7b40c72493ull, 0x3c9ebe0a15c9bebcull,
    0x431d67c49c100d4cull, 0x4cc5d4becb3e42b6ull, 0x597f299cfc657e2aull,
    0x5fcb6fab3ad6faecull, 0x6c44198c4a475817ull
};

#define ROR64(x, n) (((x) >> (n)) | ((x) << (64 - (n))))

typedef struct {
    uint64_t h[8];
    uint8_t buf[128];
    uint64_t total;
    size_t fill;
} sha512_ctx;

static void sha512_init(sha512_ctx *c)
{
    c->h[0] = 0x6a09e667f3bcc908ull;
    c->h[1] = 0xbb67ae8584caa73bull;
    c->h[2] = 0x3c6ef372fe94f82bull;
    c->h[3] = 0xa54ff53a5f1d36f1ull;
    c->h[4] = 0x510e527fade682d1ull;
    c->h[5] = 0x9b05688c2b3e6c1full;
    c->h[6] = 0x1f83d9abfb41bd6bull;
    c->h[7] = 0x5be0cd19137e2179ull;
    c->total = 0;
    c->fill = 0;
}

static void sha512_block(sha512_ctx *c, const uint8_t *p)
{
    uint64_t w[80], a, b, cc, d, e, f, g, h, t1, t2;
    int i, j;
    for (i = 0; i < 16; i++) {
        w[i] = 0;
        for (j = 0; j < 8; j++) w[i] = (w[i] << 8) | p[8 * i + j];
    }
    for (i = 16; i < 80; i++) {
        uint64_t s0 = ROR64(w[i - 15], 1) ^ ROR64(w[i - 15], 8) ^ (w[i - 15] >> 7);
        uint64_t s1 = ROR64(w[i - 2], 19) ^ ROR64(w[i - 2], 61) ^ (w[i - 2] >> 6);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = c->h[0]; b = c->h[1]; cc = c->h[2]; d = c->h[3];
    e = c->h[4]; f = c->h[5]; g = c->h[6]; h = c->h[7];
    for (i = 0; i < 80; i++) {
        t1 = h + (ROR64(e, 14) ^ ROR64(e, 18) ^ ROR64(e, 41)) + ((e & f) ^ (~e & g)) + K512[i] + w[i];
        t2 = (ROR64(a, 28) ^ ROR64(a, 34) ^ ROR64(a, 39)) + ((a & b) ^ (a & cc) ^ (b & cc));
        h = g; g = f; f = e; e = d + t1;
        d = cc; cc = b; b = a; a = t1 + t2;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += cc; c->h[3] += d;
    c->h[4] += e; c->h[5] += f; c->h[6] += g; c->h[7] += h;
}

static void sha512_update(sha512_ctx *c, const uint8_t *m, size_t len)
{
    c->total += len;
    while (len) {
        size_t n = 128 - c->fill;
        if (n > len) n = len;
        memcpy(c->buf + c->fill, m, n);
        c->fill += n;
        m += n;
        len -= n;
        if (c->fill == 128) {
            sha512_block(c, c->buf);
            c->fill = 0;
        }
    }
}

static void sha512_final(sha512_ctx *c, uint8_t out[64])
{
    uint64_t bits = c->total * 8;
    int i;
    c->buf[c->fill++] = 0x80;
    if (c->fill > 112) {
        memset(c->buf + c->fill, 0, 128 - c->fill);
        sha512_block(c, c->buf);
        c->fill = 0;
    }
    memset(c->buf + c->fill, 0, 128 - c->fill);
    for (i = 0; i < 8; i++) c->buf[120 + i] = (uint8_t)(bits >> (56 - 8 * i));
    sha512_block(c, c->buf);
    for (i = 0; i < 64; i++) out[i] = (uint8_t)(c->h[i / 8] >> (56 - 8 * (i % 8)));
}

void sha512(const uint8_t *msg, size_t len, uint8_t out[64])
{
    sha512_ctx c;
    sha512_init(&c);
    sha512_update(&c, msg, len);
    sha512_final(&c, out);
}

/* ---------------------------------------------------------------- Ed25519 */

typedef int64_t gf[16];

static const gf gf0 = {0};
static const gf gf1 = {1};
static const gf D = {0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070,
                     0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203};
static const gf D2 = {0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0,
                      0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406};
static const gf GX = {0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c,
                      0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169};
static const gf GY = {0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666,
                      0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666};
static const gf SQRTM1 = {0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43,
                          0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83};

/* group order L, little endian */
static const uint8_t LORD[32] = {
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10};

static void set25519(gf r, const gf a)
{
    int i;
    for (i = 0; i < 16; i++) r[i] = a[i];
}

static void car25519(gf o)
{
    int i;
    int64_t c;
    for (i = 0; i < 16; i++) {
        o[i] += (int64_t)1 << 16;
        c = o[i] >> 16;
        o[(i + 1) * (i < 15)] += c - 1 + 37 * (c - 1) * (i == 15);
        o[i] -= c * ((int64_t)1 << 16);
    }
}

static void sel25519(gf p, gf q, int b)
{
    int64_t t, c = ~((int64_t)b - 1);
    int i;
    for (i = 0; i < 16; i++) {
        t = c & (p[i] ^ q[i]);
        p[i] ^= t;
        q[i] ^= t;
    }
}

static void pack25519(uint8_t *o, const gf n)
{
    int i, j, b;
    gf m, t;
    for (i = 0; i < 16; i++) t[i] = n[i];
    car25519(t);
    car25519(t);
    car25519(t);
    for (j = 0; j < 2; j++) {
        m[0] = t[0] - 0xffed;
        for (i = 1; i < 15; i++) {
            m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
            m[i - 1] &= 0xffff;
        }
        m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
        b = (int)((m[15] >> 16) & 1);
        m[14] &= 0xffff;
        sel25519(t, m, 1 - b);
    }
    for (i = 0; i < 16; i++) {
        o[2 * i] = (uint8_t)(t[i] & 0xff);
        o[2 * i + 1] = (uint8_t)(t[i] >> 8);
    }
}

/* returns 0 if equal, nonzero otherwise (constant time) */
static int neq25519(const gf a, const gf b)
{
    uint8_t c[32], d[32];
    unsigned v = 0;
    int i;
    pack25519(c, a);
    pack25519(d, b);
    for (i = 0; i < 32; i++) v |= (unsigned)(c[i] ^ d[i]);
    return v != 0;
}

static int par25519(const gf a)
{
    uint8_t d[32];
    pack25519(d, a);
    return d[0] & 1;
}

static void unpack25519(gf o, const uint8_t *n)
{
    int i;
    for (i = 0; i < 16; i++) o[i] = n[2 * i] + ((int64_t)n[2 * i + 1] << 8);
    o[15] &= 0x7fff;
}

static void A(gf o, const gf a, const gf b)
{
    int i;
    for (i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

static void Z(gf o, const gf a, const gf b)
{
    int i;
    for (i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

static void M(gf o, const gf a, const gf b)
{
    int64_t t[31];
    int i, j;
    for (i = 0; i < 31; i++) t[i] = 0;
    for (i = 0; i < 16; i++)
        for (j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
    for (i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
    for (i = 0; i < 16; i++) o[i] = t[i];
    car25519(o);
    car25519(o);
}

static void S(gf o, const gf a)
{
    M(o, a, a);
}

static void pow2523(gf o, const gf i)
{
    gf c;
    int a;
    set25519(c, i);
    for (a = 250; a >= 0; a--) {
        S(c, c);
        if (a != 1) M(c, c, i);
    }
    set25519(o, c);
}

static void add(gf p[4], gf q[4])
{
    gf a, b, c, d, t, e, f, g, h;
    Z(a, p[1], p[0]);
    Z(t, q[1], q[0]);
    M(a, a, t);
    A(b, p[0], p[1]);
    A(t, q[0], q[1]);
    M(b, b, t);
    M(c, p[3], q[3]);
    M(c, c, D2);
    M(d, p[2], q[2]);
    A(d, d, d);
    Z(e, b, a);
    Z(f, d, c);
    A(g, d, c);
    A(h, b, a);
    M(p[0], e, f);
    M(p[1], h, g);
    M(p[2], g, f);
    M(p[3], e, h);
}

static void cswap(gf p[4], gf q[4], int b)
{
    int i;
    for (i = 0; i < 4; i++) sel25519(p[i], q[i], b);
}

static void inv25519(gf o, const gf i)
{
    gf c;
    int a;
    set25519(c, i);
    for (a = 253; a >= 0; a--) {
        S(c, c);
        if (a != 2 && a != 4) M(c, c, i);
    }
    set25519(o, c);
}

static void pack_point(uint8_t *r, gf p[4])
{
    gf tx, ty, zi;
    inv25519(zi, p[2]);
    M(tx, p[0], zi);
    M(ty, p[1], zi);
    pack25519(r, ty);
    r[31] ^= (uint8_t)(par25519(tx) << 7);
}

static void scalarmult(gf p[4], gf q[4], const uint8_t *s)
{
    int i;
    set25519(p[0], gf0);
    set25519(p[1], gf1);
    set25519(p[2], gf1);
    set25519(p[3], gf0);
    for (i = 255; i >= 0; --i) {
        int b = (s[i / 8] >> (i & 7)) & 1;
        cswap(p, q, b);
        add(q, p);
        add(p, p);
        cswap(p, q, b);
    }
}

static void scalarbase(gf p[4], const uint8_t *s)
{
    gf q[4];
    set25519(q[0], GX);
    set25519(q[1], GY);
    set25519(q[2], gf1);
    M(q[3], GX, GY);
    scalarmult(p, q, s);
}

/* Decode public key and negate it. Returns 0 on success, -1 if the encoding
 * is non-canonical or not a point on the curve. */
static int unpackneg(gf r[4], const uint8_t p[32])
{
    gf t, chk, num, den, den2, den4, den6;
    uint8_t canon[32];
    unsigned v;
    int i;
    int sign = p[31] >> 7;

    set25519(r[2], gf1);
    unpack25519(r[1], p);
    /* canonical y: re-encoding must reproduce the input (sign bit aside) */
    pack25519(canon, r[1]);
    v = (unsigned)(canon[31] ^ (p[31] & 0x7f));
    for (i = 0; i < 31; i++) v |= (unsigned)(canon[i] ^ p[i]);
    if (v) return -1;

    S(num, r[1]);
    M(den, num, D);
    Z(num, num, r[2]);
    A(den, r[2], den);

    S(den2, den);
    S(den4, den2);
    M(den6, den4, den2);
    M(t, den6, num);
    M(t, t, den);

    pow2523(t, t);
    M(t, t, num);
    M(t, t, den);
    M(t, t, den);
    M(r[0], t, den);

    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) M(r[0], r[0], SQRTM1);

    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) return -1;

    /* x == 0 with the sign bit set is not a valid encoding */
    if (sign && !neq25519(r[0], gf0)) return -1;

    if (par25519(r[0]) == sign) Z(r[0], gf0, r[0]);
    M(r[3], r[0], r[1]);
    return 0;
}

/* reduce 64 limbs (little endian bytes in x[]) modulo L into r[32] */
static void modL(uint8_t *r, int64_t x[64])
{
    int64_t carry;
    int i, j;
    for (i = 63; i >= 32; --i) {
        carry = 0;
        for (j = i - 32; j < i - 12; ++j) {
            x[j] += carry - 16 * x[i] * LORD[j - (i - 32)];
            carry = (x[j] + 128) >> 8;
            x[j] -= carry * 256;
        }
        x[j] += carry;
        x[i] = 0;
    }
    carry = 0;
    for (j = 0; j < 32; j++) {
        x[j] += carry - (x[31] >> 4) * LORD[j];
        carry = x[j] >> 8;
        x[j] &= 255;
    }
    for (j = 0; j < 32; j++) x[j] -= carry * LORD[j];
    for (i = 0; i < 32; i++) {
        x[i + 1] += x[i] >> 8;
        r[i] = (uint8_t)(x[i] & 255);
    }
}

static void reduce64(uint8_t r[32], const uint8_t h[64])
{
    int64_t x[64];
    int i;
    for (i = 0; i < 64; i++) x[i] = h[i];
    modL(r, x);
}

/* returns 1 if little-endian s < L */
static int scalar_lt_L(const uint8_t s[32])
{
    int i;
    for (i = 31; i >= 0; i--) {
        if (s[i] < LORD[i]) return 1;
        if (s[i] > LORD[i]) return 0;
    }
    return 0; /* equal */
}

int ed25519_verify(const uint8_t sig[64], const uint8_t *msg, size_t len, const uint8_t pk[32])
{
    gf p[4], q[4];
    uint8_t h[64], k[32], t[32];
    sha512_ctx c;
    unsigned diff = 0;
    int i;

    if (!scalar_lt_L(sig + 32)) return 0;
    if (unpackneg(q, pk)) return 0;

    sha512_init(&c);
    sha512_update(&c, sig, 32);
    sha512_update(&c, pk, 32);
    if (len) sha512_update(&c, msg, len);
    sha512_final(&c, h);
    reduce64(k, h);

    scalarmult(p, q, k);
    scalarbase(q, sig + 32);
    add(p, q);
    pack_point(t, p);

    for (i = 0; i < 32; i++) diff |= (unsigned)(t[i] ^ sig[i]);
    return diff == 0;
}
