//! LiteSVM tests of `polypus-pool`.
//!
//! Until real kernel proofs exist, actions are sent with a well-formed but
//! wrong proof (the Sunspot smoke-test proof, or `$POLYPUS_DUMMY_PROOF`). The
//! pool then runs every check up to and including the pairing and fails with
//! `InvalidProof`, logging the pi_hash it recomputed; the tests compare that
//! against `polypus-crypto` (on-chain parity of ext_data_hash / pi_hash) and use
//! "reaches InvalidProof" as evidence that all earlier checks passed.

use polypus_crypto::{
    field::{from_u64, to_bytes_be},
    merkle::{zeros, Frontier},
};
use polypus_tests::*;
use solana_account::Account;
use solana_address::Address;
use solana_signer::Signer;

fn empty_root() -> [u8; 32] {
    to_bytes_be(&zeros()[26])
}

fn args() -> TransactArgs {
    TransactArgs::new(empty_root()).proof(dummy_proof())
}

/// Send and expect a rejection with Anchor error `name`.
fn expect_err(env: &mut Env, kind: Kind, a: &TransactArgs, name: &str) {
    let e = env.send_action(kind, a).expect_err("must fail");
    assert_eq!(anchor_error(&e).as_deref(), Some(name), "logs: {:#?}", e.meta.logs);
}

#[test]
fn init_pool_state_and_cu() {
    let mut env = Env::new();
    println!("CU init_pool: {}", env.init_cu);

    let pool = env.svm.get_account(&Fixed::pool()).unwrap();
    assert_eq!(pool.owner, pool_program());
    assert_eq!(&pool.data[..8], &disc("account", "Pool"));
    // admin, mint, vault, tree, asset_id, chain_domain, 3 bumps.
    let d = &pool.data[8..];
    assert_eq!(&d[0..32], env.admin.pubkey().as_ref());
    assert_eq!(&d[32..64], Fixed::mint().as_ref());
    assert_eq!(&d[64..96], Fixed::vault().as_ref());
    assert_eq!(&d[96..128], Fixed::tree().as_ref());
    println!("kernel VK sha256 (from init_pool log): {:?}", env.vk_sha256);
    // On-chain H_3 (sol_poseidon) == off-chain reference.
    let asset = polypus_crypto::note::asset_id(&Fixed::mint().to_bytes());
    assert_eq!(&d[128..160], &to_bytes_be(&asset));
    assert_eq!(&d[160..192], &Fixed::chain_domain());

    let tree = env.tree_account();
    assert_eq!(tree.data.len(), TREE_ACCOUNT_LEN);
    assert_eq!(&tree.data[8..40], Fixed::pool().as_ref());
    assert_eq!(env.tree_state(), (0, 0, empty_root()));
    for l in 0..26 {
        let o = TREE_FILLED_OFFSET + 32 * l;
        assert_eq!(&tree.data[o..o + 32], &to_bytes_be(&zeros()[l]));
    }

    // Vault: token account of the mint, owned by the pool PDA.
    let vault = env.svm.get_account(&Fixed::vault()).unwrap();
    assert_eq!(vault.owner, token_program());
    assert_eq!(&vault.data[0..32], Fixed::mint().as_ref());
    assert_eq!(&vault.data[32..64], Fixed::pool().as_ref());

    // A second init for the same mint fails (PDAs exist).
    assert!(env.init_pool([9u8; 32]).is_err());
}

#[test]
fn fixture_context() {
    let env = Env::new();
    let ctx = serde_json::json!({
        "program_id": POOL_PROGRAM_ID,
        "mint": Fixed::mint().to_string(),
        "pool_id": Fixed::pool().to_string(),
        "pool_id_hex": hex::encode(Fixed::pool().to_bytes()),
        "chain_domain_hex": hex::encode(Fixed::chain_domain()),
        "asset_id_hex": hex::encode(to_bytes_be(&polypus_crypto::note::asset_id(&Fixed::mint().to_bytes()))),
        "deposit_public_account_hex": hex::encode(Fixed::depositor_token().to_bytes()),
        "withdraw_public_account_hex": hex::encode(Fixed::recipient_token().to_bytes()),
        "relayer_token_hex (iff fee > 0)": hex::encode(Fixed::relayer_token().to_bytes()),
        "empty_root_hex": hex::encode(empty_root()),
        "depositor_start_balance": DEPOSITOR_START_BALANCE,
    });
    let _ = env;
    println!("{}", serde_json::to_string_pretty(&ctx).unwrap());
}

