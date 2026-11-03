//! On-chain recomputation of the kernel's public values (SPEC §1, §2, §6.1, §7).
//!
//! Field elements are 32-byte big-endian canonical encodings (`< p`).
//! Poseidon is `sol_poseidon` with `Bn254X5` / `BigEndian` (= circomlib
//! parameters, SPEC §2); every call here has ≤ 12 inputs.

use anchor_lang::prelude::*;
use solana_poseidon::{hashv, Endianness, Parameters};

use crate::error::PoolError;

/// A 32-byte big-endian field element.
pub type Fe = [u8; 32];

/// BN254 scalar field modulus `p`, big-endian.
pub const P_BE: Fe = polypus_verifier::FR_MODULUS_BE;

/// `tag(s) = bytes_to_field_be(ascii(s))` (SPEC §2.1), for `len(s) ≤ 31`.
pub const fn tag(s: &[u8]) -> Fe {
    assert!(s.len() <= 31);
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < s.len() {
        out[32 - s.len() + i] = s[i];
        i += 1;
    }
    out
}

pub const T_ASSET: Fe = tag(b"polypus.asset.v1");
pub const T_PI: Fe = tag(b"polypus.pi.v1");

/// SPEC §7 domain prefix of `ext_bytes`.
pub const EXT_DOMAIN: &[u8; 14] = b"polypus.ext.v1";
/// Length of `ext_bytes`: 14 + 4·32 + 3·8 + 2·32.
pub const EXT_BYTES_LEN: usize = 14 + 32 * 4 + 8 * 3 + 32 * 2;

/// Pool-enforced bound on |ext_amount| and fee (SPEC §7): both < 2^62.
pub const MAX_EXT_MAGNITUDE: u64 = 1 << 62;

/// `x < p` (SPEC §1: non-canonical encodings MUST be rejected).
pub fn is_canonical(x: &Fe) -> bool {
    polypus_verifier::is_canonical_fr(x)
}

/// `H_n(inputs)` via `sol_poseidon`. Fails on non-canonical inputs or n > 12.
pub fn poseidon(inputs: &[&Fe]) -> Result<Fe> {
    // `hashv` takes `&[&[u8]]`; each input is exactly 32 bytes.
    let mut slices: [&[u8]; 12] = [&[]; 12];
    require!(
        !inputs.is_empty() && inputs.len() <= slices.len(),
        PoolError::PoseidonFailed
    );
    for (s, x) in slices.iter_mut().zip(inputs) {
        *s = x.as_slice();
    }
    hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &slices[..inputs.len()],
    )
    .map(|h| h.to_bytes())
    .map_err(|_| error!(PoolError::PoseidonFailed))
}

/// `asset_id = H_3(T_ASSET, be(mint[0..16]), be(mint[16..32]))` (SPEC §4).
pub fn asset_id(mint: &[u8; 32]) -> Result<Fe> {
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    hi[16..].copy_from_slice(&mint[..16]);
    lo[16..].copy_from_slice(&mint[16..]);
    poseidon(&[&T_ASSET, &hi, &lo])
}

/// Signed embedding (SPEC §1): `v` if `v ≥ 0`, else `p − |v|`, big-endian.
/// Requires `|v| < 2^64` (the pool guarantees `|v| < 2^63`).
pub fn embed_signed(v: i128) -> Fe {
    let mag = v.unsigned_abs();
    assert!(mag < 1u128 << 64);
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&mag.to_be_bytes());
    if v >= 0 {
        return out;
    }
    // out = p − mag, big-endian schoolbook subtraction (no underflow: mag < p).
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let d = P_BE[i] as i16 - out[i] as i16 - borrow as i16;
        if d < 0 {
            out[i] = (d + 256) as u8;
            borrow = 1;
        } else {
            out[i] = d as u8;
            borrow = 0;
        }
    }
    out
}

/// The fields of SPEC §7 `ext_bytes`, in order.
pub struct ExtData<'a> {
    pub pool_id: &'a [u8; 32],
    pub chain_domain: &'a [u8; 32],
    /// Depositor source / withdraw destination token account (zero if none).
    pub public_account: &'a [u8; 32],
    /// Relayer fee token account (zero if fee = 0).
    pub relayer: &'a [u8; 32],
    pub ext_amount: i64,
    pub fee: u64,
    pub not_before_slot: u64,
    pub ct_hash: [[u8; 32]; 2],
}

