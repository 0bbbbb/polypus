# Polypus cryptographic specification — kernel v1 (M1 draft)

> **Status: unaudited draft.** This specification has not been reviewed by a
> cryptographer. It is the single source of truth for the Rust reference
> implementation (`crates/polypus-crypto`), the Noir circuits (`circuits/`) and
> the pool program (`programs/polypus-pool`). If any of those disagree with this
> file, that is a bug. Design rationale lives in
> [`../../docs/POLYPUS_DESIGN.md`](../../docs/POLYPUS_DESIGN.md) and in
> [`../docs/adr/`](../docs/adr/).

## 1. Field and encodings

- `F` is the BN254 scalar field, `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- A field element is serialised as **32 bytes, big-endian, canonical** (`< p`).
  Non-canonical encodings MUST be rejected when parsing.
- `u64` values embed into `F` as integers.
- A signed value `v` (|v| < 2^64) embeds as `v` if `v ≥ 0`, else `p − |v|`.
- `bytes_to_field_be(b)` for `len(b) ≤ 31` is the big-endian integer of `b`.

## 2. Hash function

`H_n(x_1..x_n)` is **Poseidon over BN254 with the circomlib parameters**
(x^5 S-box, width `t = n + 1`, `R_F = 8`, `R_P` from circomlib's table, capacity
element initialised to 0, output = state[0]). This is the parameterisation of:

| Implementation | Version pinned |
|---|---|
| Rust: `light-poseidon` (`Poseidon::<Fr>::new_circom(n)`) | 0.4.x (arkworks 0.5) |
| Solana: `sol_poseidon` syscall via `solana-poseidon` (`Parameters::Bn254X5`, `Endianness::BigEndian`) | 5.0.x |
| Noir: `noir-lang/poseidon` `poseidon::bn254::hash_n` | v0.4.0 (commit `e105cdd5c79c222860d53c5dfdb8fa8012b291c0`) |

Noir's *stdlib* Poseidon/Poseidon2 is **not** used. `sol_poseidon` supports at
most 12 inputs, so every hash that the pool recomputes on-chain uses `n ≤ 12`.
Known-answer test: `H_2(1, 2) = 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a`.

### 2.1 Domain separation

Every protocol hash except Merkle nodes takes a **domain tag** as its first
input. `tag(s) = bytes_to_field_be(ascii(s))`.

| Name | String | Value |
|---|---|---|
| `T_AK` | `polypus.ak.v1` | `0x706f6c797075732e616b2e7631` |
| `T_OWNER` | `polypus.owner.v1` | `0x706f6c797075732e6f776e65722e7631` |
| `T_RCM` | `polypus.rcm.v1` | `0x706f6c797075732e72636d2e7631` |
| `T_NOTE` | `polypus.note.v1` | `0x706f6c797075732e6e6f74652e7631` |
| `T_NF` | `polypus.nf.v1` | `0x706f6c797075732e6e662e7631` |
| `T_ASSET` | `polypus.asset.v1` | `0x706f6c797075732e61737365742e7631` |
| `T_IO` | `polypus.io.v1` | `0x706f6c797075732e696f2e7631` |
| `T_PI` | `polypus.pi.v1` | `0x706f6c797075732e70692e7631` |

Merkle nodes use the untagged `H_2(left, right)`. They cannot collide with
tagged hashes of a different arity, because each arity is a different Poseidon
instance (different width and round constants). The only other 2-input hashes
are `H_2(T_AK, ·)` and `H_2(T_RCM, ·)`, whose outputs never enter the tree.

## 3. Keys and addresses

```
seed            : 32 random bytes (wallet secret)
ask             = wide(SHA-512("polypus.ask.v1" || seed))     ∈ F   spend-authorising key
nk              = wide(SHA-512("polypus.nk.v1"  || seed))     ∈ F   nullifier key
ivk             = SHA-256("polypus.ivk.v1" || seed)           32 B  X25519 secret (clamped on use)
dk              = SHA-256("polypus.dk.v1"  || seed)           32 B  diversifier key
ak              = H_2(T_AK, ask)
d_j             = SHA-256("polypus.div.v1" || dk || u32_le(j))[0..11]     diversifier j
d_j as field    = bytes_to_field_be(d_j)                      (88 bits)
owner_j         = H_4(T_OWNER, ak, nk, d_j)
G_d             = hash_to_curve25519(d_j)                     (see 3.1)
pk_d            = X25519(ivk, G_d)                            32 B
```

`wide(x)` reduces a 64-byte string as a big-endian integer modulo `p`
(bias ≈ 2^-258).

- **Spending** needs `ask` and `nk`.
- **Full viewing key** `fvk = (ak, nk, ivk)`: it can recompute every `owner_j`
  and every nullifier, so it can see incoming notes *and* when they are spent. It
  cannot spend, because the circuit demands knowledge of `ask` (preimage of `ak`).
- **Incoming viewing key** `ivk`: it can only trial-decrypt notes (M4).

### 3.1 Diversified base

`hash_to_curve25519(d)`: for `ctr = 0, 1, …`, let
`y = SHA-256("polypus.gd.v1" || d || u8(ctr))`, decompress `y` as a compressed
Edwards25519 point, multiply by the cofactor 8; the first non-identity result,
converted to its Montgomery `u`-coordinate, is `G_d`. Try-and-increment is not
constant-time, which is fine here because `d` is public.

### 3.2 Address encodings

All are **bech32m** (BIP-350) with **no 90-character limit** (the limit is
lifted, as Zcash does for unified addresses). Payloads start with a 1-byte
format version (`0x01`), so v1 strings start with `<hrp>1q`.

| HRP | Payload (v1) | Bytes | Chars |
|---|---|---|---|
| `poly` | `0x01 ‖ d (11) ‖ pk_d (32) ‖ owner (32, field BE)` | 76 | 133 |
| `polyview` | `0x01 ‖ ak (32) ‖ nk (32) ‖ ivk (32)` | 97 | 170 |
| `polyivk` | `0x01 ‖ ivk (32)` | 33 | 67 |

`owner` is carried in the address because it cannot be derived from
`(d, pk_d)` without in-circuit X25519 (ADR-0003). Decoders MUST check: HRP,
version byte, exact length, canonical field encoding of `owner`/`ak`/`nk`.

### 3.3 Display-only typed values

`cm_`, `nf_` and `ct_` + base58 (Bitcoin alphabet) of the 32-byte big-endian
value. The prefix is not part of the on-chain value. Truncated display:
`prefix + first6 + "…" + last6` of the payload.

## 4. Notes

```
Note v1 {
  version      : u8 = 1
  asset_id     : F      = H_3(T_ASSET, be(mint[0..16]), be(mint[16..32]))
  amount       : u64
  owner        : F
  lock_program : F      (0 = unlocked)
  lock_data    : F
  escape       : F
  rseed        : F
}
rcm  = H_2(T_RCM, rseed)
cm   = H_8(T_NOTE, asset_id, amount, owner, lock_program, lock_data, escape, rcm)
nf   = H_4(T_NF, nk, cm, leaf_index)
```

The `version` is not hashed directly; it selects the tag (`T_NOTE` is v1).

**Well-formedness of an output note (kernel v1):**
- `amount < 2^64`;
- `asset_id` equals the action's asset;
- if `lock_program = 0` then `lock_data = 0` and `escape = 0` (canonical plain note);
- if `lock_program ≠ 0` then `escape ≠ 0` (mandatory escape, design §3.6).

## 5. Commitment tree

- Depth `D = 26`. Leaves are `cm` values. Empty leaf `Z_0 = 0`; `Z_{i+1} = H_2(Z_i, Z_i)`.
- `node = H_2(left, right)`. The path bit at level `i` is bit `i` of `leaf_index`
  (little-endian), `0` = current node is the left child.
- The pool appends leaves **in pairs** (both outputs of an action) at
  `next_index` (always even), and keeps a ring buffer of the **128** most recent
  roots. Root index 0 is the empty-tree root `Z_26`.

## 6. Kernel action (2-in / 2-out)

### 6.1 Public values

```
root, nf[0], nf[1], cm_out[0], cm_out[1],
public_amount     (signed, §1 embedding)  = ext_amount − fee
public_asset_id   (asset id if any token moves, else 0)
ext_data_hash     (§7)
program_id        (0 = program 0, plain transfer)
program_io_hash   (0 if program_id = 0)
```

The **only** Groth16 public input is

```
pi_hash = H_11(T_PI, root, nf0, nf1, cm0, cm1, public_amount, public_asset_id,
               ext_data_hash, program_id, program_io_hash)
