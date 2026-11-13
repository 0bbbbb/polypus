//! LiteSVM test harness for `polypus-pool` and `polypus-verifier-bench`.
//!
//! Build the programs first (see ../README.md); the tests load
//! `../target/deploy/*.so`.
//!
//! Plugging in real kernel proofs: every address that enters `ext_data_hash`
//! is deterministic here (see [`Fixed`]; `cargo test -p polypus-tests
//! fixture_context -- --nocapture` prints them as JSON), so a prover can build
//! the witness off-chain with `polypus-crypto` and hand back an
//! [`ActionFixture`] JSON. [`TransactArgs::public_values`] computes the exact
//! public values the pool will recompute on-chain.

use std::{path::PathBuf, str::FromStr};

use base64::Engine;
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use polypus_crypto::{
    ext_data::{ciphertext_hash, ExtData},
    field::{from_bytes_be, Fr},
    kernel::PublicValues,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub use litesvm;

pub const POOL_PROGRAM_ID: &str = "PoLYdUXuf78YC6aqE4qkmyFkfJi3mm773ZqJNECDYtj";
pub const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";
pub const COMPUTE_BUDGET_ID: &str = "ComputeBudget111111111111111111111111111111";
pub const BPF_LOADER_UPGRADEABLE_ID: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

/// The pool program's ProgramData account (loader-v3 PDA `[program_id]`).
pub fn program_data_address(program: &Address) -> Address {
    Address::find_program_address(&[program.as_ref()], &addr(BPF_LOADER_UPGRADEABLE_ID)).0
}

/// Pool configuration passed to `init_pool` (after `chain_domain`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolConfig {
    pub guardian: Address,
    pub max_deposit: u64,
    pub tvl_cap: u64,
}

impl PoolConfig {
    pub fn unlimited(guardian: Address) -> Self {
        PoolConfig { guardian, max_deposit: u64::MAX, tvl_cap: u64::MAX }
    }
}

/// `init_pool` instruction for `mint` (accounts in program order).
pub fn init_pool_ix(admin: &Address, mint: &Address, chain_domain: [u8; 32], cfg: PoolConfig) -> Instruction {
    let program = pool_program();
    let pool = Address::find_program_address(&[b"pool", mint.as_ref()], &program).0;
    let mut data = disc("global", "init_pool").to_vec();
    data.extend_from_slice(&chain_domain);
    data.extend_from_slice(cfg.guardian.as_ref());
    data.extend_from_slice(&cfg.max_deposit.to_le_bytes());
    data.extend_from_slice(&cfg.tvl_cap.to_le_bytes());
    Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(pool, false),
            AccountMeta::new(Address::find_program_address(&[b"tree", pool.as_ref()], &program).0, false),
            AccountMeta::new(Address::find_program_address(&[b"vault", pool.as_ref()], &program).0, false),
            AccountMeta::new_readonly(token_program(), false),
            AccountMeta::new_readonly(addr(SYSTEM_PROGRAM_ID), false),
            AccountMeta::new_readonly(program, false),
            AccountMeta::new_readonly(program_data_address(&program), false),
        ],
        data,
    }
}

/// `set_paused` (signer = guardian), `set_guardian` / `set_limits` (signer = admin).
pub fn set_paused_ix(guardian: &Address, pool: &Address, paused: bool) -> Instruction {
    let mut data = disc("global", "set_paused").to_vec();
    data.push(paused as u8);
    Instruction {
        program_id: pool_program(),
        accounts: vec![AccountMeta::new_readonly(*guardian, true), AccountMeta::new(*pool, false)],
        data,
    }
}

pub fn set_guardian_ix(admin: &Address, pool: &Address, guardian: &Address) -> Instruction {
    let mut data = disc("global", "set_guardian").to_vec();
    data.extend_from_slice(guardian.as_ref());
    Instruction {
        program_id: pool_program(),
        accounts: vec![AccountMeta::new_readonly(*admin, true), AccountMeta::new(*pool, false)],
        data,
    }
}

