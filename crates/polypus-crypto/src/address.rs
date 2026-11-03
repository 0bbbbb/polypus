//! String encodings (spec §3.2, §3.3): `poly1…`, `polyview1…`, `polyivk1…`
//! (bech32m) and the display-only `cm_`/`nf_`/`ct_` typed base58 values.

use crate::field::{from_slice_be, to_bytes_be, Fr};
use crate::keys::{Address, Diversifier, FullViewingKey, IncomingViewingKey, DIVERSIFIER_LEN};
use bech32::primitives::decode::CheckedHrpstring;
use bech32::{Bech32m, Hrp};
use thiserror::Error;

pub const HRP_ADDRESS: &str = "poly";
pub const HRP_FVK: &str = "polyview";
pub const HRP_IVK: &str = "polyivk";
pub const FORMAT_V1: u8 = 0x01;

pub const ADDRESS_PAYLOAD_LEN: usize = 1 + DIVERSIFIER_LEN + 32 + 32;
pub const FVK_PAYLOAD_LEN: usize = 1 + 32 * 3;
pub const IVK_PAYLOAD_LEN: usize = 1 + 32;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AddressError {
    #[error("bech32m decode error: {0}")]
    Bech32(String),
    #[error("wrong human-readable part: expected {expected}, got {got}")]
    WrongHrp { expected: &'static str, got: String },
    #[error("unsupported format version {0}")]
    Version(u8),
    #[error("wrong payload length {0}")]
    Length(usize),
    #[error("non-canonical field element in payload")]
    NonCanonical,
}

fn encode(hrp: &str, payload: &[u8]) -> String {
    let hrp = Hrp::parse(hrp).expect("static hrp");
    bech32::encode::<Bech32m>(hrp, payload).expect("bech32m encode")
}

/// Strict bech32m decode (rejects bech32 checksums), any length.
fn decode(s: &str, hrp: &'static str, len: usize) -> Result<Vec<u8>, AddressError> {
    let checked = CheckedHrpstring::new::<Bech32m>(s).map_err(|e| AddressError::Bech32(e.to_string()))?;
    let got = checked.hrp().to_lowercase();
    if got != hrp {
        return Err(AddressError::WrongHrp { expected: hrp, got });
    }
    let data: Vec<u8> = checked.byte_iter().collect();
    if data.len() != len {
        return Err(AddressError::Length(data.len()));
    }
    if data[0] != FORMAT_V1 {
        return Err(AddressError::Version(data[0]));
    }
    Ok(data)
}

fn field_at(data: &[u8], off: usize) -> Result<Fr, AddressError> {
    from_slice_be(&data[off..off + 32]).map_err(|_| AddressError::NonCanonical)
}

impl Address {
    pub fn to_bytes(&self) -> [u8; ADDRESS_PAYLOAD_LEN] {
        let mut out = [0u8; ADDRESS_PAYLOAD_LEN];
        out[0] = FORMAT_V1;
        out[1..12].copy_from_slice(&self.d.0);
        out[12..44].copy_from_slice(&self.pk_d);
        out[44..76].copy_from_slice(&to_bytes_be(&self.owner));
        out
    }

    pub fn encode(&self) -> String {
        encode(HRP_ADDRESS, &self.to_bytes())
    }

    pub fn decode(s: &str) -> Result<Self, AddressError> {
        let data = decode(s, HRP_ADDRESS, ADDRESS_PAYLOAD_LEN)?;
        Ok(Address {
            d: Diversifier(data[1..12].try_into().unwrap()),
            pk_d: data[12..44].try_into().unwrap(),
            owner: field_at(&data, 44)?,
        })
    }
}

impl FullViewingKey {
    pub fn encode(&self) -> String {
        let mut p = Vec::with_capacity(FVK_PAYLOAD_LEN);
        p.push(FORMAT_V1);
        p.extend_from_slice(&to_bytes_be(&self.ak));
        p.extend_from_slice(&to_bytes_be(&self.nk));
        p.extend_from_slice(&self.ivk);
        encode(HRP_FVK, &p)
    }

    pub fn decode(s: &str) -> Result<Self, AddressError> {
        let data = decode(s, HRP_FVK, FVK_PAYLOAD_LEN)?;
        Ok(FullViewingKey {
            ak: field_at(&data, 1)?,
            nk: field_at(&data, 33)?,
            ivk: data[65..97].try_into().unwrap(),
        })
    }
}

impl IncomingViewingKey {
    pub fn encode(&self) -> String {
        let mut p = vec![FORMAT_V1];
        p.extend_from_slice(&self.ivk);
        encode(HRP_IVK, &p)
    }

    pub fn decode(s: &str) -> Result<Self, AddressError> {
        let data = decode(s, HRP_IVK, IVK_PAYLOAD_LEN)?;
        Ok(IncomingViewingKey { ivk: data[1..33].try_into().unwrap() })
    }
}

/// Display-only typed value kinds (spec §3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Typed {
    Commitment,
    Nullifier,
    Ciphertext,
}

