//! In-band note encryption and trial decryption (spec §9, ADR-0007). UNAUDITED.
//!
//! ```text
//! esk      : 32 random bytes (clamped by X25519)
//! epk      = X25519(esk, G_d)
//! shared   = X25519(esk, pk_d) = X25519(ivk, epk)        (all-zero → reject)
//! key      = HKDF-SHA256(salt = "polypus.note-enc.v1", ikm = shared, info = epk), 32 bytes
//! ct       = epk (32) ‖ ChaCha20-Poly1305(key, nonce = 0^12, aad = "", plaintext) (84 + 16)
//! ```
//!
//! The key is unique per `esk`, so the fixed nonce is safe as long as every
//! output uses a fresh `esk`. Plaintext v1 (84 bytes) describes a plain
//! (unlocked) note; the asset is the pool's and is not carried:
//!
//! ```text
//! 0x01 ‖ d (11) ‖ amount (u64 LE) ‖ rseed (32, field BE) ‖ memo (32)
//! ```
//!
//! A ciphertext proves nothing by itself: the sender chooses it. A receiver
//! accepts a note only if the commitment recomputed from the plaintext equals
//! the on-chain `cm` ([`open_note`]).

use crate::field::{from_bytes_be, to_bytes_be, Fr};
use crate::keys::{Address, Diversifier, FullViewingKey, IncomingViewingKey, DIVERSIFIER_LEN};
use crate::note::{nullifier, Note};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::ChaCha20Poly1305;
use curve25519_dalek::montgomery::MontgomeryPoint;
use hkdf::Hkdf;
use rand::{CryptoRng, RngCore};
use sha2::Sha256;

pub const PLAINTEXT_VERSION_V1: u8 = 0x01;
pub const MEMO_LEN: usize = 32;
pub const PLAINTEXT_LEN: usize = 1 + DIVERSIFIER_LEN + 8 + 32 + MEMO_LEN;
pub const EPK_LEN: usize = 32;
pub const TAG_LEN: usize = 16;
pub const CIPHERTEXT_LEN: usize = EPK_LEN + PLAINTEXT_LEN + TAG_LEN;
pub const KDF_SALT: &[u8] = b"polypus.note-enc.v1";
const NONCE: [u8; 12] = [0u8; 12];

/// Decrypted contents of a v1 note ciphertext.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotePlaintext {
    pub d: Diversifier,
    pub amount: u64,
    pub rseed: Fr,
    pub memo: [u8; MEMO_LEN],
}

impl NotePlaintext {
    pub fn to_bytes(&self) -> [u8; PLAINTEXT_LEN] {
        let mut out = [0u8; PLAINTEXT_LEN];
        out[0] = PLAINTEXT_VERSION_V1;
        out[1..12].copy_from_slice(&self.d.0);
        out[12..20].copy_from_slice(&self.amount.to_le_bytes());
        out[20..52].copy_from_slice(&to_bytes_be(&self.rseed));
        out[52..].copy_from_slice(&self.memo);
        out
    }

    /// Strict parse: exact length, version 1, canonical `rseed`.
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() != PLAINTEXT_LEN || b[0] != PLAINTEXT_VERSION_V1 {
            return None;
        }
        Some(NotePlaintext {
            d: Diversifier(b[1..12].try_into().unwrap()),
            amount: u64::from_le_bytes(b[12..20].try_into().unwrap()),
            rseed: from_bytes_be(b[20..52].try_into().unwrap()).ok()?,
            memo: b[52..].try_into().unwrap(),
        })
    }

    /// The plain note this plaintext describes, for `owner` and the pool's `asset_id`.
    pub fn note(&self, asset_id: Fr, owner: Fr) -> Note {
        Note::plain(asset_id, self.amount, owner, self.rseed)
    }
}

/// Pad or reject a memo: at most [`MEMO_LEN`] bytes, zero-padded on the right.
pub fn memo_from_slice(m: &[u8]) -> Option<[u8; MEMO_LEN]> {
    if m.len() > MEMO_LEN {
        return None;
    }
    let mut out = [0u8; MEMO_LEN];
    out[..m.len()].copy_from_slice(m);
    Some(out)
}

/// `HKDF-SHA256(salt, shared, info = epk)`.
pub fn derive_key(shared: &[u8; 32], epk: &[u8; 32]) -> [u8; 32] {
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(KDF_SALT), shared)
        .expand(epk, &mut key)
        .expect("32-byte HKDF output");
    key
}

fn aead(key: &[u8; 32]) -> ChaCha20Poly1305 {
    ChaCha20Poly1305::new(key.into())
}

/// Encrypt with an explicit ephemeral secret (deterministic; for test vectors).
/// Returns `None` if the key agreement yields the all-zero point (a malformed `pk_d`).
pub fn encrypt_with_esk(addr: &Address, pt: &NotePlaintext, esk: [u8; 32]) -> Option<Vec<u8>> {
    encrypt_bytes_with_esk(addr, &pt.to_bytes(), esk)
}