pub fn set_limits_ix(admin: &Address, pool: &Address, max_deposit: u64, tvl_cap: u64) -> Instruction {
    let mut data = disc("global", "set_limits").to_vec();
    data.extend_from_slice(&max_deposit.to_le_bytes());
    data.extend_from_slice(&tvl_cap.to_le_bytes());
    Instruction {
        program_id: pool_program(),
        accounts: vec![AccountMeta::new_readonly(*admin, true), AccountMeta::new(*pool, false)],
        data,
    }
}

/// Byte offsets of the fields appended to `Pool` by the hardening change
/// (after the 8-byte discriminator): guardian, paused, max_deposit, tvl_cap.
pub const POOL_GUARDIAN_OFFSET: usize = 8 + 32 * 6 + 3;
pub const POOL_PAUSED_OFFSET: usize = POOL_GUARDIAN_OFFSET + 32;
pub const POOL_MAX_DEPOSIT_OFFSET: usize = POOL_PAUSED_OFFSET + 1;
pub const POOL_TVL_CAP_OFFSET: usize = POOL_MAX_DEPOSIT_OFFSET + 8;

pub fn addr(s: &str) -> Address {
    Address::from_str(s).unwrap()
}
pub fn pool_program() -> Address {
    addr(POOL_PROGRAM_ID)
}
pub fn token_program() -> Address {
    addr(TOKEN_PROGRAM_ID)
}

pub fn deploy_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy")
}

/// The pool binary under test: `$POLYPUS_POOL_SO`, else `target/deploy/polypus_pool.so`.
pub fn pool_so() -> PathBuf {
    std::env::var("POLYPUS_POOL_SO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| deploy_dir().join("polypus_pool.so"))
}

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Anchor discriminator: `sha256("<namespace>:<name>")[..8]`.
pub fn disc(namespace: &str, name: &str) -> [u8; 8] {
    sha256(format!("{namespace}:{name}").as_bytes())[..8].try_into().unwrap()
}

/// Deterministic addresses / constants used by every test pool, so proofs can
/// be generated ahead of time against them.
pub struct Fixed;
impl Fixed {
    pub fn mint() -> Address {
        Address::new_from_array(sha256(b"polypus.test.mint"))
    }
    pub fn chain_domain() -> [u8; 32] {
        sha256(b"polypus.test.chain_domain.localnet")
    }
    /// Depositor's source token account (owner = the test's depositor key).
    pub fn depositor_token() -> Address {
        Address::new_from_array(sha256(b"polypus.test.depositor_token"))
    }
    /// Withdrawal destination token account.
    pub fn recipient_token() -> Address {
        Address::new_from_array(sha256(b"polypus.test.recipient_token"))
    }
    /// Relayer fee token account.
    pub fn relayer_token() -> Address {
        Address::new_from_array(sha256(b"polypus.test.relayer_token"))
    }
    pub fn pool() -> Address {
        pda(&[b"pool", Fixed::mint().as_ref()]).0
    }
    pub fn tree() -> Address {
        pda(&[b"tree", Fixed::pool().as_ref()]).0
    }
    pub fn vault() -> Address {
        pda(&[b"vault", Fixed::pool().as_ref()]).0
    }
}

pub fn pda(seeds: &[&[u8]]) -> (Address, u8) {
    Address::find_program_address(seeds, &pool_program())
}
pub fn nullifier_pda(pool: &Address, nf: &[u8; 32]) -> Address {
    pda(&[b"nf", pool.as_ref(), nf]).0
}

/// Which pool instruction an action is sent with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Deposit,
    Transact,
    Withdraw,
}

impl Kind {
    pub fn ix_name(self) -> &'static str {
        match self {
            Kind::Deposit => "deposit",
            Kind::Transact => "transact",
            Kind::Withdraw => "withdraw",
        }
    }
}

/// Arguments of `deposit` / `transact` / `withdraw` (borsh layout of the
/// program's `ActionArgs`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransactArgs {
    pub nf: [[u8; 32]; 2],
    pub root: [u8; 32],
    pub cm_out: [[u8; 32]; 2],
    pub ext_amount: i64,
    pub fee: u64,
    pub not_before_slot: u64,
    pub proof: Vec<u8>,
    pub ciphertexts: [Vec<u8>; 2],
}

pub fn fe(v: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[24..].copy_from_slice(&v.to_be_bytes());
    b
}

