//! One Polypus deposit on an existing devnet pool (trader trade or follower copy).
//! Requires ~/.polypus-keys/devnet-ledger.json from devnet-e2e.
use polypus_crypto::field::{from_bytes_be, to_bytes_be};
use polypus_crypto::keys::SpendingKey;
use polypus_crypto::merkle::MerkleTree;
use polypus_crypto::scenarios::Ledger;
use polypus_prover::Toolchain;
use polypus_tests::{compute_budget_ix, disc, pool_program, token_program, Kind, TransactArgs};
use rand::rngs::StdRng;
use rand::SeedableRng;
use solana_address::Address;
use solana_commitment_config::CommitmentConfig;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::path::Path;

const SYSTEM: Address = Address::new_from_array([0; 32]);
const TREE_ROOTS_OFFSET: usize = 8 + 32 + 8 + 8 + 32 * 26;

#[derive(serde::Deserialize)]
struct LedgerDoc {
    ledger_seed: u64,
    alice_seed: String,
    bob_seed: String,
    leaves: Vec<String>,
    mint: String,
    chain_domain: String,
    depositor_secret: Vec<u8>,
    relayer_secret: Vec<u8>,
    depositor_token: String,
    relayer_token: String,
    pool: String,
    tree: String,
    vault: String,
}

fn pda(seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, &pool_program()).0
}

fn tree_from_leaves(leaves: &[String]) -> MerkleTree {
    let mut t = MerkleTree::new();
    for h in leaves {
        let b: [u8; 32] = hex::decode(h).expect("leaf hex").try_into().expect("leaf len");
        t.append(from_bytes_be(&b).expect("leaf fr")).expect("append");
    }
    t
}

fn action_ix(
    pool: &Address,
    tree: &Address,
    vault: &Address,
    depositor_token: &Address,
    relayer_token: &Address,
    kind: Kind,
    signer: &Address,
    args: &TransactArgs,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*signer, true),
        AccountMeta::new_readonly(*pool, false),
        AccountMeta::new(*tree, false),
        AccountMeta::new(*vault, false),
    ];
    if kind == Kind::Deposit {
        accounts.push(AccountMeta::new(*depositor_token, false));
    }
    accounts.push(if args.fee > 0 {
        AccountMeta::new(*relayer_token, false)
    } else {
        AccountMeta::new_readonly(pool_program(), false)
    });
    for nf in &args.nf {
        accounts.push(AccountMeta::new(pda(&[b"nf", pool.as_ref(), nf]), false));
    }
    accounts.push(AccountMeta::new_readonly(token_program(), false));
    accounts.push(AccountMeta::new_readonly(SYSTEM, false));
    let mut data = disc("global", kind.ix_name()).to_vec();
    data.extend_from_slice(&args.encode());
    Instruction {
        program_id: pool_program(),
        accounts,
        data,
    }
}

fn tree_root_on_chain(rpc: &RpcClient, tree: &Address) -> [u8; 32] {
    let d = rpc.get_account_data(tree).expect("tree account");
    let cur = u64::from_le_bytes(d[48..56].try_into().unwrap()) as usize;
    d[TREE_ROOTS_OFFSET + 32 * cur..TREE_ROOTS_OFFSET + 32 * cur + 32]
        .try_into()
        .unwrap()
}

fn append_deployment_sig(deployment_path: &Path, label: &str, sig: &str) {
    let mut doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(deployment_path).expect("deployment json")).expect("parse");
    let arr = doc
        .as_object_mut()
        .and_then(|o| o.get_mut("signatures"))
        .and_then(|s| s.as_array_mut())
        .expect("signatures array");
    arr.push(serde_json::json!({"label": label, "sig": sig}));
    std::fs::write(deployment_path, serde_json::to_string_pretty(&doc).unwrap()).expect("write deployment");
}

