# ADR-0006: Pool program (M2 start) — framework, verifier, state layout

- Status: accepted for localnet; revisit before any shared devnet pool
- Date: 2026-11-03

## Decisions

1. **Anchor 1.2.2** (design §9.1), in a **separate Cargo workspace**
   (`programs/`) with its own lockfile. SBF builds use platform-tools Rust
   1.95, and the host crates must not pull them onto newer dependency
   versions. LiteSVM 0.18.1 tests pin the Agave runtime crates to 4.3.2,
   because the 4.4.0 crates broke API compatibility without a semver bump.
2. **Verifier: vendor Reilabs' `gnark-verifier-solana`** (Apache-2.0, commit
   `0a9f7d0`) as `programs/polypus-verifier`, rather than `groth16-solana`.
   Sunspot emits gnark proofs with BSB22 commitments, which this verifier
   parses natively. It was ported from solana-program 2.2 to the solana 3.x
   crates. Local changes, all listed in `NOTICE` and covered by tests:
   - precomputed −α/−γ/−δ;
   - syscall SHA-256;
   - a faster 48-byte hash-to-field reduction, checked against arkworks on
     more than 2,000 inputs;
   - rejection of mismatched VK shapes, non-canonical public inputs and wrong
     commitment counts.

   These changes cut a 1-commitment verify from 429,559 to 161,417 CU. **They
   are security-relevant and must be audited.**
3. **Kernel VK compiled in** by `build.rs` from `$POLYPUS_KERNEL_VK` (default
   `artifacts/dev/kernel.vk`). The build fails unless the VK has exactly 1
   public input. `init_pool` logs the VK's SHA-256. Known test VKs (the
   trivial circuit and the smoke test) trigger a DO-NOT-DEPLOY build warning.
4. **The public witness is built on-chain** from the recomputed `pi_hash`; the
   client never supplies it.
5. **State:**
   - `Pool` PDA `["pool", mint]`, one pool per mint (MVP);
   - zero-copy `Tree` PDA `["tree", pool]` (depth 26, filled subtrees, 128-root
     ring, about 5 KB);
   - vault token account PDA `["vault", pool]`;
   - nullifier PDAs `["nf", pool, nf]`. The pool key is added to the doc's
     `["nf", nf]` so that two pools never share a nullifier namespace.
6. **One core for three instructions** (`deposit`, `transact`, `withdraw`).
   Each instruction fixes the sign of `ext_amount` and its account set. A
   relayer token account must be present **iff** `fee > 0`. `program_id` and
   `program_io_hash` are hard-coded to 0, because program actions are M3.
7. **Program id** `PoLyMJzp2sUxqEguNkpK5nvtJJna2UECSod7q9UWCVu`. The doc asked
   for a `PoLY…` vanity id, which the grind did not find in 12 minutes; `PoLy`
   was found instantly. The keypair is git-ignored. A shared devnet
   deployment should grind a proper `PoLY` id and hold the upgrade authority
   in a multisig.

## Known gaps (must close before a shared devnet pool)

- `init_pool` is permissionless: the first caller picks `admin` and
  `chain_domain`. Gate it on the program upgrade authority.
- There is no guardian pause and no deposit cap (design §8.2).
- Proof points are validated only by the alt_bn128 syscalls. Subgroup checks
  for G2 inputs need review together with the vendored verifier.
- Legacy transactions are 1,085–1,154 B with test ciphertexts. Real
  ciphertexts need v0 + lookup tables, or v1 transactions.
- CU variance comes from the on-chain PDA bump search; pass the bumps as
  instruction data.
