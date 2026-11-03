//! End-to-end on LiteSVM with REAL kernel proofs: witnesses are built by the
//! Rust reference against this pool's actual addresses, proven with
//! nargo + Sunspot (INSECURE dev keys from scripts/dev-setup.sh), and verified
//! by the pool built with the matching VK.
//!
//!   ../scripts/dev-setup.sh && anchor build   # pool with artifacts/dev/kernel.vk
//!   cargo test -p polypus-tests --test kernel_e2e -- --ignored --nocapture

use polypus_crypto::ext_data::ExtData;
use polypus_crypto::field::to_bytes_be;
use polypus_crypto::kernel::{KernelWitness, SpendInput};
use polypus_crypto::keys::SpendingKey;
use polypus_crypto::note::Note;
use polypus_crypto::scenarios::Ledger;
use polypus_prover::Toolchain;
use polypus_tests::*;
use solana_address::Address;
use solana_signer::Signer;

struct Run {
    env: Env,
    ledger: Ledger,
    tc: Toolchain,
    cu: Vec<(String, u64, usize)>,
}

impl Run {
    fn args(&self, w: &KernelWitness, ext: &ExtData, proof: Vec<u8>, cts: [Vec<u8>; 2]) -> TransactArgs {
        let p = &w.public;
        TransactArgs {
            nf: [to_bytes_be(&p.nf[0]), to_bytes_be(&p.nf[1])],
            root: to_bytes_be(&p.root),
            cm_out: [to_bytes_be(&p.cm_out[0]), to_bytes_be(&p.cm_out[1])],
            ext_amount: ext.ext_amount,
            fee: ext.fee,
            not_before_slot: ext.not_before_slot,
            proof,
            ciphertexts: cts,
        }
    }

    /// Build, prove and submit one action; returns its args and output leaf indices.
    fn step(
        &mut self,
        label: &str,
        kind: Kind,
        sk: &SpendingKey,
        inputs: [Option<SpendInput>; 2],
        outputs: [Note; 2],
        ext_amount: i64,
        fee: u64,
    ) -> (TransactArgs, [u64; 2]) {
        let (public, relayer) = default_accounts(kind, fee);
        let cts = [format!("{label}/ct0").into_bytes(), format!("{label}/ct1").into_bytes()];
        let ext = self.ledger.ext(
            ext_amount,
            fee,
            public.map(|a| a.to_bytes()).unwrap_or_default(),
            relayer.map(|a| a.to_bytes()).unwrap_or_default(),
            [&cts[0], &cts[1]],
        );
        let (w, idx) = self.ledger.act(sk, inputs, outputs, &ext);
        w.check().expect("reference relation accepts the witness");
        let proof = self.tc.prove(&w).expect("prove");
        assert!(self.tc.verify(&proof).unwrap(), "off-chain verify");
        let a = self.args(&w, &ext, proof.proof, cts);
        assert_eq!(expected_pi_hash(kind, &a), to_bytes_be(&w.pi_hash), "pool and prover agree on pi_hash");

        let vault_before = token_amount(&self.env.svm, &Fixed::vault());
        let m = self
            .env
            .send_action(kind, &a)
            .unwrap_or_else(|e| panic!("{label}: {:?}\n{:#?}", anchor_error(&e), e.meta.logs));
        let ev = action_event(&m).expect("ActionEvent");
        assert_eq!(ev.leaf_index, idx, "{label}: on-chain leaf indices = client tree");
        let (_, _, root) = self.env.tree_state();
        assert_eq!(root, to_bytes_be(&self.ledger.tree.root()), "{label}: on-chain root = Rust MerkleTree root");
        assert_eq!(
            token_amount(&self.env.svm, &Fixed::vault()) as i128,
            vault_before as i128 + ext_amount as i128 - fee as i128
        );

        let (p, r) = default_accounts(kind, fee);
        let signer = if kind == Kind::Deposit { self.env.depositor.pubkey() } else { self.env.relayer.pubkey() };
        let size = legacy_tx_size(&[compute_budget_ix(1_400_000), self.env.action_ix(kind, &signer, p, r, &a)], &signer);
        println!("{label:<28} CU {:>7}  tx {size} B  prove {:.0} ms", m.compute_units_consumed, proof.timings.prove.as_secs_f64() * 1e3);
        self.cu.push((label.to_string(), m.compute_units_consumed, size));

        // Double spend: the same action (same nullifiers) cannot land twice.
        let e = self.env.send_action(kind, &a).unwrap_err();
        assert!(e.meta.logs.iter().any(|l| l.contains("already in use")), "{label}: replay must fail");
        (a, idx)
    }
}

