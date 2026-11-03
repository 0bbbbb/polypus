//! Notes, commitments and nullifiers (spec §4).

use crate::field::{from_short_be, from_u64, Fr};
use crate::hash::{poseidon, tags};
use ark_ff::Zero;
use rand::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const NOTE_VERSION_V1: u8 = 1;

/// `asset_id = H_3(T_ASSET, be(mint[0..16]), be(mint[16..32]))`.
pub fn asset_id(mint: &[u8; 32]) -> Fr {
    poseidon(&[tags::t_asset(), from_short_be(&mint[..16]), from_short_be(&mint[16..])])
}

/// `rcm = H_2(T_RCM, rseed)`.
pub fn rcm(rseed: &Fr) -> Fr {
    poseidon(&[tags::t_rcm(), *rseed])
}

/// `nf = H_4(T_NF, nk, cm, leaf_index)`.
pub fn nullifier(nk: &Fr, cm: &Fr, leaf_index: u64) -> Fr {
    poseidon(&[tags::t_nf(), *nk, *cm, from_u64(leaf_index)])
}

pub fn random_field<R: RngCore + CryptoRng>(rng: &mut R) -> Fr {
    let mut b = [0u8; 64];
    rng.fill_bytes(&mut b);
    crate::field::wide_reduce(&b)
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NoteError {
    #[error("unsupported note version {0}")]
    Version(u8),
    #[error("unlocked note must have lock_data = 0 and escape = 0")]
    NonCanonicalUnlocked,
    #[error("locked note must have a non-zero escape")]
    MissingEscape,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub version: u8,
    #[serde(with = "crate::serde_fr")]
    pub asset_id: Fr,
    pub amount: u64,
    #[serde(with = "crate::serde_fr")]
    pub owner: Fr,
    #[serde(with = "crate::serde_fr")]
    pub lock_program: Fr,
    #[serde(with = "crate::serde_fr")]
    pub lock_data: Fr,
    #[serde(with = "crate::serde_fr")]
    pub escape: Fr,
    #[serde(with = "crate::serde_fr")]
    pub rseed: Fr,
}

impl Note {
    /// A plain (unlocked) v1 note.
    pub fn plain(asset_id: Fr, amount: u64, owner: Fr, rseed: Fr) -> Self {
        Note {
            version: NOTE_VERSION_V1,
            asset_id,
            amount,
            owner,
            lock_program: Fr::zero(),
            lock_data: Fr::zero(),
            escape: Fr::zero(),
            rseed,
        }
    }

    pub fn random_plain<R: RngCore + CryptoRng>(rng: &mut R, asset_id: Fr, amount: u64, owner: Fr) -> Self {
        Self::plain(asset_id, amount, owner, random_field(rng))
    }

    /// Kernel v1 output well-formedness (spec §4).
    pub fn check_well_formed(&self) -> Result<(), NoteError> {
        if self.version != NOTE_VERSION_V1 {
            return Err(NoteError::Version(self.version));
        }
        if self.lock_program.is_zero() {
            if !self.lock_data.is_zero() || !self.escape.is_zero() {
                return Err(NoteError::NonCanonicalUnlocked);
            }
        } else if self.escape.is_zero() {
            return Err(NoteError::MissingEscape);
        }
        Ok(())
    }

    pub fn commitment(&self) -> Fr {
        assert_eq!(self.version, NOTE_VERSION_V1, "only note v1 is defined");
        poseidon(&[
            tags::t_note(),
            self.asset_id,
            from_u64(self.amount),
            self.owner,
            self.lock_program,
            self.lock_data,
            self.escape,
            rcm(&self.rseed),
        ])
    }
}
