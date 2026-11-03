# ADR-0003: Key derivation and the poly1 address payload

- Status: accepted (M1); resolves the "Open item" in design §3.2 *Address formats*
- Date: 2026-11-03

## Context

The design gives `owner = Poseidon(DS_addr, ak, nk)` and a 43-byte `poly1`
payload `d (11) ‖ pk_d (32)`, with an open item: *the note's owner field must
be derivable from (d, pk_d) for this payload to be sufficient; otherwise the
payload has to carry owner as well.*

A sender builds the output commitment, so the sender must know `owner`.
`pk_d` is an X25519 key. Making `owner` a function of `pk_d` alone would mean
either:
- proving X25519 (Curve25519) arithmetic inside a BN254 circuit, which is
  non-native and very expensive; or
- moving note encryption to an embedded curve (Grumpkin/Baby Jubjub) and
  proving `pk_d = ivk·G_d` in-circuit, Sapling-style. That is a larger
  redesign and adds an in-circuit scalar multiplication per input.

## Decision

1. **Derivation** (spec §3): from a 32-byte seed,
   - `ask` and `nk` via SHA-512 wide reduction;
   - `ivk` and the diversifier key `dk` via SHA-256 (domain-separated labels);
   - `ak = H_2(T_AK, ask)`;
   - `d_j = SHA-256("polypus.div.v1" ‖ dk ‖ j)[..11]`;
   - **`owner_j = H_4(T_OWNER, ak, nk, d_j)`**. Including `d` makes owners of
     different diversified addresses unlinkable, which is the point of
     diversifiers. The kernel takes `d` as a private input per spent note.
   - `pk_d = X25519(ivk, G_d)`, where `G_d` is a try-and-increment hash to
     Curve25519 (cofactor-cleared). This gives the Sapling property that one
     `ivk` decrypts notes to every diversified address. `d` is public, so the
     variable-time hash is acceptable.
2. **The address carries `owner`.** Payload v1 is
   `0x01 ‖ d (11) ‖ pk_d (32) ‖ owner (32)` = 76 bytes, giving a 133-character
   `poly1q…` string.
3. **A version byte is added** (`0x01`). It encodes as `q`, so v1 strings
   start `poly1q…`, consistent with the doc's examples. A future payload, for
   example an embedded-curve `pk_d` from which `owner` *is* derivable, gets a
   new version byte, not a new HRP.
4. **bech32m with the 90-character limit lifted**, as the doc already does for
   `polyview1` and as Zcash does for unified addresses. Decoders are strict:
   bech32m only (a bech32 checksum is rejected), exact length, version byte,
   and canonical field encodings.
5. `polyview1` = `0x01 ‖ ak ‖ nk ‖ ivk` (97 bytes, 170 chars). `polyivk1` =
   `0x01 ‖ ivk` (33 bytes, 67 chars).

## Consequences

- Addresses are longer than the doc's 80-character estimate (133). The
  display rules (truncate to `poly1` + 6 + `…` + 6) are unaffected.
- The address is *not* self-authenticating. A sender cannot check that
  `owner` and `pk_d` belong together, so a malformed address makes notes the
  recipient can decrypt but not spend, or the reverse. This is the same
  failure as a typo; wallets should only produce addresses from keys. The
  embedded-curve design (address v2) would close this gap and is worth
  revisiting with note encryption in M4.
- The kernel proves knowledge of `ask` directly (no spend-auth signature), so
  hardware wallets cannot keep `ask` off the proving device (design Q7).
- Note encryption (X25519 + HKDF + ChaCha20-Poly1305) is M4. M1 implements
  and tests only the key agreement.
