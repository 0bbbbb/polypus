//! Kernel v1 (2-in / 2-out). This is the only circuit that guards money.
//! UNAUDITED — see spec/SPEC.md §6.3 for the normative constraint list.
//!
//! Invariants enforced (numbering = spec):
//!  K1  every note amount < 2^64
//!  K2  public_amount ∈ [-2^64, 2^64)
//!  K3  input owners are derived from the prover's (ask, nk, d)
//!  K4  non-dummy inputs are in the tree under `root`; leaf_index < 2^26
//!  K5  nullifiers are H(T_NF, nk, cm, leaf_index)
//!  K6  nf[0] != nf[1]
//!  K7  output commitments open to well-formed notes of the action's asset
//!  K8  sum(in) + public_amount == sum(out)
//!  K9  the public asset id (if any) is the action's asset
//!  K10 locked inputs can only be spent under their own program_id
//!  K11 program_io_hash binds program_id to these exact nf/cm (0 for program 0)
//!  K12 pi_hash (the only public input) commits to all public values
//!
//! Because K1 and K2 bound every term of K8 by 2^66 << p, the field equation in
//! K8 is an integer equation: no wraparound, so no minting.

use poseidon::poseidon::bn254;
use polypus_notes::{
    assert_u64, derive_ak, derive_owner, DEPTH, merkle_root, note_commitment, nullifier, T_IO, T_PI,
};

pub global N_IN: u32 = 2;
pub global N_OUT: u32 = 2;
global TWO_POW_64: Field = 18446744073709551616;

pub struct InputNote {
    pub amount: Field,
    pub d: Field,
    pub lock_program: Field,
    pub lock_data: Field,
    pub escape: Field,
    pub rseed: Field,
    pub leaf_index: Field,
    pub path: [Field; DEPTH],
}

pub struct OutputNote {
    pub amount: Field,
    pub owner: Field,
    pub lock_program: Field,
    pub lock_data: Field,
    pub escape: Field,
    pub rseed: Field,
}

/// Values bound by pi_hash and recomputed by the pool from instruction data.
pub struct PublicValues {
    pub root: Field,
    pub nf: [Field; N_IN],
    pub cm_out: [Field; N_OUT],
    pub public_amount: Field,
    pub public_asset_id: Field,
    pub ext_data_hash: Field,
    pub program_id: Field,
    pub program_io_hash: Field,
}

pub struct Witness {
    pub pi_hash: Field,
    pub public: PublicValues,
    pub ask: Field,
    pub nk: Field,
    pub asset_id: Field,
    pub inputs: [InputNote; N_IN],
    pub outputs: [OutputNote; N_OUT],
    pub program_params_hash: Field,
}

pub fn input_commitment(w: Witness, i: u32) -> Field {
    let inp = w.inputs[i];
    let owner = derive_owner(derive_ak(w.ask), w.nk, inp.d);
    note_commitment(w.asset_id, inp.amount, owner, inp.lock_program, inp.lock_data, inp.escape, inp.rseed)
}

pub fn output_commitment(w: Witness, j: u32) -> Field {
    let o = w.outputs[j];
    note_commitment(w.asset_id, o.amount, o.owner, o.lock_program, o.lock_data, o.escape, o.rseed)
}

pub fn program_io_hash(p: PublicValues, program_params_hash: Field) -> Field {
    bn254::hash_7([T_IO, p.program_id, p.nf[0], p.nf[1], p.cm_out[0], p.cm_out[1], program_params_hash])
}

pub fn pi_hash(p: PublicValues) -> Field {
    bn254::hash_11([
        T_PI, p.root, p.nf[0], p.nf[1], p.cm_out[0], p.cm_out[1], p.public_amount, p.public_asset_id,
        p.ext_data_hash, p.program_id, p.program_io_hash,
    ])
}