impl TransactArgs {
    /// Placeholder action against `root` with distinct dummy nf / cm values.
    pub fn new(root: [u8; 32]) -> Self {
        TransactArgs {
            nf: [fe(101), fe(102)],
            root,
            cm_out: [fe(201), fe(202)],
            ext_amount: 0,
            fee: 0,
            not_before_slot: 0,
            proof: vec![0u8; 324],
            ciphertexts: [b"ciphertext-0".to_vec(), b"ciphertext-1".to_vec()],
        }
    }
    pub fn nf(mut self, a: [u8; 32], b: [u8; 32]) -> Self {
        self.nf = [a, b];
        self
    }
    pub fn cm_out(mut self, a: [u8; 32], b: [u8; 32]) -> Self {
        self.cm_out = [a, b];
        self
    }
    pub fn ext_amount(mut self, v: i64) -> Self {
        self.ext_amount = v;
        self
    }
    pub fn fee(mut self, v: u64) -> Self {
        self.fee = v;
        self
    }
    pub fn not_before_slot(mut self, v: u64) -> Self {
        self.not_before_slot = v;
        self
    }
    pub fn proof(mut self, p: Vec<u8>) -> Self {
        self.proof = p;
        self
    }
    pub fn ciphertexts(mut self, a: Vec<u8>, b: Vec<u8>) -> Self {
        self.ciphertexts = [a, b];
        self
    }

    /// Borsh encoding of `ActionArgs`.
    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&self.nf[0]);
        v.extend_from_slice(&self.nf[1]);
        v.extend_from_slice(&self.root);
        v.extend_from_slice(&self.cm_out[0]);
        v.extend_from_slice(&self.cm_out[1]);
        v.extend_from_slice(&self.ext_amount.to_le_bytes());
        v.extend_from_slice(&self.fee.to_le_bytes());
        v.extend_from_slice(&self.not_before_slot.to_le_bytes());
        for b in [&self.proof, &self.ciphertexts[0], &self.ciphertexts[1]] {
            v.extend_from_slice(&(b.len() as u32).to_le_bytes());
            v.extend_from_slice(b);
        }
        v
    }

    /// SPEC §7 ext data as the pool will assemble it.
    pub fn ext_data(
        &self,
        pool: &Address,
        chain_domain: [u8; 32],
        public_account: Option<Address>,
        relayer: Option<Address>,
    ) -> ExtData {
        ExtData {
            pool_id: pool.to_bytes(),
            chain_domain,
            public_account: public_account.map(|a| a.to_bytes()).unwrap_or_default(),
            relayer: relayer.map(|a| a.to_bytes()).unwrap_or_default(),
            ext_amount: self.ext_amount,
            fee: self.fee,
            not_before_slot: self.not_before_slot,
            ct_hash: [
                ciphertext_hash(&self.ciphertexts[0]),
                ciphertext_hash(&self.ciphertexts[1]),
            ],
        }
    }

    /// SPEC §6.1 public values as the pool will recompute them.
    pub fn public_values(
        &self,
        pool: &Address,
        chain_domain: [u8; 32],
        mint: &Address,
        public_account: Option<Address>,
        relayer: Option<Address>,
    ) -> PublicValues {
        let ext = self.ext_data(pool, chain_domain, public_account, relayer);
        let f = |b: &[u8; 32]| from_bytes_be(b).expect("canonical");
        PublicValues {
            root: f(&self.root),
            nf: [f(&self.nf[0]), f(&self.nf[1])],
            cm_out: [f(&self.cm_out[0]), f(&self.cm_out[1])],
            public_amount: ext.public_amount(),
            public_asset_id: if ext.moves_tokens() {
                polypus_crypto::note::asset_id(&mint.to_bytes())
            } else {
                Fr::from(0u64)
            },
            ext_data_hash: ext.hash(),
            program_id: Fr::from(0u64),
            program_io_hash: Fr::from(0u64),
        }
    }
}

/// JSON form of one action with a real proof (all byte strings hex-encoded,
/// field elements as 32-byte big-endian hex).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActionFixture {
    pub kind: Kind,
    pub nf: [String; 2],
    pub root: String,
    pub cm_out: [String; 2],
    pub ext_amount: i64,
    pub fee: u64,
    pub not_before_slot: u64,
    pub proof: String,
    pub ciphertexts: [String; 2],
}

