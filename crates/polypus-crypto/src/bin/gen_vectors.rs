//! Generate `spec/vectors/*.json` (deterministic). Usage:
//! `cargo run -p polypus-crypto --bin gen-vectors -- spec/vectors`

use polypus_crypto::ext_data::{ciphertext_hash, ExtData};
use polypus_crypto::field::{tag, to_hex, Fr};
use polypus_crypto::hash::{poseidon, tags::ALL_TAGS};
use polypus_crypto::kernel::{build_action, SpendInput};
use polypus_crypto::keys::SpendingKey;
use polypus_crypto::merkle::{zeros, MerkleTree, DEPTH};
use polypus_crypto::note::{asset_id, nullifier, rcm, Note};
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde_json::{json, Value};
use std::path::PathBuf;

fn h(x: &Fr) -> Value {
    Value::String(to_hex(x))
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "spec/vectors".into()));
    std::fs::create_dir_all(&dir).unwrap();

    // Poseidon: inputs 1..=n for every arity used on-chain.
    let poseidon_v: Vec<Value> = (1..=12u64)
        .map(|n| {
            let ins: Vec<Fr> = (1..=n).map(Fr::from).collect();
            json!({ "inputs": ins.iter().map(h).collect::<Vec<_>>(), "output": h(&poseidon(&ins)) })
        })
        .collect();

    let tags_v: Vec<Value> =
        ALL_TAGS.iter().map(|(n, s)| json!({ "name": n, "string": s, "value": h(&tag(s)) })).collect();

    let z = zeros();
    let zeros_v: Vec<Value> = z.iter().map(h).collect();

    // Keys and addresses for seeds 0x01.., 0x02..
    let keys_v: Vec<Value> = (1u8..=3)
        .map(|b| {
            let sk = SpendingKey::from_seed([b; 32]);
            let fvk = sk.full_viewing_key();
            let addrs: Vec<Value> = (0..2)
                .map(|j| {
                    let a = sk.address(j);
                    json!({
                        "index": j,
                        "diversifier": hex::encode(a.d.0),
                        "diversifier_field": h(&a.d.to_field()),
                        "pk_d": hex::encode(a.pk_d),
                        "owner": h(&a.owner),
                        "encoded": a.encode(),
                    })
                })
                .collect();
            json!({
                "seed": hex::encode([b; 32]),
                "ask": h(&sk.ask()),
                "nk": h(&sk.nk()),
                "ak": h(&fvk.ak),
                "ivk": hex::encode(fvk.ivk),
                "fvk_encoded": fvk.encode(),
                "ivk_encoded": fvk.incoming().encode(),
                "addresses": addrs,
            })
        })
        .collect();

    // Notes: commitment and nullifier.
    let mint = [0x11u8; 32];
    let aid = asset_id(&mint);
    let sk = SpendingKey::from_seed([1u8; 32]);
    let owner = sk.address(0).owner;
    let notes_v: Vec<Value> = [(0u64, 1u64), (100, 2), (u64::MAX, 3)]
        .iter()
        .map(|&(amount, rs)| {
            let n = Note::plain(aid, amount, owner, Fr::from(rs));
            let cm = n.commitment();
            json!({
                "asset_id": h(&n.asset_id), "amount": amount.to_string(), "owner": h(&n.owner),
                "lock_program": h(&n.lock_program), "lock_data": h(&n.lock_data), "escape": h(&n.escape),
                "rseed": h(&n.rseed), "rcm": h(&rcm(&n.rseed)), "commitment": h(&cm),
                "nk": h(&sk.nk()), "leaf_index": 5, "nullifier": h(&nullifier(&sk.nk(), &cm, 5)),
            })
        })
        .collect();

    // Merkle: 4 leaves 1..4.
    let mut t = MerkleTree::new();
    for i in 1..=4u64 {
        t.append(Fr::from(i)).unwrap();
    }
    let merkle_v = json!({
        "depth": DEPTH, "leaves": ["1","2","3","4"], "root": h(&t.root()),
        "path_leaf_2": t.path(2).unwrap().iter().map(h).collect::<Vec<_>>(),
    });

    // Ext data.
    let ext = ExtData {
        pool_id: [1; 32],
        chain_domain: [2; 32],
        public_account: [3; 32],
        relayer: [4; 32],
        ext_amount: -500,
        fee: 7,
        not_before_slot: 9,
        ct_hash: [ciphertext_hash(b"ct0"), ciphertext_hash(b"ct1")],
    };
    let ext_v = json!({
        "pool_id": hex::encode(ext.pool_id), "chain_domain": hex::encode(ext.chain_domain),
        "public_account": hex::encode(ext.public_account), "relayer": hex::encode(ext.relayer),
        "ext_amount": ext.ext_amount, "fee": ext.fee, "not_before_slot": ext.not_before_slot,
        "ct_hash": [hex::encode(ext.ct_hash[0]), hex::encode(ext.ct_hash[1])],
        "bytes": hex::encode(ext.bytes()), "ext_data_hash": h(&ext.hash()),
        "public_amount": h(&ext.public_amount()),
    });

    // A full honest kernel witness: deposit 100, then spend it in a transfer.
    let mut rng = StdRng::seed_from_u64(42);
    let alice = SpendingKey::from_seed([1u8; 32]);
    let bob = SpendingKey::from_seed([2u8; 32]);
    let mut tree = MerkleTree::new();
    let dep_ext = ExtData { ext_amount: 100, public_account: [3; 32], ..ext.clone() };
    let dep_ext = ExtData { fee: 0, relayer: [0; 32], ..dep_ext };
    let note_a = Note::random_plain(&mut rng, aid, 100, alice.address(0).owner);
    let zero_note = Note::random_plain(&mut rng, aid, 0, alice.address(0).owner);
    let w_dep = build_action(&mut rng, &alice, &tree, aid, [None, None], [note_a, zero_note], &dep_ext);
    w_dep.check().expect("deposit witness valid");
    tree.append(note_a.commitment()).unwrap();
    tree.append(zero_note.commitment()).unwrap();
    let to_bob = Note::random_plain(&mut rng, aid, 60, bob.address(0).owner);
    let change = Note::random_plain(&mut rng, aid, 40, alice.address(0).owner);
    let tr_ext = ExtData { ext_amount: 0, fee: 0, public_account: [0; 32], relayer: [0; 32], ..ext.clone() };
    let w_tr = build_action(
        &mut rng,
        &alice,
        &tree,
        aid,
        [Some(SpendInput { note: note_a, d: alice.diversifier(0), leaf_index: 0 }), None],
        [to_bob, change],
        &tr_ext,
    );
    w_tr.check().expect("transfer witness valid");

    let write = |name: &str, v: Value| {
        std::fs::write(dir.join(name), serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
    };
    write("poseidon.json", json!({ "params": "circomlib BN254 x^5", "vectors": poseidon_v }));
    write("tags.json", json!(tags_v));
    write("merkle.json", json!({ "zeros": zeros_v, "small_tree": merkle_v }));
    write("keys.json", json!(keys_v));
    write("notes.json", json!({ "mint": hex::encode(mint), "asset_id": h(&aid), "notes": notes_v }));
    write("ext_data.json", ext_v);
    std::fs::write(dir.join("kernel_deposit.Prover.toml"), w_dep.to_prover_toml()).unwrap();
    std::fs::write(dir.join("kernel_transfer.Prover.toml"), w_tr.to_prover_toml()).unwrap();
    write(
        "kernel.json",
        json!({
            "deposit": { "pi_hash": h(&w_dep.pi_hash), "root": h(&w_dep.public.root),
                         "nf": w_dep.public.nf.iter().map(h).collect::<Vec<_>>(),
                         "cm_out": w_dep.public.cm_out.iter().map(h).collect::<Vec<_>>() },
            "transfer": { "pi_hash": h(&w_tr.pi_hash), "root": h(&w_tr.public.root),
                          "nf": w_tr.public.nf.iter().map(h).collect::<Vec<_>>(),
                          "cm_out": w_tr.public.cm_out.iter().map(h).collect::<Vec<_>>() },
        }),
    );
    eprintln!("wrote vectors to {}", dir.display());
}
