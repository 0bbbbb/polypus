//! Native reference implementation of the kernel relation (spec §6.3).
//!
//! [`KernelWitness::check`] evaluates constraints K1..K12 in the same order as
//! `circuits/kernel`, over raw field values (so tests can feed out-of-range
//! values). The witness layout mirrors the Noir `main` parameters one-to-one, and
//! [`KernelWitness::to_prover_toml`] emits exactly that ABI.

use crate::ext_data::ExtData;
use crate::field::{fits_bits, from_u64, to_decimal, Fr};
use crate::hash::{poseidon, tags};
use crate::keys::{derive_ak, derive_owner, Diversifier, SpendingKey};
use crate::merkle::{root_from_path, MerkleTree, DEPTH};
use crate::note::{nullifier, random_field, rcm, Note};
use ark_ff::{BigInteger, PrimeField, Zero};
use rand::{CryptoRng, RngCore};
use thiserror::Error;

pub const N_IN: usize = 2;
pub const N_OUT: usize = 2;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum KernelError {
    #[error("K1: note amount out of 64-bit range")]
    AmountRange,
    #[error("K2: public_amount out of range")]
    PublicAmountRange,
    #[error("K4: leaf index of input {0} out of range")]
    LeafIndexRange(usize),
    #[error("K3/K4: input {0} not in tree under root (wrong path, key or note)")]
    Membership(usize),
    #[error("K5: nullifier {0} incorrect")]
    Nullifier(usize),
    #[error("K6: duplicate nullifiers")]
    DuplicateNullifier,
    #[error("K7: output {0} malformed")]
    OutputWellFormed(usize),
    #[error("K7: output commitment {0} incorrect")]
    OutputCommitment(usize),
    #[error("K8: value not conserved")]
    Conservation,
    #[error("K9: asset binding")]
    Asset,
    #[error("K10: input {0} is locked to another program")]
    Lock(usize),
    #[error("K11: program_io_hash")]
    ProgramIo,
    #[error("K12: pi_hash")]
    PiHash,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicValues {
    pub root: Fr,
    pub nf: [Fr; N_IN],
    pub cm_out: [Fr; N_OUT],
    pub public_amount: Fr,
    pub public_asset_id: Fr,
    pub ext_data_hash: Fr,
    pub program_id: Fr,
    pub program_io_hash: Fr,
}

impl PublicValues {
    /// The single Groth16 public input (spec §6.1).
    pub fn pi_hash(&self) -> Fr {
        poseidon(&[
            tags::t_pi(),
            self.root,
            self.nf[0],
            self.nf[1],
            self.cm_out[0],
            self.cm_out[1],
            self.public_amount,
            self.public_asset_id,
            self.ext_data_hash,
            self.program_id,
            self.program_io_hash,
        ])
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InWitness {
    pub amount: Fr,
    pub d: Fr,
    pub lock_program: Fr,
    pub lock_data: Fr,
    pub escape: Fr,
    pub rseed: Fr,
    pub leaf_index: Fr,
    pub path: [Fr; DEPTH],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutWitness {
    pub amount: Fr,
    pub owner: Fr,
    pub lock_program: Fr,
    pub lock_data: Fr,
    pub escape: Fr,
    pub rseed: Fr,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelWitness {
    pub pi_hash: Fr,
    pub public: PublicValues,
    pub ask: Fr,
    pub nk: Fr,
    pub asset_id: Fr,
    pub inputs: [InWitness; N_IN],
    pub outputs: [OutWitness; N_OUT],
    pub program_params_hash: Fr,
}

fn commit(asset_id: Fr, amount: Fr, owner: Fr, lp: Fr, ld: Fr, esc: Fr, rseed: Fr) -> Fr {
    poseidon(&[tags::t_note(), asset_id, amount, owner, lp, ld, esc, rcm(&rseed)])
}

fn le_index(x: &Fr) -> Option<u64> {
    fits_bits(x, DEPTH as u32).then(|| x.into_bigint().as_ref()[0])
}

impl KernelWitness {
    /// Evaluate K1..K12. `Ok(())` iff the circuit would accept this witness.
    pub fn check(&self) -> Result<(), KernelError> {
        let p = &self.public;
        // K1
        for a in self.inputs.iter().map(|i| &i.amount).chain(self.outputs.iter().map(|o| &o.amount)) {
            if !fits_bits(a, 64) {
                return Err(KernelError::AmountRange);
            }
        }
        // K2
        if !fits_bits(&(p.public_amount + from_u64(1 << 63) + from_u64(1 << 63)), 65) {
            return Err(KernelError::PublicAmountRange);
        }
        // K3, K4, K5
        let ak = derive_ak(&self.ask);
        let mut cm_in = [Fr::zero(); N_IN];
        for (i, inp) in self.inputs.iter().enumerate() {
            let idx = le_index(&inp.leaf_index).ok_or(KernelError::LeafIndexRange(i))?;
            let owner = poseidon(&[tags::t_owner(), ak, self.nk, inp.d]);
            cm_in[i] = commit(self.asset_id, inp.amount, owner, inp.lock_program, inp.lock_data, inp.escape, inp.rseed);
            if !inp.amount.is_zero() && root_from_path(&cm_in[i], idx, &inp.path) != p.root {
                return Err(KernelError::Membership(i));
            }
            if p.nf[i] != poseidon(&[tags::t_nf(), self.nk, cm_in[i], inp.leaf_index]) {
                return Err(KernelError::Nullifier(i));
            }
        }
        // K6
        if p.nf[0] == p.nf[1] {
            return Err(KernelError::DuplicateNullifier);
        }
        // K7
        for (j, o) in self.outputs.iter().enumerate() {
            let ok = if o.lock_program.is_zero() {
                o.lock_data.is_zero() && o.escape.is_zero()
            } else {
                !o.escape.is_zero()
            };
            if !ok {
                return Err(KernelError::OutputWellFormed(j));
            }
            if p.cm_out[j] != commit(self.asset_id, o.amount, o.owner, o.lock_program, o.lock_data, o.escape, o.rseed) {
                return Err(KernelError::OutputCommitment(j));
            }
        }
        // K8
        let sum_in = self.inputs.iter().fold(p.public_amount, |s, i| s + i.amount);
        let sum_out = self.outputs.iter().fold(Fr::zero(), |s, o| s + o.amount);
        if sum_in != sum_out {
            return Err(KernelError::Conservation);
        }
        // K9
        if !p.public_asset_id.is_zero() && self.asset_id != p.public_asset_id {
            return Err(KernelError::Asset);
        }
        if !p.public_amount.is_zero() && p.public_asset_id.is_zero() {
            return Err(KernelError::Asset);
        }
        // K10
        for (i, inp) in self.inputs.iter().enumerate() {
            if !inp.lock_program.is_zero() && inp.lock_program != p.program_id {
                return Err(KernelError::Lock(i));
            }
        }
        // K11
        let io_ok = if p.program_id.is_zero() {
            p.program_io_hash.is_zero()
        } else {
            p.program_io_hash
                == poseidon(&[
                    tags::t_io(),
                    p.program_id,
                    p.nf[0],
                    p.nf[1],
                    p.cm_out[0],
                    p.cm_out[1],
                    self.program_params_hash,
                ])
        };
        if !io_ok {
            return Err(KernelError::ProgramIo);
        }
        // K12
        if self.pi_hash != p.pi_hash() {
            return Err(KernelError::PiHash);
        }
        Ok(())
    }

    /// Recompute every derived public value (nf, cm_out, io hash, pi_hash) from
    /// the private witness. Used by tests to build "consistent but malicious"
    /// witnesses, i.e. ones that only a missing constraint would accept.
    pub fn recompute_public(&mut self) {
        let ak = derive_ak(&self.ask);
        for (i, inp) in self.inputs.iter().enumerate() {
            let owner = poseidon(&[tags::t_owner(), ak, self.nk, inp.d]);
            let cm = commit(self.asset_id, inp.amount, owner, inp.lock_program, inp.lock_data, inp.escape, inp.rseed);
            self.public.nf[i] = poseidon(&[tags::t_nf(), self.nk, cm, inp.leaf_index]);
        }
        for (j, o) in self.outputs.iter().enumerate() {
            self.public.cm_out[j] =
                commit(self.asset_id, o.amount, o.owner, o.lock_program, o.lock_data, o.escape, o.rseed);
        }
        if !self.public.program_id.is_zero() {
            let p = &self.public;
            self.public.program_io_hash = poseidon(&[
                tags::t_io(),
                p.program_id,
                p.nf[0],
                p.nf[1],
                p.cm_out[0],
                p.cm_out[1],
                self.program_params_hash,
            ]);
        }
        self.pi_hash = self.public.pi_hash();
    }

    /// Prover.toml for `circuits/kernel` (Noir ABI: decimal strings).
    pub fn to_prover_toml(&self) -> String {
        let f = |x: &Fr| format!("\"{}\"", to_decimal(x));
        let arr = |xs: &mut dyn Iterator<Item = Fr>| format!("[{}]", xs.map(|x| f(&x)).collect::<Vec<_>>().join(", "));
        let p = &self.public;
        let mut s = String::new();
        let mut kv = |k: &str, v: String| s.push_str(&format!("{k} = {v}\n"));
        kv("pi_hash", f(&self.pi_hash));
        kv("root", f(&p.root));
        kv("nf", arr(&mut p.nf.iter().copied()));
        kv("cm_out", arr(&mut p.cm_out.iter().copied()));
        kv("public_amount", f(&p.public_amount));
        kv("public_asset_id", f(&p.public_asset_id));
        kv("ext_data_hash", f(&p.ext_data_hash));
        kv("program_id", f(&p.program_id));
        kv("program_io_hash", f(&p.program_io_hash));
        kv("ask", f(&self.ask));
        kv("nk", f(&self.nk));
        kv("asset_id", f(&self.asset_id));
        let ins = &self.inputs;
        kv("in_amount", arr(&mut ins.iter().map(|i| i.amount)));
        kv("in_d", arr(&mut ins.iter().map(|i| i.d)));
        kv("in_lock_program", arr(&mut ins.iter().map(|i| i.lock_program)));
        kv("in_lock_data", arr(&mut ins.iter().map(|i| i.lock_data)));
        kv("in_escape", arr(&mut ins.iter().map(|i| i.escape)));
        kv("in_rseed", arr(&mut ins.iter().map(|i| i.rseed)));
        kv("in_leaf_index", arr(&mut ins.iter().map(|i| i.leaf_index)));
        kv(
            "in_path",
            format!("[{}]", ins.iter().map(|i| arr(&mut i.path.iter().copied())).collect::<Vec<_>>().join(", ")),
        );
        let outs = &self.outputs;
        kv("out_amount", arr(&mut outs.iter().map(|o| o.amount)));
        kv("out_owner", arr(&mut outs.iter().map(|o| o.owner)));
        kv("out_lock_program", arr(&mut outs.iter().map(|o| o.lock_program)));
        kv("out_lock_data", arr(&mut outs.iter().map(|o| o.lock_data)));
        kv("out_escape", arr(&mut outs.iter().map(|o| o.escape)));
        kv("out_rseed", arr(&mut outs.iter().map(|o| o.rseed)));
        kv("program_params_hash", f(&self.program_params_hash));
        s
    }
}

/// An existing note the prover wants to spend.
#[derive(Clone, Debug)]
pub struct SpendInput {
    pub note: Note,
    pub d: Diversifier,
    pub leaf_index: u64,
}

/// Build an honest program-0 witness. `None` inputs become zero-value dummies
/// owned by `sk`'s diversifier 0. Panics if the inputs are not `sk`'s or are
/// not in `tree` (caller bug, not a soundness property).
pub fn build_action<R: RngCore + CryptoRng>(
    rng: &mut R,
    sk: &SpendingKey,
    tree: &MerkleTree,
    asset_id: Fr,
    inputs: [Option<SpendInput>; N_IN],
    outputs: [Note; N_OUT],
    ext: &ExtData,
) -> KernelWitness {
    let fvk = sk.full_viewing_key();
    let d0 = sk.diversifier(0);
    let inputs: Vec<InWitness> = inputs
        .into_iter()
        .map(|inp| match inp {
            Some(s) => {
                assert_eq!(s.note.owner, derive_owner(&fvk.ak, &fvk.nk, &s.d), "input not owned by sk");
                assert_eq!(s.note.asset_id, asset_id, "single-asset action");
                assert_eq!(tree.leaf(s.leaf_index), Some(s.note.commitment()), "input not in tree");
                InWitness {
                    amount: from_u64(s.note.amount),
                    d: s.d.to_field(),
                    lock_program: s.note.lock_program,
                    lock_data: s.note.lock_data,
                    escape: s.note.escape,
                    rseed: s.note.rseed,
                    leaf_index: from_u64(s.leaf_index),
                    path: tree.path(s.leaf_index).expect("path"),
                }
            }
            None => InWitness {
                amount: Fr::zero(),
                d: d0.to_field(),
                lock_program: Fr::zero(),
                lock_data: Fr::zero(),
                escape: Fr::zero(),
                rseed: random_field(rng),
                leaf_index: Fr::zero(),
                path: [Fr::zero(); DEPTH],
            },
        })
        .collect();
    let outputs: Vec<OutWitness> = outputs
        .iter()
        .map(|n| {
            assert_eq!(n.asset_id, asset_id, "single-asset action");
            OutWitness {
                amount: from_u64(n.amount),
                owner: n.owner,
                lock_program: n.lock_program,
                lock_data: n.lock_data,
                escape: n.escape,
                rseed: n.rseed,
            }
        })
        .collect();
    let mut w = KernelWitness {
        pi_hash: Fr::zero(),
        public: PublicValues {
            root: tree.root(),
            nf: [Fr::zero(); N_IN],
            cm_out: [Fr::zero(); N_OUT],
            public_amount: ext.public_amount(),
            public_asset_id: if ext.moves_tokens() { asset_id } else { Fr::zero() },
            ext_data_hash: ext.hash(),
            program_id: Fr::zero(),
            program_io_hash: Fr::zero(),
        },
        ask: sk.ask(),
        nk: sk.nk(),
        asset_id,
        inputs: inputs.try_into().unwrap(),
        outputs: outputs.try_into().unwrap(),
        program_params_hash: Fr::zero(),
    };
    w.recompute_public();
    w
}

/// Commitment of output `j` (for tree bookkeeping by the caller).
pub fn output_leaf(w: &KernelWitness, j: usize) -> Fr {
    w.public.cm_out[j]
}

/// Nullifier the wallet expects for a note it owns.
pub fn expected_nullifier(sk: &SpendingKey, note: &Note, leaf_index: u64) -> Fr {
    nullifier(&sk.nk(), &note.commitment(), leaf_index)
}

/// Little-endian bits helper exposed for tests.
pub fn index_bits(x: &Fr) -> Vec<bool> {
    x.into_bigint().to_bits_le()
}
