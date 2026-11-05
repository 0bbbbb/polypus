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
7. **Program id** `PoLYdUXuf78YC6aqE4qkmyFkfJi3mm773ZqJNECDYtj` (ground in
   about 6 minutes on 8 threads, 2026-11-05; the earlier
   `PoLyMJzp2sUxqEguNkpK5nvtJJna2UECSod7q9UWCVu` is retired). The keypair is
   git-ignored. A shared deployment should hold the upgrade authority in a
   multisig.
8. **Access control (2026-11-05).**
   - `init_pool` requires the signer to be the program's **upgrade
     authority**. The instruction takes the program account and its
     ProgramData account; the pool checks that the program account points to
     that ProgramData, and that `upgrade_authority_address == Some(signer)`.
     The signer becomes `admin`. An immutable program (no authority) cannot
     create pools. The LiteSVM tests patch the authority into the
     ProgramData that LiteSVM creates, so no test-only feature flag exists.
   - `Pool` gained `guardian`, `paused`, `max_deposit`, `tvl_cap`, appended
     after the existing fields. `set_paused(bool)` is guardian-only;
     `set_guardian` and `set_limits(max_deposit, tvl_cap)` are admin-only.
     There is no admin transfer instruction yet.
   - **When paused, `deposit` and `transact` fail with `PoolPaused`;
     `withdraw` is never paused.** Users can always exit (design §8.2: a
     guardian may pause deposits, "never withdrawals of plain notes"). Pausing
     `transact` too stops value moving between notes inside the pool while an
     incident is investigated. The cost is that a user who must merge notes
     before withdrawing can still do it, because a withdraw takes two inputs
     and returns change. A soundness bug that inflates notes can still drain
     the vault through `withdraw` while paused; the caps bound how much is in
     the vault, not how fast it leaves. A per-epoch withdrawal rate limit
     (design §8.2 item 6) is still missing.
   - Deposit limits: `ext_amount ≤ max_deposit` (`DepositTooLarge`) and
     `vault.amount + ext_amount − fee ≤ tvl_cap` (`TvlCapExceeded`). They are
     checked before any proof work. `u64::MAX` means unlimited.
9. **PDA bumps are not passed as instruction data.** The variance comes from
   `find_program_address` for the two nullifier PDAs. Anchor's `init` with an
   explicit `bump = …` still runs `find_program_address`, to enforce the
   canonical bump. The canonical bump has to be enforced: a nullifier PDA at
   a non-canonical bump is a different address, so `init` would succeed
   there and the same nullifier could be spent twice. Proving a client-given
   bump canonical takes the same search, so this would save nothing safely.
   The pool, tree and vault are already checked by stored address
   (`address = pool.tree`, …), not by seeds.

## Known gaps (must close before a shared devnet pool)

- ~~`init_pool` is permissionless~~ — closed (decision 8).
- ~~No guardian pause and no deposit cap~~ — closed (decision 8). Still
  missing: per-epoch withdrawal rate limits and a two-step admin transfer.
- Proof points are validated only by the alt_bn128 syscalls. Subgroup checks
  for G2 inputs need review together with the vendored verifier.
- Legacy transactions are 1,085–1,154 B with test ciphertexts. Real
  ciphertexts need v0 + lookup tables (see `docs/benchmarks.md`).
- CU variance from the nullifier PDA bump search stays (decision 9).
