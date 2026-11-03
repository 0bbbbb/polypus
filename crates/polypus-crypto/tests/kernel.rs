//! Reference-relation tests: honest actions verify; every constraint has a
//! mutation that makes it fail; value conservation holds under proptest.

use ark_ff::{One, Zero};
use polypus_crypto::address::display_typed;
use polypus_crypto::ext_data::ExtData;
use polypus_crypto::field::{from_i128, from_u64, Fr};
use polypus_crypto::kernel::{build_action, KernelError, KernelWitness, SpendInput};
use polypus_crypto::keys::{Address, SpendingKey};
use polypus_crypto::merkle::{Frontier, MerkleTree};
use polypus_crypto::note::{asset_id, Note};
use proptest::prelude::*;
use rand::rngs::StdRng;
use rand::SeedableRng;

struct World {
    rng: StdRng,
    alice: SpendingKey,
    bob: SpendingKey,
    aid: Fr,
    tree: MerkleTree,
}

impl World {
    fn new(seed: u64) -> Self {
        World {
            rng: StdRng::seed_from_u64(seed),
            alice: SpendingKey::from_seed([1; 32]),
            bob: SpendingKey::from_seed([2; 32]),
            aid: asset_id(&[0x11; 32]),
            tree: MerkleTree::new(),
        }
    }

    fn ext(&self, ext_amount: i64, fee: u64) -> ExtData {
        ExtData {
            pool_id: [9; 32],
            chain_domain: [8; 32],
            public_account: if ext_amount != 0 { [7; 32] } else { [0; 32] },
            relayer: if fee != 0 { [6; 32] } else { [0; 32] },
            ext_amount,
            fee,
            not_before_slot: 0,
            ct_hash: [[1; 32], [2; 32]],
        }
    }

    fn note(&mut self, amount: u64, owner: Fr) -> Note {
        Note::random_plain(&mut self.rng, self.aid, amount, owner)
    }

    /// Deposit `a` to alice and return the spendable input.
    fn deposit(&mut self, a: u64) -> SpendInput {
        let n = self.note(a, self.alice.address(0).owner);
        let z = self.note(0, self.alice.address(0).owner);
        let ext = self.ext(a as i64, 0);
        let w = build_action(&mut self.rng, &self.alice, &self.tree, self.aid, [None, None], [n, z], &ext);
        w.check().unwrap();
        let idx = self.tree.append(n.commitment()).unwrap();
        self.tree.append(z.commitment()).unwrap();
        SpendInput { note: n, d: self.alice.diversifier(0), leaf_index: idx }
    }

    fn transfer_witness(&mut self) -> KernelWitness {
        let i0 = self.deposit(70);
        let i1 = self.deposit(30);
        let to_bob = self.note(80, self.bob.address(0).owner);
        let change = self.note(15, self.alice.address(1).owner);
        let ext = self.ext(0, 5);
        build_action(&mut self.rng, &self.alice, &self.tree, self.aid, [Some(i0), Some(i1)], [to_bob, change], &ext)
    }
}

#[test]
fn honest_deposit_transfer_withdraw() {
    let mut w = World::new(1);
    let t = w.transfer_witness();
    assert_eq!(t.check(), Ok(()));

    // Bob withdraws 50 of his 80 and keeps 30.
    let bob_note = Note {
        version: 1,
        asset_id: w.aid,
        amount: 80,
        owner: w.bob.address(0).owner,
        lock_program: Fr::zero(),
        lock_data: Fr::zero(),
        escape: Fr::zero(),
        rseed: t.outputs[0].rseed,
    };
    assert_eq!(bob_note.commitment(), t.public.cm_out[0]);
    let idx = w.tree.append(t.public.cm_out[0]).unwrap();
    w.tree.append(t.public.cm_out[1]).unwrap();
    let keep = w.note(30, w.bob.address(0).owner);
    let zero = w.note(0, w.bob.address(0).owner);
    let ext = w.ext(-50, 0);
    let bob = w.bob.clone();
    let wd = build_action(
        &mut w.rng,
        &bob,
        &w.tree,
        w.aid,
        [None, Some(SpendInput { note: bob_note, d: bob.diversifier(0), leaf_index: idx })],
        [keep, zero],
        &ext,
    );
    assert_eq!(wd.check(), Ok(()));
    assert!(display_typed(polypus_crypto::address::Typed::Nullifier, &polypus_crypto::field::to_bytes_be(&wd.public.nf[1])).starts_with("nf_"));
}

