//! # polypus-crypto — native reference implementation (UNAUDITED)
//!
//! Single source of truth for test vectors shared by the Noir circuits and the
//! Solana pool program. Implements `spec/SPEC.md`; any divergence is a bug.
//! Not reviewed by a cryptographer. Do not use with real funds.

pub mod address;
pub mod ext_data;
pub mod field;
pub mod hash;
pub mod kernel;
pub mod keys;
pub mod merkle;
pub mod note;

pub use field::Fr;

/// serde helper: field elements as 0x-prefixed 32-byte big-endian hex.
pub mod serde_fr {
    use crate::field::{from_hex, to_hex, Fr};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(x: &Fr, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&to_hex(x))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Fr, D::Error> {
        let s = String::deserialize(d)?;
        from_hex(&s).map_err(serde::de::Error::custom)
    }
}
