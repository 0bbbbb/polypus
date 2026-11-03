# Polypus on-chain programs

> ## ⚠️ UNAUDITED — DEVNET / LOCALNET ONLY
> This code has not been audited. Never deploy it to mainnet and never use it
> with real funds. The dev kernel VK comes from an **insecure single-party
> setup**. Builds made with the test VKs in this directory are deliberately
> insecure (see "Test verifying keys" below).

This is a separate Cargo workspace (its own `Cargo.lock`), so SBF builds do not
share a lockfile with the host-only crates in `../crates`.

| Crate | What |
|---|---|
| `polypus-verifier/` | Groth16 verifier for gnark/Sunspot proofs, including BSB22 commitments, using the alt_bn128 syscalls. Vendored from Reilabs' Apache-2.0 [`gnark-verifier-solana`](https://github.com/reilabs/sunspot/tree/main/gnark-solana/crates/verifier-lib) (commit `0a9f7d0`). See `NOTICE` for the modifications (hardening plus CU optimizations). |
| `polypus-pool/` | Anchor 1.2.2 program: `init_pool`, `deposit`, `transact`, `withdraw`. |
| `verifier-bench/` | **Test-only** SBF program, never deployed. It measures the verifier, `sol_poseidon` and the tree append in isolation. |
| `tests/` | LiteSVM host tests (load `target/deploy/*.so`), plus fixtures. |

Program id: `PoLyMJzp2sUxqEguNkpK5nvtJJna2UECSod7q9UWCVu`. The keypair is in
`keys/polypus_pool-keypair.json` and `target/deploy/` (both gitignored). Never commit keypairs.

## Versions

anchor-lang / anchor-spl `=1.2.2` (feature `solana-v3`), solana-poseidon
`=5.0.1`, solana-bn254 `3.2.1`, solana-define-syscall `5`,
solana-sha256-hasher `3.1`, ark-bn254/ark-ff `0.5`, litesvm `=0.18.1`
(tests only). Toolchain: cargo-build-sbf 4.5.0 (platform-tools v1.57, default
`--arch v3`), Anchor CLI 1.2.2.

`litesvm 0.18.1` asks for the Agave 4.3 runtime crates with `^4.3.0`, but the
Agave **4.4.0** crates changed their APIs without following semver. The test
crate therefore pins them to `=4.3.2`. That only affects `tests/`.

## How the kernel VK is compiled in

`polypus-pool/build.rs` reads a Sunspot/gnark `.vk` file from
`$POLYPUS_KERNEL_VK`. If the variable is unset, it uses `../artifacts/dev/kernel.vk`
(relative to this directory). The script parses the file with
`polypus_verifier::parse_vk` and writes
`$OUT_DIR/kernel_vk.rs`, which contains a `const VK` and `VK_SHA256`. The VK is not
configurable at runtime. The build **fails** if the file is missing, cannot be
parsed, or has a number of public inputs other than 1 (`pi_hash`). The build
script prints the VK path, its SHA-256 and the commitment count, and prints a
loud warning if the VK is one of the known test keys. `init_pool` logs the
compiled-in VK hash.

## Build

```sh
export PATH=$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH
export CARGO_BUILD_JOBS=4
cd programs
# Default VK = ../artifacts/dev/kernel.vk; override with POLYPUS_KERNEL_VK=/path/to/kernel.vk
anchor build                       # pool .so + IDL (target/idl/polypus_pool.json)
cargo build-sbf --manifest-path verifier-bench/Cargo.toml   # test-only bench program
# (equivalently for the pool: cargo build-sbf --manifest-path polypus-pool/Cargo.toml)
```

## Test

```sh
# Host unit tests (verifier, pool crypto/tree vs polypus-crypto and spec/vectors)
# and the LiteSVM tests (need the two .so files built as above):
cargo test --workspace -- --nocapture

# On-chain verification of real kernel proofs (<name>.proof + <name>.pw):
POLYPUS_KERNEL_VK=$PWD/../artifacts/dev/kernel.vk \
  cargo build-sbf --manifest-path verifier-bench/Cargo.toml --sbf-out-dir target/deploy-kernel
POLYPUS_BENCH_SO=$PWD/target/deploy-kernel/polypus_verifier_bench.so \
POLYPUS_KERNEL_PROOFS=$PWD/../artifacts/dev \
  cargo test -p polypus-tests --test bench kernel_proofs -- --ignored --nocapture

# Full deposit -> transact -> withdraw flows with real proofs (trivial test VK):
POLYPUS_KERNEL_VK=$PWD/tests/fixtures/trivial_pi/trivial_pi.vk \
  cargo build-sbf --manifest-path polypus-pool/Cargo.toml --sbf-out-dir target/deploy-trivial
POLYPUS_POOL_SO=$PWD/target/deploy-trivial/polypus_pool.so \
POLYPUS_ACTION_FIXTURES=$PWD/tests/fixtures/trivial \
  cargo test -p polypus-tests --test pool -- --ignored --nocapture
```

