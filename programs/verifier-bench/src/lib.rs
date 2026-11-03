//! TEST-ONLY benchmark program. It is never deployed and is not part of the
//! pool: it exists so LiteSVM tests can measure, in isolation, the CU cost of
//! the vendored Groth16 verifier, of `sol_poseidon` and of the pool's tree
//! append, and check their outputs against off-chain implementations.
//!
//! Instruction data: `op (u8) ‖ payload`.
//! * 0: verify (ptest VK, no commitment)       payload = proof ‖ public input (32)
//! * 1: verify (sanction VK, 1 BSB22 commitment) payload = proof ‖ public input (32)
//! * 2: Poseidon H_n                            payload = n × 32-byte BE inputs
//! * 3: tree append on an empty tree            payload = k × (cm0 ‖ cm1)
//! * 4: verify (the pool's compiled-in kernel VK) payload = proof ‖ public input (32)
//!
//! On success the return data is `result ‖ 0xff` (the trailing marker keeps
//! trailing zero bytes intact). The operation is bracketed by two
//! `sol_log_compute_units` calls, so the test can read its exact CU cost from
//! the logs.

use anchor_lang::solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    program_error::ProgramError, pubkey::Pubkey,
};
use polypus_pool::{crypto, state::Tree};
use polypus_verifier::{GnarkProof, GnarkVerifier, GnarkWitness};

#[allow(dead_code)]
mod ptest_vk {
    include!(concat!(env!("OUT_DIR"), "/ptest_vk.rs"));
}
#[allow(dead_code)]
mod sanction_vk {
    include!(concat!(env!("OUT_DIR"), "/sanction_vk.rs"));
}

entrypoint!(process_instruction);

fn log_cu() {
    #[cfg(target_os = "solana")]
    unsafe {
        solana_define_syscall::definitions::sol_log_compute_units_()
    }
}

fn set_return_data(data: &[u8]) {
    #[cfg(target_os = "solana")]
    unsafe {
        solana_define_syscall::definitions::sol_set_return_data(data.as_ptr(), data.len() as u64)
    }
    #[cfg(not(target_os = "solana"))]
    let _ = data;
}

fn verify<const NC: usize>(
    vk: &polypus_verifier::GnarkVerifyingkey<'static>,
    payload: &[u8],
) -> Result<(), ProgramError> {
    if payload.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (proof, pi) = payload.split_at(payload.len() - 32);
    let proof = GnarkProof::<NC>::from_bytes(proof).map_err(|e| ProgramError::Custom(u32::from(e)))?;
    let witness = GnarkWitness::<1> { entries: [pi.try_into().unwrap()] };
    GnarkVerifier::<1>::new(vk)
        .verify(proof, witness)
        .map_err(|e| ProgramError::Custom(u32::from(e)))
}

pub fn process_instruction(_: &Pubkey, _: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&op, payload) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let mut out: Vec<u8> = Vec::new();
    log_cu();
    match op {
        0 => verify::<{ ptest_vk::VK.commitment_keys.len() }>(&ptest_vk::VK, payload)?,
        1 => verify::<{ sanction_vk::VK.commitment_keys.len() }>(&sanction_vk::VK, payload)?,
        4 => verify::<{ polypus_pool::kernel_vk::N_COMMITMENTS }>(&polypus_pool::kernel_vk::VK, payload)?,
        2 => {
            let inputs: Vec<&[u8; 32]> = payload
                .chunks_exact(32)
                .map(|c| c.try_into().unwrap())
                .collect();
            out.extend_from_slice(
                &crypto::poseidon(&inputs).map_err(|_| ProgramError::Custom(100))?,
            );
        }
        3 => {
            // Heap-allocated in place: a ~5 KB Tree would overflow the 4 KB SBF stack frame.
            let mut tree: Box<Tree> = bytemuck::allocation::zeroed_box();
            tree.init(Pubkey::default());
            log_cu();
            for pair in payload.chunks_exact(64) {
                tree.append_pair(pair[..32].try_into().unwrap(), pair[32..].try_into().unwrap())
                    .map_err(|_| ProgramError::Custom(101))?;
            }
            log_cu();
            out.extend_from_slice(&tree.root());
            return finish(&out);
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    }
    log_cu();
    finish(&out)
}

fn finish(result: &[u8]) -> ProgramResult {
    let mut rd = result.to_vec();
    rd.push(0xff);
    set_return_data(&rd);
    Ok(())
}
