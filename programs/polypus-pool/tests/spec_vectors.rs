//! The pool's on-chain hashing code (host build: solana-poseidon falls back to
//! light-poseidon, sha256 to sha2) against spec/vectors/*.json (SPEC §8).

use polypus_pool::{
    crypto::{self, ExtData, PublicValues},
    merkle::ZEROS,
};
use serde_json::Value;

fn vectors(name: &str) -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/vectors/");
    serde_json::from_slice(&std::fs::read(format!("{p}{name}.json")).unwrap()).unwrap()
}

fn b32(v: &Value) -> [u8; 32] {
    let s = v.as_str().unwrap().trim_start_matches("0x");
    let mut b = hex::decode(format!("{s:0>64}")).unwrap();
    b.reverse();
    b.resize(32, 0);
    b.reverse();
    b.try_into().unwrap()
}

#[test]
fn poseidon_vectors() {
    let v = vectors("poseidon");
    for t in v["vectors"].as_array().unwrap() {
        let inputs: Vec<[u8; 32]> = t["inputs"].as_array().unwrap().iter().map(b32).collect();
        let refs: Vec<&[u8; 32]> = inputs.iter().collect();
        assert_eq!(crypto::poseidon(&refs).unwrap(), b32(&t["output"]), "H_{}", inputs.len());
    }
}

#[test]
fn tag_vectors() {
    for t in vectors("tags").as_array().unwrap() {
        let s = t["string"].as_str().unwrap();
        assert_eq!(crypto::tag(s.as_bytes()), b32(&t["value"]), "{s}");
    }
    assert_eq!(crypto::T_PI, crypto::tag(b"polypus.pi.v1"));
    assert_eq!(crypto::T_ASSET, crypto::tag(b"polypus.asset.v1"));
}

#[test]
fn merkle_zero_vectors() {
    let v = vectors("merkle");
    let zeros = v["zeros"].as_array().unwrap();
    assert_eq!(zeros.len(), ZEROS.len());
    for (i, z) in zeros.iter().enumerate() {
        assert_eq!(ZEROS[i], b32(z), "Z_{i}");
    }
}

#[test]
fn ext_data_and_kernel_vectors() {
    let ext = vectors("ext_data");
    let kernel = vectors("kernel");
    for (e, k) in ext.as_array().unwrap().iter().zip(kernel.as_array().unwrap()) {
        assert_eq!(e["scenario"], k["scenario"]);
        let x = &e["ext"];
        let h = |v: &Value| -> [u8; 32] { hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap() };
        let ext_amount = x["ext_amount"].as_i64().unwrap();
        let fee = x["fee"].as_u64().unwrap();
        let d = ExtData {
            pool_id: &h(&x["pool_id"]),
            chain_domain: &h(&x["chain_domain"]),
            public_account: &h(&x["public_account"]),
            relayer: &h(&x["relayer"]),
            ext_amount,
            fee,
            not_before_slot: x["not_before_slot"].as_u64().unwrap(),
            ct_hash: [h(&x["ct_hash"][0]), h(&x["ct_hash"][1])],
        };
        let scenario = e["scenario"].as_str().unwrap();
        assert_eq!(hex::encode(d.bytes()), x["bytes"].as_str().unwrap(), "{scenario}: ext bytes");
        assert_eq!(d.hash(), b32(&x["ext_data_hash"]), "{scenario}: ext_data_hash");
        let public_amount = crypto::embed_signed(ext_amount as i128 - fee as i128);
        assert_eq!(public_amount, b32(&x["public_amount"]), "{scenario}: public_amount");

        let pv = PublicValues {
            root: b32(&k["root"]),
            nf: [b32(&k["nf"][0]), b32(&k["nf"][1])],
            cm_out: [b32(&k["cm_out"][0]), b32(&k["cm_out"][1])],
            public_amount,
            public_asset_id: b32(&k["public_asset_id"]),
            ext_data_hash: d.hash(),
            program_id: [0u8; 32],
            program_io_hash: [0u8; 32],
        };
        // The pool reveals the asset id iff tokens move.
        assert_eq!(
            pv.public_asset_id != [0u8; 32],
            ext_amount != 0 || fee != 0,
            "{scenario}: public_asset_id rule"
        );
        assert_eq!(b32(&k["public_amount"]), public_amount);
        assert_eq!(b32(&k["ext_data_hash"]), d.hash());
        assert_eq!(pv.pi_hash().unwrap(), b32(&k["pi_hash"]), "{scenario}: pi_hash");
    }
}