pub fn verify_action(w: Witness) {
    let p = w.public;

    // K1: 64-bit amounts, so sums cannot wrap modulo p.
    for i in 0..N_IN {
        assert_u64(w.inputs[i].amount);
    }
    for j in 0..N_OUT {
        assert_u64(w.outputs[j].amount);
    }

    // K2: public_amount is a small signed integer (the pool also bounds it).
    (p.public_amount + TWO_POW_64).assert_max_bit_size::<65>();

    let ak = derive_ak(w.ask);
    for i in 0..N_IN {
        let inp = w.inputs[i];
        // K3: the owner is derived from the spend key, so only the key holder
        // can produce a commitment that passes K4.
        let owner = derive_owner(ak, w.nk, inp.d);
        let cm = note_commitment(w.asset_id, inp.amount, owner, inp.lock_program, inp.lock_data, inp.escape, inp.rseed);
        // K4: membership (leaf_index < 2^26 is enforced inside merkle_root for
        // every input). Zero-value inputs are dummies and skip membership; they
        // add no value, and their nullifiers are still published.
        let computed_root = merkle_root(cm, inp.leaf_index, inp.path);
        if inp.amount != 0 {
            assert(computed_root == p.root, "K4: input not in tree");
        }
        // K5
        assert(p.nf[i] == nullifier(w.nk, cm, inp.leaf_index), "K5: nullifier");
    }

    // K6
    assert(p.nf[0] != p.nf[1], "K6: duplicate nullifier");

    // K7: outputs are well-formed notes of the same asset.
    for j in 0..N_OUT {
        let o = w.outputs[j];
        if o.lock_program == 0 {
            assert((o.lock_data == 0) & (o.escape == 0), "K7: unlocked output not canonical");
        } else {
            assert(o.escape != 0, "K7: locked output without escape");
        }
        assert(
            p.cm_out[j] == note_commitment(w.asset_id, o.amount, o.owner, o.lock_program, o.lock_data, o.escape, o.rseed),
            "K7: output commitment",
        );
    }

    // K8: value conservation (single asset).
    assert(
        w.inputs[0].amount + w.inputs[1].amount + p.public_amount == w.outputs[0].amount + w.outputs[1].amount,
        "K8: value not conserved",
    );

    // K9: tokens moving in or out of the vault must be of this action's asset.
    if p.public_asset_id != 0 {
        assert(w.asset_id == p.public_asset_id, "K9: asset mismatch");
    }
    if p.public_amount != 0 {
        assert(p.public_asset_id != 0, "K9: public asset required");
    }

    // K10: lock_program ∈ {0, program_id}. The escape path is deferred (ADR-0005);
    // the M2 pool only accepts program_id = 0, so locked notes are unspendable.
    for i in 0..N_IN {
        let lp = w.inputs[i].lock_program;
        assert(lp * (lp - p.program_id) == 0, "K10: input locked to another program");
    }

    // K11: bind a program proof to these exact notes.
    let io = program_io_hash(p, w.program_params_hash);
    if p.program_id == 0 {
        assert(p.program_io_hash == 0, "K11: program_io_hash must be 0 for program 0");
    } else {
        assert(p.program_io_hash == io, "K11: program_io_hash");
    }

    // K12: the single Groth16 public input.
    assert(w.pi_hash == pi_hash(p), "K12: pi_hash");
}

/// Recompute every derived public value from the private witness. Test helper
/// for "internally consistent but malicious" witnesses: after a mutation, only
/// the constraint under test can reject them.
pub fn recompute_public(w: Witness) -> Witness {
    let mut out = w;
    for i in 0..N_IN {
        out.public.nf[i] = nullifier(w.nk, input_commitment(w, i), w.inputs[i].leaf_index);
    }
    for j in 0..N_OUT {
        out.public.cm_out[j] = output_commitment(w, j);
    }
    if out.public.program_id != 0 {
        out.public.program_io_hash = program_io_hash(out.public, w.program_params_hash);
    }
    out.pi_hash = pi_hash(out.public);
    out
}