```

which the pool recomputes on-chain from instruction data (one `sol_poseidon`
call). Fewer public inputs make verification cheaper (ADR-0004).

### 6.2 Private witness

`ask, nk, asset_id`; per input `i ∈ {0,1}`: `amount, d, lock_program,
lock_data, escape, rseed, leaf_index, path[26]`; per output `j ∈ {0,1}`:
`amount, owner, lock_program, lock_data, escape, rseed`; `program_params_hash`.

### 6.3 Constraints (complete list)

| # | Constraint |
|---|---|
| K1 | Every input and output `amount < 2^64` |
| K2 | `public_amount + 2^64 < 2^65`, i.e. `public_amount ∈ [−2^64, 2^64)` |
| K3 | `ak = H_2(T_AK, ask)`; input owner `owner_i = H_4(T_OWNER, ak, nk, d_i)`; `cm_in_i = commit(asset_id, amount_i, owner_i, …)` (ownership is enforced through K4: a wrong key gives a commitment that is not in the tree) |
| K4 | If `amount_i ≠ 0`: the Merkle root computed from `cm_in_i`, `leaf_index_i`, `path_i` equals `root`. `leaf_index_i < 2^26`. Zero-value inputs are dummies and skip membership |
| K5 | `nf[i] = H_4(T_NF, nk, cm_in_i, leaf_index_i)` |
| K6 | `nf[0] ≠ nf[1]` |
| K7 | `cm_out[j] = commit(output j)` and output j is well-formed (§4) |
| K8 | `amount_in_0 + amount_in_1 + public_amount = amount_out_0 + amount_out_1` (in F; no wraparound because of K1/K2) |
| K9 | If `public_asset_id ≠ 0` then `asset_id = public_asset_id`; if `public_amount ≠ 0` then `public_asset_id ≠ 0` |
| K10 | Lock rule (M1 subset): each input has `lock_program_i = 0` or `lock_program_i = program_id`. The escape path is **not** implemented in kernel v1-M1 (ADR-0005); the M2 pool rejects `program_id ≠ 0`, so locked notes cannot be spent until M3 |
| K11 | If `program_id = 0`: `program_io_hash = 0`. Else `program_io_hash = H_7(T_IO, program_id, nf0, nf1, cm0, cm1, program_params_hash)` |
| K12 | `pi_hash` = the hash in §6.1 |

Dummy inputs still need ownership (they are built with the prover's own keys)
and still produce nullifiers. Those nullifiers are inserted on-chain like any
other, so dummies must use fresh random `rseed`.

## 7. External data binding

`ext_data_hash` binds everything the relayer could otherwise tamper with:

```
ext_bytes = "polypus.ext.v1"            (14 bytes ASCII)
          ‖ pool_id          (32)  pool state PDA address
          ‖ chain_domain     (32)  per-cluster constant stored in the pool at init
          ‖ public_account   (32)  depositor source / withdraw destination token account (zero if none)
          ‖ relayer          (32)  relayer fee token account (zero if fee = 0)
          ‖ ext_amount       (i64 LE)
          ‖ fee              (u64 LE)
          ‖ not_before_slot  (u64 LE)  pool requires Clock.slot ≥ this
          ‖ ct_hash[0]       (32)  SHA-256 of output-note ciphertext 0
          ‖ ct_hash[1]       (32)  SHA-256 of output-note ciphertext 1
h = SHA-256(ext_bytes); h[0] = 0
ext_data_hash = field_from_be(h)          (248 bits, always canonical)
```

The pool computes `public_amount = ext_amount − fee` itself and requires
`|ext_amount| < 2^62` and `fee < 2^62`. The pool, not the prover, chooses
`pool_id`, `chain_domain` and `public_asset_id`.

## 8. Test vectors

`spec/vectors/*.json` are generated by `cargo run -p polypus-crypto --bin gen-vectors`
and checked by the Rust tests, the Noir tests and the pool's tests.
