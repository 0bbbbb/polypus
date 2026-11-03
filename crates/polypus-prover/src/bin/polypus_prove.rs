//! `polypus-prove` — dev CLI for the kernel proving pipeline (INSECURE dev keys).
//!
//!   polypus-prove scenarios            prove + verify the standard scenario, check public input
//!   polypus-prove tamper               a proof must not verify with a mutated proof / public input
//!   polypus-prove bench [N]            N proofs, report witness-gen and proving times
//!   polypus-prove diff [N] [JOBS] [SEED]  differential test: Rust reference vs Noir circuit

use anyhow::{ensure, Result};
use ark_ff::{One, Zero};
use polypus_crypto::field::{from_u64, Fr};
use polypus_crypto::kernel::{KernelWitness, SpendInput};
use polypus_crypto::keys::SpendingKey;
use polypus_crypto::note::random_field;
use polypus_crypto::scenarios::{standard_scenarios, Ledger, TEST_MINT};
use polypus_prover::{public_witness_bytes, Toolchain};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn arg<T: std::str::FromStr>(i: usize, default: T) -> T {
    std::env::args().nth(i).and_then(|s| s.parse().ok()).unwrap_or(default)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

fn scenarios(tc: &Toolchain) -> Result<()> {
    for s in standard_scenarios() {
        let p = tc.prove(&s.witness)?;
        ensure!(p.public_witness == public_witness_bytes(&s.witness.pi_hash), "public witness != Rust pi_hash");
        ensure!(tc.verify(&p)?, "proof for {} did not verify", s.name);
        println!(
            "{:<18} proof={}B witness_gen={:.0}ms prove={:.0}ms verified=ok pi_hash={}",
            s.name,
            p.proof.len(),
            ms(p.timings.witness_gen),
            ms(p.timings.prove),
            polypus_crypto::field::to_hex(&s.witness.pi_hash)
        );
    }
    Ok(())
}

fn tamper(tc: &Toolchain) -> Result<()> {
    let s = &standard_scenarios()[3];
    let good = tc.prove(&s.witness)?;
    ensure!(tc.verify(&good)?, "honest proof must verify");
    // Public input changed (e.g. a relayer edits the recipient → different pi_hash).
    let mut bad = good.clone();
    bad.public_witness = public_witness_bytes(&(s.witness.pi_hash + Fr::one()));
    ensure!(!tc.verify(&bad)?, "proof verified against a different public input");
    println!("tamper: mutated public input rejected");
    // Proof bytes corrupted at A, B, C, commitment and PoK.
    for off in [10usize, 100, 200, 270, 340] {
        let mut bad = good.clone();
        bad.proof[off] ^= 1;
        ensure!(!tc.verify(&bad)?, "corrupted proof (byte {off}) verified");
    }
    println!("tamper: corrupted proof bytes rejected (A, B, C, commitment, PoK)");
    // A proof for one action cannot be used for another action's public input.
    let other = &standard_scenarios()[1];
    let mut swapped = good.clone();
    swapped.public_witness = public_witness_bytes(&other.witness.pi_hash);
    ensure!(!tc.verify(&swapped)?, "proof verified for another action");
    println!("tamper: proof replayed against another action's pi_hash rejected");
    Ok(())
}

fn bench(tc: &Toolchain, n: usize) -> Result<()> {
    let s = &standard_scenarios()[2];
    let (mut wg, mut pr) = (Vec::new(), Vec::new());
    for _ in 0..n {
        let p = tc.prove(&s.witness)?;
        wg.push(ms(p.timings.witness_gen));
        pr.push(ms(p.timings.prove));
    }
    let stat = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (v[0], v[v.len() / 2], v[v.len() - 1])
    };
    let (a, b, c) = stat(&mut wg);
    let (d, e, f) = stat(&mut pr);
    println!("bench n={n} (transfer_2in_fee, wall-clock incl. process start + key load)");
    println!("  nargo execute (witness): min {a:.0} ms, median {b:.0} ms, max {c:.0} ms");
    println!("  sunspot prove (Groth16): min {d:.0} ms, median {e:.0} ms, max {f:.0} ms");
    Ok(())
}