#[test]
#[ignore = "needs nargo, sunspot, artifacts/dev (scripts/dev-setup.sh) and a pool built with that VK"]
fn kernel_e2e_deposit_transfer_withdraw() {
    let tc = Toolchain::default_for_repo();
    let vk = std::fs::read(tc.artifacts_dir.join("kernel.vk")).expect("artifacts/dev/kernel.vk");
    let env = Env::new();
    assert_eq!(
        env.vk_sha256.as_deref(),
        Some(hex::encode(sha256(&vk)).as_str()),
        "pool .so must be built with artifacts/dev/kernel.vk (anchor build after dev-setup)"
    );
    let ledger = Ledger::new(7, Fixed::mint().to_bytes(), Fixed::pool().to_bytes(), Fixed::chain_domain());
    let mut run = Run { env, ledger, tc, cu: Vec::new() };
    let alice = SpendingKey::from_seed([0xa1; 32]);
    let bob = SpendingKey::from_seed([0xb0; 32]);
    let (aa, ba) = (alice.address(0), bob.address(0));
    let dep_start = token_amount(&run.env.svm, &Fixed::depositor_token());

    // 1. Alice shields 100.
    let n = [run.ledger.note(100, aa.owner), run.ledger.note(0, aa.owner)];
    let (_, i) = run.step("deposit 100", Kind::Deposit, &alice, [None, None], n, 100, 0);
    let a100 = SpendInput { note: n[0], d: aa.d, leaf_index: i[0] };

    // 2. Alice → Bob 60 privately, change 38, relayer fee 2.
    let n = [run.ledger.note(60, ba.owner), run.ledger.note(38, aa.owner)];
    let (_, i) = run.step("transfer 1-in, fee 2", Kind::Transact, &alice, [Some(a100), None], n, 0, 2);
    let (b60, a38) = (SpendInput { note: n[0], d: ba.d, leaf_index: i[0] }, SpendInput { note: n[1], d: aa.d, leaf_index: i[1] });

    // 3. Alice shields 25 through a relayer (fee 1 from the deposit).
    let n = [run.ledger.note(24, aa.owner), run.ledger.note(0, aa.owner)];
    let (_, i) = run.step("deposit 25, fee 1", Kind::Deposit, &alice, [None, None], n, 25, 1);
    let a24 = SpendInput { note: n[0], d: aa.d, leaf_index: i[0] };

    // 4. Alice merges 38 + 24 and pays Bob 30 (no fee: asset id stays hidden).
    let n = [run.ledger.note(30, ba.owner), run.ledger.note(32, aa.owner)];
    let (_, i) = run.step("transfer 2-in, no fee", Kind::Transact, &alice, [Some(a38), Some(a24)], n, 0, 0);
    let b30 = SpendInput { note: n[0], d: ba.d, leaf_index: i[0] };

    // 5. Bob unshields 85 of his 90 to a public account, fee 1, keeps 4.
    let n = [run.ledger.note(4, ba.owner), run.ledger.note(0, ba.owner)];
    let (wd, _) = run.step("withdraw 85 2-in, fee 1", Kind::Withdraw, &bob, [Some(b60), Some(b30)], n, -85, 1);

    // Public accounting: vault holds exactly the unspent notes (alice 32 + bob 4).
    let svm = &run.env.svm;
    assert_eq!(token_amount(svm, &Fixed::vault()), 36);
    assert_eq!(token_amount(svm, &Fixed::recipient_token()), 85);
    assert_eq!(token_amount(svm, &Fixed::relayer_token()), 4);
    assert_eq!(dep_start - token_amount(svm, &Fixed::depositor_token()), 125);

    println!("\nsummary (LiteSVM, real kernel proofs, kernel VK compiled in):");
    for (l, c, s) in &run.cu {
        println!("  {l:<28} {c:>7} CU  {s:>5} B");
    }
    let _ = wd;
}

