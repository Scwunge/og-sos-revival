/*
 * Shared by the loader (xinput1_3.dll) and the core (sos_client_core.dll): the signed-manifest format.
 *
 * manifest.json is one line of JSON written by tools/mod_update.js:
 *   {"product":"sos_client","version":3,"core":{"file":"core-3.dll","size":123456,"sha256":"<64 hex>"},"notes":"..."}
 * manifest.sig is the 128-hex-digit Ed25519 signature over the exact bytes of manifest.json.
 * Only the version, size, sha256 and file name are read, and only after the signature checked out.
 */
#ifndef SOS_UPDATE_COMMON_H
#define SOS_UPDATE_COMMON_H

#include <windows.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "ed25519.h"
#include "update_pubkey.h"

typedef struct {
    unsigned long version;
    unsigned long size;
    uint8_t sha[32];
    char file[64];
} UpdManifest;

/* Whole file into a malloc'd buffer (NUL-terminated copy). Returns NULL on failure or if larger than max. */
static uint8_t *upd_read_file(const wchar_t *path, size_t max, size_t *len)
{
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    LARGE_INTEGER sz;
    uint8_t *buf = NULL;
    if (GetFileSizeEx(h, &sz) && sz.QuadPart >= 0 && (uint64_t)sz.QuadPart <= max) {
        buf = (uint8_t *)malloc((size_t)sz.QuadPart + 1);
        DWORD got = 0;
        if (buf && (!ReadFile(h, buf, (DWORD)sz.QuadPart, &got, NULL) || got != (DWORD)sz.QuadPart)) { free(buf); buf = NULL; }
        if (buf) { buf[sz.QuadPart] = 0; *len = (size_t)sz.QuadPart; }
    }
    CloseHandle(h);
    return buf;
}

static int upd_write_file(const wchar_t *path, const void *data, size_t len)
{
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    DWORD put = 0;
    int ok = WriteFile(h, data, (DWORD)len, &put, NULL) && put == (DWORD)len;
    CloseHandle(h);
    if (!ok) DeleteFileW(path);
    return ok;
}

static int upd_hexval(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Decode exactly n bytes of hex from s (trailing whitespace allowed). */
static int upd_hex(const char *s, uint8_t *out, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        int a = upd_hexval(s[2 * i]), b = a < 0 ? -1 : upd_hexval(s[2 * i + 1]);
        if (a < 0 || b < 0) return 0;
        out[i] = (uint8_t)(a * 16 + b);
    }
    for (size_t i = 2 * n; s[i]; i++) if (s[i] != '\r' && s[i] != '\n' && s[i] != ' ') return 0;
    return 1;
}

static int upd_zero_key(const uint8_t *k)
{
    for (int i = 0; i < 32; i++) if (k[i]) return 0;
    return 1;
}

/* 1 when sig_hex is a valid signature of msg under either compiled-in key. */
static int upd_verify(const uint8_t *msg, size_t len, const char *sig_hex)
{
    uint8_t sig[64];
    if (!upd_hex(sig_hex, sig, 64)) return 0;
    for (int k = 0; k < 2; k++) {
        if (upd_zero_key(UPDATE_PUBKEY[k])) continue;
        if (ed25519_verify(sig, msg, len, UPDATE_PUBKEY[k])) return 1;
    }
    return 0;
}

/* Value of the first  "key":  in a flat JSON text (numbers or strings); the manifest is ours and signed. */
static const char *upd_find(const char *json, const char *key)
{
    char pat[48];
    size_t kl = strlen(key);
    if (kl > 40) return NULL;
    pat[0] = '"';
    memcpy(pat + 1, key, kl);
    pat[kl + 1] = '"';
    pat[kl + 2] = ':';
    pat[kl + 3] = 0;
    const char *p = strstr(json, pat);
    return p ? p + kl + 3 : NULL;
}

/* Parses an already-verified manifest. 1 on success. */
static int upd_parse(const char *json, UpdManifest *m)
{
    memset(m, 0, sizeof *m);
    const char *p = upd_find(json, "product");
    if (!p || strncmp(p, "\"sos_client\"", 12) != 0) return 0;
    if (!(p = upd_find(json, "version"))) return 0;
    m->version = strtoul(p, NULL, 10);
    if (!(p = upd_find(json, "size"))) return 0;
    m->size = strtoul(p, NULL, 10);
    if (!(p = upd_find(json, "sha256")) || *p != '"') return 0;
    char hx[65];
    if (strnlen(p + 1, 65) < 65 || p[65] != '"') return 0;
    memcpy(hx, p + 1, 64);
    hx[64] = 0;
    if (!upd_hex(hx, m->sha, 32)) return 0;
    if (!(p = upd_find(json, "file")) || *p != '"') return 0;
    size_t n = 0;
    for (p++; *p && *p != '"' && n < sizeof m->file - 1; p++, n++) {
        char c = *p;
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_')) return 0;
        m->file[n] = c;
    }
    if (*p != '"' || n == 0 || m->file[0] == '.') return 0;
    m->file[n] = 0;
    return m->version > 0 && m->size > 0 && m->size <= 16u * 1024 * 1024;
}

/* Reads manifest + signature files, verifies, parses. 1 only when the signature is valid. */
static int upd_load_manifest(const wchar_t *mpath, const wchar_t *spath, UpdManifest *m)
{
    size_t ml = 0, sl = 0;
    uint8_t *mb = upd_read_file(mpath, 4096, &ml);
    uint8_t *sb = upd_read_file(spath, 512, &sl);
    int ok = 0;
    if (mb && sb && ml > 0) ok = upd_verify(mb, ml, (const char *)sb) && upd_parse((const char *)mb, m);
    free(mb);
    free(sb);
    return ok;
}

/* 1 when the file's size and SHA-256 match the manifest. */
__attribute__((unused)) static int upd_check_file(const wchar_t *path, const UpdManifest *m)
{
    size_t len = 0;
    uint8_t *b = upd_read_file(path, 16u * 1024 * 1024, &len);
    if (!b) return 0;
    uint8_t h[32];
    sha256(b, len, h);
    free(b);
    return len == m->size && memcmp(h, m->sha, 32) == 0;
}

#endif
