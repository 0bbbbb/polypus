//! Deterministic end-to-end scenario (deposit → transfer → transfer with fee →
//! withdraw) shared by the vector generator, the Noir fixtures and the
//! differential tests.

use crate::ext_data::{ciphertext_hash, ExtData};
use crate::field::Fr;
use crate::kernel::{build_action, KernelWitness, SpendInput};
use crate::keys::SpendingKey;
use crate::merkle::MerkleTree;
use crate::note::{asset_id, Note};
use rand::rngs::StdRng;
use rand::SeedableRng;

pub const TEST_MINT: [u8; 32] = [0x11; 32];

pub struct Scenario {
    pub name: &'static str,
    pub witness: KernelWitness,
    pub ext: ExtData,
}

/// Simple in-memory pool used to sequence actions in tests.
pub struct Ledger {
    pub rng: StdRng,
    pub tree: MerkleTree,
    pub aid: Fr,
    pub pool_id: [u8; 32],
    pub chain_domain: [u8; 32],
}

impl Ledger {
    pub fn new(seed: u64, mint: [u8; 32], pool_id: [u8; 32], chain_domain: [u8; 32]) -> Self {
        Ledger { rng: StdRng::seed_from_u64(seed), tree: MerkleTree::new(), aid: asset_id(&mint), pool_id, chain_domain }
    }

    pub fn ext(&self, ext_amount: i64, fee: u64, public_account: [u8; 32], relayer: [u8; 32], cts: [&[u8]; 2]) -> ExtData {
        ExtData {
            pool_id: self.pool_id,
            chain_domain: self.chain_domain,
            public_account,
            relayer,
            ext_amount,
            fee,
            not_before_slot: 0,
            ct_hash: [ciphertext_hash(cts[0]), ciphertext_hash(cts[1])],
        }
    }

    pub fn note(&mut self, amount: u64, owner: Fr) -> Note {
        Note::random_plain(&mut self.rng, self.aid, amount, owner)
    }

    /// Build a witness and apply its outputs to the tree (as the pool would).
    /// Returns the witness and the leaf indices of the two outputs.
    pub fn act(
        &mut self,
        sk: &SpendingKey,
        inputs: [Option<SpendInput>; 2],
        outputs: [Note; 2],
        ext: &ExtData,
    ) -> (KernelWitness, [u64; 2]) {
        let w = build_action(&mut self.rng, sk, &self.tree, self.aid, inputs, outputs, ext);
        let a = self.tree.append(w.public.cm_out[0]).unwrap();
        let b = self.tree.append(w.public.cm_out[1]).unwrap();
        (w, [a, b])
    }
}

pub fn standard_scenarios() -> Vec<Scenario> {
    let alice = SpendingKey::from_seed([1; 32]);
    let bob = SpendingKey::from_seed([2; 32]);
    let (alice_a, bob_a) = (alice.address(0), bob.address(0));
    let mut l = Ledger::new(42, TEST_MINT, [0xa1; 32], [0xc0; 32]);
    let depositor = [0x33; 32];
    let relayer = [0x44; 32];
    let none = [0u8; 32];
    let mut out = Vec::new();

    // 1. Deposit 100 to Alice (0 real inputs).
    let n100 = l.note(100, alice_a.owner);
    let z = l.note(0, alice_a.owner);
    let ext = l.ext(100, 0, depositor, none, [b"ct-dep-0", b"ct-dep-1"]);
    let (w, idx) = l.act(&alice, [None, None], [n100, z], &ext);
    out.push(Scenario { name: "deposit", witness: w, ext });
    let in100 = SpendInput { note: n100, d: alice_a.d, leaf_index: idx[0] };

    // 2. Alice → Bob 60, change 40 (1 real input + dummy, no fee).
    let to_bob = l.note(60, bob_a.owner);
    let change = l.note(40, alice_a.owner);
    let ext = l.ext(0, 0, none, none, [b"ct-tr-0", b"ct-tr-1"]);
    let (w, idx) = l.act(&alice, [Some(in100), None], [to_bob, change], &ext);
    out.push(Scenario { name: "transfer_1in", witness: w, ext });
    let bob60 = SpendInput { note: to_bob, d: bob_a.d, leaf_index: idx[0] };
    let alice40 = SpendInput { note: change, d: alice_a.d, leaf_index: idx[1] };

    // 3. Alice deposits 25 more, then sends 50 to Bob from both notes, fee 5.
    let n25 = l.note(25, alice_a.owner);
    let z = l.note(0, alice_a.owner);
    let ext = l.ext(25, 0, depositor, none, [b"ct-dep2-0", b"ct-dep2-1"]);
    let (_, idx) = l.act(&alice, [None, None], [n25, z], &ext);
    let alice25 = SpendInput { note: n25, d: alice_a.d, leaf_index: idx[0] };
    let bob50 = l.note(50, bob_a.owner);
    let alice10 = l.note(10, alice_a.owner);
    let ext = l.ext(0, 5, none, relayer, [b"ct-tr2-0", b"ct-tr2-1"]);
    let (w, idx) = l.act(&alice, [Some(alice40), Some(alice25)], [bob50, alice10], &ext);
    out.push(Scenario { name: "transfer_2in_fee", witness: w, ext });
    let bob50 = SpendInput { note: bob50, d: bob_a.d, leaf_index: idx[0] };

    // 4. Bob withdraws 100 of his 110 to a public account, fee 3, keeps 7.
    let keep = l.note(7, bob_a.owner);
    let z = l.note(0, bob_a.owner);
    let ext = l.ext(-100, 3, [0x55; 32], relayer, [b"ct-wd-0", b"ct-wd-1"]);
    let (w, _) = l.act(&bob, [Some(bob60), Some(bob50)], [keep, z], &ext);
    out.push(Scenario { name: "withdraw", witness: w, ext });

    for s in &out {
        s.witness.check().unwrap_or_else(|e| panic!("scenario {} invalid: {e}", s.name));
    }
    out
}
