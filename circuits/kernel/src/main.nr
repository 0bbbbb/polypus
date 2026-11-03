//! Kernel v1 entry point. The ABI below is the Prover.toml layout produced by
//! `polypus_crypto::kernel::KernelWitness::to_prover_toml`. Only `pi_hash` is
//! public; every other public value is bound through it (spec §6.1).

mod kernel;
mod fixtures;
mod tests;

use kernel::{InputNote, OutputNote, PublicValues, verify_action, Witness};

fn main(
    pi_hash: pub Field,
    root: Field,
    nf: [Field; 2],
    cm_out: [Field; 2],
    public_amount: Field,
    public_asset_id: Field,
    ext_data_hash: Field,
    program_id: Field,
    program_io_hash: Field,
    ask: Field,
    nk: Field,
    asset_id: Field,
    in_amount: [Field; 2],
    in_d: [Field; 2],
    in_lock_program: [Field; 2],
    in_lock_data: [Field; 2],
    in_escape: [Field; 2],
    in_rseed: [Field; 2],
    in_leaf_index: [Field; 2],
    in_path: [[Field; 26]; 2],
    out_amount: [Field; 2],
    out_owner: [Field; 2],
    out_lock_program: [Field; 2],
    out_lock_data: [Field; 2],
    out_escape: [Field; 2],
    out_rseed: [Field; 2],
    program_params_hash: Field,
) {
    let input = |i: u32| InputNote {
        amount: in_amount[i],
        d: in_d[i],
        lock_program: in_lock_program[i],
        lock_data: in_lock_data[i],
        escape: in_escape[i],
        rseed: in_rseed[i],
        leaf_index: in_leaf_index[i],
        path: in_path[i],
    };
    let output = |j: u32| OutputNote {
        amount: out_amount[j],
        owner: out_owner[j],
        lock_program: out_lock_program[j],
        lock_data: out_lock_data[j],
        escape: out_escape[j],
        rseed: out_rseed[j],
    };
    verify_action(
        Witness {
            pi_hash,
            public: PublicValues {
                root,
                nf,
                cm_out,
                public_amount,
                public_asset_id,
                ext_data_hash,
                program_id,
                program_io_hash,
            },
            ask,
            nk,
            asset_id,
            inputs: [input(0), input(1)],
            outputs: [output(0), output(1)],
            program_params_hash,
        },
    );
}
