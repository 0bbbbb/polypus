// Vendored from Reilabs gnark-verifier-solana (Apache-2.0), see NOTICE.
// Modified for Polypus: upstream fixtures (sum_a_b, keccak_f1600, xor) are not
// shipped upstream, so the tests use test_files/ptest.* (Noir
// `hash_2([a, b]) == out`, 1 public input, no commitment) and
// test_files/sanction_checker.* (1 public input, 1 BSB22 commitment).
// Negative tests added.

#[cfg(test)]
mod tests {
    use std::fs::File;

    use ark_ec::CurveGroup;

    use crate::{
        error::GnarkError,
        proof::GnarkProof,
        verifier::{g2_from_bytes, g2_to_bytes, GnarkVerifier, FR_MODULUS_BE},
        vk::parse_vk,
        witness::GnarkWitness,
    };

    fn load<const NR: usize, const NC: usize>(
        name: &str,
    ) -> (
        crate::GnarkVerifyingkey<'static>,
        GnarkProof<NC>,
        GnarkWitness<NR>,
    ) {
        let vk = parse_vk(File::open(format!("test_files/{name}.vk")).unwrap()).unwrap();
        let proof = GnarkProof::<NC>::parse(File::open(format!("test_files/{name}.proof")).unwrap())
            .unwrap();
        let pw = GnarkWitness::<NR>::parse(File::open(format!("test_files/{name}.pw")).unwrap())
            .unwrap();
        (vk, proof, pw)
    }

    #[test]
    fn test_verification_no_commitment() {
        let (vk, proof, pw) = load::<1, 0>("ptest");
        assert_eq!(GnarkVerifier::<1>::new(&vk).verify(proof, pw), Ok(()));
    }

    #[test]
    fn test_verification_with_commitment_and_pw() {
        let (vk, proof, pw) = load::<1, 1>("sanction_checker");
        assert_eq!(GnarkVerifier::<1>::new(&vk).verify(proof, pw), Ok(()));
    }

    #[test]
    fn test_mutated_public_input_rejected() {
        for name in ["ptest", "sanction_checker"] {
            let vk = parse_vk(File::open(format!("test_files/{name}.vk")).unwrap()).unwrap();
            let bytes = std::fs::read(format!("test_files/{name}.proof")).unwrap();
            let mut pw = GnarkWitness::<1>::parse(
                File::open(format!("test_files/{name}.pw")).unwrap(),
            )
            .unwrap();
            pw.entries[0][31] ^= 1;
            let res = if name == "ptest" {
                GnarkVerifier::<1>::new(&vk).verify(GnarkProof::<0>::from_bytes(&bytes).unwrap(), pw)
            } else {
                GnarkVerifier::<1>::new(&vk).verify(GnarkProof::<1>::from_bytes(&bytes).unwrap(), pw)
            };
            assert!(res.is_err(), "{name}: mutated public input accepted");
        }
    }

    #[test]
    fn test_mutated_proof_rejected() {
        let vk = parse_vk(File::open("test_files/ptest.vk").unwrap()).unwrap();
        let bytes = std::fs::read("test_files/ptest.proof").unwrap();
        // Flip one bit in each of A, B and C (any change breaks the pairing
        // equation or the point encoding).
        for pos in [63usize, 191, 255] {
            let mut b = bytes.clone();
            b[pos] ^= 1;
            let pw = GnarkWitness::<1>::parse(File::open("test_files/ptest.pw").unwrap()).unwrap();
            let res = GnarkProof::<0>::from_bytes(&b)
                .and_then(|p| GnarkVerifier::<1>::new(&vk).verify(p, pw));
            assert!(res.is_err(), "mutated proof byte {pos} accepted");
        }
    }

    #[test]
    fn test_non_canonical_public_input_rejected() {
        let (vk, proof, mut pw) = load::<1, 0>("ptest");
        pw.entries[0] = FR_MODULUS_BE;
        assert_eq!(
            GnarkVerifier::<1>::new(&vk).verify(proof, pw),
            Err(GnarkError::PublicInputGreaterThanFieldSize)
        );
    }

    #[test]
    fn test_arity_mismatch_rejected() {
        // Correct proof, but the verifier is instantiated with the wrong number
        // of public inputs for this key.
        let vk = parse_vk(File::open("test_files/ptest.vk").unwrap()).unwrap();
        let proof = GnarkProof::<0>::parse(File::open("test_files/ptest.proof").unwrap()).unwrap();
        let pw = GnarkWitness::<2> { entries: [[0u8; 32]; 2] };
        assert_eq!(
            GnarkVerifier::<2>::new(&vk).verify(proof, pw),
            Err(GnarkError::IncompatibleVerifyingKeyWithNrPublicInputs)
        );
        // Commitment count in the proof encoding must match N_COMMITMENTS.
        let bytes = std::fs::read("test_files/sanction_checker.proof").unwrap();
        assert!(GnarkProof::<0>::from_bytes(&bytes).is_err());
        assert!(GnarkProof::<2>::from_bytes(&bytes).is_err());
    }

    #[test]
    fn test_g2_bytes_serde() {
        use ark_bn254::G2Projective;
        use ark_ff::UniformRand;

        let mut rng = ark_std::test_rng();
        let p = G2Projective::rand(&mut rng).into_affine();
        let bytes = g2_to_bytes(&p);
        let q = g2_from_bytes(&bytes);

        assert_eq!(p, q, "g2 serde failed");
    }
}
