//! BN254 scalar field helpers. Spec §1.

use ark_ff::{BigInteger, PrimeField, Zero};
use thiserror::Error;

pub use ark_bn254::Fr;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FieldError {
    #[error("non-canonical field element (>= p)")]
    NonCanonical,
    #[error("expected 32 bytes, got {0}")]
    BadLength(usize),
    #[error("invalid hex")]
    BadHex,
}

/// Canonical 32-byte big-endian encoding.
pub fn to_bytes_be(x: &Fr) -> [u8; 32] {
    let v = x.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - v.len()..].copy_from_slice(&v);
    out
}

/// Parse a canonical 32-byte big-endian encoding; rejects values >= p.
pub fn from_bytes_be(b: &[u8; 32]) -> Result<Fr, FieldError> {
    let x = Fr::from_be_bytes_mod_order(b);
    if to_bytes_be(&x) != *b {
        return Err(FieldError::NonCanonical);
    }
    Ok(x)
}

pub fn from_slice_be(b: &[u8]) -> Result<Fr, FieldError> {
    let arr: [u8; 32] = b.try_into().map_err(|_| FieldError::BadLength(b.len()))?;
    from_bytes_be(&arr)
}

/// Big-endian integer of up to 31 bytes (always canonical).
pub fn from_short_be(b: &[u8]) -> Fr {
    assert!(b.len() <= 31, "from_short_be: at most 31 bytes");
    Fr::from_be_bytes_mod_order(b)
}

/// Domain tag: big-endian integer of the ASCII string (spec §2.1).
pub fn tag(s: &str) -> Fr {
    from_short_be(s.as_bytes())
}

/// Reduce a 64-byte string, as a big-endian integer, modulo p.
pub fn wide_reduce(b: &[u8; 64]) -> Fr {
    Fr::from_be_bytes_mod_order(b)
}

pub fn from_u64(v: u64) -> Fr {
    Fr::from(v)
}

/// Signed embedding: v >= 0 -> v, v < 0 -> p - |v|.
pub fn from_i128(v: i128) -> Fr {
    if v >= 0 {
        Fr::from(v as u128)
    } else {
        -Fr::from(v.unsigned_abs())
    }
}

/// Inverse of [`from_i128`] for values with |v| < 2^127; `None` otherwise.
pub fn to_i128(x: &Fr) -> Option<i128> {
    let small = |f: &Fr| -> Option<u128> {
        let b = to_bytes_be(f);
        if b[..16].iter().all(|&z| z == 0) {
            let v = u128::from_be_bytes(b[16..].try_into().unwrap());
            (v < (1u128 << 127)).then_some(v)
        } else {
            None
        }
    };
    if let Some(v) = small(x) {
        return Some(v as i128);
    }
    small(&-*x).map(|v| -(v as i128))
}

/// True iff x < 2^bits as an integer.
pub fn fits_bits(x: &Fr, bits: u32) -> bool {
    let n = x.into_bigint();
    n.num_bits() <= bits
}

pub fn is_zero(x: &Fr) -> bool {
    x.is_zero()
}

pub fn to_hex(x: &Fr) -> String {
    format!("0x{}", hex::encode(to_bytes_be(x)))
}

pub fn from_hex(s: &str) -> Result<Fr, FieldError> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let raw = hex::decode(s).map_err(|_| FieldError::BadHex)?;
    if raw.len() > 32 {
        return Err(FieldError::BadLength(raw.len()));
    }
    let mut b = [0u8; 32];
    b[32 - raw.len()..].copy_from_slice(&raw);
    from_bytes_be(&b)
}

/// Decimal string, the format nargo's Prover.toml accepts most robustly.
pub fn to_decimal(x: &Fr) -> String {
    x.into_bigint().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_canonical() {
        let x = from_u64(123456789);
        assert_eq!(from_bytes_be(&to_bytes_be(&x)).unwrap(), x);
        // p itself is non-canonical.
        let p = from_hex("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
        assert_eq!(p, Err(FieldError::NonCanonical));
        assert_eq!(from_bytes_be(&[0xff; 32]), Err(FieldError::NonCanonical));
    }

    #[test]
    fn signed_embedding() {
        for v in [0i128, 1, -1, 1 << 63, -(1 << 63), (1 << 64) - 1, -(1 << 64) + 1] {
            assert_eq!(to_i128(&from_i128(v)), Some(v));
        }
        assert_eq!(from_i128(-1) + from_u64(1), Fr::zero());
    }

    #[test]
    fn tags_match_spec() {
        assert_eq!(to_hex(&tag("polypus.note.v1")), format!("0x{:0>64}", "706f6c797075732e6e6f74652e7631"));
    }
}
