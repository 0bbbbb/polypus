// Vendored from Reilabs gnark-verifier-solana (Apache-2.0), see NOTICE.
#![warn(missing_docs)]
//! Groth16 verifier for gnark / Sunspot proofs (including BSB22 commitments)
//! on Solana, using the alt_bn128 syscalls.
//!
//! Vendored from Reilabs' `gnark-verifier-solana` (Apache-2.0); see NOTICE for
//! the list of Polypus modifications.
mod commitments;
mod error;
mod hash;
mod proof;
mod syscalls;
mod verifier;
#[cfg(test)]
mod verifier_test;
mod vk;
mod witness;

pub use error::GnarkError;
pub use proof::GnarkProof;
pub use verifier::{is_canonical_fr, GnarkVerifier, FR_MODULUS_BE};
pub use vk::{generate_key_file, parse_vk, GnarkVerifyingkey};
pub use witness::GnarkWitness;
