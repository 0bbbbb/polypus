//! Key hierarchy (spec §3). Simplified Sapling/Orchard-style derivation from a
//! single 32-byte wallet seed. UNAUDITED.

use crate::field::{from_short_be, wide_reduce, Fr};
use crate::hash::{poseidon, tags};
use curve25519_dalek::edwards::CompressedEdwardsY;
use curve25519_dalek::montgomery::MontgomeryPoint;
use curve25519_dalek::traits::IsIdentity;
use rand::{CryptoRng, RngCore};
use sha2::{Digest, Sha256, Sha512};

pub const DIVERSIFIER_LEN: usize = 11;

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn prf_field(label: &str, seed: &[u8; 32]) -> Fr {
    let mut h = Sha512::new();
    h.update(label.as_bytes());
    h.update(seed);
    wide_reduce(&h.finalize().into())
}

/// `ak = H_2(T_AK, ask)`.
pub fn derive_ak(ask: &Fr) -> Fr {
    poseidon(&[tags::t_ak(), *ask])
}

/// `owner = H_4(T_OWNER, ak, nk, d)`.
pub fn derive_owner(ak: &Fr, nk: &Fr, d: &Diversifier) -> Fr {
    poseidon(&[tags::t_owner(), *ak, *nk, d.to_field()])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Diversifier(pub [u8; DIVERSIFIER_LEN]);

impl Diversifier {
    pub fn to_field(&self) -> Fr {
        from_short_be(&self.0)
    }

    /// Diversified X25519 base `G_d` (spec §3.1).
    pub fn base(&self) -> MontgomeryPoint {
        for ctr in 0u8..=255 {
            let y = sha256(&[b"polypus.gd.v1", &self.0, &[ctr]]);
            if let Some(p) = CompressedEdwardsY(y).decompress() {
                let p8 = p.mul_by_cofactor();
                if !p8.is_identity() {
                    return p8.to_montgomery();
                }
            }
        }
        unreachable!("hash_to_curve25519: 256 consecutive failures (probability ~2^-256)")
    }
}

/// Spending key: the wallet seed. Everything is derived from it.
#[derive(Clone)]
pub struct SpendingKey {
    seed: [u8; 32],
}

impl std::fmt::Debug for SpendingKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SpendingKey(<redacted>)")
    }
}

impl SpendingKey {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self { seed }
    }

    pub fn random<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        let mut seed = [0u8; 32];
        rng.fill_bytes(&mut seed);
        Self { seed }
    }

    pub fn ask(&self) -> Fr {
        prf_field("polypus.ask.v1", &self.seed)
    }

    pub fn nk(&self) -> Fr {
        prf_field("polypus.nk.v1", &self.seed)
    }

    /// X25519 incoming viewing secret (clamped on use).
    pub fn ivk(&self) -> [u8; 32] {
        sha256(&[b"polypus.ivk.v1", &self.seed])
    }

    fn dk(&self) -> [u8; 32] {
        sha256(&[b"polypus.dk.v1", &self.seed])
    }

    pub fn diversifier(&self, j: u32) -> Diversifier {
        let h = sha256(&[b"polypus.div.v1", &self.dk(), &j.to_le_bytes()]);
        Diversifier(h[..DIVERSIFIER_LEN].try_into().unwrap())
    }

    pub fn full_viewing_key(&self) -> FullViewingKey {
        FullViewingKey { ak: derive_ak(&self.ask()), nk: self.nk(), ivk: self.ivk() }
    }

    pub fn address(&self, j: u32) -> Address {
        self.full_viewing_key().address(self.diversifier(j))
    }
}

/// `(ak, nk, ivk)`: sees incoming notes and their spends; cannot spend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FullViewingKey {
    pub ak: Fr,
    pub nk: Fr,
    pub ivk: [u8; 32],
}

impl FullViewingKey {
    pub fn owner(&self, d: &Diversifier) -> Fr {
        derive_owner(&self.ak, &self.nk, d)
    }

    pub fn incoming(&self) -> IncomingViewingKey {
        IncomingViewingKey { ivk: self.ivk }
    }

    pub fn address(&self, d: Diversifier) -> Address {
        Address { d, pk_d: d.base().mul_clamped(self.ivk).to_bytes(), owner: self.owner(&d) }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncomingViewingKey {
    pub ivk: [u8; 32],
}

impl IncomingViewingKey {
    /// Receiver side of the note-encryption key agreement (M4).
    pub fn shared_secret(&self, epk: &[u8; 32]) -> [u8; 32] {
        MontgomeryPoint(*epk).mul_clamped(self.ivk).to_bytes()
    }
}

/// Shielded payment address (spec §3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Address {
    pub d: Diversifier,
    pub pk_d: [u8; 32],
    pub owner: Fr,
}

impl Address {
    /// Sender side: returns `(epk, shared_secret)` for ephemeral secret `esk`.
    pub fn key_agreement(&self, esk: [u8; 32]) -> ([u8; 32], [u8; 32]) {
        let epk = self.d.base().mul_clamped(esk).to_bytes();
        let shared = MontgomeryPoint(self.pk_d).mul_clamped(esk).to_bytes();
        (epk, shared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    #[test]
    fn deterministic_and_separated() {
        let sk = SpendingKey::from_seed([7u8; 32]);
        assert_eq!(sk.ask(), SpendingKey::from_seed([7u8; 32]).ask());
        assert_ne!(sk.ask(), sk.nk());
        assert_ne!(sk.diversifier(0), sk.diversifier(1));
        assert_ne!(sk.address(0).owner, sk.address(1).owner);
        assert_ne!(sk.address(0).pk_d, sk.address(1).pk_d);
    }

    #[test]
    fn key_agreement_matches() {
        let mut rng = StdRng::seed_from_u64(1);
        let sk = SpendingKey::random(&mut rng);
        for j in 0..4 {
            let addr = sk.address(j);
            let mut esk = [0u8; 32];
            rng.fill_bytes(&mut esk);
            let (epk, s1) = addr.key_agreement(esk);
            let s2 = sk.full_viewing_key().incoming().shared_secret(&epk);
            assert_eq!(s1, s2);
        }
    }
}