/// Seal arbitrary plaintext bytes. Only for negative test vectors (malformed
/// plaintexts); senders use [`encrypt`].
pub fn encrypt_bytes_with_esk(addr: &Address, plaintext: &[u8], esk: [u8; 32]) -> Option<Vec<u8>> {
    let (epk, shared) = addr.key_agreement(esk);
    if shared == [0u8; 32] {
        return None;
    }
    let key = derive_key(&shared, &epk);
    let body = aead(&key)
        .encrypt(&NONCE.into(), Payload { msg: plaintext, aad: b"" })
        .expect("chacha20poly1305 encrypt");
    let mut out = Vec::with_capacity(CIPHERTEXT_LEN);
    out.extend_from_slice(&epk);
    out.extend_from_slice(&body);
    Some(out)
}

/// Encrypt `pt` to `addr` with a fresh ephemeral key.
pub fn encrypt<R: RngCore + CryptoRng>(rng: &mut R, addr: &Address, pt: &NotePlaintext) -> Option<Vec<u8>> {
    let mut esk = [0u8; 32];
    rng.fill_bytes(&mut esk);
    encrypt_with_esk(addr, pt, esk)
}

/// Sender side: a fresh plain output note to `addr` and its ciphertext.
pub fn new_output<R: RngCore + CryptoRng>(
    rng: &mut R,
    addr: &Address,
    asset_id: Fr,
    amount: u64,
    memo: [u8; MEMO_LEN],
) -> (Note, Vec<u8>) {
    let pt = NotePlaintext { d: addr.d, amount, rseed: crate::note::random_field(rng), memo };
    let ct = encrypt(rng, addr, &pt).expect("pk_d of a decoded address is not low-order");
    (pt.note(asset_id, addr.owner), ct)
}

impl IncomingViewingKey {
    /// Trial-decrypt one ciphertext. `None` if it is not for this key or is malformed.
    pub fn trial_decrypt(&self, ct: &[u8]) -> Option<NotePlaintext> {
        if ct.len() != CIPHERTEXT_LEN {
            return None;
        }
        let epk: [u8; 32] = ct[..EPK_LEN].try_into().unwrap();
        let shared = MontgomeryPoint(epk).mul_clamped(self.ivk).to_bytes();
        if shared == [0u8; 32] {
            return None;
        }
        let key = derive_key(&shared, &epk);
        let pt = aead(&key)
            .decrypt(&NONCE.into(), Payload { msg: &ct[EPK_LEN..], aad: b"" })
            .ok()?;
        NotePlaintext::from_bytes(&pt)
    }
}

/// A received note whose commitment matched the chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenedNote {
    pub plaintext: NotePlaintext,
    pub note: Note,
    pub cm: Fr,
    pub leaf_index: u64,
    /// Present iff opened with a full viewing key.
    pub nullifier: Option<Fr>,
}

/// Why a ciphertext did not yield a note.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// AEAD failure, wrong length, bad version, non-canonical rseed, low-order epk.
    NotForUs,
    /// Decrypted, but no known owner for its diversifier (ivk-only scanning).
    UnknownOwner,
    /// Decrypted, but the recomputed commitment differs from the on-chain one.
    CommitmentMismatch,
}

/// Full scan step with a full viewing key: decrypt, recompute `owner` from
/// `(ak, nk, d)`, require `commit(note) == cm`, and compute the nullifier.
pub fn open_note(fvk: &FullViewingKey, asset_id: Fr, cm: Fr, leaf_index: u64, ct: &[u8]) -> Result<OpenedNote, OpenError> {
    let pt = fvk.incoming().trial_decrypt(ct).ok_or(OpenError::NotForUs)?;
    let note = pt.note(asset_id, fvk.owner(&pt.d));
    if note.commitment() != cm {
        return Err(OpenError::CommitmentMismatch);
    }
    Ok(OpenedNote { plaintext: pt, note, cm, leaf_index, nullifier: Some(nullifier(&fvk.nk, &cm, leaf_index)) })
}

