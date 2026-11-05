//! LiteSVM tests of the pool's access control and limits: `init_pool` gated on
//! the upgrade authority, guardian pause (withdraw stays open), admin-set
//! deposit caps. Actions use the dummy proof, so "reaches InvalidProof" means
//! every check before verification passed.

use polypus_crypto::{field::to_bytes_be, merkle::zeros};
use polypus_tests::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn args() -> TransactArgs {
    TransactArgs::new(to_bytes_be(&zeros()[26])).proof(dummy_proof())
}

fn err_name(r: TxResult) -> Option<String> {
    anchor_error(&r.expect_err("must fail"))
}

fn expect_action_err(env: &mut Env, kind: Kind, a: &TransactArgs, name: &str) {
    let e = env.send_action(kind, a).expect_err("must fail");
    assert_eq!(anchor_error(&e).as_deref(), Some(name), "logs: {:#?}", e.meta.logs);
}

fn u64_at(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}

#[test]
fn init_pool_stores_guardian_and_limits() {
    let mut env = Env::with_init(false);
    let cfg = PoolConfig { guardian: env.guardian.pubkey(), max_deposit: 1_000, tvl_cap: 5_000 };
    let ix = init_pool_ix(&env.admin.pubkey(), &Fixed::mint(), Fixed::chain_domain(), cfg);
    let admin = env.admin.insecure_clone();
    let m = env.send(&[ix], &admin).expect("init_pool by the upgrade authority");
    println!("CU init_pool (with ProgramData check): {}", m.compute_units_consumed);
    let d = env.pool_data();
    assert_eq!(&d[8..40], env.admin.pubkey().as_ref(), "admin = upgrade authority");
    assert_eq!(&d[POOL_GUARDIAN_OFFSET..POOL_GUARDIAN_OFFSET + 32], env.guardian.pubkey().as_ref());
    assert_eq!(d[POOL_PAUSED_OFFSET], 0);
    assert_eq!(u64_at(&d, POOL_MAX_DEPOSIT_OFFSET), 1_000);
    assert_eq!(u64_at(&d, POOL_TVL_CAP_OFFSET), 5_000);
}

#[test]
fn init_pool_rejects_non_upgrade_authority() {
    let mut env = Env::with_init(false);
    let mallory = Keypair::new();
    env.svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();
    let ix = init_pool_ix(&mallory.pubkey(), &Fixed::mint(), [7; 32], PoolConfig::unlimited(mallory.pubkey()));
    assert_eq!(err_name(env.send(&[ix], &mallory)).as_deref(), Some("NotUpgradeAuthority"));
    assert!(env.svm.get_account(&Fixed::pool()).is_none());
}

#[test]
fn init_pool_rejects_immutable_program() {
    // Upgrade authority removed (program made immutable): nobody can init.
    let mut env = Env::with_init(false);
    set_upgrade_authority(&mut env.svm, None);
    let admin = env.admin.insecure_clone();
    let ix = env.init_pool_ix(Fixed::chain_domain());
    assert_eq!(err_name(env.send(&[ix], &admin)).as_deref(), Some("NotUpgradeAuthority"));
}

#[test]
fn init_pool_rejects_foreign_program_data() {
    // A ProgramData account of some other program, whose authority is the caller.
    let mut env = Env::with_init(false);
    let admin = env.admin.insecure_clone();
    let real = env.svm.get_account(&program_data_address(&pool_program())).unwrap();
    let fake = Address::new_unique();
    env.svm.set_account(fake, real).unwrap();
    let mut ix = env.init_pool_ix(Fixed::chain_domain());
    ix.accounts[8].pubkey = fake;
    assert_eq!(err_name(env.send(&[ix], &admin)).as_deref(), Some("WrongProgramData"));
    // And a non-ProgramData account in that slot fails to deserialize.
    let mut ix = env.init_pool_ix(Fixed::chain_domain());
    ix.accounts[8].pubkey = Fixed::mint();
    assert!(env.send(&[ix], &admin).is_err());
    // The real one still works.
    let ix = env.init_pool_ix(Fixed::chain_domain());
    env.send(&[ix], &admin).expect("init_pool");
}