/// A random valid action plus (half the time) one random mutation.
fn random_case(seed: u64) -> (KernelWitness, String) {
    let mut rng = StdRng::seed_from_u64(seed);
    let alice = SpendingKey::from_seed(rng.gen());
    let bob = SpendingKey::from_seed(rng.gen());
    let mut l = Ledger::new(seed, TEST_MINT, rng.gen(), rng.gen());
    let mut spendable = Vec::new();
    for _ in 0..rng.gen_range(1..=3) {
        let a = rng.gen_range(0..1_000_000u64);
        let n = l.note(a, alice.address(0).owner);
        let z = l.note(0, alice.address(0).owner);
        let ext = l.ext(a as i64, 0, [3; 32], [0; 32], [b"a", b"b"]);
        let (_, idx) = l.act(&alice, [None, None], [n, z], &ext);
        spendable.push(SpendInput { note: n, d: alice.diversifier(0), leaf_index: idx[0] });
    }
    let n_real = rng.gen_range(0..=2.min(spendable.len()));
    let mut ins: [Option<SpendInput>; 2] = [None, None];
    let mut sum_in = 0i128;
    for slot in ins.iter_mut().take(n_real) {
        let s = spendable.remove(rng.gen_range(0..spendable.len()));
        sum_in += s.note.amount as i128;
        *slot = Some(s);
    }
    if rng.gen_bool(0.5) {
        ins.swap(0, 1);
    }
    let fee = if rng.gen_bool(0.5) { rng.gen_range(0..50u64) } else { 0 };
    let ext_amount = rng.gen_range(-(sum_in as i64)..=1000);
    let total = sum_in + ext_amount as i128 - fee as i128;
    let (ext_amount, fee) = if total < 0 { (fee as i64, fee) } else { (ext_amount, fee) };
    let total = (sum_in + ext_amount as i128 - fee as i128) as u64;
    let o0 = rng.gen_range(0..=total);
    let outs = [l.note(o0, bob.address(rng.gen_range(0..3)).owner), l.note(total - o0, alice.address(1).owner)];
    let ext = l.ext(ext_amount, fee, [5; 32], if fee > 0 { [6; 32] } else { [0; 32] }, [b"x", b"y"]);
    let (mut w, _) = l.act(&alice, ins, outs, &ext);
    if rng.gen_bool(0.5) {
        return (w, "honest".into());
    }
    let delta = match rng.gen_range(0..6) {
        0 => Fr::one(),
        1 => -Fr::one(),
        2 => from_u64(u64::MAX) + Fr::one(),
        3 => from_u64(1 << 26),
        4 => random_field(&mut rng),
        _ => Fr::zero(),
    };
    let set_zero = delta.is_zero();
    let loc = rng.gen_range(0..43usize);
    let i = rng.gen_range(0..26usize);
    let p = &mut w.public;
    let target: &mut Fr = match loc {
        0 => &mut w.pi_hash,
        1 => &mut p.root,
        2 | 3 => &mut p.nf[loc - 2],
        4 | 5 => &mut p.cm_out[loc - 4],
        6 => &mut p.public_amount,
        7 => &mut p.public_asset_id,
        8 => &mut p.ext_data_hash,
        9 => &mut p.program_id,
        10 => &mut p.program_io_hash,
        11 => &mut w.ask,
        12 => &mut w.nk,
        13 => &mut w.asset_id,
        14..=29 => {
            let inp = &mut w.inputs[(loc - 14) / 8];
            match (loc - 14) % 8 {
                0 => &mut inp.amount,
                1 => &mut inp.d,
                2 => &mut inp.lock_program,
                3 => &mut inp.lock_data,
                4 => &mut inp.escape,
                5 => &mut inp.rseed,
                6 => &mut inp.leaf_index,
                _ => &mut inp.path[i],
            }
        }
        30..=41 => {
            let o = &mut w.outputs[(loc - 30) / 6];
            match (loc - 30) % 6 {
                0 => &mut o.amount,
                1 => &mut o.owner,
                2 => &mut o.lock_program,
                3 => &mut o.lock_data,
                4 => &mut o.escape,
                _ => &mut o.rseed,
            }
        }
        _ => &mut w.program_params_hash,
    };
    if set_zero {
        *target = Fr::zero();
    } else {
        *target += delta;
    }
    let recompute = rng.gen_bool(0.5);
    if recompute {
        w.recompute_public();
    }
    (w, format!("mutate loc={loc} recompute={recompute}"))
}

fn diff(tc: &Toolchain, n: usize, jobs: usize, seed: u64) -> Result<()> {
    let next = Arc::new(AtomicUsize::new(0));
    let stats = Arc::new(Mutex::new((0usize, 0usize, 0usize, Vec::<String>::new())));
    let t0 = Instant::now();
    // nargo locks its workspace, so each worker gets a private copy of circuits/.
    let mut workers = Vec::new();
    for j in 0..jobs {
        let dir = tc.artifacts_dir.join("tmp").join(format!("diff-worker-{j}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let st = std::process::Command::new("cp").arg("-r").arg(&tc.circuits_dir).arg(&dir).status()?;
        ensure!(st.success(), "copying circuits/");
        let mut t = tc.clone();
        t.circuits_dir = dir.join("circuits");
        workers.push(t);
    }
    let handles: Vec<_> = workers
        .into_iter()
        .map(|tc| {
            let (next, stats) = (next.clone(), stats.clone());
            std::thread::spawn(move || loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                if k >= n {
                    break;
                }
                let (w, what) = random_case(seed.wrapping_add(k as u64));
                let rust_ok = w.check().is_ok();
                let noir_ok = tc.circuit_accepts(&w).expect("nargo");
                let mut s = stats.lock().unwrap();
                if rust_ok {
                    s.0 += 1;
                } else {
                    s.1 += 1;
                }
                if rust_ok != noir_ok {
                    s.2 += 1;
                    s.3.push(format!("case {k} ({what}): rust={rust_ok} noir={noir_ok} err={:?}", w.check()));
                }
                let done = s.0 + s.1;
                if done % 500 == 0 {
                    eprintln!("  {done}/{n} cases, {} mismatches, {:.0}s", s.2, t0.elapsed().as_secs_f64());
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let s = stats.lock().unwrap();
    println!(
        "diff: {} cases (seed {seed}): {} accepted, {} rejected by the Rust reference; {} mismatches with the Noir circuit; {:.0}s",
        n,
        s.0,
        s.1,
        s.2,
        t0.elapsed().as_secs_f64()
    );
    for m in s.3.iter().take(20) {
        println!("  MISMATCH {m}");
    }
    ensure!(s.2 == 0, "Rust reference and Noir circuit disagree");
    Ok(())
}

fn main() -> Result<()> {
    let tc = Toolchain::default_for_repo();
    match std::env::args().nth(1).as_deref() {
        Some("scenarios") => scenarios(&tc),
        Some("tamper") => tamper(&tc),
        Some("bench") => bench(&tc, arg(2, 10)),
        Some("diff") => diff(&tc, arg(2, 1000), arg(3, 8), arg(4, 1)),
        _ => {
            eprintln!("usage: polypus-prove scenarios | tamper | bench [N] | diff [N] [JOBS] [SEED]");
            std::process::exit(2);
        }
    }
}
