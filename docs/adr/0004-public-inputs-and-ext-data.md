# ADR-0004: Public inputs, ext_data binding and public_amount

- Status: accepted (M1/M2)
- Date: 2026-11-03

## Decision

1. **One Groth16 public input.** `pi_hash = H_11(T_PI, root, nf0, nf1, cm0,
   cm1, public_amount, public_asset_id, ext_data_hash, program_id,
   program_io_hash)`. The pool recomputes it from instruction data with one
   `sol_poseidon` call and builds the verifier's public witness itself. A
   client-supplied public witness is never accepted. The design said "two
   field elements"; one suffices because every value fits in a single
   11-input Poseidon. Each extra public input costs one G1 scalar
   multiplication in the verifier.
2. **`ext_data_hash`** is SHA-256 over a fixed little-endian/byte layout (spec
   §7) with the first byte zeroed, giving 248 bits, always a canonical field
   element. It binds:
   - pool id (the pool PDA) and chain domain, against cross-pool and
     cross-cluster replay;
   - the public token account (depositor source or withdraw destination);
   - the relayer fee account, `ext_amount` and `fee`;
   - `not_before_slot`;
   - the SHA-256 of each output ciphertext.

   SHA-256 is cheap on-chain (`sol_sha256`), and the circuit only needs the
   digest.
3. **`public_amount = ext_amount − fee`** (Tornado-Nova style) is computed by
   the pool, not supplied by the client. The circuit enforces
   `Σin + public_amount = Σout`. The pool requires `|ext_amount| < 2^62` and
   `fee < 2^62`, and the circuit independently enforces
   `public_amount ∈ [−2^64, 2^64)` (K2), so no term can wrap.
4. **`public_asset_id`** is set by the pool to the pool's
   `asset_id = H_3(T_ASSET, mint_hi, mint_lo)` whenever tokens move
   (`ext_amount ≠ 0 or fee ≠ 0`), else 0. K9 forces the note asset to match
   when it is non-zero, and forbids `public_amount ≠ 0` with a hidden asset.
   With one pool per mint in the MVP, the asset is public anyway. The rule is
   written so that a later multi-asset tree hides the asset for internal
   transfers without a fee.
5. **Root history:** a ring of 128 roots, with pair insertion (both outputs
   at an even index) so an action costs 26 Poseidon calls, not 52.

## Consequences

- Any change to the instruction layout must be mirrored in `ExtData::bytes`.
  This is covered by `spec/vectors/ext_data.json`, which the pool tests check.
- Groth16 proofs are malleable. Nothing is keyed on proof bytes; nullifier
  PDAs are the only uniqueness guarantee.
