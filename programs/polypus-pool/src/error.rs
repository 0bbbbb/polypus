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
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("program_data is not this program's ProgramData account")]
    WrongProgramData,
    #[msg("signer is not the pool admin")]
    NotAdmin,
    #[msg("signer is not the pool guardian")]
    NotGuardian,
    #[msg("pool is paused: deposit and transact are disabled, withdraw is allowed")]
    PoolPaused,
    #[msg("deposit ext_amount exceeds the pool's max_deposit")]
    DepositTooLarge,
    #[msg("deposit would push the vault balance above the pool's tvl_cap")]
    TvlCapExceeded,
}
