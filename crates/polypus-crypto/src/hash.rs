//! Poseidon (BN254, circomlib parameters) and the protocol's domain-separated
//! hashes. Spec §2. `light-poseidon` is the same implementation `sol_poseidon`
//! uses, so these outputs are what the pool computes on-chain.

use crate::field::{tag, Fr};
use light_poseidon::{Poseidon, PoseidonHasher};
use std::sync::OnceLock;

/// Largest arity `sol_poseidon` accepts.
pub const MAX_ONCHAIN_INPUTS: usize = 12;

/// circomlib Poseidon with `inputs.len()` inputs (1..=12).
pub fn poseidon(inputs: &[Fr]) -> Fr {
    assert!(
        (1..=MAX_ONCHAIN_INPUTS).contains(&inputs.len()),
        "poseidon arity {} unsupported",
        inputs.len()
    );
    let mut h = Poseidon::<Fr>::new_circom(inputs.len()).expect("circom params");
    h.hash(inputs).expect("poseidon hash")
}

macro_rules! tags {
    ($($name:ident = $s:literal;)*) => {
        $(pub fn $name() -> Fr {
            static V: OnceLock<Fr> = OnceLock::new();
            *V.get_or_init(|| tag($s))
        })*
        /// (name, string) pairs, for test vectors.
        pub const ALL_TAGS: &[(&str, &str)] = &[$((stringify!($name), $s)),*];
    };
}

pub mod tags {
    use super::*;
    tags! {
        t_ak = "polypus.ak.v1";
        t_owner = "polypus.owner.v1";
        t_rcm = "polypus.rcm.v1";
        t_note = "polypus.note.v1";
        t_nf = "polypus.nf.v1";
        t_asset = "polypus.asset.v1";
        t_io = "polypus.io.v1";
        t_pi = "polypus.pi.v1";
    }
}

/// Merkle node: untagged H_2(left, right).
pub fn merkle_node(l: &Fr, r: &Fr) -> Fr {
    poseidon(&[*l, *r])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{from_hex, from_u64};

    #[test]
    fn circomlib_known_answer() {
        assert_eq!(
            poseidon(&[from_u64(1), from_u64(2)]),
            from_hex("0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a").unwrap()
        );
    }

    #[test]
    fn all_onchain_arities_work() {
        for n in 1..=MAX_ONCHAIN_INPUTS {
            let v: Vec<Fr> = (0..n as u64).map(from_u64).collect();
            poseidon(&v);
        }
    }
}