/// For each action shape, the pool's recomputed pi_hash equals the reference.
#[test]
fn pi_hash_parity_and_cu_up_to_verification() {
    let cases: Vec<(&str, Kind, TransactArgs)> = vec![
        ("deposit, no fee", Kind::Deposit, args().ext_amount(1_000)),
        ("deposit, fee", Kind::Deposit, args().ext_amount(1_000).fee(10)),
        ("transact, no fee (asset hidden)", Kind::Transact, args()),
        ("transact, fee", Kind::Transact, args().fee(5)),
        ("withdraw, fee", Kind::Withdraw, args().ext_amount(-500).fee(7).not_before_slot(0)),
        (
            "withdraw, max magnitudes",
            Kind::Withdraw,
            args().ext_amount(-((1i64 << 62) - 1)).fee((1u64 << 62) - 1),
        ),
    ];
    for (label, kind, a) in cases {
        let mut env = Env::new();
        let vault_before = token_amount(&env.svm, &Fixed::vault());
        let e = env.send_action(kind, &a).expect_err("dummy proof must be rejected");
        assert_eq!(anchor_error(&e).as_deref(), Some("InvalidProof"), "{label}: {:#?}", e.meta.logs);
        assert_eq!(logged_pi_hash(&e), Some(env.expected_pi_hash(kind, &a)), "{label}");
        println!(
            "CU {label}: {} (all checks + Groth16 verify, failing at the pairing; excludes tree append / token CPIs)",
            e.meta.compute_units_consumed
        );
        // Atomic: nothing changed.
        assert_eq!(token_amount(&env.svm, &Fixed::vault()), vault_before);
        assert!(env.svm.get_account(&nullifier_pda(&Fixed::pool(), &a.nf[0])).is_none());
        assert_eq!(env.tree_state(), (0, 0, empty_root()));
    }
}

#[test]
fn transaction_size() {
    let env = Env::new();
    for (ct_len, kind, fee) in [(0usize, Kind::Transact, 0u64), (0, Kind::Withdraw, 1), (120, Kind::Withdraw, 1)] {
        let a = args().ext_amount(if kind == Kind::Withdraw { -1 } else { 0 }).fee(fee)
            .ciphertexts(vec![7u8; ct_len], vec![8u8; ct_len]);
        let (p, r) = default_accounts(kind, fee);
        let ix = env.action_ix(kind, &env.relayer.pubkey(), p, r, &a);
        let n = legacy_tx_size(&[compute_budget_ix(1_400_000), ix], &env.relayer.pubkey());
        println!(
            "tx size {kind:?} fee={fee} ciphertexts=2x{ct_len}B proof={}B: {n} bytes (legacy limit 1232)",
            a.proof.len()
        );
    }
}

#[test]
fn rejects_wrong_ext_amount_sign() {
    let mut env = Env::new();
    expect_err(&mut env, Kind::Deposit, &args(), "WrongExtAmountSign");
    expect_err(&mut env, Kind::Deposit, &args().ext_amount(-1), "WrongExtAmountSign");
    expect_err(&mut env, Kind::Transact, &args().ext_amount(5), "WrongExtAmountSign");
    expect_err(&mut env, Kind::Withdraw, &args().ext_amount(5), "WrongExtAmountSign");
    expect_err(&mut env, Kind::Withdraw, &args(), "WrongExtAmountSign");
}

#[test]
fn rejects_out_of_range_amounts() {
    let mut env = Env::new();
    expect_err(&mut env, Kind::Deposit, &args().ext_amount(1 << 62), "ExtAmountOutOfRange");
    expect_err(&mut env, Kind::Withdraw, &args().ext_amount(-(1 << 62)), "ExtAmountOutOfRange");
    expect_err(&mut env, Kind::Withdraw, &args().ext_amount(i64::MIN), "ExtAmountOutOfRange");
    expect_err(&mut env, Kind::Transact, &args().fee(1 << 62), "FeeOutOfRange");
    expect_err(&mut env, Kind::Transact, &args().fee(u64::MAX), "FeeOutOfRange");
}