/// Scan step with only an incoming viewing key. The owner field cannot be
/// derived from `ivk` (it needs `ak`, `nk`), so it is taken from `known`, the
/// recipient addresses being watched, matched by diversifier.
pub fn open_note_ivk(
    ivk: &IncomingViewingKey,
    known: &[Address],
    asset_id: Fr,
    cm: Fr,
    leaf_index: u64,
    ct: &[u8],
) -> Result<OpenedNote, OpenError> {
    let pt = ivk.trial_decrypt(ct).ok_or(OpenError::NotForUs)?;
    let owner = known.iter().find(|a| a.d == pt.d).ok_or(OpenError::UnknownOwner)?.owner;
    let note = pt.note(asset_id, owner);
    if note.commitment() != cm {
        return Err(OpenError::CommitmentMismatch);
    }
    Ok(OpenedNote { plaintext: pt, note, cm, leaf_index, nullifier: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::SpendingKey;
    use crate::note::{asset_id, random_field};
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    fn setup(seed: u8) -> (SpendingKey, Address, NotePlaintext, Fr) {
        let mut rng = StdRng::seed_from_u64(seed as u64);
        let sk = SpendingKey::from_seed([seed; 32]);
        let addr = sk.address(3);
        let pt = NotePlaintext { d: addr.d, amount: 1234, rseed: random_field(&mut rng), memo: memo_from_slice(b"hi").unwrap() };
        (sk, addr, pt, asset_id(&[0x22; 32]))
    }

    #[test]
    fn sizes() {
        assert_eq!(PLAINTEXT_LEN, 84);
        assert_eq!(CIPHERTEXT_LEN, 132);
    }

    #[test]
    fn roundtrip_and_open() {
        let mut rng = StdRng::seed_from_u64(9);
        let (sk, addr, pt, aid) = setup(1);
        let ct = encrypt(&mut rng, &addr, &pt).unwrap();
        assert_eq!(ct.len(), CIPHERTEXT_LEN);
        let fvk = sk.full_viewing_key();
        assert_eq!(fvk.incoming().trial_decrypt(&ct), Some(pt));
        let cm = pt.note(aid, addr.owner).commitment();
        let o = open_note(&fvk, aid, cm, 6, &ct).unwrap();
        assert_eq!(o.note.owner, addr.owner);
        assert_eq!(o.nullifier, Some(nullifier(&fvk.nk, &cm, 6)));
        // ivk-only: needs the address for the owner field.
        let ivk = fvk.incoming();
        assert_eq!(open_note_ivk(&ivk, &[], aid, cm, 6, &ct), Err(OpenError::UnknownOwner));
        let o2 = open_note_ivk(&ivk, &[sk.address(0), addr], aid, cm, 6, &ct).unwrap();
        assert_eq!((o2.note, o2.nullifier), (o.note, None));
    }

    #[test]
    fn rejects_wrong_key_tamper_and_mismatch() {
        let mut rng = StdRng::seed_from_u64(10);
        let (sk, addr, pt, aid) = setup(2);
        let ct = encrypt(&mut rng, &addr, &pt).unwrap();
        let other = SpendingKey::from_seed([3; 32]).full_viewing_key();
        assert_eq!(other.incoming().trial_decrypt(&ct), None);
        let fvk = sk.full_viewing_key();
        for i in [0, 31, 32, 60, CIPHERTEXT_LEN - 1] {
            let mut bad = ct.clone();
            bad[i] ^= 1;
            assert_eq!(fvk.incoming().trial_decrypt(&bad), None, "flip byte {i}");
        }
        assert_eq!(fvk.incoming().trial_decrypt(&ct[..CIPHERTEXT_LEN - 1]), None);
        let mut long = ct.clone();
        long.push(0);
        assert_eq!(fvk.incoming().trial_decrypt(&long), None);
        // All-zero epk is a low-order point: shared secret 0, rejected.
        let mut zero = ct.clone();
        zero[..32].fill(0);
        assert_eq!(fvk.incoming().trial_decrypt(&zero), None);
        // Sender lies about the amount: decrypts, but the commitment check fails.
        let cm = pt.note(aid, addr.owner).commitment();
        let lie = NotePlaintext { amount: pt.amount + 1, ..pt };
        let ct_lie = encrypt(&mut rng, &addr, &lie).unwrap();
        assert_eq!(open_note(&fvk, aid, cm, 0, &ct_lie), Err(OpenError::CommitmentMismatch));
        // Wrong asset (another pool's) also fails the commitment check.
        assert_eq!(open_note(&fvk, asset_id(&[0x33; 32]), cm, 0, &ct), Err(OpenError::CommitmentMismatch));
    }

    #[test]
    fn plaintext_parse_is_strict() {
        let (_, _, pt, _) = setup(4);
        let b = pt.to_bytes();
        assert_eq!(NotePlaintext::from_bytes(&b), Some(pt));
        let mut v = b;
        v[0] = 2;
        assert_eq!(NotePlaintext::from_bytes(&v), None);
        let mut r = b;
        r[20..52].fill(0xff);
        assert_eq!(NotePlaintext::from_bytes(&r), None, "non-canonical rseed");
        assert_eq!(NotePlaintext::from_bytes(&b[..83]), None);
        assert!(memo_from_slice(&[1; 33]).is_none());
    }

    #[test]
    fn one_ivk_decrypts_every_diversified_address() {
        let mut rng = StdRng::seed_from_u64(11);
        let sk = SpendingKey::from_seed([5; 32]);
        for j in 0..5 {
            let addr = sk.address(j);
            let pt = NotePlaintext { d: addr.d, amount: j as u64, rseed: random_field(&mut rng), memo: [0; MEMO_LEN] };
            let ct = encrypt(&mut rng, &addr, &pt).unwrap();
            assert_eq!(sk.full_viewing_key().incoming().trial_decrypt(&ct), Some(pt));
        }
    }
}
