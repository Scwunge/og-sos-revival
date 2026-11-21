/* Tests for ed25519.c. Usage: ed25519_test [cases-file]
 * cases-file: lines of "pkhex sighex msghex valid" from ed25519_gen.js. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../ed25519.h"

static int fails = 0, checks = 0;

#define CHECK(cond, ...)                                  \
    do {                                                  \
        checks++;                                         \
        if (!(cond)) {                                    \
            fails++;                                      \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);   \
            printf(__VA_ARGS__);                          \
            printf("\n");                                 \
        }                                                 \
    } while (0)

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* decode hex into out (cap bytes); returns byte count or -1 */
static int unhex(const char *s, size_t n, uint8_t *out, size_t cap)
{
    size_t i;
    if (n % 2 || n / 2 > cap) return -1;
    for (i = 0; i < n / 2; i++) {
        int a = hexval(s[2 * i]), b = hexval(s[2 * i + 1]);
        if (a < 0 || b < 0) return -1;
        out[i] = (uint8_t)(a * 16 + b);
    }
    return (int)(n / 2);
}

static void tohex(const uint8_t *p, size_t n, char *out)
{
    size_t i;
    for (i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", p[i]);
}

static void check_hash(const char *name, const uint8_t *d, size_t dl, const char *expect,
                       const uint8_t *msg, size_t len)
{
    char hex[129];
    (void)msg; (void)len;
    tohex(d, dl, hex);
    CHECK(strcmp(hex, expect) == 0, "%s: got %s", name, hex);
}

static void test_sha(void)
{
    uint8_t d[64];
    static uint8_t million[1000000];
    const char *abc = "abc";
    const char *two =
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    const char *two512 =
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";

    sha256((const uint8_t *)"", 0, d);
    check_hash("sha256 empty", d, 32, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 0, 0);
    sha256((const uint8_t *)abc, 3, d);
    check_hash("sha256 abc", d, 32, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", 0, 0);
    sha256((const uint8_t *)two, strlen(two), d);
    check_hash("sha256 448bit", d, 32, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", 0, 0);
    memset(million, 'a', sizeof million);
    sha256(million, sizeof million, d);
    check_hash("sha256 million a", d, 32, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0", 0, 0);

    sha512((const uint8_t *)"", 0, d);
    check_hash("sha512 empty", d, 64,
        "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e", 0, 0);
    sha512((const uint8_t *)abc, 3, d);
    check_hash("sha512 abc", d, 64,
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", 0, 0);
    sha512((const uint8_t *)two512, strlen(two512), d);
    check_hash("sha512 896bit", d, 64,
        "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909", 0, 0);
    sha512(million, sizeof million, d);
    check_hash("sha512 million a", d, 64,
        "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b", 0, 0);
}

static void rfc_case(int n, const char *pkh, const char *msgh, const char *sigh)
{
    uint8_t pk[32], sig[64], msg[8], t[64];
    int ml = unhex(msgh, strlen(msgh), msg, sizeof msg);
    CHECK(unhex(pkh, 64, pk, 32) == 32, "rfc%d pk hex", n);
    CHECK(unhex(sigh, 128, sig, 64) == 64, "rfc%d sig hex", n);
    CHECK(ml >= 0, "rfc%d msg hex", n);
    CHECK(ed25519_verify(sig, msg, (size_t)ml, pk) == 1, "rfc%d verify true", n);

    /* tampered message */
    if (ml > 0) {
        memcpy(t, msg, (size_t)ml);
        t[0] ^= 1;
        CHECK(ed25519_verify(sig, t, (size_t)ml, pk) == 0, "rfc%d tampered msg", n);
    } else {
        t[0] = 0;
        CHECK(ed25519_verify(sig, t, 1, pk) == 0, "rfc%d extended msg", n);
    }
    /* tampered signature: R half, then S half */
    memcpy(t, sig, 64);
    t[5] ^= 0x10;
    CHECK(ed25519_verify(t, msg, (size_t)ml, pk) == 0, "rfc%d tampered R", n);
    memcpy(t, sig, 64);
    t[40] ^= 0x01;
    CHECK(ed25519_verify(t, msg, (size_t)ml, pk) == 0, "rfc%d tampered S", n);
    /* tampered public key */
    {
        uint8_t p2[32];
        memcpy(p2, pk, 32);
        p2[3] ^= 0x04;
        CHECK(ed25519_verify(sig, msg, (size_t)ml, p2) == 0, "rfc%d tampered pk", n);
    }
}

static void test_rfc(void)
{
    rfc_case(1, "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
    rfc_case(2, "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00");
    rfc_case(3, "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
        "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a");
}

static void test_strict(void)
{
    uint8_t pk[32], sig[64], bad[32];
    int i;
    /* RFC 8032 test 1 with s replaced by s + L must be rejected (s >= L) */
    static const uint8_t L[32] = {
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10};
    unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", 64, pk, 32);
    unhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", 128, sig, 64);
    CHECK(ed25519_verify(sig, (const uint8_t *)"", 0, pk) == 1, "baseline");
    {
        int carry = 0;
        uint8_t s2[64];
        memcpy(s2, sig, 64);
        for (i = 0; i < 32; i++) {
            int v = s2[32 + i] + L[i] + carry;
            s2[32 + i] = (uint8_t)v;
            carry = v >> 8;
        }
        CHECK(carry == 0, "s+L fits");
        CHECK(ed25519_verify(s2, (const uint8_t *)"", 0, pk) == 0, "s+L rejected");
    }
    /* s == L exactly */
    memcpy(bad, L, 32);
    memcpy(sig + 32, bad, 32);
    CHECK(ed25519_verify(sig, (const uint8_t *)"", 0, pk) == 0, "s==L rejected");
    /* all 0xff s */
    memset(sig + 32, 0xff, 32);
    CHECK(ed25519_verify(sig, (const uint8_t *)"", 0, pk) == 0, "s=max rejected");

    /* non-decodable public key: y=2 is not on the curve (x^2 non-square) */
    memset(pk, 0, 32);
    pk[0] = 2;
    CHECK(ed25519_verify(sig, (const uint8_t *)"", 0, pk) == 0, "undecodable pk (y=2)");
    /* non-canonical y = p (0x7fff..ed), sign bit clear */
    memset(pk, 0xff, 32);
    pk[0] = 0xed;
    pk[31] = 0x7f;
    CHECK(ed25519_verify(sig, (const uint8_t *)"", 0, pk) == 0, "non-canonical y=p");
    /* x=0 with sign bit set: y=1, sign=1 */
    memset(pk, 0, 32);
    pk[0] = 1;
    pk[31] = 0x80;
    CHECK(ed25519_verify(sig, (const uint8_t *)"", 0, pk) == 0, "x=0 sign=1");
}

static void test_file(const char *path)
{
    FILE *f = fopen(path, "r");
    static char line[4096 + 4096];
    int ln = 0, ok = 0;
    if (!f) {
        CHECK(0, "cannot open cases file %s", path);
        return;
    }
    while (fgets(line, sizeof line, f)) {
        char *tok[4];
        char *p = line;
        uint8_t pk[32], sig[64], msg[2048];
        int k, ml, expect, got;
        ln++;
        for (k = 0; k < 4; k++) {
            tok[k] = p;
            while (*p && *p != ' ' && *p != '\n' && *p != '\r') p++;
            if (k < 3 && *p != ' ') break;
            if (*p) *p++ = 0;
        }
        if (k < 4) {
            if (tok[0][0] == 0) continue;
            CHECK(0, "line %d malformed", ln);
            continue;
        }
        CHECK(unhex(tok[0], strlen(tok[0]), pk, 32) == 32, "line %d pk", ln);
        CHECK(unhex(tok[1], strlen(tok[1]), sig, 64) == 64, "line %d sig", ln);
        ml = unhex(tok[2], strlen(tok[2]), msg, sizeof msg);
        CHECK(ml >= 0, "line %d msg", ln);
        expect = atoi(tok[3]);
        got = ed25519_verify(sig, msg, ml < 0 ? 0 : (size_t)ml, pk);
        CHECK(got == expect, "line %d expected %d got %d", ln, expect, got);
        if (got == expect) ok++;
    }
    fclose(f);
    CHECK(ln > 0, "cases file empty");
    printf("file cases: %d/%d lines matched\n", ok, ln);
}

int main(int argc, char **argv)
{
    test_sha();
    test_rfc();
    test_strict();
    if (argc > 1) test_file(argv[1]);
    else printf("note: no cases file given, node cross-check skipped\n");
    printf("%d checks, %d failures\n", checks, fails);
    return fails ? 1 : 0;
}