#[test]
fn relayer_account_iff_fee() {
    let mut env = Env::new();
    let payer = env.relayer.insecure_clone();
    // fee > 0 but no relayer account.
    let a = args().fee(3);
    let ix = env.action_ix(Kind::Transact, &payer.pubkey(), None, None, &a);
    let e = env.send(&[ix], &payer).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("RelayerAccountMismatch"));
    // fee == 0 but a relayer account is supplied.
    let a = args();
    let ix = env.action_ix(Kind::Transact, &payer.pubkey(), None, Some(Fixed::relayer_token()), &a);
    let e = env.send(&[ix], &payer).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("RelayerAccountMismatch"));
}

#[test]
fn not_before_slot() {
    let mut env = Env::new();
    let now = env.svm.get_sysvar::<solana_clock::Clock>().slot;
    let a = args().not_before_slot(now + 1_000);
    expect_err(&mut env, Kind::Transact, &a, "NotBeforeSlot");
    env.svm.warp_to_slot(now + 999);
    expect_err(&mut env, Kind::Transact, &a, "NotBeforeSlot");
    env.svm.warp_to_slot(now + 1_000);
    expect_err(&mut env, Kind::Transact, &a, "InvalidProof");
}

#[test]
fn rejects_non_canonical_field_elements() {
    let mut env = Env::new();
    let p: [u8; 32] = hex::decode("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001")
        .unwrap()
        .try_into()
        .unwrap();
    let mut root = args();
    root.root = p;
    expect_err(&mut env, Kind::Transact, &root, "NonCanonicalFieldElement");
    expect_err(&mut env, Kind::Transact, &args().nf(p, fe(1)), "NonCanonicalFieldElement");
    expect_err(&mut env, Kind::Transact, &args().nf(fe(1), [0xff; 32]), "NonCanonicalFieldElement");
    expect_err(&mut env, Kind::Transact, &args().cm_out(p, fe(1)), "NonCanonicalFieldElement");
    expect_err(&mut env, Kind::Transact, &args().cm_out(fe(1), p), "NonCanonicalFieldElement");
}

#[test]
fn rejects_duplicate_nullifiers() {
    let mut env = Env::new();
    let e = env.send_action(Kind::Transact, &args().nf(fe(5), fe(5))).unwrap_err();
    // The second `init` of the same PDA fails before the handler runs.
    assert_ne!(anchor_error(&e).as_deref(), Some("InvalidProof"));
    assert!(e.meta.logs.iter().any(|l| l.contains("already in use")), "{:#?}", e.meta.logs);
}

#[test]
fn rejects_unknown_root_and_malformed_proof() {
    let mut env = Env::new();
    expect_err(&mut env, Kind::Transact, &TransactArgs::new(fe(42)).proof(dummy_proof()), "UnknownRoot");
    expect_err(&mut env, Kind::Transact, &TransactArgs::new([0u8; 32]).proof(dummy_proof()), "UnknownRoot");
    let mut short = dummy_proof();
    short.pop();
    expect_err(&mut env, Kind::Transact, &args().proof(short), "MalformedProof");
    let mut long = dummy_proof();
    long.push(0);
    expect_err(&mut env, Kind::Transact, &args().proof(long), "MalformedProof");
    // Commitment-count field must match the compiled-in VK.
    let mut count = dummy_proof();
    count[256 + 3] ^= 1;
    expect_err(&mut env, Kind::Transact, &args().proof(count), "MalformedProof");
}

#[test]
fn rejects_wrong_accounts() {
    let mut env = Env::new();
    let payer = env.relayer.insecure_clone();

    // Token account of another mint as the withdrawal destination.
    let other_mint = Address::new_unique();
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    let foreign = Address::new_unique();
    env.svm
        .set_account(
            foreign,
            Account {
                lamports: rent,
                data: pack_token_account(&other_mint, &payer.pubkey(), 0),
                owner: token_program(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let a = args().ext_amount(-1);
    let ix = env.action_ix(Kind::Withdraw, &payer.pubkey(), Some(foreign), None, &a);
    let e = env.send(&[ix], &payer).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("ConstraintTokenMint"));

    // The vault itself as the counterparty (Anchor already rejects the
    // duplicate mutable account; the pool re-checks it in process_action).
    let ix = env.action_ix(Kind::Withdraw, &payer.pubkey(), Some(Fixed::vault()), None, &a);
    let e = env.send(&[ix], &payer).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("ConstraintDuplicateMutableAccount"));

    // A tree account that is not the pool's tree.
    let mut ix = env.action_ix(Kind::Transact, &payer.pubkey(), None, None, &args());
    let mut fake = env.tree_account();
    let fake_addr = Address::new_unique();
    fake.data[8..40].copy_from_slice(&[0u8; 32]);
    env.svm.set_account(fake_addr, fake).unwrap();
    ix.accounts[2].pubkey = fake_addr;
    let e = env.send(&[ix], &payer).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("ConstraintAddress"));
}

