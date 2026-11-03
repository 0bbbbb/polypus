//! Cross-language parity: Noir must reproduce the Rust reference vectors.

use crate::{
    asset_id, derive_ak, derive_owner, merkle_node, merkle_root, note_commitment, nullifier, T_AK,
    T_ASSET, T_IO, T_NF, T_NOTE, T_OWNER, T_PI, T_RCM,
};
use crate::vectors;
use poseidon::poseidon::bn254;

#[test]
fn poseidon_matches_rust_all_arities() {
    assert(bn254::hash_1([1]) == vectors::POSEIDON_1);
    assert(bn254::hash_2([1, 2]) == vectors::POSEIDON_2);
    assert(bn254::hash_3([1, 2, 3]) == vectors::POSEIDON_3);
    assert(bn254::hash_4([1, 2, 3, 4]) == vectors::POSEIDON_4);
    assert(bn254::hash_5([1, 2, 3, 4, 5]) == vectors::POSEIDON_5);
    assert(bn254::hash_6([1, 2, 3, 4, 5, 6]) == vectors::POSEIDON_6);
    assert(bn254::hash_7([1, 2, 3, 4, 5, 6, 7]) == vectors::POSEIDON_7);
    assert(bn254::hash_8([1, 2, 3, 4, 5, 6, 7, 8]) == vectors::POSEIDON_8);
    assert(bn254::hash_9([1, 2, 3, 4, 5, 6, 7, 8, 9]) == vectors::POSEIDON_9);
    assert(bn254::hash_10([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) == vectors::POSEIDON_10);
    assert(bn254::hash_11([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) == vectors::POSEIDON_11);
    assert(bn254::hash_12([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) == vectors::POSEIDON_12);
}

#[test]
fn tags_match_rust() {
    assert(T_AK == vectors::T_AK);
    assert(T_OWNER == vectors::T_OWNER);
    assert(T_RCM == vectors::T_RCM);
    assert(T_NOTE == vectors::T_NOTE);
    assert(T_NF == vectors::T_NF);
    assert(T_ASSET == vectors::T_ASSET);
    assert(T_IO == vectors::T_IO);
    assert(T_PI == vectors::T_PI);
}

#[test]
fn keys_note_nullifier_match_rust() {
    let ak = derive_ak(vectors::ASK);
    assert(ak == vectors::AK);
    let owner = derive_owner(ak, vectors::NK, vectors::D);
    assert(owner == vectors::OWNER);
    assert(asset_id(vectors::MINT_HI, vectors::MINT_LO) == vectors::ASSET_ID);
    let cm = note_commitment(vectors::ASSET_ID, vectors::NOTE_AMOUNT, owner, 0, 0, 0, vectors::NOTE_RSEED);
    assert(cm == vectors::NOTE_CM);
    assert(nullifier(vectors::NK, cm, 5) == vectors::NOTE_NF_AT_5);
}

#[test]
fn merkle_matches_rust() {
    // Empty root: Z_26 with Z_0 = 0.
    let mut z = 0;
    for _ in 0..26 {
        z = merkle_node(z, z);
    }
    assert(z == vectors::EMPTY_ROOT);
    // Leaf 3 at index 2 of the tree with leaves [1, 2, 3, 4].
    assert(merkle_root(3, 2, vectors::SMALL_TREE_PATH_2) == vectors::SMALL_TREE_ROOT);
}

#[test(should_fail_with = "Field failed to decompose")]
fn merkle_rejects_index_out_of_range() {
    let _ = merkle_root(3, 67108864 + 2, vectors::SMALL_TREE_PATH_2);
}

#[test]
fn merkle_wrong_index_gives_other_root() {
    assert(merkle_root(3, 3, vectors::SMALL_TREE_PATH_2) != vectors::SMALL_TREE_ROOT);
}

#[test]
fn commitment_binds_every_field() {
    let a = vectors::ASSET_ID;
    let o = vectors::OWNER;
    let base = note_commitment(a, 100, o, 0, 0, 0, 2);
    assert(note_commitment(a + 1, 100, o, 0, 0, 0, 2) != base);
    assert(note_commitment(a, 101, o, 0, 0, 0, 2) != base);
    assert(note_commitment(a, 100, o + 1, 0, 0, 0, 2) != base);
    assert(note_commitment(a, 100, o, 1, 0, 0, 2) != base);
    assert(note_commitment(a, 100, o, 0, 1, 0, 2) != base);
    assert(note_commitment(a, 100, o, 0, 0, 1, 2) != base);
    assert(note_commitment(a, 100, o, 0, 0, 0, 3) != base);
}
