//! Devnet (or localnet) end to end with REAL kernel proofs.
//! Set POLYPUS_ALLOW_DEVNET=1 and POLYPUS_RPC=https://api.devnet.solana.com.
//! Fund POLYPUS_DEVNET_KEYPAIR (≥3 SOL). Writes POLYPUS_DEPLOYMENT_OUT JSON.
//!
//! Driven by `scripts/localnet-e2e.sh`, which starts the validator and deploys
//! the pool. This binary creates a fresh SPL mint and token accounts, then:
//! init_pool → deposit 100 → transfer (1-in, fee) → deposit 25 (fee) →
//! transfer (2-in) → withdraw 85 (2-in, fee). It checks roots against the Rust
//! tree, balances and replay rejection, and reports compute units from
//! transaction metadata. All keypairs are generated in memory.

use polypus_crypto::field::to_bytes_be;
use polypus_crypto::kernel::SpendInput;
use polypus_crypto::keys::SpendingKey;
use polypus_crypto::note::Note;
use polypus_crypto::scenarios::Ledger;
use polypus_prover::Toolchain;
use polypus_tests::{
    compute_budget_ix, disc, init_pool_ix, legacy_tx_size, pool_program, sha256, token_program, Kind, PoolConfig,
    TransactArgs,
};
use solana_address::Address;
use solana_commitment_config::CommitmentConfig;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::RpcTransactionConfig;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_status_client_types::{option_serializer::OptionSerializer, UiTransactionEncoding};

const SYSTEM: Address = Address::new_from_array([0; 32]);
const TREE_ROOTS_OFFSET: usize = 8 + 32 + 8 + 8 + 32 * 26;

struct Accounts {
    mint: Address,
    pool: Address,
    tree: Address,
    vault: Address,
    depositor_token: Address,
    recipient_token: Address,
    relayer_token: Address,
}

fn pda(seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, &pool_program()).0
}

fn create_account_ix(payer: &Address, new: &Address, lamports: u64, space: u64, owner: &Address) -> Instruction {
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: SYSTEM,
        accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(*new, true)],
        data,
    }
}

fn token_ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction { program_id: token_program(), accounts, data }
}

struct Net {
    rpc: RpcClient,
    payer: Keypair,
    cu: Vec<(String, u64, usize)>,
    sigs: Vec<(String, String)>,
}

impl Net {
    fn send(&self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(String, u64), String> {
        let mut all = vec![compute_budget_ix(1_400_000)];
        all.extend_from_slice(ixs);
        let msg = Message::new(&all, Some(&signers[0].pubkey()));
        let bh = self.rpc.get_latest_blockhash().map_err(|e| e.to_string())?;
        let tx = Transaction::new(signers, msg, bh);
        let sig = self.rpc.send_and_confirm_transaction(&tx).map_err(|e| format!("{e:?}"))?;
        let cfg = RpcTransactionConfig {
            encoding: Some(UiTransactionEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            max_supported_transaction_version: Some(0),
        };
        let t = self.rpc.get_transaction_with_config(&sig, cfg).map_err(|e| e.to_string())?;
        let cu = match t.transaction.meta.map(|m| m.compute_units_consumed) {
            Some(OptionSerializer::Some(c)) => c,
            _ => 0,
        };
        Ok((sig.to_string(), cu))
    }

    fn airdrop(&self, to: &Address, lamports: u64) {
        let sig = self.rpc.request_airdrop(to, lamports).expect("airdrop");
        while !self.rpc.confirm_transaction(&sig).unwrap_or(false) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    fn token_balance(&self, a: &Address) -> u64 {
        let d = self.rpc.get_account_data(a).expect("token account");
        u64::from_le_bytes(d[64..72].try_into().unwrap())
    }

    fn tree_root(&self, acc: &Accounts) -> [u8; 32] {
        let d = self.rpc.get_account_data(&acc.tree).expect("tree");
        let cur = u64::from_le_bytes(d[48..56].try_into().unwrap()) as usize;
        d[TREE_ROOTS_OFFSET + 32 * cur..TREE_ROOTS_OFFSET + 32 * cur + 32].try_into().unwrap()
    }
}

fn action_ix(acc: &Accounts, kind: Kind, signer: &Address, args: &TransactArgs) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*signer, true),
        AccountMeta::new_readonly(acc.pool, false),
        AccountMeta::new(acc.tree, false),
        AccountMeta::new(acc.vault, false),
    ];
    match kind {
        Kind::Deposit => accounts.push(AccountMeta::new(acc.depositor_token, false)),
        Kind::Withdraw => accounts.push(AccountMeta::new(acc.recipient_token, false)),
        Kind::Transact => {}
    }
    accounts.push(if args.fee > 0 {
        AccountMeta::new(acc.relayer_token, false)
    } else {
        AccountMeta::new_readonly(pool_program(), false)
    });
    for nf in &args.nf {
        accounts.push(AccountMeta::new(pda(&[b"nf", acc.pool.as_ref(), nf]), false));
    }
    accounts.push(AccountMeta::new_readonly(token_program(), false));
    accounts.push(AccountMeta::new_readonly(SYSTEM, false));
    let mut data = disc("global", kind.ix_name()).to_vec();
    data.extend_from_slice(&args.encode());
    Instruction { program_id: pool_program(), accounts, data }
}

