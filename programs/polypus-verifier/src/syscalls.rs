// Vendored from Reilabs gnark-verifier-solana (Apache-2.0), see NOTICE.
// Modified for Polypus: solana-program 2.2 -> solana-define-syscall 5 /
// solana-bn254 3.2 and explicit *_BE op codes.

//! Allocation-free BN254 syscall wrappers for SBF.

use solana_bn254::AltBn128Error;

#[cfg(target_os = "solana")]
use solana_bn254::prelude::{ALT_BN128_G1_ADD_BE, ALT_BN128_G1_MUL_BE, ALT_BN128_PAIRING_BE};

#[cfg(not(target_os = "solana"))]
use solana_bn254::prelude::{
    alt_bn128_g1_addition_be as alt_add, alt_bn128_g1_multiplication_be as alt_mul,
    alt_bn128_pairing_be as alt_pair,
};

const ADD_INPUT_LEN: usize = 128;
const MUL_INPUT_LEN: usize = 96;
const ADD_OUTPUT_LEN: usize = 64;
const MUL_OUTPUT_LEN: usize = 64;
const PAIR_OUTPUT_LEN: usize = 32;

#[cfg(target_os = "solana")]
fn syscall(group_op: u64, input: &[u8], output: &mut [u8]) -> Result<(), AltBn128Error> {
    let res = unsafe {
        solana_define_syscall::definitions::sol_alt_bn128_group_op(
            group_op,
            input.as_ptr(),
            input.len() as u64,
            output.as_mut_ptr(),
        )
    };
    if res == 0 {
        Ok(())
    } else {
        Err(AltBn128Error::from(res))
    }
}

/// performs an alt_bn128 addn without heap allocation on SBF
pub(crate) fn alt_bn128_addition(
    input: &[u8; ADD_INPUT_LEN],
) -> Result<[u8; ADD_OUTPUT_LEN], AltBn128Error> {
    #[cfg(target_os = "solana")]
    {
        let mut out = [0u8; ADD_OUTPUT_LEN];
        syscall(ALT_BN128_G1_ADD_BE, input, &mut out)?;
        Ok(out)
    }

    #[cfg(not(target_os = "solana"))]
    {
        let out = alt_add(input)?;
        let arr: [u8; ADD_OUTPUT_LEN] = out
            .as_slice()
            .try_into()
            .map_err(|_| AltBn128Error::SliceOutOfBounds)?;
        Ok(arr)
    }
}

/// performs an alt_bn128 multiplication without heap allocation on SBF
pub(crate) fn alt_bn128_multiplication(
    input: &[u8; MUL_INPUT_LEN],
) -> Result<[u8; MUL_OUTPUT_LEN], AltBn128Error> {
    #[cfg(target_os = "solana")]
    {
        let mut out = [0u8; MUL_OUTPUT_LEN];
        syscall(ALT_BN128_G1_MUL_BE, input, &mut out)?;
        Ok(out)
    }

    #[cfg(not(target_os = "solana"))]
    {
        let out = alt_mul(input)?;
        let arr: [u8; MUL_OUTPUT_LEN] = out
            .as_slice()
            .try_into()
            .map_err(|_| AltBn128Error::SliceOutOfBounds)?;
        Ok(arr)
    }
}

/// performs an alt_bn128 pairing without heap allocation on SBF
pub(crate) fn alt_bn128_pairing(input: &[u8]) -> Result<[u8; PAIR_OUTPUT_LEN], AltBn128Error> {
    #[cfg(target_os = "solana")]
    {
        let mut out = [0u8; PAIR_OUTPUT_LEN];
        syscall(ALT_BN128_PAIRING_BE, input, &mut out)?;
        Ok(out)
    }

    #[cfg(not(target_os = "solana"))]
    {
        let out = alt_pair(input)?;
        let arr: [u8; PAIR_OUTPUT_LEN] = out
            .as_slice()
            .try_into()
            .map_err(|_| AltBn128Error::SliceOutOfBounds)?;
        Ok(arr)
    }
}
