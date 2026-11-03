//! Kernel tests. Honest witnesses come from the Rust reference (fixtures.nr).
//! Every constraint K1..K12 has at least one negative test: mutate the witness
//! (and, where needed, recompute all *derived* public values so that only the
//! constraint under test can catch the mutation) and expect that exact failure.

use crate::fixtures;
use crate::kernel::{recompute_public, verify_action};

global TWO_POW_64: Field = 18446744073709551616;
global TWO_POW_26: Field = 67108864;

// ---------------------------------------------------------------- honest cases

#[test]
fn honest_deposit() {
    verify_action(fixtures::deposit());
}

#[test]
fn honest_transfer_one_input() {
    verify_action(fixtures::transfer_1in());
}

#[test]
fn honest_transfer_two_inputs_with_fee() {
    verify_action(fixtures::transfer_2in_fee());
}

#[test]
fn honest_withdraw() {
    verify_action(fixtures::withdraw());
}

#[test]
fn recompute_is_identity_on_honest_witnesses() {
    let w = fixtures::transfer_2in_fee();
    let r = recompute_public(w);
    assert(r.pi_hash == w.pi_hash);
}

#[test]
fn program_path_with_correct_io_hash_is_accepted() {
    // The kernel accepts program_id != 0 with a correct io hash; the M2 pool
    // rejects program_id != 0 until program proofs are verified (M3).
    let mut w = fixtures::transfer_1in();
    w.public.program_id = 77;
    w.program_params_hash = 5;
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K1 amounts

#[test(should_fail_with = "call to assert_max_bit_size")]
fn k1_output_amount_2_pow_64() {
    // Wraparound mint attempt: out0 = 2^64 + 60, out1 = 40 - 2^64 (mod p).
    let mut w = fixtures::transfer_1in();
    w.outputs[0].amount += TWO_POW_64;
    w.outputs[1].amount -= TWO_POW_64;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "call to assert_max_bit_size")]
fn k1_negative_output_amount() {
    let mut w = fixtures::transfer_1in();
    w.outputs[0].amount = -1;
    w.outputs[1].amount = 101;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "call to assert_max_bit_size")]
fn k1_input_amount_out_of_range() {
    let mut w = fixtures::deposit();
    w.inputs[0].amount = TWO_POW_64; // dummy slot, so membership is not what fails
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K2 public amount

#[test(should_fail_with = "call to assert_max_bit_size")]
fn k2_public_amount_too_large() {
    let mut w = fixtures::deposit();
    w.public.public_amount = TWO_POW_64;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "call to assert_max_bit_size")]
