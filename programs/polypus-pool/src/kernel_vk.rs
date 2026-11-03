//! The kernel verifying key, compiled in by `build.rs` from `$POLYPUS_KERNEL_VK`.
//! Not configurable at runtime (design doc §3.5).

include!(concat!(env!("OUT_DIR"), "/kernel_vk.rs"));

/// Number of Groth16 public inputs: exactly one, `pi_hash` (SPEC §6.1).
pub const NR_INPUTS: usize = 1;
/// Number of BSB22 (Pedersen) commitments in kernel proofs.
pub const N_COMMITMENTS: usize = VK.commitment_keys.len();
/// Proof length in the gnark raw encoding: A, B, C, u32 count, commitments, PoK.
pub const PROOF_LEN: usize = 64 + 128 + 64 + 4 + 64 * N_COMMITMENTS + 64;

const _: () = assert!(VK.nr_pubinputs == NR_INPUTS, "kernel VK must have exactly 1 public input");
const _: () = assert!(VK.k.len() == 1 + NR_INPUTS + N_COMMITMENTS);
