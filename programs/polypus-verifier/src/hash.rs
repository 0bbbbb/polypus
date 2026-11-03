// Vendored from Reilabs gnark-verifier-solana (Apache-2.0), see NOTICE.
// Modified for Polypus: SHA-256 goes through solana-sha256-hasher (the
// sol_sha256 syscall on-chain, sha2 on the host) instead of software sha2, and
// the 48-byte mod-r reduction uses `fr_from_be_48` (~75k CU cheaper on SBF).
//! Provides functionality for verifier-side Fiat_Shamir challenge generation.
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use solana_sha256_hasher::hashv;

use crate::error::GnarkError;

/// A simple wrapper that accumulates bytes and hashes them to a field element.
pub(crate) struct WrappedHashToField {
    domain: Vec<u8>,
    to_hash: Vec<u8>,
}

impl WrappedHashToField {
    /// Create a new instance with a given domain separator.
    pub(crate) fn new(domain_separator: &[u8]) -> Self {
        Self {
            domain: domain_separator.to_vec(),
            to_hash: Vec::new(),
        }
    }

    /// Append bytes to the internal buffer.
    pub(crate) fn write(&mut self, data: &[u8]) {
        self.to_hash.extend_from_slice(data);
    }

    /// Hash accumulated bytes to a field element (returning its byte representation).
    pub(crate) fn sum(&mut self, mut b: Vec<u8>) -> Vec<u8> {
        let res = hash_to_field(&self.to_hash, &self.domain, 1)
            .expect("Unable to get elements from hashing");

        // Convert the hash output to a field element
        let element = res[0];

        // Clear the buffer (optional; similar to Reset)
        self.to_hash.clear();

        // Return the field element as bytes (big-endian)
        b.extend_from_slice(&element.into_bigint().to_bytes_be());

        b
    }

    /// Reset internal state (clears accumulated bytes)
    pub(crate) fn reset(&mut self) {
        self.to_hash.clear();
    }
}

/// Hashes to field elements with 128-bit security.
/// Equivalent to the Go `Hash` function.
pub(crate) fn hash_to_field(msg: &[u8], dst: &[u8], count: usize) -> Result<Vec<Fr>, GnarkError> {
    // 128 bits of security
    // L = ceil((ceil(log2(p)) + k) / 8), where k = 128
    let bits = Fr::MODULUS_BIT_SIZE as usize;
    let bytes = 1 + (bits - 1) / 8;
    let l = 16 + bytes; // per RFC 9380
    let len_in_bytes = count * l;

    // Step 1: Expand message
    let pseudo_random_bytes = expand_message_xmd(msg, dst, len_in_bytes)?;

    // Step 2: Convert to field elements
    let mut res = Vec::with_capacity(count);
    for i in 0..count {
        let start = i * l;
        let end = (i + 1) * l;
        let slice = &pseudo_random_bytes[start..end];

        // Interpret as a big integer mod p
        let fe = fr_from_be_48(slice.try_into().expect("l = 48 for BN254 Fr"));
        res.push(fe);
    }

    Ok(res)
}

/// `Fr::from_be_bytes_mod_order` for exactly 48 bytes, computed as
/// `hi · 2^256 + lo (mod r)` with `hi` = first 16 bytes, `lo` = last 32.
/// arkworks' generic byte-wise reduction costs ~75k CU on SBF; this is a few
/// field multiplications. Equality with arkworks is tested below.
pub(crate) fn fr_from_be_48(bytes: &[u8; 48]) -> Fr {
    use ark_ff::{BigInt, Field};
    let hi = u128::from_be_bytes(bytes[..16].try_into().unwrap());
    let mut limbs = [0u64; 4];
    for (i, limb) in limbs.iter_mut().enumerate() {
        let o = 16 + 8 * (3 - i);
        *limb = u64::from_be_bytes(bytes[o..o + 8].try_into().unwrap());
    }
    // lo < 2^256 < 6r: at most 5 subtractions bring it into [0, r).
    let mut lo = BigInt::<4>(limbs);
    while lo >= Fr::MODULUS {
        lo.sub_with_borrow(&Fr::MODULUS);
    }
    let lo = Fr::from_bigint(lo).expect("lo < r");
    // 2^256 = (2^128)^2, with 2^128 = u128::MAX + 1.
    let two_128 = Fr::from(u128::MAX) + Fr::from(1u64);
    Fr::from(hi) * two_128.square() + lo
}