fn transfer_sol(net: &Net, from: &Keypair, to: &Address, lamports: u64) {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    let ix = Instruction {
        program_id: SYSTEM,
        accounts: vec![AccountMeta::new(from.pubkey(), true), AccountMeta::new(*to, false)],
        data,
    };
    net.send(&[ix], &[from]).expect("transfer");
}

fn main() {
    let url = std::env::var("POLYPUS_RPC").unwrap_or_else(|_| "http://127.0.0.1:8899".into());
    let local = url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    if !local {
        assert_eq!(
            std::env::var("POLYPUS_ALLOW_DEVNET").ok().as_deref(),
            Some("1"),
            "refusing non-local RPC {url} without POLYPUS_ALLOW_DEVNET=1"
        );
    }
    let rpc = RpcClient::new_with_commitment(url.clone(), CommitmentConfig::confirmed());
    let genesis = rpc.get_genesis_hash().expect("validator reachable");
    let cluster = if local { "localnet" } else { "devnet" };
    println!("{cluster} {url}, genesis {genesis}");
    assert!(rpc.get_account(&pool_program()).map(|a| a.executable).unwrap_or(false), "pool program not deployed");

    let admin_path = std::env::var("POLYPUS_DEVNET_KEYPAIR")
        .or_else(|_| std::env::var("POLYPUS_ADMIN_KEYPAIR"))
        .expect("POLYPUS_DEVNET_KEYPAIR or POLYPUS_ADMIN_KEYPAIR");
    let admin = read_keypair(&admin_path);
    let net = Net {
        rpc,
        payer: Keypair::try_from(admin.to_bytes().as_slice()).expect("payer keypair"),
        cu: Vec::new(),
        sigs: Vec::new(),
    };
    let (depositor, relayer) = (Keypair::new(), Keypair::new());
    if local {
        for k in [&net.payer, &depositor, &relayer] {
            net.airdrop(&k.pubkey(), 10_000_000_000);
        }
    } else {
        for k in [&depositor, &relayer] {
            transfer_sol(&net, &net.payer, &k.pubkey(), 500_000_000);
        }
    }

    // Test SPL mint and token accounts.
    let (mint_kp, dep_kp, rec_kp, rel_kp) = (Keypair::new(), Keypair::new(), Keypair::new(), Keypair::new());
    let mint_rent = net.rpc.get_minimum_balance_for_rent_exemption(82).unwrap();
    let acct_rent = net.rpc.get_minimum_balance_for_rent_exemption(165).unwrap();
    let p = net.payer.pubkey();
    let mut init_mint = vec![20u8, 6];
    init_mint.extend_from_slice(p.as_ref());
    init_mint.push(0); // no freeze authority
    let mut ixs = vec![
        create_account_ix(&p, &mint_kp.pubkey(), mint_rent, 82, &token_program()),
        token_ix(init_mint, vec![AccountMeta::new(mint_kp.pubkey(), false)]),
    ];
    for (kp, owner) in [(&dep_kp, depositor.pubkey()), (&rec_kp, Keypair::new().pubkey()), (&rel_kp, relayer.pubkey())] {
        ixs.push(create_account_ix(&p, &kp.pubkey(), acct_rent, 165, &token_program()));
        let mut d = vec![18u8];
        d.extend_from_slice(owner.as_ref());
        ixs.push(token_ix(d, vec![AccountMeta::new(kp.pubkey(), false), AccountMeta::new_readonly(mint_kp.pubkey(), false)]));
    }
    let mut mint_to = vec![7u8];
    mint_to.extend_from_slice(&1_000_000u64.to_le_bytes());
    ixs.push(token_ix(
        mint_to,
        vec![
            AccountMeta::new(mint_kp.pubkey(), false),
            AccountMeta::new(dep_kp.pubkey(), false),
            AccountMeta::new_readonly(p, true),
        ],
    ));
    net.send(&ixs, &[&net.payer, &mint_kp, &dep_kp, &rec_kp, &rel_kp]).expect("create mint + token accounts");

    let mint = mint_kp.pubkey();
    let pool = pda(&[b"pool", mint.as_ref()]);
    let acc = Accounts {
        mint,
        pool,
        tree: pda(&[b"tree", pool.as_ref()]),
        vault: pda(&[b"vault", pool.as_ref()]),
        depositor_token: dep_kp.pubkey(),
        recipient_token: rec_kp.pubkey(),
        relayer_token: rel_kp.pubkey(),
    };
    let chain_domain = sha256(format!("polypus.{cluster}.{genesis}").as_bytes());
    let init = init_pool_ix(&admin.pubkey(), &acc.mint, chain_domain, PoolConfig::unlimited(admin.pubkey()));
    let (sig, cu) = net.send(&[init], &[&admin]).expect("init_pool");
    println!("init_pool                    CU {cu:>7}  sig {sig}");
    let mut net = net;
    net.cu.push(("init_pool".into(), cu, 0));
    net.sigs.push(("init_pool".into(), sig));

    let tc = Toolchain::default_for_repo();
    let mut l = Ledger::new(11, acc.mint.to_bytes(), acc.pool.to_bytes(), chain_domain);
    let alice = SpendingKey::from_seed(rand_seed());
    let bob = SpendingKey::from_seed(rand_seed());
    let (aa, ba) = (alice.address(0), bob.address(0));

    let step = |net: &mut Net,
                    l: &mut Ledger,
                    label: &str,
                    kind: Kind,
                    sk: &SpendingKey,
                    inputs: [Option<SpendInput>; 2],
                    outputs: [Note; 2],
                    ext_amount: i64,
                    fee: u64|
     -> [u64; 2] {
        let public = match kind {
            Kind::Deposit => acc.depositor_token.to_bytes(),
            Kind::Withdraw => acc.recipient_token.to_bytes(),
            Kind::Transact => [0; 32],
        };
        let relayer_b = if fee > 0 { acc.relayer_token.to_bytes() } else { [0; 32] };
        let cts = [format!("{label}/ct0").into_bytes(), format!("{label}/ct1").into_bytes()];
        let ext = l.ext(ext_amount, fee, public, relayer_b, [&cts[0], &cts[1]]);
        let (w, idx) = l.act(sk, inputs, outputs, &ext);
        w.check().expect("reference accepts");
        let proof = tc.prove(&w).expect("prove");
        let pv = &w.public;
        let args = TransactArgs {
            nf: [to_bytes_be(&pv.nf[0]), to_bytes_be(&pv.nf[1])],
            root: to_bytes_be(&pv.root),
            cm_out: [to_bytes_be(&pv.cm_out[0]), to_bytes_be(&pv.cm_out[1])],
            ext_amount,
            fee,
            not_before_slot: 0,
            proof: proof.proof,
            ciphertexts: cts,
        };
        let signer = if kind == Kind::Deposit { &depositor } else { &relayer };
        let ix = action_ix(&acc, kind, &signer.pubkey(), &args);
        let size = legacy_tx_size(&[compute_budget_ix(1_400_000), ix.clone()], &signer.pubkey());
        let vault_before = net.token_balance(&acc.vault);
        let (sig, cu) = net.send(&[ix.clone()], &[signer]).unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_eq!(net.tree_root(&acc), to_bytes_be(&l.tree.root()), "{label}: on-chain root = Rust tree root");
        assert_eq!(net.token_balance(&acc.vault) as i128, vault_before as i128 + ext_amount as i128 - fee as i128);
        assert!(net.send(&[ix], &[signer]).is_err(), "{label}: replay must fail");
        println!("{label:<28} CU {cu:>7}  tx {size} B  sig {sig}");
        net.cu.push((label.to_string(), cu, size));
        net.sigs.push((label.to_string(), sig));
        idx
    };

    let n = [l_note(&mut l, 100, aa.owner), l_note(&mut l, 0, aa.owner)];
    let i = step(&mut net, &mut l, "deposit 100", Kind::Deposit, &alice, [None, None], n, 100, 0);
    let a100 = SpendInput { note: n[0], d: aa.d, leaf_index: i[0] };
    let n = [l_note(&mut l, 60, ba.owner), l_note(&mut l, 38, aa.owner)];
    let i = step(&mut net, &mut l, "transfer 1-in, fee 2", Kind::Transact, &alice, [Some(a100), None], n, 0, 2);
    let (b60, a38) = (SpendInput { note: n[0], d: ba.d, leaf_index: i[0] }, SpendInput { note: n[1], d: aa.d, leaf_index: i[1] });
    let n = [l_note(&mut l, 24, aa.owner), l_note(&mut l, 0, aa.owner)];
    let i = step(&mut net, &mut l, "deposit 25, fee 1", Kind::Deposit, &alice, [None, None], n, 25, 1);
    let a24 = SpendInput { note: n[0], d: aa.d, leaf_index: i[0] };
    let n = [l_note(&mut l, 30, ba.owner), l_note(&mut l, 32, aa.owner)];
    let i = step(&mut net, &mut l, "transfer 2-in, no fee", Kind::Transact, &alice, [Some(a38), Some(a24)], n, 0, 0);
    let b30 = SpendInput { note: n[0], d: ba.d, leaf_index: i[0] };
    let n = [l_note(&mut l, 4, ba.owner), l_note(&mut l, 0, ba.owner)];
    step(&mut net, &mut l, "withdraw 85 2-in, fee 1", Kind::Withdraw, &bob, [Some(b60), Some(b30)], n, -85, 1);

    assert_eq!(net.token_balance(&acc.vault), 36);
    assert_eq!(net.token_balance(&acc.recipient_token), 85);
    assert_eq!(net.token_balance(&acc.relayer_token), 4);
    println!("\n{cluster} E2E OK: vault 36 (= unspent notes), recipient 85, relayer fees 4");
    println!("| action | CU | legacy tx bytes |\n|---|---|---|");
    let mut actions = Vec::new();
    for (label, cu, size) in &net.cu {
        println!("| {label} | {cu} | {size} |");
        actions.push(serde_json::json!({"action": label, "cu": cu, "tx_bytes": size}));
    }
    let out_path = std::env::var("POLYPUS_DEPLOYMENT_OUT")
        .unwrap_or_else(|_| "deployments/devnet.json".into());
    let mint_str = acc.mint.to_string();
    let pool_str = acc.pool.to_string();
    let doc = serde_json::json!({
        "network": cluster,
        "rpc": url,
        "program_id": pool_program().to_string(),
        "mint": mint_str,
        "pool": pool_str,
        "tree": acc.tree.to_string(),
        "vault": acc.vault.to_string(),
        "chain_domain": hex::encode(chain_domain),
        "genesis": genesis.to_string(),
        "actions": actions,
        "signatures": net.sigs.iter().map(|(label, sig)| {
            serde_json::json!({"label": label, "sig": sig})
        }).collect::<Vec<_>>(),
        "explorer_base": if cluster == "devnet" {
            "https://explorer.solana.com/tx/{sig}?cluster=devnet"
        } else {
            "http://127.0.0.1:8899/tx/{sig}"
        },
    });
    if let Some(parent) = std::path::Path::new(&out_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&out_path, serde_json::to_string_pretty(&doc).unwrap()).expect("write deployment json");
    println!("wrote {out_path}");
}

fn l_note(l: &mut Ledger, amount: u64, owner: polypus_crypto::Fr) -> Note {
    l.note(amount, owner)
}

fn read_keypair(path: &str) -> Keypair {
    let bytes: Vec<u8> = serde_json::from_str(&std::fs::read_to_string(path).expect("read keypair")).expect("keypair json");
    Keypair::try_from(bytes.as_slice()).expect("keypair bytes")
}

fn rand_seed() -> [u8; 32] {
    Keypair::new().to_bytes()[..32].try_into().unwrap()
}
