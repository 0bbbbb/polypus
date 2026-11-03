//! polypus_notes — note, key and tree primitives shared by the kernel and by
//! every private program (spec/SPEC.md §2-§5). UNAUDITED.
//!
//! All hashes are circomlib Poseidon over BN254 (noir-lang/poseidon), which is
//! bit-for-bit what `sol_poseidon` and the Rust reference compute. Never use the
//! Noir stdlib Poseidon here: it is a different function.

use poseidon::poseidon::bn254;

mod vectors;
mod tests;

pub global DEPTH: u32 = 26;

// Domain tags: big-endian integer of the ASCII string (spec §2.1).
pub global T_AK: Field = 0x706f6c797075732e616b2e7631; // "polypus.ak.v1"
pub global T_OWNER: Field = 0x706f6c797075732e6f776e65722e7631; // "polypus.owner.v1"
pub global T_RCM: Field = 0x706f6c797075732e72636d2e7631; // "polypus.rcm.v1"
pub global T_NOTE: Field = 0x706f6c797075732e6e6f74652e7631; // "polypus.note.v1"
pub global T_NF: Field = 0x706f6c797075732e6e662e7631; // "polypus.nf.v1"
pub global T_ASSET: Field = 0x706f6c797075732e61737365742e7631; // "polypus.asset.v1"
pub global T_IO: Field = 0x706f6c797075732e696f2e7631; // "polypus.io.v1"
pub global T_PI: Field = 0x706f6c797075732e70692e7631; // "polypus.pi.v1"

/// ak = H_2(T_AK, ask)
pub fn derive_ak(ask: Field) -> Field {
    bn254::hash_2([T_AK, ask])
}

/// owner = H_4(T_OWNER, ak, nk, d). `d` is the 11-byte diversifier as a field.
pub fn derive_owner(ak: Field, nk: Field, d: Field) -> Field {
    bn254::hash_4([T_OWNER, ak, nk, d])
}

/// asset_id = H_3(T_ASSET, be(mint[0..16]), be(mint[16..32]))
pub fn asset_id(mint_hi: Field, mint_lo: Field) -> Field {
    bn254::hash_3([T_ASSET, mint_hi, mint_lo])
}

/// cm = H_8(T_NOTE, asset_id, amount, owner, lock_program, lock_data, escape, H_2(T_RCM, rseed))
pub fn note_commitment(
    asset_id: Field,
    amount: Field,
    owner: Field,
    lock_program: Field,
    lock_data: Field,
    escape: Field,
    rseed: Field,
) -> Field {
    let rcm = bn254::hash_2([T_RCM, rseed]);
    bn254::hash_8([T_NOTE, asset_id, amount, owner, lock_program, lock_data, escape, rcm])
}

/// nf = H_4(T_NF, nk, cm, leaf_index)
pub fn nullifier(nk: Field, cm: Field, leaf_index: Field) -> Field {
    bn254::hash_4([T_NF, nk, cm, leaf_index])
}

/// Untagged Merkle node H_2(left, right).
pub fn merkle_node(left: Field, right: Field) -> Field {
    bn254::hash_2([left, right])
}

/// Root of the depth-26 tree from a leaf, its index and its path.
/// Constrains `leaf_index < 2^26` (bit decomposition); bit i = 0 means the
/// running node is the left child at level i.
pub fn merkle_root(leaf: Field, leaf_index: Field, path: [Field; DEPTH]) -> Field {
    let bits: [bool; DEPTH] = leaf_index.to_le_bits();
    let mut cur = leaf;
    for i in 0..DEPTH {
        let sib = path[i];
        // Arithmetic select so only one hash is constrained per level.
        let b = bits[i] as Field;
        let left = cur + b * (sib - cur);
        let right = sib + b * (cur - sib);
        cur = merkle_node(left, right);
    }
    cur
}

/// Range check: x < 2^64.
pub fn assert_u64(x: Field) {
    x.assert_max_bit_size::<64>();
}
