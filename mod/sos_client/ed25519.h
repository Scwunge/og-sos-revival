/* ed25519.h - SHA-256, SHA-512 and Ed25519 signature verification (verify only).
 * Self-contained, no heap, no globals needing init. Public domain style;
 * field arithmetic follows the TweetNaCl design (public domain). */
#ifndef ED25519_H
#define ED25519_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* SHA-256 of msg[0..len) into out[32]. */
void sha256(const uint8_t *msg, size_t len, uint8_t out[32]);

/* SHA-512 of msg[0..len) into out[64]. */
void sha512(const uint8_t *msg, size_t len, uint8_t out[64]);

/* Returns 1 if sig is a valid Ed25519 signature of msg under pk, else 0.
 * Strict: rejects s >= L and public keys that do not decode to a curve point. */
int ed25519_verify(const uint8_t sig[64], const uint8_t *msg, size_t len,
                   const uint8_t pk[32]);

#ifdef __cplusplus
}
#endif

#endif
