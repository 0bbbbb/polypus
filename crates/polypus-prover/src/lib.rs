//! Proving pipeline glue (DEV ONLY): kernel witness → `nargo execute` (ACVM
//! witness generation) → `sunspot prove` (gnark Groth16 over BN254) →
//! `sunspot verify`.
//!
//! The proving/verifying keys come from `scripts/dev-setup.sh`, an INSECURE
//! single-party setup (the toxic waste is not destroyed in any verifiable way).
//! Proofs made with these keys are worthless outside local testing.

use anyhow::{bail, Context, Result};
use polypus_crypto::kernel::KernelWitness;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Sunspot proof file layout for the kernel VK (one BSB22 commitment):
/// A (64) ‖ B (128) ‖ C (64) ‖ n_commitments u32 BE ‖ commitment (64) ‖ PoK (64).
pub const KERNEL_PROOF_LEN: usize = 388;

#[derive(Clone, Debug)]
pub struct Toolchain {
    pub nargo: PathBuf,
    pub sunspot: PathBuf,
    /// `circuits/` (the Noir workspace).
    pub circuits_dir: PathBuf,
    /// Directory holding kernel.json, kernel.ccs, kernel.pk, kernel.vk.
    pub artifacts_dir: PathBuf,
}

fn which(name: &str, extra: &[&str]) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    for dir in extra {
        let p = Path::new(&home).join(dir).join(name);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(name)
}

impl Toolchain {
    /// Locate tools (env `NARGO`/`SUNSPOT` override) relative to the repo root.
    pub fn from_repo_root(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref();
        Toolchain {
            nargo: std::env::var_os("NARGO").map(PathBuf::from).unwrap_or_else(|| which("nargo", &[".nargo/bin"])),
            sunspot: std::env::var_os("SUNSPOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| which("sunspot", &[".local/bin", "go/bin"])),
            circuits_dir: root.join("circuits"),
            artifacts_dir: std::env::var_os("POLYPUS_ARTIFACTS")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join("artifacts/dev")),
        }
    }

    /// Repo root = two levels above this crate's manifest.
    pub fn default_for_repo() -> Self {
        Self::from_repo_root(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
    }

    fn artifact(&self, name: &str) -> PathBuf {
        self.artifacts_dir.join(name)
    }
}

#[derive(Clone, Debug)]
pub struct Proof {
    /// gnark proof bytes as written by `sunspot prove`.
    pub proof: Vec<u8>,
    /// gnark public witness (12-byte header ‖ pi_hash).
    pub public_witness: Vec<u8>,
    pub timings: Timings,
}

#[derive(Clone, Debug, Default)]
pub struct Timings {
    pub witness_gen: Duration,
    pub prove: Duration,
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    format!("{tag}_{}_{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn run(cmd: &mut Command) -> Result<std::process::Output> {
    let out = cmd.output().with_context(|| format!("spawning {cmd:?}"))?;
    Ok(out)
}

impl Toolchain {
    /// Generate the ACVM witness for `w` with `nargo execute`. Returns the path
    /// of the `.gz` witness, or an error if the circuit rejects the witness.
    pub fn execute(&self, w: &KernelWitness) -> Result<PathBuf> {
        let name = unique("w");
        let tmp = self.circuits_dir.join("kernel/.tmp");
        std::fs::create_dir_all(&tmp)?;
        let toml = tmp.join(format!("{name}.toml"));
        std::fs::write(&toml, w.to_prover_toml())?;
        let out = run(Command::new(&self.nargo)
            .current_dir(&self.circuits_dir)
            .args(["execute", "--package", "kernel", "--silence-warnings", "--prover-name"])
            .arg(format!(".tmp/{name}"))
            .arg(&name));
        let _ = std::fs::remove_file(&toml);
        let out = out?;
        if !out.status.success() {
            bail!("nargo execute rejected the witness: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(self.circuits_dir.join("target").join(format!("{name}.gz")))
    }

    /// Whether the circuit accepts `w` (ACVM witness solving succeeds).
    pub fn circuit_accepts(&self, w: &KernelWitness) -> Result<bool> {
        match self.execute(w) {
            Ok(p) => {
                let _ = std::fs::remove_file(p);
                Ok(true)
            }
            Err(e) if e.to_string().contains("rejected the witness") => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Full proof: witness generation + Groth16 proving.
    pub fn prove(&self, w: &KernelWitness) -> Result<Proof> {
        for f in ["kernel.json", "kernel.ccs", "kernel.pk"] {
            if !self.artifact(f).exists() {
                bail!("missing {} — run scripts/dev-setup.sh first", self.artifact(f).display());
            }
        }
        let t0 = Instant::now();
        let wit = self.execute(w)?;
        let witness_gen = t0.elapsed();

        // sunspot writes <acir-stem>.proof/.pw next to its inputs: use a private dir.
        let dir = self.artifacts_dir.join("tmp").join(unique("p"));
        std::fs::create_dir_all(&dir)?;
        for f in ["kernel.json", "kernel.ccs", "kernel.pk"] {
            std::os::unix::fs::symlink(std::fs::canonicalize(self.artifact(f))?, dir.join(f))?;
        }
        std::fs::rename(&wit, dir.join("kernel.gz")).or_else(|_| std::fs::copy(&wit, dir.join("kernel.gz")).map(|_| ()))?;
        let t1 = Instant::now();
        let out = run(Command::new(&self.sunspot)
            .current_dir(&dir)
            .args(["prove", "kernel.json", "kernel.gz", "kernel.ccs", "kernel.pk"]))?;
        let prove = t1.elapsed();
        if !out.status.success() {
            bail!("sunspot prove failed: {}", String::from_utf8_lossy(&out.stderr));
        }
        let proof = std::fs::read(dir.join("kernel.proof"))?;
        let public_witness = std::fs::read(dir.join("kernel.pw"))?;
        let _ = std::fs::remove_dir_all(&dir);
        Ok(Proof { proof, public_witness, timings: Timings { witness_gen, prove } })
    }

    /// Off-chain verification with `sunspot verify` against the dev VK.
    pub fn verify(&self, proof: &Proof) -> Result<bool> {
        let dir = self.artifacts_dir.join("tmp").join(unique("v"));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("k.proof"), &proof.proof)?;
        std::fs::write(dir.join("k.pw"), &proof.public_witness)?;
        let out = run(Command::new(&self.sunspot)
            .current_dir(&dir)
            .arg("verify")
            .arg(std::fs::canonicalize(self.artifact("kernel.vk"))?)
            .args(["k.proof", "k.pw"]))?;
        let _ = std::fs::remove_dir_all(&dir);
        Ok(out.status.success())
    }
}

/// gnark public-witness encoding for a single public input:
/// u32 BE n_public ‖ u32 BE n_secret (0) ‖ u32 BE vector length ‖ 32-byte BE elements.
pub fn public_witness_bytes(pi_hash: &polypus_crypto::Fr) -> Vec<u8> {
    let mut v = Vec::with_capacity(44);
    v.extend_from_slice(&1u32.to_be_bytes());
    v.extend_from_slice(&0u32.to_be_bytes());
    v.extend_from_slice(&1u32.to_be_bytes());
    v.extend_from_slice(&polypus_crypto::field::to_bytes_be(pi_hash));
    v
}
