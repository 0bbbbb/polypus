//! Regenerates `fixtures/trivial/*.json`: real Groth16 proofs, for the actions
//! of [`trivial_scenario`], under the TEST-ONLY trivial circuit in
//! `fixtures/trivial_pi` (its only constraint is on `pi_hash`). Requires
//! `nargo` and `sunspot` on PATH.

use std::process::Command;

use polypus_tests::*;

#[test]
#[ignore = "regenerates fixtures with nargo + sunspot"]
fn generate_trivial_fixtures() {
    let circuit = fixtures_dir().join("trivial_pi");
    let out = fixtures_dir().join("trivial");
    std::fs::create_dir_all(&out).unwrap();
    for (i, (kind, mut a)) in trivial_scenario().into_iter().enumerate() {
        let pi = hex::encode(expected_pi_hash(kind, &a));
        std::fs::write(circuit.join("Prover.toml"), format!("pi_hash = \"0x{pi}\"\nx = \"0x{pi}\"\n")).unwrap();
        let run = |cmd: &mut Command| {
            let o = cmd.current_dir(&circuit).output().expect("spawn");
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        };
        run(Command::new("nargo").arg("execute"));
        run(Command::new("sunspot").args([
            "prove",
            "trivial_pi.json",
            "target/trivial_pi.gz",
            "trivial_pi.ccs",
            "trivial_pi.pk",
        ]));
        let pw = std::fs::read(circuit.join("trivial_pi.pw")).unwrap();
        assert_eq!(hex::encode(&pw[12..]), pi, "public witness must be pi_hash");
        a.proof = std::fs::read(circuit.join("trivial_pi.proof")).unwrap();
        let fx = ActionFixture::from_args(kind, &a);
        let path = out.join(format!("{i:02}_{}.json", kind.ix_name()));
        std::fs::write(&path, serde_json::to_string_pretty(&fx).unwrap()).unwrap();
        println!("wrote {}", path.display());
    }
}