fn h32(s: &str) -> [u8; 32] {
    hex::decode(s.trim_start_matches("0x")).unwrap().try_into().expect("32 bytes")
}

impl ActionFixture {
    pub fn from_args(kind: Kind, a: &TransactArgs) -> Self {
        let h = |b: &[u8]| hex::encode(b);
        ActionFixture {
            kind,
            nf: [h(&a.nf[0]), h(&a.nf[1])],
            root: h(&a.root),
            cm_out: [h(&a.cm_out[0]), h(&a.cm_out[1])],
            ext_amount: a.ext_amount,
            fee: a.fee,
            not_before_slot: a.not_before_slot,
            proof: h(&a.proof),
            ciphertexts: [h(&a.ciphertexts[0]), h(&a.ciphertexts[1])],
        }
    }

    pub fn to_args(&self) -> TransactArgs {
        TransactArgs {
            nf: [h32(&self.nf[0]), h32(&self.nf[1])],
            root: h32(&self.root),
            cm_out: [h32(&self.cm_out[0]), h32(&self.cm_out[1])],
            ext_amount: self.ext_amount,
            fee: self.fee,
            not_before_slot: self.not_before_slot,
            proof: hex::decode(self.proof.trim_start_matches("0x")).unwrap(),
            ciphertexts: [
                hex::decode(&self.ciphertexts[0]).unwrap(),
                hex::decode(&self.ciphertexts[1]).unwrap(),
            ],
        }
    }
}

// SPL Token accounts are packed by hand to avoid pulling a second solana-* major.
pub fn pack_mint(authority: &Address, decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes()); // COption::Some
    d[4..36].copy_from_slice(authority.as_ref());
    d[36..44].copy_from_slice(&1_000_000_000_000u64.to_le_bytes()); // supply
    d[44] = decimals;
    d[45] = 1; // is_initialized
    d // freeze_authority: None
}