/// Apply `f`, optionally recompute derived public values, expect `err`.
fn expect_fail(base: &KernelWitness, recompute: bool, err: KernelError, f: impl FnOnce(&mut KernelWitness)) {
    let mut w = base.clone();
    f(&mut w);
    if recompute {
        w.recompute_public();
    }
    assert_eq!(w.check(), Err(err));
}

#[test]
fn every_constraint_has_a_failing_mutation() {
    let mut world = World::new(2);
    let base = world.transfer_witness();
    assert_eq!(base.check(), Ok(()));
    let two64 = from_u64(u64::MAX) + Fr::one();

    // K1: amount 2^64 in an output, balanced by an input of 2^64 + ... (wraparound attempt).
    expect_fail(&base, true, KernelError::AmountRange, |w| w.outputs[0].amount = two64);
    expect_fail(&base, true, KernelError::AmountRange, |w| w.outputs[1].amount = -Fr::one());
    expect_fail(&base, true, KernelError::AmountRange, |w| w.inputs[0].amount = two64 + from_u64(70));
    // K2
    expect_fail(&base, true, KernelError::PublicAmountRange, |w| w.public.public_amount = two64);
    expect_fail(&base, true, KernelError::PublicAmountRange, |w| w.public.public_amount = -two64 - Fr::one());
    // K4: leaf index range, wrong path, wrong root, wrong spend key (ownership), wrong nk.
    expect_fail(&base, true, KernelError::LeafIndexRange(0), |w| w.inputs[0].leaf_index = from_u64(1 << 26));
    expect_fail(&base, true, KernelError::Membership(0), |w| w.inputs[0].path[3] += Fr::one());
    expect_fail(&base, true, KernelError::Membership(1), |w| w.inputs[1].leaf_index = from_u64(0));
    expect_fail(&base, true, KernelError::Membership(0), |w| w.public.root += Fr::one());
    expect_fail(&base, true, KernelError::Membership(0), |w| w.ask += Fr::one());
    expect_fail(&base, true, KernelError::Membership(0), |w| w.nk += Fr::one());
    expect_fail(&base, true, KernelError::Membership(0), |w| w.inputs[0].d += Fr::one());
    expect_fail(&base, true, KernelError::Membership(0), |w| w.asset_id += Fr::one());
    // K5
    expect_fail(&base, false, KernelError::Nullifier(0), |w| w.public.nf[0] += Fr::one());
    expect_fail(&base, false, KernelError::Nullifier(1), |w| w.public.nf[1] = w.public.nf[0]);
    // K6: two dummies with identical openings produce equal nullifiers.
    {
        let mut w = base.clone();
        for i in 0..2 {
            w.inputs[i].amount = Fr::zero();
        }
        w.inputs[1] = w.inputs[0].clone();
        w.outputs[0].amount = from_u64(0);
        w.outputs[1].amount = from_u64(0);
        w.public.public_amount = Fr::zero();
        w.public.public_asset_id = Fr::zero();
        w.recompute_public();
        assert_eq!(w.check(), Err(KernelError::DuplicateNullifier));
    }
    // K7
    expect_fail(&base, false, KernelError::OutputCommitment(0), |w| w.public.cm_out[0] += Fr::one());
    expect_fail(&base, false, KernelError::OutputCommitment(1), |w| w.outputs[1].owner += Fr::one());
    expect_fail(&base, true, KernelError::OutputWellFormed(0), |w| w.outputs[0].escape = Fr::one());
    expect_fail(&base, true, KernelError::OutputWellFormed(1), |w| w.outputs[1].lock_program = Fr::one());
    // K8: off by one in either direction.
    expect_fail(&base, true, KernelError::Conservation, |w| w.outputs[0].amount += Fr::one());
    expect_fail(&base, true, KernelError::Conservation, |w| w.public.public_amount += Fr::one());
    // K9
    expect_fail(&base, true, KernelError::Asset, |w| w.public.public_asset_id += Fr::one());
    expect_fail(&base, true, KernelError::Asset, |w| w.public.public_asset_id = Fr::zero());
    // K10: spend a note locked to program 77 as a plain transfer (dummy so that
    // membership is not what fails).
    expect_fail(&base, true, KernelError::Lock(0), |w| {
        w.inputs[0].amount = Fr::zero();
        w.outputs[0].amount -= from_u64(70);
        w.inputs[0].lock_program = from_u64(77);
        w.inputs[0].escape = Fr::one();
    });
    // K11
    expect_fail(&base, true, KernelError::ProgramIo, |w| w.public.program_io_hash = Fr::one());
    {
        let mut w = base.clone();
        w.public.program_id = from_u64(77);
        w.recompute_public();
        assert_eq!(w.check(), Ok(()), "program path with a correct io hash is accepted by the kernel");
        w.public.program_io_hash += Fr::one();
        w.pi_hash = w.public.pi_hash();
        assert_eq!(w.check(), Err(KernelError::ProgramIo));
    }
    // K12: every public value is bound by pi_hash.
    expect_fail(&base, false, KernelError::PiHash, |w| w.public.ext_data_hash += Fr::one());
    expect_fail(&base, false, KernelError::PiHash, |w| w.pi_hash += Fr::one());
}