#[test]
fn existing_nullifier_pda_blocks_the_action() {
    let mut env = Env::new();
    let a = args();
    // Simulate an already-spent nf[1]: the PDA exists, owned by the pool.
    let nf_pda = nullifier_pda(&Fixed::pool(), &a.nf[1]);
    let rent = env.svm.minimum_balance_for_rent_exemption(8);
    env.svm
        .set_account(
            nf_pda,
            Account {
                lamports: rent,
                data: disc("account", "Nullifier").to_vec(),
                owner: pool_program(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let e = env.send_action(Kind::Transact, &a).unwrap_err();
    assert!(e.meta.logs.iter().any(|l| l.contains("already in use")), "{:#?}", e.meta.logs);
    assert_ne!(anchor_error(&e).as_deref(), Some("InvalidProof"), "must fail before verification");
    println!("CU rejected double-spend (nullifier exists): {}", e.meta.compute_units_consumed);

    // A pre-funded (but not created) nullifier address does not block `init`.
    let mut env = Env::new();
    env.svm.airdrop(&nullifier_pda(&Fixed::pool(), &a.nf[0]), 1_000_000).unwrap();
    expect_err(&mut env, Kind::Transact, &a, "InvalidProof");
}

#[test]
fn root_history_window() {
    let mut env = Env::new();
    // Write the state of a tree after 130 pair appends (computed off-chain).
    let mut f = Frontier::default();
    let mut roots = vec![f.root()];
    for i in 0..130u64 {
        f.append_pair(from_u64(3 * i + 1), from_u64(3 * i + 2)).unwrap();
        roots.push(f.root());
    }
    let mut tree = env.tree_account();
    tree.data[40..48].copy_from_slice(&f.next_index.to_le_bytes());
    tree.data[48..56].copy_from_slice(&(f.current_root_index as u64).to_le_bytes());
    for l in 0..26 {
        let o = TREE_FILLED_OFFSET + 32 * l;
        tree.data[o..o + 32].copy_from_slice(&to_bytes_be(&f.filled_subtrees[l]));
    }
    for (i, r) in f.roots.iter().enumerate() {
        let o = TREE_ROOTS_OFFSET + 32 * i;
        tree.data[o..o + 32].copy_from_slice(&to_bytes_be(r));
    }
    env.svm.set_account(Fixed::tree(), tree).unwrap();
    assert_eq!(env.tree_state().2, to_bytes_be(&f.root()));

    let with_root = |r: &polypus_crypto::field::Fr| TransactArgs::new(to_bytes_be(r)).proof(dummy_proof());
    // Evicted: the empty root and the roots after appends 1 and 2.
    for r in &roots[0..3] {
        expect_err(&mut env, Kind::Transact, &with_root(r), "UnknownRoot");
    }
    // Inside the window (oldest kept, a middle one, the current one).
    for r in [&roots[3], &roots[64], &roots[130]] {
        expect_err(&mut env, Kind::Transact, &with_root(r), "InvalidProof");
    }
}

fn fixture_files() -> Vec<std::path::PathBuf> {
    let dir = std::env::var("POLYPUS_ACTION_FIXTURES").expect("POLYPUS_ACTION_FIXTURES");
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files
}

fn read_fixture(path: &std::path::Path) -> ActionFixture {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// End-to-end with real proofs. Set `POLYPUS_ACTION_FIXTURES` to a directory
/// of `ActionFixture` JSON files (applied in file-name order) whose proofs
/// were generated against `fixture_context`, and `POLYPUS_POOL_SO` to a pool
/// built with the matching VK (see README: `fixtures/trivial` + trivial VK).
#[test]
#[ignore = "needs real proofs (POLYPUS_ACTION_FIXTURES, POLYPUS_POOL_SO)"]
fn real_proof_actions() {
    let mut env = Env::new();
    for path in fixture_files() {
        let fx = read_fixture(&path);
        let a = fx.to_args();
        let (next_before, _, _) = env.tree_state();
        let vault_before = token_amount(&env.svm, &Fixed::vault());
        let m = env
            .send_action(fx.kind, &a)
            .unwrap_or_else(|e| panic!("{}: {:?} {:#?}", path.display(), anchor_error(&e), e.meta.logs));
        let (p, r) = default_accounts(fx.kind, a.fee);
        let signer = if fx.kind == Kind::Deposit { env.depositor.pubkey() } else { env.relayer.pubkey() };
        let size = legacy_tx_size(
            &[compute_budget_ix(1_400_000), env.action_ix(fx.kind, &signer, p, r, &a)],
            &signer,
        );
        println!(
            "CU {:?} fee={} ({}): {} total, tx {size} bytes",
            fx.kind,
            a.fee,
            path.file_name().unwrap().to_string_lossy(),
            m.compute_units_consumed
        );

        let ev = action_event(&m).expect("ActionEvent");
        assert_eq!(ev.leaf_index, [next_before, next_before + 1]);
        assert_eq!(ev.cm_out, a.cm_out);
        assert_eq!(ev.nf, a.nf);
        assert_eq!(ev.ciphertexts, a.ciphertexts);
        assert_eq!(env.tree_state(), (next_before + 2, env.tree_state().1, ev.new_root));
        for nf in &a.nf {
            assert!(env.svm.get_account(&nullifier_pda(&Fixed::pool(), nf)).is_some());
        }
        let vault_after = token_amount(&env.svm, &Fixed::vault());
        assert_eq!(vault_after as i128, vault_before as i128 + a.ext_amount as i128 - a.fee as i128);

        // Replaying the same nullifiers fails.
        let e = env.send_action(fx.kind, &a).unwrap_err();
        assert!(e.meta.logs.iter().any(|l| l.contains("already in use")));
    }
}

/// A valid proof stops verifying as soon as anything it is bound to changes,
/// and the untouched action still succeeds afterwards. Also: the same proof is
/// rejected by a pool with another chain_domain, and cannot be replayed.
#[test]
#[ignore = "needs real proofs (POLYPUS_ACTION_FIXTURES, POLYPUS_POOL_SO)"]
fn real_proof_bound_data_cannot_change() {
    let files = fixture_files();
    let fx = read_fixture(&files[0]);
    assert_eq!(fx.kind, Kind::Deposit, "first fixture must be a deposit");
    let good = fx.to_args();
    let mut env = Env::new();

    let mutations: Vec<(&str, TransactArgs)> = vec![
        ("ext_amount", good.clone().ext_amount(good.ext_amount + 1)),
        ("fee (with relayer)", good.clone().fee(1)),
        ("not_before_slot", good.clone().not_before_slot(1)),
        ("ciphertext 0", good.clone().ciphertexts(b"other".to_vec(), good.ciphertexts[1].clone())),
        ("ciphertext 1", good.clone().ciphertexts(good.ciphertexts[0].clone(), vec![])),
        ("cm_out 1", good.clone().cm_out(good.cm_out[0], fe(77))),
        ("nf 0", good.clone().nf(fe(78), good.nf[1])),
        ("proof bit", {
            let mut p = good.proof.clone();
            p[100] ^= 1;
            good.clone().proof(p)
        }),
    ];
    for (label, a) in mutations {
        let e = env.send_action(Kind::Deposit, &a).expect_err(label);
        assert_eq!(anchor_error(&e).as_deref(), Some("InvalidProof"), "mutated {label}");
    }

    // Another depositor token account (same mint) as public_account.
    let other = solana_address::Address::new_unique();
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    env.svm
        .set_account(
            other,
            Account {
                lamports: rent,
                data: pack_token_account(&Fixed::mint(), &env.depositor.pubkey(), 10_000),
                owner: token_program(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let dep = env.depositor.insecure_clone();
    let ix = env.action_ix(Kind::Deposit, &dep.pubkey(), Some(other), None, &good);
    let e = env.send(&[ix], &dep).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("InvalidProof"), "public_account swap");

    // Same program and mint, different chain_domain (cross-deployment replay).
    let mut other_env = Env::with_init(false);
    other_env.init_pool([0x42; 32]).unwrap();
    let e = other_env.send_action(Kind::Deposit, &good).unwrap_err();
    assert_eq!(anchor_error(&e).as_deref(), Some("InvalidProof"), "other chain_domain");

    // The untouched action succeeds; replaying it (same nullifiers) fails.
    env.send_action(Kind::Deposit, &good).expect("valid deposit");
    let e = env.send_action(Kind::Deposit, &good).unwrap_err();
    assert!(e.meta.logs.iter().any(|l| l.contains("already in use")));
}