pub fn pack_token_account(mint: &Address, owner: &Address, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

pub fn token_amount(svm: &LiteSVM, a: &Address) -> u64 {
    let acc = svm.get_account(a).expect("token account");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

/// A LiteSVM instance with the pool program loaded and a pool initialised for
/// the [`Fixed`] mint.
pub struct Env {
    pub svm: LiteSVM,
    /// Upgrade authority of the loaded pool program, and pool admin.
    pub admin: Keypair,
    pub guardian: Keypair,
    pub depositor: Keypair,
    pub relayer: Keypair,
    pub init_cu: u64,
    /// SHA-256 of the kernel VK compiled into the loaded pool (from the
    /// `init_pool` log); `None` if the pool was not initialised.
    pub vk_sha256: Option<String>,
}

pub const DEPOSITOR_START_BALANCE: u64 = 1_000_000_000;

impl Env {
    pub fn new() -> Self {
        Self::with_init(true)
    }

    pub fn with_init(init: bool) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(pool_program(), pool_so())
            .expect("load polypus_pool.so (run cargo build-sbf first)");
        let admin = Keypair::new();
        let guardian = Keypair::new();
        let depositor = Keypair::new();
        let relayer = Keypair::new();
        for k in [&admin, &guardian, &depositor, &relayer] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        set_upgrade_authority(&mut svm, Some(&admin.pubkey()));
        let mint = Fixed::mint();
        let tp = token_program();
        let rent = |svm: &LiteSVM, n| svm.minimum_balance_for_rent_exemption(n);
        let acct = |svm: &LiteSVM, data: Vec<u8>| Account {
            lamports: rent(svm, data.len()),
            data,
            owner: tp,
            executable: false,
            rent_epoch: 0,
        };
        svm.set_account(mint, acct(&svm, pack_mint(&admin.pubkey(), 6))).unwrap();
        let dep = acct(&svm, pack_token_account(&mint, &depositor.pubkey(), DEPOSITOR_START_BALANCE));
        svm.set_account(Fixed::depositor_token(), dep).unwrap();
        let rec = acct(&svm, pack_token_account(&mint, &Keypair::new().pubkey(), 0));
        svm.set_account(Fixed::recipient_token(), rec).unwrap();
        let rel = acct(&svm, pack_token_account(&mint, &relayer.pubkey(), 0));
        svm.set_account(Fixed::relayer_token(), rel).unwrap();

        let mut env = Env { svm, admin, guardian, depositor, relayer, init_cu: 0, vk_sha256: None };
        if init {
            let meta = env.init_pool(Fixed::chain_domain()).expect("init_pool");
            env.init_cu = meta.compute_units_consumed;
            env.vk_sha256 = meta.logs.iter().find_map(|l| {
                Some(l.split("kernel vk sha256 = ").nth(1)?.trim().to_string())
            });
        }
        env
    }

    pub fn default_config(&self) -> PoolConfig {
        PoolConfig::unlimited(self.guardian.pubkey())
    }

    pub fn init_pool_ix(&self, chain_domain: [u8; 32]) -> Instruction {
        init_pool_ix(&self.admin.pubkey(), &Fixed::mint(), chain_domain, self.default_config())
    }

    pub fn init_pool(&mut self, chain_domain: [u8; 32]) -> TxResult {
        let ix = self.init_pool_ix(chain_domain);
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &admin)
    }

    pub fn set_paused(&mut self, signer: &Keypair, paused: bool) -> TxResult {
        let ix = set_paused_ix(&signer.pubkey(), &Fixed::pool(), paused);
        self.send(&[ix], signer)
    }

    pub fn set_guardian(&mut self, signer: &Keypair, guardian: &Address) -> TxResult {
        let ix = set_guardian_ix(&signer.pubkey(), &Fixed::pool(), guardian);
        self.send(&[ix], signer)
    }

    pub fn set_limits(&mut self, signer: &Keypair, max_deposit: u64, tvl_cap: u64) -> TxResult {
        let ix = set_limits_ix(&signer.pubkey(), &Fixed::pool(), max_deposit, tvl_cap);
        self.send(&[ix], signer)
    }

    pub fn pool_data(&self) -> Vec<u8> {
        self.svm.get_account(&Fixed::pool()).expect("pool").data
    }

    /// Build a pool action instruction. `signer` is the depositor (deposit)
    /// or the fee payer (transact / withdraw). `None` optional accounts are
    /// passed as the program id (Anchor's convention).
    pub fn action_ix(
        &self,
        kind: Kind,
        signer: &Address,
        public_account: Option<Address>,
        relayer_token: Option<Address>,
        args: &TransactArgs,
    ) -> Instruction {
        let pool = Fixed::pool();
        let none = pool_program();
        let mut accounts = vec![
            AccountMeta::new(*signer, true),
            AccountMeta::new_readonly(pool, false),
            AccountMeta::new(Fixed::tree(), false),
            AccountMeta::new(Fixed::vault(), false),
        ];
        if kind != Kind::Transact {
            accounts.push(AccountMeta::new(public_account.expect("public account"), false));
        }
        accounts.push(match relayer_token {
            Some(r) => AccountMeta::new(r, false),
            None => AccountMeta::new_readonly(none, false),
        });
        accounts.push(AccountMeta::new(nullifier_pda(&pool, &args.nf[0]), false));
        accounts.push(AccountMeta::new(nullifier_pda(&pool, &args.nf[1]), false));
        accounts.push(AccountMeta::new_readonly(token_program(), false));
        accounts.push(AccountMeta::new_readonly(addr(SYSTEM_PROGRAM_ID), false));
        let mut data = disc("global", kind.ix_name()).to_vec();
        data.extend_from_slice(&args.encode());
        Instruction { program_id: pool_program(), accounts, data }
    }

    /// Send an action with the default accounts for its kind:
    /// deposit from [`Fixed::depositor_token`], withdraw to
    /// [`Fixed::recipient_token`], relayer [`Fixed::relayer_token`] iff fee > 0.
    pub fn send_action(&mut self, kind: Kind, args: &TransactArgs) -> TxResult {
        let (public, relayer) = default_accounts(kind, args.fee);
        let signer = match kind {
            Kind::Deposit => self.depositor.insecure_clone(),
            _ => self.relayer.insecure_clone(),
        };
        let ix = self.action_ix(kind, &signer.pubkey(), public, relayer, args);
        self.send(&[ix], &signer)
    }

    /// The pi_hash the pool computes for `args` sent with [`Env::send_action`].
    pub fn expected_pi_hash(&self, kind: Kind, args: &TransactArgs) -> [u8; 32] {
        expected_pi_hash(kind, args)
    }

    pub fn send(&mut self, ixs: &[Instruction], signer: &Keypair) -> TxResult {
        let mut all = vec![compute_budget_ix(1_400_000)];
        all.extend_from_slice(ixs);
        let msg = Message::new(&all, Some(&signer.pubkey()));
        let tx = Transaction::new(&[signer], msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    pub fn tree_account(&self) -> Account {
        self.svm.get_account(&Fixed::tree()).expect("tree")
    }

    /// (next_index, current_root_index, current root).
    pub fn tree_state(&self) -> (u64, u64, [u8; 32]) {
        let d = self.tree_account().data;
        let next = u64::from_le_bytes(d[40..48].try_into().unwrap());
        let cur = u64::from_le_bytes(d[48..56].try_into().unwrap());
        let off = TREE_ROOTS_OFFSET + 32 * cur as usize;
        (next, cur, d[off..off + 32].try_into().unwrap())
    }
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

/// Rewrite the upgrade authority in the pool program's ProgramData account.
/// LiteSVM deploys with the upgradeable loader but no authority; the metadata
/// is bincode `ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }`
/// after a u32 enum tag (45 bytes).
pub fn set_upgrade_authority(svm: &mut LiteSVM, authority: Option<&Address>) {
    let pd = program_data_address(&pool_program());
    let mut acc = svm.get_account(&pd).expect("pool program must be loaded with the upgradeable loader");
    assert_eq!(u32::from_le_bytes(acc.data[0..4].try_into().unwrap()), 3, "ProgramData tag");
    match authority {
        Some(a) => {
            acc.data[12] = 1;
            acc.data[13..45].copy_from_slice(a.as_ref());
        }
        None => {
            acc.data[12] = 0;
            acc.data[13..45].fill(0);
        }
    }
    svm.set_account(pd, acc).unwrap();
}

/// Byte offsets inside the Tree account (8-byte discriminator first).
pub const TREE_FILLED_OFFSET: usize = 8 + 32 + 8 + 8;
pub const TREE_ROOTS_OFFSET: usize = TREE_FILLED_OFFSET + 32 * 26;
pub const TREE_ACCOUNT_LEN: usize = TREE_ROOTS_OFFSET + 32 * 128;

/// The pi_hash the pool computes for `args` sent with [`Env::send_action`]
/// to the [`Fixed`] pool.
pub fn expected_pi_hash(kind: Kind, args: &TransactArgs) -> [u8; 32] {
    let (public, relayer) = default_accounts(kind, args.fee);
    let pv = args.public_values(&Fixed::pool(), Fixed::chain_domain(), &Fixed::mint(), public, relayer);
    polypus_crypto::field::to_bytes_be(&pv.pi_hash())
}

/// The action sequence behind `fixtures/trivial/*.json` (proofs left empty):
/// deposit 1000 (fee 0) at the empty root; transact with fee 10 at the
/// post-deposit root; withdraw 400 with fee 5 at the (older, still known)
/// empty root. Expected vault balance afterwards: 585.
pub fn trivial_scenario() -> Vec<(Kind, TransactArgs)> {
    use polypus_crypto::{field::to_bytes_be, merkle::Frontier};
    let mut f = Frontier::default();
    let empty = to_bytes_be(&f.root());
    let ct = |s: &str| s.as_bytes().to_vec();
    let deposit = TransactArgs::new(empty)
        .nf(fe(0x1001), fe(0x1002))
        .cm_out(fe(0x2001), fe(0x2002))
        .ext_amount(1_000)
        .ciphertexts(ct("deposit-ct-0"), ct("deposit-ct-1"))
        .proof(vec![]);
    let from = |b: &[u8; 32]| polypus_crypto::field::from_bytes_be(b).unwrap();
    f.append_pair(from(&deposit.cm_out[0]), from(&deposit.cm_out[1])).unwrap();
    let transact = TransactArgs::new(to_bytes_be(&f.root()))
        .nf(fe(0x1003), fe(0x1004))
        .cm_out(fe(0x2003), fe(0x2004))
        .fee(10)
        .ciphertexts(ct("transfer-ct-0"), ct("transfer-ct-1"))
        .proof(vec![]);
    let withdraw = TransactArgs::new(empty)
        .nf(fe(0x1005), fe(0x1006))
        .cm_out(fe(0x2005), fe(0x2006))
        .ext_amount(-400)
        .fee(5)
        .ciphertexts(ct("withdraw-ct-0"), ct("withdraw-ct-1"))
        .proof(vec![]);
    vec![(Kind::Deposit, deposit), (Kind::Transact, transact), (Kind::Withdraw, withdraw)]
}

pub fn default_accounts(kind: Kind, fee: u64) -> (Option<Address>, Option<Address>) {
    let public = match kind {
        Kind::Deposit => Some(Fixed::depositor_token()),
        Kind::Withdraw => Some(Fixed::recipient_token()),
        Kind::Transact => None,
    };
    (public, (fee > 0).then(Fixed::relayer_token))
}

pub fn compute_budget_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: addr(COMPUTE_BUDGET_ID), accounts: vec![], data }
}

/// Anchor error name from the logs of a failed transaction, if any.
pub fn anchor_error(f: &FailedTransactionMetadata) -> Option<String> {
    f.meta.logs.iter().find_map(|l| {
        let i = l.find("Error Code: ")?;
        Some(l[i + 12..].split('.').next()?.to_string())
    })
}

/// The pi_hash the pool logged when it rejected a proof.
pub fn logged_pi_hash(f: &FailedTransactionMetadata) -> Option<[u8; 32]> {
    f.meta.logs.iter().find_map(|l| {
        let i = l.find("on-chain pi_hash = ")?;
        Some(h32(&l[i + 19..i + 19 + 64]))
    })
}

/// Decoded `ActionEvent` (from the `Program data:` log).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionEvent {
    pub pool: [u8; 32],
    pub leaf_index: [u64; 2],
    pub cm_out: [[u8; 32]; 2],
    pub nf: [[u8; 32]; 2],
    pub new_root: [u8; 32],
    pub ext_amount: i64,
    pub fee: u64,
    pub ciphertexts: [Vec<u8>; 2],
}