### End to end with REAL kernel proofs (`tests/tests/kernel_e2e.rs`)

```sh
../scripts/dev-setup.sh      # only if artifacts/dev is missing (a new VK means rebuild the pool)
anchor build                 # pool with ../artifacts/dev/kernel.vk compiled in
cargo test --release -p polypus-tests --test kernel_e2e -- --ignored --nocapture --test-threads 1
```

The test builds witnesses with `polypus-crypto` against this pool's real
addresses (pool PDA, `chain_domain`, token accounts) and proves them in
process with `polypus-prover` (nargo + Sunspot). It runs five actions:

1. Alice deposits 100.
2. Alice sends Bob 60 privately (1 input + 1 dummy, change 38), relayer fee 2.
3. Alice deposits 25 through a relayer, fee 1.
4. Alice merges 38 + 24 (2 inputs) and sends Bob 30.
5. Bob withdraws 85 from 60 + 30 (2 inputs), fee 1, keeping 4.

After every action the test checks four things:
- the on-chain root equals the Rust `MerkleTree` root;
- the event's leaf indices are correct;
- the vault delta equals `ext_amount − fee`;
- a replay of the same action fails.

At the end the vault holds exactly the unspent notes (36). A second test shows
that a relayer holding a valid withdraw proof cannot change the recipient, fee,
amount or a ciphertext.

| Action (real kernel proof, dev VK, LiteSVM) | CU | Legacy tx size |
|---|---|---|
| deposit 100 | 220,215 | 1,098 B |
| transfer, 1 input, fee 2 | 213,975 | 1,115 B |
| deposit 25, fee 1 | 221,363 | 1,142 B |
| transfer, 2 inputs, no fee | 214,176 | 1,085 B |
| withdraw 85, 2 inputs, fee 1 | 220,023 | 1,154 B |

Before real proofs exist, the pool tests send a well-formed but wrong proof (`polypus_tests::dummy_proof`, chosen from the VK hash that `init_pool` logs).
The pool then runs every check, including the pairing, and fails with
`InvalidProof`. On that failure it logs the `pi_hash` it recomputed, and the tests compare that
value with `polypus-crypto`, so they check on-chain parity of `ext_data_hash`, `public_amount`,
`public_asset_id` and `pi_hash`. If the pool is built with a VK that has a
commitment count other than 0 or 1, set `POLYPUS_DUMMY_PROOF` to any proof
file of the right size.

### Plugging in real kernel proofs

Every address that enters `ext_data_hash` is deterministic in the tests
(`polypus_tests::Fixed`). To print them as JSON, run
`cargo test -p polypus-tests --test pool fixture_context -- --nocapture`. The JSON includes
the program id, mint, pool PDA, `chain_domain`, the deposit/withdraw/relayer token
accounts and the empty root. Generate the kernel witness for those values,
then write one `polypus_tests::ActionFixture` JSON per action. The format is
in `tests/fixtures/trivial/*.json` (kind, nf, root, cm_out, ext_amount, fee,
not_before_slot, proof, ciphertexts; hex-encoded). Then run
`real_proof_actions` / `real_proof_bound_data_cannot_change` with
`POLYPUS_ACTION_FIXTURES=<dir>` and a pool built with the matching VK.
`TransactArgs::public_values()` gives the exact public values the pool will
recompute. `generate_trivial_fixtures`, an ignored test, shows the whole
pipeline with `nargo` + `sunspot`.

### Test verifying keys

- `polypus-verifier/test_files/ptest.vk`: the Sunspot smoke test
  (`hash_2([a,b]) == out`, 1 public input, no commitment). It is used for the default
  test builds. A pool built with it is harmless but unusable.
- `polypus-verifier/test_files/sanction_checker.vk`: Reilabs' example
  (1 public input, 1 BSB22 commitment). The bench uses it.
- `tests/fixtures/trivial_pi/trivial_pi.vk`: **INSECURE.** A circuit whose only
  constraint is on `pi_hash`, so anyone can prove anything. It exists for
  the end-to-end LiteSVM tests only.

## Measured compute units (LiteSVM 0.18.1, SBPF v3)