/// ExpandMsgXmd per RFC 9380 §5.4.1 using SHA-256.
/// Expands `msg` and `dst` into `len_in_bytes` pseudorandom bytes.
fn expand_message_xmd(msg: &[u8], dst: &[u8], len_in_bytes: usize) -> Result<Vec<u8>, GnarkError> {
    const B_IN_BYTES: usize = 64; // SHA-256 block size (in bytes)
    const H_LEN: usize = 32; // SHA-256 output size (in bytes)

    let ell = len_in_bytes.div_ceil(H_LEN);
    if ell > 255 {
        return Err(GnarkError::HashError(
            "invalid len_in_bytes: too large".into(),
        ));
    }
    if dst.len() > 255 {
        return Err(GnarkError::HashError(
            "invalid DST length (>255 bytes)".into(),
        ));
    }

    let size_domain = dst.len() as u8;
    let mut dst_prime = Vec::with_capacity(dst.len() + 1);
    dst_prime.extend_from_slice(dst);
    dst_prime.push(size_domain);

    // Step 1: b0 = H(Z_pad || msg || I2OSP(len_in_bytes, 2) || I2OSP(0, 1) || DST_prime)
    let b0 = hashv(&[
        &[0u8; B_IN_BYTES], // Z_pad
        msg,
        &[(len_in_bytes >> 8) as u8, (len_in_bytes & 0xff) as u8],
        &[0x00],
        &dst_prime,
    ])
    .to_bytes();

    // Step 2: b1 = H(b0 || I2OSP(1, 1) || DST_prime)
    let mut bi = hashv(&[&b0, &[0x01], &dst_prime]).to_bytes();

    // Step 3: accumulate blocks
    let mut result = Vec::with_capacity(len_in_bytes);
    result.extend_from_slice(&bi);

    for i in 2..=ell {
        // bi = H(strxor(b0, b_{i-1}) || I2OSP(i,1) || DST_prime)
        let mut strxor = [0u8; H_LEN];
        for j in 0..H_LEN {
            strxor[j] = b0[j] ^ bi[j];
        }
        bi = hashv(&[&strxor, &[i as u8], &dst_prime]).to_bytes();

        let start = (i - 1) * H_LEN;
        let end = std::cmp::min(i * H_LEN, len_in_bytes);
        result.extend_from_slice(&bi[..end - start]);
    }

    result.truncate(len_in_bytes);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fr_from_be_48_matches_arkworks() {
        let r = Fr::MODULUS.to_bytes_be();
        let mut cases: Vec<[u8; 48]> = vec![[0u8; 48], [0xff; 48]];
        for lo in [r.clone(), {
            let mut x = r.clone();
            x[31] -= 1;
            x
        }] {
            for hi in [[0u8; 16], [0xff; 16], [1u8; 16]] {
                let mut b = [0u8; 48];
                b[..16].copy_from_slice(&hi);
                b[16..].copy_from_slice(&lo);
                cases.push(b);
            }
        }
        // Deterministic pseudo-random inputs (SHA-256 chain).
        let mut seed = [7u8; 32];
        for _ in 0..2000 {
            let a = hashv(&[&seed, b"a"]).to_bytes();
            let b = hashv(&[&seed, b"b"]).to_bytes();
            seed = a;
            let mut x = [0u8; 48];
            x[..32].copy_from_slice(&a);
            x[32..].copy_from_slice(&b[..16]);
            cases.push(x);
        }
        for c in cases {
            assert_eq!(fr_from_be_48(&c), Fr::from_be_bytes_mod_order(&c), "{c:?}");
        }
    }
}