#[test]
fn frontier_tracks_client_tree() {
    let mut world = World::new(3);
    let mut f = Frontier::default();
    for _ in 0..3 {
        world.deposit(5);
    }
    for i in (0..world.tree.len()).step_by(2) {
        f.append_pair(world.tree.leaf(i).unwrap(), world.tree.leaf(i + 1).unwrap()).unwrap();
    }
    assert_eq!(f.root(), world.tree.root());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Any split of in + public_amount into two outputs is accepted; any
    /// imbalance is rejected.
    #[test]
    fn conservation(a in 0u64..1_000_000, b in 0u64..1_000_000, ext in -1_000_000i64..1_000_000, fee in 0u64..1000, cut in 0u64..=u64::MAX, delta in 1i64..1000) {
        let mut world = World::new(a ^ b);
        let total = a as i128 + b as i128 + ext as i128 - fee as i128;
        prop_assume!(total >= 0);
        let i0 = world.deposit(a);
        let i1 = world.deposit(b);
        let out0 = (cut as i128 % (total + 1)) as u64;
        let out1 = (total as u64) - out0;
        let n0 = world.note(out0, world.bob.address(0).owner);
        let n1 = world.note(out1, world.alice.address(0).owner);
        let e = world.ext(ext, fee);
        let alice = world.alice.clone();
        let w = build_action(&mut world.rng, &alice, &world.tree, world.aid, [Some(i0), Some(i1)], [n0, n1], &e);
        prop_assert_eq!(w.check(), Ok(()));
        let mut bad = w.clone();
        bad.outputs[1].amount += from_i128(delta as i128);
        bad.recompute_public();
        prop_assert!(bad.check().is_err());
    }

    #[test]
    fn address_roundtrip(seed in any::<[u8; 32]>(), j in any::<u32>()) {
        let a = SpendingKey::from_seed(seed).address(j);
        prop_assert_eq!(Address::decode(&a.encode()).unwrap(), a);
    }

    #[test]
    fn frontier_equals_tree(leaves in proptest::collection::vec(any::<u64>(), 0..40)) {
        let mut t = MerkleTree::new();
        let mut f = Frontier::default();
        for pair in leaves.chunks_exact(2) {
            let (x, y) = (from_u64(pair[0]), from_u64(pair[1]));
            t.append(x).unwrap();
            t.append(y).unwrap();
            f.append_pair(x, y).unwrap();
        }
        prop_assert_eq!(t.root(), f.root());
    }
}