pub fn action_event(m: &TransactionMetadata) -> Option<ActionEvent> {
    let want = disc("event", "ActionEvent");
    m.logs.iter().find_map(|l| {
        let b = base64::engine::general_purpose::STANDARD
            .decode(l.strip_prefix("Program data: ")?)
            .ok()?;
        if b[..8] != want {
            return None;
        }
        let mut r = &b[8..];
        let mut take = |n: usize| {
            let (a, rest) = r.split_at(n);
            r = rest;
            a.to_vec()
        };
        let b32 = |v: Vec<u8>| -> [u8; 32] { v.try_into().unwrap() };
        let u64le = |v: Vec<u8>| u64::from_le_bytes(v.try_into().unwrap());
        let pool = b32(take(32));
        let leaf_index = [u64le(take(8)), u64le(take(8))];
        let cm_out = [b32(take(32)), b32(take(32))];
        let nf = [b32(take(32)), b32(take(32))];
        let new_root = b32(take(32));
        let ext_amount = u64le(take(8)) as i64;
        let fee = u64le(take(8));
        let mut vecs = Vec::new();
        for _ in 0..2 {
            let n = u32::from_le_bytes(take(4).try_into().unwrap()) as usize;
            vecs.push(take(n));
        }
        Some(ActionEvent {
            pool,
            leaf_index,
            cm_out,
            nf,
            new_root,
            ext_amount,
            fee,
            ciphertexts: [vecs[0].clone(), vecs[1].clone()],
        })
    })
}

