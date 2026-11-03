use anchor_lang::prelude::*;

#[error_code]
pub enum PoolError {
    #[msg("ext_amount has the wrong sign for this instruction")]
    WrongExtAmountSign,
    #[msg("|ext_amount| must be < 2^62")]
    ExtAmountOutOfRange,
    #[msg("fee must be < 2^62")]
    FeeOutOfRange,
    #[msg("a relayer token account is required iff fee > 0")]
    RelayerAccountMismatch,
    #[msg("Clock.slot < not_before_slot")]
    NotBeforeSlot,
    #[msg("field element is not canonical (>= p)")]
    NonCanonicalFieldElement,
    #[msg("nf[0] == nf[1]")]
    DuplicateNullifier,
    #[msg("root is not in the root history")]
    UnknownRoot,
    #[msg("malformed proof bytes")]
    MalformedProof,
    #[msg("Groth16 proof verification failed")]
    InvalidProof,
    #[msg("Poseidon syscall failed")]
    PoseidonFailed,
    #[msg("commitment tree is full")]
    TreeFull,
    #[msg("commitment tree state is corrupted")]
    TreeCorrupted,
    #[msg("token account must not be the vault")]
    VaultAsCounterparty,
}