impl ExtData<'_> {
    pub fn bytes(&self) -> [u8; EXT_BYTES_LEN] {
        let mut b = [0u8; EXT_BYTES_LEN];
        let parts: [&[u8]; 10] = [
            EXT_DOMAIN,
            self.pool_id,
            self.chain_domain,
            self.public_account,
            self.relayer,
            &self.ext_amount.to_le_bytes(),
            &self.fee.to_le_bytes(),
            &self.not_before_slot.to_le_bytes(),
            &self.ct_hash[0],
            &self.ct_hash[1],
        ];
        let mut o = 0;
        for p in parts {
            b[o..o + p.len()].copy_from_slice(p);
            o += p.len();
        }
        debug_assert_eq!(o, EXT_BYTES_LEN);
        b
    }

    /// `h = SHA-256(ext_bytes); h[0] = 0` — a 248-bit, always canonical value.
    pub fn hash(&self) -> Fe {
        let mut h = sha256(&self.bytes());
        h[0] = 0;
        h
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

/// The kernel public values of SPEC §6.1.
pub struct PublicValues {
    pub root: Fe,
    pub nf: [Fe; 2],
    pub cm_out: [Fe; 2],
    pub public_amount: Fe,
    pub public_asset_id: Fe,
    pub ext_data_hash: Fe,
    pub program_id: Fe,
    pub program_io_hash: Fe,
}

impl PublicValues {
    /// `pi_hash = H_11(T_PI, root, nf0, nf1, cm0, cm1, public_amount,
    /// public_asset_id, ext_data_hash, program_id, program_io_hash)`.
    pub fn pi_hash(&self) -> Result<Fe> {
        poseidon(&[
            &T_PI,
            &self.root,
            &self.nf[0],
            &self.nf[1],
            &self.cm_out[0],
            &self.cm_out[1],
            &self.public_amount,
            &self.public_asset_id,
            &self.ext_data_hash,
            &self.program_id,
            &self.program_io_hash,
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use polypus_crypto::{
        ext_data::ExtData as RefExt,
        field::{from_i128, tag as ref_tag, to_bytes_be},
        hash::tags,
        kernel::PublicValues as RefPv,
    };

    #[test]
    fn tags_match_spec() {
        assert_eq!(T_ASSET, to_bytes_be(&tags::t_asset()));
        assert_eq!(T_PI, to_bytes_be(&tags::t_pi()));
        assert_eq!(T_PI, to_bytes_be(&ref_tag("polypus.pi.v1")));
        // SPEC §2.1 table values.
        assert_eq!(&T_PI[19..], &[0x70, 0x6f, 0x6c, 0x79, 0x70, 0x75, 0x73, 0x2e, 0x70, 0x69, 0x2e, 0x76, 0x31]);
    }

    #[test]
    fn poseidon_known_answer() {
        let (mut one, mut two) = ([0u8; 32], [0u8; 32]);
        one[31] = 1;
        two[31] = 2;
        let h = poseidon(&[&one, &two]).unwrap();
        let mut kat = [0u8; 32];
        hex_decode("115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a", &mut kat);
        assert_eq!(h, kat);
        assert!(poseidon(&[&P_BE]).is_err(), "non-canonical input must be rejected");
        assert!(poseidon(&[&one; 13]).is_err());
    }

    #[test]
    fn signed_embedding() {
        for v in [0i128, 1, -1, 12345, -12345, (1 << 62) - 1, -(1i128 << 63) + 1, i64::MIN as i128] {
            assert_eq!(embed_signed(v), to_bytes_be(&from_i128(v)), "v = {v}");
        }
    }

    #[test]
    fn ext_data_and_pi_hash_match_reference() {
        let r = RefExt {
            pool_id: [1u8; 32],
            chain_domain: [2u8; 32],
            public_account: [3u8; 32],
            relayer: [4u8; 32],
            ext_amount: -1_000_000,
            fee: 5_000,
            not_before_slot: 77,
            ct_hash: [sha256(b"ct0"), sha256(b"ct1")],
        };
        let e = ExtData {
            pool_id: &r.pool_id,
            chain_domain: &r.chain_domain,
            public_account: &r.public_account,
            relayer: &r.relayer,
            ext_amount: r.ext_amount,
            fee: r.fee,
            not_before_slot: r.not_before_slot,
            ct_hash: r.ct_hash,
        };
        assert_eq!(e.bytes().as_slice(), r.bytes().as_slice());
        assert_eq!(e.hash(), to_bytes_be(&r.hash()));
        assert_eq!(
            embed_signed(r.ext_amount as i128 - r.fee as i128),
            to_bytes_be(&r.public_amount())
        );

        let mint = [9u8; 32];
        let rp = RefPv {
            root: polypus_crypto::merkle::zeros()[26],
            nf: [from_i128(11), from_i128(12)],
            cm_out: [from_i128(13), from_i128(14)],
            public_amount: r.public_amount(),
            public_asset_id: polypus_crypto::note::asset_id(&mint),
            ext_data_hash: r.hash(),
            program_id: from_i128(0),
            program_io_hash: from_i128(0),
        };
        let pv = PublicValues {
            root: to_bytes_be(&rp.root),
            nf: [to_bytes_be(&rp.nf[0]), to_bytes_be(&rp.nf[1])],
            cm_out: [to_bytes_be(&rp.cm_out[0]), to_bytes_be(&rp.cm_out[1])],
            public_amount: embed_signed(r.ext_amount as i128 - r.fee as i128),
            public_asset_id: asset_id(&mint).unwrap(),
            ext_data_hash: e.hash(),
            program_id: [0u8; 32],
            program_io_hash: [0u8; 32],
        };
        assert_eq!(pv.public_asset_id, to_bytes_be(&rp.public_asset_id));
        assert_eq!(pv.pi_hash().unwrap(), to_bytes_be(&rp.pi_hash()));
    }

    fn hex_decode(s: &str, out: &mut [u8]) {
        for (i, o) in out.iter_mut().enumerate() {
            *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
    }
}