#[test]
fn only_guardian_can_pause() {
    let mut env = Env::new();
    let (admin, depositor) = (env.admin.insecure_clone(), env.depositor.insecure_clone());
    assert_eq!(err_name(env.set_paused(&admin, true)).as_deref(), Some("NotGuardian"));
    assert_eq!(err_name(env.set_paused(&depositor, true)).as_deref(), Some("NotGuardian"));
    assert_eq!(env.pool_data()[POOL_PAUSED_OFFSET], 0);
    let guardian = env.guardian.insecure_clone();
    env.set_paused(&guardian, true).expect("guardian pauses");
    assert_eq!(env.pool_data()[POOL_PAUSED_OFFSET], 1);
}

#[test]
fn pause_blocks_deposit_and_transact_but_not_withdraw() {
    let mut env = Env::new();
    let guardian = env.guardian.insecure_clone();
    env.set_paused(&guardian, true).unwrap();
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(10), "PoolPaused");
    expect_action_err(&mut env, Kind::Transact, &args(), "PoolPaused");
    expect_action_err(&mut env, Kind::Transact, &args().fee(1), "PoolPaused");
    // Withdraw runs every check up to proof verification.
    expect_action_err(&mut env, Kind::Withdraw, &args().ext_amount(-10), "InvalidProof");
    expect_action_err(&mut env, Kind::Withdraw, &args().ext_amount(-10).fee(1), "InvalidProof");

    env.set_paused(&guardian, false).unwrap();
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(10), "InvalidProof");
    expect_action_err(&mut env, Kind::Transact, &args(), "InvalidProof");
}

#[test]
fn only_admin_sets_guardian() {
    let mut env = Env::new();
    let (guardian, admin) = (env.guardian.insecure_clone(), env.admin.insecure_clone());
    let new_guardian = Keypair::new();
    env.svm.airdrop(&new_guardian.pubkey(), 1_000_000_000).unwrap();
    assert_eq!(err_name(env.set_guardian(&guardian, &guardian.pubkey())).as_deref(), Some("NotAdmin"));
    env.set_guardian(&admin, &new_guardian.pubkey()).expect("admin sets guardian");
    let d = env.pool_data();
    assert_eq!(&d[POOL_GUARDIAN_OFFSET..POOL_GUARDIAN_OFFSET + 32], new_guardian.pubkey().as_ref());
    // The old guardian lost the power to pause; the new one has it.
    assert_eq!(err_name(env.set_paused(&guardian, true)).as_deref(), Some("NotGuardian"));
    env.set_paused(&new_guardian, true).expect("new guardian pauses");
}

#[test]
fn only_admin_sets_limits() {
    let mut env = Env::new();
    let (guardian, depositor, admin) =
        (env.guardian.insecure_clone(), env.depositor.insecure_clone(), env.admin.insecure_clone());
    assert_eq!(err_name(env.set_limits(&guardian, 1, 1)).as_deref(), Some("NotAdmin"));
    assert_eq!(err_name(env.set_limits(&depositor, 1, 1)).as_deref(), Some("NotAdmin"));
    env.set_limits(&admin, 100, 200).unwrap();
    let d = env.pool_data();
    assert_eq!((u64_at(&d, POOL_MAX_DEPOSIT_OFFSET), u64_at(&d, POOL_TVL_CAP_OFFSET)), (100, 200));
}

#[test]
fn deposit_caps() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    env.set_limits(&admin, 100, 250).unwrap();

    // Per-deposit maximum (gross ext_amount, before the relayer fee).
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(101), "DepositTooLarge");
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(101).fee(50), "DepositTooLarge");
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(100), "InvalidProof");

    // TVL cap: vault balance after the deposit (vault + ext_amount − fee).
    // Pretend the vault already holds 200.
    let vault = Fixed::vault();
    let mut acc = env.svm.get_account(&vault).unwrap();
    acc.data[64..72].copy_from_slice(&200u64.to_le_bytes());
    env.svm.set_account(vault, acc).unwrap();
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(51), "TvlCapExceeded");
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(50), "InvalidProof");
    // A fee paid out of the same deposit counts against the vault delta.
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(52).fee(1), "TvlCapExceeded");
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(51).fee(1), "InvalidProof");

    // Caps never block transact or withdraw.
    env.set_limits(&admin, 0, 0).unwrap();
    expect_action_err(&mut env, Kind::Deposit, &args().ext_amount(1), "DepositTooLarge");
    expect_action_err(&mut env, Kind::Transact, &args().fee(1), "InvalidProof");
    expect_action_err(&mut env, Kind::Withdraw, &args().ext_amount(-1), "InvalidProof");
}