fn k2_public_amount_too_negative() {
    let mut w = fixtures::withdraw();
    w.public.public_amount = -TWO_POW_64 - 1;
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K3/K4 ownership and membership

#[test(should_fail_with = "K4: input not in tree")]
fn k3_wrong_spend_key() {
    let mut w = fixtures::transfer_1in();
    w.ask += 1; // someone else's ask: derived owner, hence cm, differs
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K4: input not in tree")]
fn k3_wrong_nullifier_key() {
    let mut w = fixtures::transfer_1in();
    w.nk += 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K4: input not in tree")]
fn k3_wrong_diversifier() {
    let mut w = fixtures::transfer_1in();
    w.inputs[0].d += 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K4: input not in tree")]
fn k4_wrong_merkle_path() {
    let mut w = fixtures::transfer_1in();
    w.inputs[0].path[0] += 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K4: input not in tree")]
fn k4_wrong_root() {
    let mut w = fixtures::transfer_2in_fee();
    w.public.root += 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K4: input not in tree")]
fn k4_wrong_leaf_index() {
    let mut w = fixtures::transfer_2in_fee();
    w.inputs[1].leaf_index += 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K4: input not in tree")]
fn k4_inflated_input_amount() {
    // Claim the 100-note is worth 1000 and withdraw the difference.
    let mut w = fixtures::transfer_1in();
    w.inputs[0].amount = 1000;
    w.outputs[1].amount += 900;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K4: input not in tree")]
fn k4_wrong_asset() {
    let mut w = fixtures::transfer_1in();
    w.asset_id += 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "Field failed to decompose")]
fn k4_leaf_index_out_of_range() {
    // Index aliasing: leaf_index + 2^26 has the same low 26 bits.
    let mut w = fixtures::transfer_1in();
    w.inputs[0].leaf_index += TWO_POW_26;
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K5 nullifier

#[test(should_fail_with = "K5: nullifier")]
fn k5_tampered_nullifier() {
    let mut w = fixtures::transfer_1in();
    w.public.nf[0] += 1;
    w.pi_hash = crate::kernel::pi_hash(w.public);
    verify_action(w);
}

#[test(should_fail_with = "K5: nullifier")]
fn k5_nullifier_of_other_index() {
    let mut w = fixtures::transfer_2in_fee();
    w.public.nf[1] = polypus_notes::nullifier(
        w.nk,
        crate::kernel::input_commitment(w, 1),
        w.inputs[1].leaf_index + 1,
    );
    w.pi_hash = crate::kernel::pi_hash(w.public);
    verify_action(w);
}

// ---------------------------------------------------------------- K6 distinct nullifiers

#[test(should_fail_with = "K6: duplicate nullifier")]
fn k6_duplicate_nullifiers() {
    let mut w = fixtures::deposit();
    w.inputs[1] = w.inputs[0];
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K7 outputs

#[test(should_fail_with = "K7: output commitment")]
fn k7_tampered_output_commitment() {
    let mut w = fixtures::transfer_1in();
    w.public.cm_out[0] += 1;
    w.pi_hash = crate::kernel::pi_hash(w.public);
    verify_action(w);
}

#[test(should_fail_with = "K7: output commitment")]
fn k7_output_owner_swapped_after_commitment() {
    let mut w = fixtures::transfer_1in();
    w.outputs[0].owner = w.outputs[1].owner;
    verify_action(w);
}

#[test(should_fail_with = "K7: unlocked output not canonical")]
fn k7_unlocked_output_with_escape() {
    let mut w = fixtures::transfer_1in();
    w.outputs[1].escape = 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K7: locked output without escape")]
fn k7_locked_output_without_escape() {
    let mut w = fixtures::transfer_1in();
    w.outputs[0].lock_program = 77;
    w.outputs[0].lock_data = 9;
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K8 conservation

#[test(should_fail_with = "K8: value not conserved")]
fn k8_output_off_by_one() {
    let mut w = fixtures::transfer_2in_fee();
    w.outputs[0].amount += 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K8: value not conserved")]
fn k8_public_amount_off_by_one() {
    let mut w = fixtures::withdraw();
    w.public.public_amount -= 1; // withdraw one more than the notes cover
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K8: value not conserved")]
fn k8_deposit_mints_extra() {
    let mut w = fixtures::deposit();
    w.outputs[1].amount = 1;
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K9 asset binding

#[test(should_fail_with = "K9: asset mismatch")]
fn k9_public_asset_mismatch() {
    let mut w = fixtures::deposit();
    w.public.public_asset_id += 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K9: public asset required")]
fn k9_hidden_asset_with_public_amount() {
    let mut w = fixtures::withdraw();
    w.public.public_asset_id = 0;
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K10 lock rule

#[test(should_fail_with = "K10: input locked to another program")]
fn k10_locked_input_spent_as_plain_transfer() {
    // A zero-value input (so K4 is skipped) locked to program 77, spent with
    // program_id = 0: only K10 can reject it.
    let mut w = fixtures::deposit();
    w.inputs[0].lock_program = 77;
    w.inputs[0].escape = 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K10: input locked to another program")]
fn k10_locked_input_spent_under_other_program() {
    let mut w = fixtures::deposit();
    w.inputs[0].lock_program = 77;
    w.inputs[0].escape = 1;
    w.public.program_id = 78;
    verify_action(recompute_public(w));
}

// ---------------------------------------------------------------- K11 program binding

#[test(should_fail_with = "K11: program_io_hash must be 0 for program 0")]
fn k11_nonzero_io_hash_for_program_0() {
    let mut w = fixtures::transfer_1in();
    w.public.program_io_hash = 1;
    verify_action(recompute_public(w));
}

#[test(should_fail_with = "K11: program_io_hash")]
fn k11_tampered_io_hash() {
    let mut w = fixtures::transfer_1in();
    w.public.program_id = 77;
    let mut r = recompute_public(w);
    r.public.program_io_hash += 1;
    r.pi_hash = crate::kernel::pi_hash(r.public);
    verify_action(r);
}

#[test(should_fail_with = "K11: program_io_hash")]
fn k11_io_hash_with_other_params() {
    let mut w = fixtures::transfer_1in();
    w.public.program_id = 77;
    let mut r = recompute_public(w);
    r.program_params_hash = 1; // proof for different public params
    verify_action(r);
}

// ---------------------------------------------------------------- K12 public-input binding

#[test(should_fail_with = "K12: pi_hash")]
fn k12_tampered_ext_data_hash() {
    // Relayer swaps recipient/fee: ext_data_hash changes, pi_hash no longer matches.
    let mut w = fixtures::withdraw();
    w.public.ext_data_hash += 1;
    verify_action(w);
}

#[test(should_fail_with = "K12: pi_hash")]
fn k12_tampered_pi_hash() {
    let mut w = fixtures::transfer_1in();
    w.pi_hash += 1;
    verify_action(w);
}

#[test(should_fail_with = "K12: pi_hash")]
fn k12_root_swap_not_bound() {
    // Same witness, but claim it was proven against another (empty) root.
    let mut w = fixtures::deposit();
    w.public.root += 1;
    verify_action(w);
}