/// Legacy wire size of a transaction with these instructions (1 signer).
pub fn legacy_tx_size(ixs: &[Instruction], payer: &Address) -> usize {
    fn shortvec(n: usize) -> usize {
        if n < 0x80 {
            1
        } else if n < 0x4000 {
            2
        } else {
            3
        }
    }
    let msg = Message::new(ixs, Some(payer));
    let mut n = shortvec(1) + 64 + 3;
    n += shortvec(msg.account_keys.len()) + 32 * msg.account_keys.len() + 32;
    n += shortvec(msg.instructions.len());
    for ix in &msg.instructions {
        n += 1 + shortvec(ix.accounts.len()) + ix.accounts.len() + shortvec(ix.data.len()) + ix.data.len();
    }
    n
}

/// CU charged by one `sol_log_compute_units` call (Agave `syscall_base_cost`).
pub const LOG_CU_SYSCALL_COST: u64 = 100;

pub struct Bench {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub id: Address,
}

impl Bench {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let id = Address::new_unique();
        let so = std::env::var("POLYPUS_BENCH_SO")
            .map(PathBuf::from)
            .unwrap_or_else(|_| deploy_dir().join("polypus_verifier_bench.so"));
        svm.add_program_from_file(id, so)
            .expect("load polypus_verifier_bench.so (run cargo build-sbf first)");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        Bench { svm, payer, id }
    }

    /// Run `op ‖ payload`; on success returns (result bytes, in-program CU of
    /// the operation, total tx CU).
    pub fn run(&mut self, op: u8, payload: &[u8]) -> Result<(Vec<u8>, u64, u64), FailedTransactionMetadata> {
        let mut data = vec![op];
        data.extend_from_slice(payload);
        let ix = Instruction { program_id: self.id, accounts: vec![], data };
        let msg = Message::new(&[compute_budget_ix(1_400_000), ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        let m = res?;
        let rd = &m.return_data.data;
        assert_eq!(rd.last(), Some(&0xff), "bench return data marker");
        // The last two `sol_log_compute_units` readings bracket the operation.
        let remaining: Vec<u64> = m
            .logs
            .iter()
            .filter_map(|l| {
                let r = l.split("Program consumption: ").nth(1)?;
                r.split(' ').next()?.parse().ok()
            })
            .collect();
        let cu = match remaining.as_slice() {
            [.., a, b] => a - b - LOG_CU_SYSCALL_COST,
            _ => panic!("missing compute-unit logs: {:#?}", m.logs),
        };
        Ok((rd[..rd.len() - 1].to_vec(), cu, m.compute_units_consumed))
    }
}

impl Default for Bench {
    fn default() -> Self {
        Self::new()
    }
}

/// SHA-256 of `polypus-verifier/test_files/ptest.vk` and of the trivial test
/// VK; both take 324-byte (0-commitment) proofs.
pub const PTEST_VK_SHA256: &str = "7e74a260084d55f8a30e73e68f6880a67065d6802d0ea6e4cf4a8d1b04e7b252";
pub const TRIVIAL_VK_SHA256: &str = "42414a8634b0d65298d974fa5b85ab16c22934b12df167c8d70e0e19c49435a2";

/// A well-formed proof for the loaded pool's VK shape that does not verify
/// for the test actions: `$POLYPUS_DUMMY_PROOF` if set; else the smoke-test
/// proof (0 commitments) for the test VKs; else a dev kernel proof from
/// `../artifacts/dev/deposit.proof` (valid BSB22 PoK, so verification only
/// fails at the final pairing, which keeps CU numbers representative); else
/// the sanction_checker proof (1 commitment; fails at the Pedersen check).
pub fn dummy_proof() -> Vec<u8> {
    static PROOF: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    PROOF
        .get_or_init(|| {
            if let Ok(p) = std::env::var("POLYPUS_DUMMY_PROOF") {
                return std::fs::read(p).unwrap();
            }
            let vk = Env::new().vk_sha256.expect("init_pool logs the VK hash");
            let kernel_proof = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/dev/deposit.proof");
            if vk == PTEST_VK_SHA256 || vk == TRIVIAL_VK_SHA256 {
                test_file("ptest.proof")
            } else if let Ok(p) = std::fs::read(kernel_proof) {
                p
            } else {
                test_file("sanction_checker.proof")
            }
        })
        .clone()
}

pub fn test_file(name: &str) -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../polypus-verifier/test_files").join(name))
        .unwrap()
}
