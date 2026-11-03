//! Compiles the kernel verifying key into the program as a constant.
//!
//! The kernel VK is NOT configurable at runtime (design doc §3.5: avoids
//! VK-swap attacks). It is read at build time from `$POLYPUS_KERNEL_VK`
//! (path to a Sunspot/gnark `.vk` file), defaulting to
//! `../../artifacts/dev/kernel.vk` relative to this crate. The build fails if
//! the file is missing or the key does not have exactly one public input
//! (`pi_hash`, SPEC §6.1).

use std::{env, fs, path::PathBuf};

/// SHA-256 of test-only verifying keys shipped in this repo. A pool built with
/// one of them must never be deployed.
const TEST_VKS: &[(&str, &str)] = &[
    (
        "42414a8634b0d65298d974fa5b85ab16c22934b12df167c8d70e0e19c49435a2",
        "tests/fixtures/trivial_pi (INSECURE: anyone can prove any pi_hash)",
    ),
    (
        "7e74a260084d55f8a30e73e68f6880a67065d6802d0ea6e4cf4a8d1b04e7b252",
        "polypus-verifier/test_files/ptest (Sunspot smoke test, not the kernel)",
    ),
];

fn main() {
    println!("cargo:rerun-if-env-changed=POLYPUS_KERNEL_VK");
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vk_path = match env::var("POLYPUS_KERNEL_VK") {
        Ok(p) => PathBuf::from(p),
        Err(_) => manifest_dir.join("../../artifacts/dev/kernel.vk"),
    };
    println!("cargo:rerun-if-changed={}", vk_path.display());

    let bytes = fs::read(&vk_path).unwrap_or_else(|e| {
        panic!(
            "polypus-pool: cannot read kernel VK at {} ({e}). Set POLYPUS_KERNEL_VK to a Sunspot .vk file.",
            vk_path.display()
        )
    });
    let vk = polypus_verifier::parse_vk(bytes.as_slice())
        .unwrap_or_else(|e| panic!("polypus-pool: invalid kernel VK {}: {e}", vk_path.display()));
    if vk.nr_pubinputs != 1 {
        panic!(
            "polypus-pool: kernel VK {} has {} public inputs; the kernel must have exactly 1 (pi_hash)",
            vk_path.display(),
            vk.nr_pubinputs
        );
    }

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("kernel_vk.rs");
    polypus_verifier::generate_key_file(vk_path.to_str().unwrap(), out.to_str().unwrap())
        .unwrap_or_else(|e| panic!("polypus-pool: failed to generate VK constant: {e}"));
    let digest: String = solana_sha256_hasher::hash(&bytes)
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    println!(
        "cargo:warning=polypus-pool: kernel VK compiled in from {} (sha256 {digest}, {} BSB22 commitment(s))",
        vk_path.display(),
        vk.commitment_keys.len()
    );
    if let Some((_, what)) = TEST_VKS.iter().find(|(h, _)| *h == digest) {
        println!("cargo:warning=polypus-pool: TEST-ONLY VERIFYING KEY {what} -- DO NOT DEPLOY THIS BUILD");
    }
}