/// A relayer holding a valid withdraw proof cannot redirect funds or raise its fee.
#[test]
#[ignore = "needs nargo, sunspot, artifacts/dev (scripts/dev-setup.sh) and a pool built with that VK"]
fn kernel_e2e_relayer_cannot_tamper() {
    let tc = Toolchain::default_for_repo();
    let env = Env::new();
    let ledger = Ledger::new(8, Fixed::mint().to_bytes(), Fixed::pool().to_bytes(), Fixed::chain_domain());
    let mut run = Run { env, ledger, tc, cu: Vec::new() };
    let alice = SpendingKey::from_seed([0xa2; 32]);
    let aa = alice.address(0);
    let n = [run.ledger.note(50, aa.owner), run.ledger.note(0, aa.owner)];
    let (_, i) = run.step("deposit 50", Kind::Deposit, &alice, [None, None], n, 50, 0);
    let a50 = SpendInput { note: n[0], d: aa.d, leaf_index: i[0] };

    // Build (but do not send) an honest withdraw of 40 with fee 1.
    let (public, relayer) = default_accounts(Kind::Withdraw, 1);
    let cts = [b"w0".to_vec(), b"w1".to_vec()];
    let ext = run.ledger.ext(-40, 1, public.unwrap().to_bytes(), relayer.unwrap().to_bytes(), [&cts[0], &cts[1]]);
    let keep = run.ledger.note(9, aa.owner);
    let zero = run.ledger.note(0, aa.owner);
    let (w, _) = run.ledger.act(&alice, [Some(a50), None], [keep, zero], &ext);
    let proof = run.tc.prove(&w).unwrap();
    let good = run.args(&w, &ext, proof.proof, cts);

    let relayer_kp = run.env.relayer.insecure_clone();
    let send = |env: &mut Env, public: Address, relayer: Option<Address>, a: &TransactArgs| {
        let ix = env.action_ix(Kind::Withdraw, &relayer_kp.pubkey(), Some(public), relayer, a);
        env.send(&[ix], &relayer_kp)
    };
    // Redirect the withdrawal to an attacker-controlled token account.
    let evil = Address::new_unique();
    let rent = run.env.svm.minimum_balance_for_rent_exemption(165);
    let data = pack_token_account(&Fixed::mint(), &relayer_kp.pubkey(), 0);
    let acct = solana_account::Account { lamports: rent, data, owner: token_program(), executable: false, rent_epoch: 0 };
    run.env.svm.set_account(evil, acct).unwrap();
    let e = send(&mut run.env, evil, relayer, &good).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("InvalidProof"), "recipient swap");
    // Raise the fee.
    let e = send(&mut run.env, Fixed::recipient_token(), relayer, &good.clone().fee(5)).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("InvalidProof"), "fee change");
    // Change the amount.
    let e = send(&mut run.env, Fixed::recipient_token(), relayer, &good.clone().ext_amount(-45)).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("InvalidProof"), "amount change");
    // Swap a ciphertext (would break the recipient's note discovery).
    let e = send(&mut run.env, Fixed::recipient_token(), relayer, &good.clone().ciphertexts(b"evil".to_vec(), b"w1".to_vec()))
        .unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("InvalidProof"), "ciphertext swap");
    // The untouched action still succeeds.
    send(&mut run.env, Fixed::recipient_token(), relayer, &good).expect("honest withdraw");
    assert_eq!(token_amount(&run.env.svm, &Fixed::recipient_token()), 40);
    println!("relayer tampering (recipient, fee, amount, ciphertext) rejected; honest withdraw landed");
}
