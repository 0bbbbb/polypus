//! Compiles the two vendored test VKs (Sunspot smoke test without commitment,
//! and Reilabs' sanction_checker with one BSB22 commitment) into the bench.
use std::{env, path::PathBuf};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    for (name, file) in [("ptest", "ptest.vk"), ("sanction", "sanction_checker.vk")] {
        let src = format!("../polypus-verifier/test_files/{file}");
        println!("cargo:rerun-if-changed={src}");
        polypus_verifier::generate_key_file(&src, out.join(format!("{name}_vk.rs")).to_str().unwrap())
            .unwrap_or_else(|e| panic!("{src}: {e}"));
    }
}