| Operation | CU |
|---|---|
| `init_pool` (3 PDAs, incl. on-chain `asset_id` = H_3) | 31,278 |
| `sol_poseidon` H_2 / H_3 / H_11 / H_12 (incl. wrapper) | 1,097 / 1,415 / 8,351 / 9,767 |
| Tree append of one pair (26 × H_2) | 24,295 |
| Verifier, 1 public input, 0 commitments (smoke test) | 78,677 (upstream code: 161,177) |
| Verifier, 1 public input, 1 BSB22 commitment (sanction_checker) | 161,417 (upstream code: 429,559) |
| Verifier, **dev kernel** (`artifacts/dev`, 388 B proofs, 1 commitment) | ≈161,400–161,500 |
| Verifier rejecting a mutated public input | ≈79,000 |
| Full `deposit` / `transact`+fee / `withdraw`+fee, trivial VK (0 commitments) | 132,884 / 132,687 / 134,138 |
| Kernel-VK pool, all checks through the pairing (rejected proof): deposit / transact / withdraw+fee | 191,497 / 190,357 / 192,412 |
| **Projected full action with the dev kernel VK** (above + tree append + CPIs) | **≈ 217,000** |
| Double spend rejected (nullifier PDA exists) | 14,795 |

Token CPIs were measured against LiteSVM's default SPL Token, which is p-token
when that feature is active. Classic SPL Token costs a few thousand CU more per transfer.

Transaction size (legacy, 1 signer, compute-budget instruction included):

| Transaction | Size |
|---|---|
| `transact`, 324 B proof, empty ciphertexts | 971 B |
| `withdraw` + fee, empty ciphertexts | 1,036 B |
| `withdraw` + fee, two 120 B ciphertexts | 1,276 B (over the 1,232 B limit) |

The kernel's 388 B proofs add 64 B. Real note ciphertexts therefore need v0 transactions with an
address lookup table, or v1 transactions.

## Instruction semantics (all three actions share `process_action`)

The checks run in this order, and each one fails the whole transaction:

1. Anchor account constraints: `tree`/`vault` must be the pool's;
   `public_account`/`relayer_token` must be token accounts of the pool mint; no
   duplicate mutable accounts. The two nullifier PDAs `["nf", pool, nf_i]` are
   created with `init`, so creation fails if either already exists. This is the
   double-spend guard. Nothing is keyed on proof bytes.
2. `ext_amount` has the right sign for the instruction (deposit > 0, transact = 0,
   withdraw < 0); `|ext_amount| < 2^62`; `fee < 2^62`.
3. A relayer token account is present iff `fee > 0`. Neither counterparty account may be
   the vault.
4. `Clock.slot ≥ not_before_slot`.
5. `root`, `nf[0..2]` and `cm_out[0..2]` are canonical (< p); `nf[0] ≠ nf[1]`.
6. `root` is non-zero and in the 128-root history.
7. `ext_data_hash` is built per SPEC §7. The pool supplies `pool_id`, `chain_domain`,
   `public_account` and `relayer` (zero when absent), and computes `ct_hash` with
   on-chain SHA-256.
8. `pi_hash = H_11(T_PI, root, nf0, nf1, cm0, cm1, public_amount, public_asset_id,
   ext_data_hash, 0, 0)`. Here `public_amount` is the signed embedding of
   `ext_amount − fee`, and `public_asset_id` is the pool's asset id iff tokens move.
9. The Groth16 proof is verified against the compiled-in VK. The public witness
   `[pi_hash]` is built on-chain.
10. The `cm_out` pair is appended to the tree; `ActionEvent` is emitted; then the
    token transfers run (deposit: depositor to vault; withdraw: vault to
    `public_account`; fee: vault to `relayer_token`).

## Known limitations (M2)

- `init_pool` is permissionless: anyone can create the pool for a mint first,
  choosing its `admin` and `chain_domain`. Gate it on the upgrade authority before
  any shared devnet deployment.
- There is no pause flag or deposit cap yet, so the design doc's guardian is missing.
  Only classic SPL Token mints are supported. The mint's freeze authority could
  freeze the vault.
- `program_id` / `program_io_hash` are fixed to 0. They are not instruction
  inputs, so locked notes (K10) cannot be spent until M3.
- With real ciphertexts, legacy transactions exceed 1,232 B (see above).
- Kernel proof points are validated only by the alt_bn128 syscalls (on-curve
  checks, and whatever subgroup checks the pairing syscall performs). This
  should be reviewed together with the vendored verifier.
