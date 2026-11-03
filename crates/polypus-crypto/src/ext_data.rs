//! External-data binding (spec §7): everything a relayer could tamper with is
//! hashed into `ext_data_hash`, a kernel public value.

use crate::field::{from_bytes_be, from_i128, Fr};
use sha2::{Digest, Sha256};

pub const EXT_DOMAIN: &[u8; 14] = b"polypus.ext.v1";
/// Pool-enforced bound on |ext_amount| and fee.
pub const MAX_EXT_MAGNITUDE: u64 = 1 << 62;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExtData {
    /// Pool state PDA address.
    pub pool_id: [u8; 32],
    /// Per-cluster constant stored in the pool at init.
    pub chain_domain: [u8; 32],
    /// Depositor source / withdrawal destination token account (zero if none).
    pub public_account: [u8; 32],
    /// Relayer fee token account (zero if fee = 0).
    pub relayer: [u8; 32],
    /// > 0 deposit, < 0 withdraw, 0 internal transfer.
    pub ext_amount: i64,
    pub fee: u64,
    pub not_before_slot: u64,
    /// SHA-256 of the two output-note ciphertexts.
    pub ct_hash: [[u8; 32]; 2],
}

impl ExtData {
    pub fn bytes(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(14 + 32 * 6 + 24);
        v.extend_from_slice(EXT_DOMAIN);
        v.extend_from_slice(&self.pool_id);
        v.extend_from_slice(&self.chain_domain);
        v.extend_from_slice(&self.public_account);
        v.extend_from_slice(&self.relayer);
        v.extend_from_slice(&self.ext_amount.to_le_bytes());
        v.extend_from_slice(&self.fee.to_le_bytes());
        v.extend_from_slice(&self.not_before_slot.to_le_bytes());
        v.extend_from_slice(&self.ct_hash[0]);
        v.extend_from_slice(&self.ct_hash[1]);
        v
    }

    /// SHA-256 with the first byte zeroed, read as a big-endian field element.
    pub fn hash(&self) -> Fr {
        let mut h: [u8; 32] = Sha256::digest(self.bytes()).into();
        h[0] = 0;
        from_bytes_be(&h).expect("248-bit value is canonical")
    }

    /// Whether the pool would accept these magnitudes.
    pub fn magnitudes_ok(&self) -> bool {
        self.ext_amount.unsigned_abs() < MAX_EXT_MAGNITUDE && self.fee < MAX_EXT_MAGNITUDE
    }

    /// `public_amount = ext_amount − fee` as a field element.
    pub fn public_amount(&self) -> Fr {
        from_i128(self.ext_amount as i128 - self.fee as i128)
    }

    /// Whether tokens move (so the pool reveals the asset id).
    pub fn moves_tokens(&self) -> bool {
        self.ext_amount != 0 || self.fee != 0
    }
}

pub fn ciphertext_hash(ct: &[u8]) -> [u8; 32] {
    Sha256::digest(ct).into()
}
