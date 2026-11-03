//! On-chain (SBF, LiteSVM) checks and CU measurements of the building blocks,
//! via the test-only `polypus-verifier-bench` program.

use polypus_crypto::{
    field::{from_u64, to_bytes_be},
    hash::poseidon,
    merkle::Frontier,
};
use polypus_tests::{test_file, Bench};

fn verify_payload(name: &str) -> Vec<u8> {
    let mut p = test_file(&format!("{name}.proof"));
    // Public witness file: 12-byte gnark header, then one 32-byte input.
    let pw = test_file(&format!("{name}.pw"));
    assert_eq!(pw.len(), 12 + 32);
    p.extend_from_slice(&pw[12..]);
    p
}

#[test]
fn verifier_accepts_smoke_proof_and_rejects_mutations() {
    let mut b = Bench::new();
    let good = verify_payload("ptest");
    let (_, cu, total) = b.run(0, &good).expect("ptest proof must verify");
    println!("CU verifier (1 public input, 0 commitments): {cu} in-program, {total} tx");

    let mut pi = good.clone();
    let n = pi.len();
    pi[n - 1] ^= 1;
    let e = b.run(0, &pi).expect_err("mutated public input must fail");
    println!("CU verifier reject (mutated public input): {}", e.meta.compute_units_consumed);

    for pos in [10usize, 100, 200] {
        let mut pr = good.clone();
        pr[pos] ^= 1;
        assert!(b.run(0, &pr).is_err(), "mutated proof byte {pos} accepted");
    }
    // A public input >= r is rejected even though x - r would verify.
    let mut nc = good.clone();
    let x = polypus_crypto::field::from_bytes_be(&nc[n - 32..].try_into().unwrap()).unwrap();
    let modulus = num_add_be(&to_bytes_be(&x), &polypus_tests_modulus());
    if let Some(m) = modulus {
        nc[n - 32..].copy_from_slice(&m);
        assert!(b.run(0, &nc).is_err(), "non-canonical public input accepted");
    }
}

#[test]
fn verifier_with_bsb22_commitment() {
    let mut b = Bench::new();
    let good = verify_payload("sanction_checker");
    let (_, cu, total) = b.run(1, &good).expect("sanction_checker proof must verify");
    println!("CU verifier (1 public input, 1 BSB22 commitment): {cu} in-program, {total} tx");
    let mut bad = good.clone();
    let n = bad.len();
    bad[n - 1] ^= 1;
    assert!(b.run(1, &bad).is_err());
}

/// Real kernel proofs (`<name>.proof` + `<name>.pw` in `$POLYPUS_KERNEL_PROOFS`)
/// against the kernel VK compiled into the bench (via polypus-pool), so build
/// the bench with the matching `POLYPUS_KERNEL_VK`.
#[test]
#[ignore = "needs POLYPUS_KERNEL_PROOFS and a bench built with that kernel VK"]
fn kernel_proofs_verify_on_chain() {
    let dir = std::path::PathBuf::from(std::env::var("POLYPUS_KERNEL_PROOFS").unwrap());
    let mut b = Bench::new();
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            (p.extension()? == "proof").then(|| p.file_stem().unwrap().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    assert!(!names.is_empty());
    for name in names {
        let mut payload = std::fs::read(dir.join(format!("{name}.proof"))).unwrap();
        let pw = std::fs::read(dir.join(format!("{name}.pw"))).unwrap();
        assert_eq!(pw.len(), 12 + 32, "kernel has exactly one public input");
        payload.extend_from_slice(&pw[12..]);
        let (_, cu, total) = b.run(4, &payload).unwrap_or_else(|e| panic!("{name}: {:#?}", e.meta.logs));
        println!("CU kernel verifier ({name}, {} B proof): {cu} in-program, {total} tx", payload.len() - 32);
        let n = payload.len();
        payload[n - 1] ^= 1;
        assert!(b.run(4, &payload).is_err(), "{name}: mutated pi_hash accepted");
    }
}

#[test]
fn poseidon_syscall_parity() {
    let mut b = Bench::new();
    // SPEC §2 known answer.
    let mut kat = to_bytes_be(&from_u64(1)).to_vec();
    kat.extend_from_slice(&to_bytes_be(&from_u64(2)));
    let (h, cu, _) = b.run(2, &kat).unwrap();
    assert_eq!(hex::encode(&h), "115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a");
    println!("CU sol_poseidon H_2: {cu}");
    for n in 1..=12u64 {
        let inputs: Vec<_> = (0..n).map(|i| from_u64(0xdead_0000 + 31 * n + i)).collect();
        let payload: Vec<u8> = inputs.iter().flat_map(to_bytes_be).collect();
        let (h, cu, _) = b.run(2, &payload).unwrap();
        assert_eq!(h, to_bytes_be(&poseidon(&inputs)).to_vec(), "H_{n}");
        println!("CU sol_poseidon H_{n}: {cu}");
    }
    // Non-canonical input (= p) is rejected by the syscall.
    let p = polypus_tests_modulus();
    let mut payload = p.to_vec();
    payload.extend_from_slice(&[0u8; 32]);
    assert!(b.run(2, &payload).is_err());
    // More than 12 inputs is rejected.
    assert!(b.run(2, &vec![0u8; 32 * 13]).is_err());
}

#[test]
fn tree_append_parity_and_cost() {
    let mut b = Bench::new();
    for k in [1usize, 2, 8] {
        let mut f = Frontier::default();
        let mut payload = Vec::new();
        for i in 0..k as u64 {
            let (x, y) = (from_u64(1_000 + 2 * i), from_u64(1_001 + 2 * i));
            payload.extend_from_slice(&to_bytes_be(&x));
            payload.extend_from_slice(&to_bytes_be(&y));
            f.append_pair(x, y).unwrap();
        }
        let (root, cu, _) = b.run(3, &payload).unwrap();
        assert_eq!(root, to_bytes_be(&f.root()).to_vec(), "root after {k} pairs");
        println!("CU tree append: {k} pair(s) = {cu} ({} per pair)", cu / k as u64);
    }
}

fn polypus_tests_modulus() -> [u8; 32] {
    hex::decode("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001")
        .unwrap()
        .try_into()
        .unwrap()
}

/// a + b as 32-byte big-endian, None on overflow.
fn num_add_be(a: &[u8; 32], b: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let s = a[i] as u16 + b[i] as u16 + carry;
        out[i] = s as u8;
        carry = s >> 8;
    }
    (carry == 0).then_some(out)
}