impl Typed {
    pub fn prefix(self) -> &'static str {
        match self {
            Typed::Commitment => "cm_",
            Typed::Nullifier => "nf_",
            Typed::Ciphertext => "ct_",
        }
    }
}

pub fn display_typed(kind: Typed, value: &[u8; 32]) -> String {
    format!("{}{}", kind.prefix(), bs58::encode(value).into_string())
}

pub fn parse_typed(kind: Typed, s: &str) -> Option<[u8; 32]> {
    let body = s.strip_prefix(kind.prefix())?;
    bs58::decode(body).into_vec().ok()?.try_into().ok()
}

/// `prefix + first 6 + "…" + last 6` of the payload. Known prefixes are kept whole.
pub fn truncate_display(s: &str) -> String {
    const PREFIXES: [&str; 6] = ["polyview1", "polyivk1", "poly1", "cm_", "nf_", "ct_"];
    let prefix = PREFIXES.iter().find(|p| s.starts_with(**p)).copied().unwrap_or("");
    let body: Vec<char> = s[prefix.len()..].chars().collect();
    if body.len() <= 13 {
        return s.to_string();
    }
    let head: String = body[..6].iter().collect();
    let tail: String = body[body.len() - 6..].iter().collect();
    format!("{prefix}{head}\u{2026}{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::SpendingKey;

    #[test]
    fn address_roundtrip_and_shape() {
        let sk = SpendingKey::from_seed([1u8; 32]);
        let a = sk.address(0);
        let s = a.encode();
        assert!(s.starts_with("poly1q"), "{s}");
        assert_eq!(s.len(), 133);
        assert!(s[5..].chars().all(|c| "qpzry9x8gf2tvdw0s3jn54khce6mua7l".contains(c)));
        assert_eq!(Address::decode(&s).unwrap(), a);
        assert_eq!(Address::decode(&s.to_uppercase()).unwrap(), a);
    }

    #[test]
    fn rejects_corruption_and_wrong_hrp() {
        let sk = SpendingKey::from_seed([2u8; 32]);
        let s = sk.address(0).encode();
        let mut c: Vec<char> = s.chars().collect();
        let i = 40;
        c[i] = if c[i] == 'q' { 'p' } else { 'q' };
        let bad: String = c.into_iter().collect();
        assert!(matches!(Address::decode(&bad), Err(AddressError::Bech32(_))));
        let fvk = sk.full_viewing_key().encode();
        assert!(matches!(Address::decode(&fvk), Err(AddressError::WrongHrp { .. }) | Err(AddressError::Length(_))));
        assert!(fvk.starts_with("polyview1q"));
        assert_eq!(FullViewingKey::decode(&fvk).unwrap(), sk.full_viewing_key());
        let ivk = sk.full_viewing_key().incoming().encode();
        assert!(ivk.starts_with("polyivk1q"));
        assert_eq!(IncomingViewingKey::decode(&ivk).unwrap(), sk.full_viewing_key().incoming());
    }

    #[test]
    fn rejects_bech32_non_m_checksum() {
        let sk = SpendingKey::from_seed([3u8; 32]);
        let hrp = Hrp::parse(HRP_ADDRESS).unwrap();
        let s = bech32::encode::<bech32::Bech32>(hrp, &sk.address(0).to_bytes()).unwrap();
        assert!(matches!(Address::decode(&s), Err(AddressError::Bech32(_))));
    }

    #[test]
    fn rejects_non_canonical_owner() {
        let sk = SpendingKey::from_seed([4u8; 32]);
        let mut p = sk.address(0).to_bytes();
        p[44..76].copy_from_slice(&[0xff; 32]);
        let s = encode(HRP_ADDRESS, &p);
        assert_eq!(Address::decode(&s), Err(AddressError::NonCanonical));
    }

    #[test]
    fn typed_display() {
        let v = [9u8; 32];
        let s = display_typed(Typed::Commitment, &v);
        assert!(s.starts_with("cm_"));
        assert_eq!(parse_typed(Typed::Commitment, &s), Some(v));
        assert_eq!(parse_typed(Typed::Nullifier, &s), None);
        let t = truncate_display(&s);
        assert!(t.starts_with("cm_") && t.contains('\u{2026}'));
        assert_eq!(t.chars().count(), 3 + 6 + 1 + 6);
        let a = SpendingKey::from_seed([5u8; 32]).address(0).encode();
        assert_eq!(truncate_display(&a).chars().count(), 5 + 13);
    }
}
