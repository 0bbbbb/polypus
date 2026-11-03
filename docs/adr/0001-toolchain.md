# ADR-0001: Toolchain and pinned versions

- Status: accepted (M1)
- Date: 2026-11-03

## Context

The design doc (§4.2, §4.5, §9.1) chooses Noir compiled to Groth16 by Reilabs'
Sunspot, with a gnark-native kernel as the fallback if Sunspot cannot be used.
Sunspot pins one Noir version, so the whole toolchain has to be pinned
together.

## Decision

| Tool | Version | How installed | Notes |
|---|---|---|---|
| Rust (host) | rustc 1.99.1, cargo 1.99.1, rustup 1.29.1 | rustup | already present |
| Noir (`nargo`/`noirc`) | **1.0.0-beta.22** (`c57152f91260ecdb9faad4efc20abb14b6d2ece7`) | release tarball → `~/.nargo/bin` | exactly what Sunspot v1.0.0 requires. Noir 1.0.0 stable exists (Nov 2026) but is **not** supported by Sunspot, so we do not use it |
| `noir-lang/poseidon` | **v0.4.0** (`e105cdd5c79c222860d53c5dfdb8fa8012b291c0`) | git dep in `Nargo.toml` | v0.2.6 does not compile on beta.22; v0.3.0 and v0.4.0 do. v0.4.0 matches circomlib's KAT |
| Sunspot | **v1.0.0** (release 2026-06-19), sha256 `d50a9cd8…ea7746` of `sunspot_1.0.0_linux_amd64.tar.gz` (matches `checksums.txt`) | prebuilt binary → `~/.local/bin` | gnark v0.14.0 / gnark-crypto v0.19.0 inside. HashCloak audit, Apr–Sep 2026 |
| Go | 1.27.3 | tarball → `~/.local/go` | only needed to build Sunspot from source or for a gnark fallback |
| Agave / Solana CLI | **4.4.0** (`solana-cli 4.4.0 src:9ef63128`) | `release.anza.xyz` installer | includes `cargo-build-sbf` 4.5.0 (platform-tools v1.57, Rust 1.95.0) and `solana-test-validator` 4.4.0 |
| Anchor CLI | 1.2.2 | `cargo install anchor-cli --version 1.2.2 --locked` | `anchor-lang` 1.2.2 |
| Node | 22.23.3 (npm 10.9.9) | system | TS SDK later |

Rust crates: `light-poseidon` 0.4 (the implementation behind `sol_poseidon`)
with arkworks 0.5, `curve25519-dalek` 4.1, `bech32` 0.11, `bs58` 0.5,
`proptest` 1. Pool program: see `programs/README.md`.

`scripts/setup-toolchain.sh` installs exactly these versions without sudo, and
`scripts/env.sh` puts them on `PATH`.

## Sunspot works, so the gnark fallback is not triggered

Smoke test, then the real kernel: `nargo compile` → `sunspot compile` (ACIR →
gnark constraint system) → `sunspot setup` → `sunspot prove` → `sunspot verify`
all succeed on Noir beta.22, including the `noir-lang/poseidon` library and
the range checks (Sunspot lowers range checks with a BSB22 commitment, so
kernel proofs are 388 bytes). The gnark fallback (design §4.5c) therefore
stays a planned M6 spike, not a current need.

## Consequences

- We are pinned to a Noir *beta*. Upgrading Noir waits for Sunspot. Every
  Noir or Sunspot bump changes the constraint system, so it needs a new
  setup/VK and a re-run of the full test, differential and benchmark suite.
- `sunspot setup` is single-party and INSECURE. It is used only for dev
  (`scripts/dev-setup.sh`). A production VK needs an MPC phase 2 (e.g.
  `reilabs/trusted-setup`), per design §4.3.
- The ACIR→gnark translation is trusted computing base. It needs an audit as
  used by the kernel (design §4.5d).
