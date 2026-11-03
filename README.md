# Polypus

Privacy protocol on Solana: shielded SPL transfers and, later, private programs
over shielded notes. Design: [`../docs/POLYPUS_DESIGN.md`](../docs/POLYPUS_DESIGN.md).

> **⚠️ UNAUDITED RESEARCH CODE — LOCALNET / DEVNET ONLY.**
> Nothing here has been reviewed or audited. The Groth16 keys in
> `artifacts/dev/` come from an **INSECURE single-party dev setup**: whoever ran
> it could forge proofs. Do not deploy to mainnet, do not use real funds, and do
> not describe this code as secure. Keypairs are never committed (see `.gitignore`).

## Status (Milestone 1 + start of M2)

| Area | State |
|---|---|
| `spec/SPEC.md` | Kernel v1 cryptographic spec (field, Poseidon, tags, keys, addresses, notes, tree, constraints K1–K12, ext_data) |
| `crates/polypus-crypto` | Rust reference implementation and test-vector generator |
| `circuits/polypus_notes` | Noir library shared by the kernel and future programs |
| `circuits/kernel` | 2-in/2-out kernel circuit; a negative test for every constraint |
| `crates/polypus-prover` | nargo → Sunspot Groth16 proving glue, `polypus-prove` CLI |
| `programs/` | Anchor pool program (init/deposit/transact/withdraw) with an on-chain Groth16 verifier; see `programs/README.md` |
| `docs/adr/` | Architecture decision records |
| `docs/benchmarks.md` | Constraint count, proving time, CU |

## Layout

```
polypus/
├─ spec/                 SPEC.md + JSON test vectors (generated)
├─ crates/
│  ├─ polypus-crypto/    reference impl: keys, poly1 addresses, notes, nullifiers,
│  │                     Merkle tree, ext_data, kernel relation, scenarios
│  └─ polypus-prover/    proving pipeline + `polypus-prove` CLI (dev only)
├─ circuits/             Noir workspace (nargo 1.0.0-beta.22)
│  ├─ polypus_notes/     shared note/key/tree library + cross-language KAT tests
│  └─ kernel/            kernel v1 circuit + tests (fixtures generated from Rust)
├─ programs/             Solana workspace (Anchor 1.2.2): polypus-pool, polypus-verifier
├─ docs/adr/  docs/benchmarks.md
├─ scripts/              env.sh, setup-toolchain.sh, dev-setup.sh (INSECURE), localnet e2e
└─ sdk/                  TypeScript SDK (M4, empty)
```

## Toolchain (pinned; see ADR-0001)

| Tool | Version |
|---|---|
| Rust | 1.99.1 (host); SBF builds use platform-tools v1.57 / Rust 1.95.0 |
| Noir | nargo 1.0.0-beta.22 (required by Sunspot v1.0.0) |
| noir-lang/poseidon | v0.4.0 (circomlib-compatible) |
| Sunspot | v1.0.0 (gnark v0.14.0) |
| Go | 1.27.3 |
| Agave / Solana CLI | 4.4.0 (cargo-build-sbf 4.5.0) |
| Anchor | 1.2.2 |
| Node | 22.23.3 |

```bash
scripts/setup-toolchain.sh     # installs all of the above into $HOME, no sudo
source scripts/env.sh
```

## Build and test

```bash
source scripts/env.sh

# 1. Rust reference implementation: unit, negative and property tests
cargo test --release -p polypus-crypto

# 2. Regenerate the cross-language vectors and Noir fixtures (deterministic; CI should diff)
cargo run --release -p polypus-crypto --bin gen-vectors

# 3. Noir: KAT parity with Rust + kernel honest/negative tests
(cd circuits && nargo test --workspace)

# 4. Proving pipeline (INSECURE dev setup, then prove/verify/tamper/bench/differential)
scripts/dev-setup.sh
cargo build --release -p polypus-prover
./target/release/polypus-prove scenarios     # prove + verify deposit, transfers, withdraw
./target/release/polypus-prove tamper        # mutated proof / public input must be rejected
./target/release/polypus-prove bench 20
./target/release/polypus-prove diff 10000 8  # Rust reference vs Noir circuit, random + mutated witnesses

# 5. Solana pool program: see programs/README.md
```

## Security notes

- Every constraint the kernel enforces is listed in `spec/SPEC.md` §6.3 and
  in the header of `circuits/kernel/src/kernel.nr`. Each has a named negative
  test in `circuits/kernel/src/tests.nr`.
- Known gaps, by design for this milestone (ADR-0005): no escape path for
  locked notes, no program proofs (the pool rejects `program_id ≠ 0`), no note
  encryption, no MPC ceremony.
- The dev proving key lives in `artifacts/dev/` and is git-ignored. Each
  `scripts/dev-setup.sh` run produces a *different* VK, after which the pool
  program must be rebuilt.