fn main() {
    let role = std::env::args().nth(1).unwrap_or_else(|| "trader".into());
    let (amount, label, use_bob) = match role.as_str() {
        "follower" => (8u64, "keys_follower_copy", true),
        "trader" | _ => (10u64, "keys_trader_trade", false),
    };

    let ledger_path = std::env::var("POLYPUS_LEDGER_STATE").unwrap_or_else(|_| {
        format!(
            "{}/.polypus-keys/devnet-ledger.json",
            std::env::var("HOME").unwrap_or_else(|_| ".".into())
        )
    });
    let deployment_path = std::env::var("POLYPUS_DEPLOYMENT_OUT")
        .unwrap_or_else(|_| "deployments/devnet.json".into());

    let ld: LedgerDoc = serde_json::from_str(&std::fs::read_to_string(&ledger_path).expect("ledger state")).expect("ledger json");
    let chain_domain: [u8; 32] = hex::decode(&ld.chain_domain).unwrap().try_into().unwrap();
    let pool: Address = ld.pool.parse().expect("pool");
    let tree: Address = ld.tree.parse().expect("tree");
    let vault: Address = ld.vault.parse().expect("vault");
    let depositor_token: Address = ld.depositor_token.parse().expect("dep token");
    let relayer_token: Address = ld.relayer_token.parse().expect("rel token");

    let alice_seed: [u8; 32] = hex::decode(&ld.alice_seed).unwrap().try_into().unwrap();
    let bob_seed: [u8; 32] = hex::decode(&ld.bob_seed).unwrap().try_into().unwrap();
    let mut rebuilt = tree_from_leaves(&ld.leaves);
    let mint: Address = ld.mint.parse().expect("mint");

    let rng_seed = ld.ledger_seed.wrapping_add(ld.leaves.len() as u64);
    let mut l = Ledger {
        rng: StdRng::seed_from_u64(rng_seed),
        tree: std::mem::replace(&mut rebuilt, MerkleTree::new()),
        aid: polypus_crypto::note::asset_id(&mint.to_bytes()),
        pool_id: pool.to_bytes(),
        chain_domain,
    };
    assert_eq!(
        to_bytes_be(&l.tree.root()),
        tree_root_on_chain(
            &RpcClient::new_with_commitment(
                std::env::var("POLYPUS_RPC").unwrap_or_else(|_| "https://api.devnet.solana.com".into()),
                CommitmentConfig::confirmed(),
            ),
            &tree,
        ),
        "ledger leaves match on-chain tree"
    );

    let sk = if use_bob {
        SpendingKey::from_seed(bob_seed)
    } else {
        SpendingKey::from_seed(alice_seed)
    };
    let owner = sk.address(0).owner;
    let n = [l.note(amount, owner), l.note(0, owner)];

    let url = std::env::var("POLYPUS_RPC").unwrap_or_else(|_| "https://api.devnet.solana.com".into());
    assert_eq!(
        std::env::var("POLYPUS_ALLOW_DEVNET").ok().as_deref(),
        Some("1"),
        "set POLYPUS_ALLOW_DEVNET=1"
    );
    let rpc = RpcClient::new_with_commitment(url, CommitmentConfig::confirmed());
    let depositor = Keypair::try_from(ld.depositor_secret.as_slice()).expect("depositor");
    let relayer = Keypair::try_from(ld.relayer_secret.as_slice()).expect("relayer");

    let public = depositor_token.to_bytes();
    let relayer_b = [0u8; 32];
    let cts = [format!("{label}/ct0").into_bytes(), format!("{label}/ct1").into_bytes()];
    let ext = l.ext(amount as i64, 0, public, relayer_b, [&cts[0], &cts[1]]);
    let (w, _idx) = l.act(&sk, [None, None], n, &ext);
    w.check().expect("witness");
    let proof = Toolchain::default_for_repo().prove(&w).expect("prove");
    let pv = &w.public;
    let args = TransactArgs {
        nf: [to_bytes_be(&pv.nf[0]), to_bytes_be(&pv.nf[1])],
        root: to_bytes_be(&pv.root),
        cm_out: [to_bytes_be(&pv.cm_out[0]), to_bytes_be(&pv.cm_out[1])],
        ext_amount: amount as i64,
        fee: 0,
        not_before_slot: 0,
        proof: proof.proof,
        ciphertexts: cts,
    };
    let ix = action_ix(
        &pool,
        &tree,
        &vault,
        &depositor_token,
        &relayer_token,
        Kind::Deposit,
        &depositor.pubkey(),
        &args,
    );
    let bh = rpc.get_latest_blockhash().expect("blockhash");
    let msg = Message::new(&[compute_budget_ix(1_400_000), ix], Some(&depositor.pubkey()));
    let tx = Transaction::new(&[&depositor], msg, bh);
    let sig = rpc.send_and_confirm_transaction(&tx).expect("send deposit");
    println!("{label} amount={amount} sig={sig}");

    append_deployment_sig(Path::new(&deployment_path), label, &sig.to_string());

    let mut leaf_hex = ld.leaves;
    let start = leaf_hex.len() as u64;
    for i in start..l.tree.len() {
        leaf_hex.push(hex::encode(to_bytes_be(&l.tree.leaf(i).expect("leaf"))));
    }
    let mut ledger_val: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&ledger_path).unwrap()).expect("ledger");
    ledger_val["leaves"] = serde_json::json!(leaf_hex);
    std::fs::write(&ledger_path, serde_json::to_string_pretty(&ledger_val).unwrap()).expect("update ledger");
}
