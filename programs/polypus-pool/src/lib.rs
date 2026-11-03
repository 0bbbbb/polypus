//! Polypus shielded pool — M2 transfer path (program 0 only).
//!
//! UNAUDITED. DEVNET / LOCALNET ONLY.
//!
//! Every state-changing instruction (`deposit`, `transact`, `withdraw`) runs
//! the same core, [`process_action`]: it recomputes the kernel's single public
//! input `pi_hash` (SPEC §6.1) from instruction data and pool state, verifies
//! the Groth16 proof against the compiled-in kernel VK, and appends the two
//! output commitments. The two nullifier PDAs are created by the account
//! constraints (`init`), which is the double-spend guard. Nothing is ever keyed
//! on proof bytes (Groth16 proofs are malleable).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use polypus_verifier::{GnarkProof, GnarkVerifier, GnarkWitness};

pub mod crypto;
pub mod error;
pub mod kernel_vk;
pub mod merkle;
pub mod state;

use crate::{
    crypto::{Fe, MAX_EXT_MAGNITUDE},
    error::PoolError,
    state::*,
};

declare_id!("PoLyMJzp2sUxqEguNkpK5nvtJJna2UECSod7q9UWCVu");

/// Arguments shared by `deposit`, `transact` and `withdraw`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct ActionArgs {
    /// Nullifiers of the two inputs (seeds of the nullifier PDAs).
    pub nf: [[u8; 32]; 2],
    /// A recent tree root (must be in the 128-root history).
    pub root: [u8; 32],
    /// Output commitments, appended at leaf indices `next_index`, `+1`.
    pub cm_out: [[u8; 32]; 2],
    /// > 0 deposit, < 0 withdraw, 0 transact.
    pub ext_amount: i64,
    /// Paid from the vault to the relayer token account.
    pub fee: u64,
    /// The action is only valid from this slot on.
    pub not_before_slot: u64,
    /// gnark raw-encoded Groth16 proof (`kernel_vk::PROOF_LEN` bytes).
    pub proof: Vec<u8>,
    /// Output-note ciphertexts; only their SHA-256 is bound (ct_hash, SPEC §7).
    pub ciphertexts: [Vec<u8>; 2],
}

/// Emitted once per action. Indexers should prefer instruction data (logs can
/// be truncated), but the event carries the same values plus the new root.
#[event]
pub struct ActionEvent {
    pub pool: Pubkey,
    pub leaf_index: [u64; 2],
    pub cm_out: [[u8; 32]; 2],
    pub nf: [[u8; 32]; 2],
    pub new_root: [u8; 32],
    pub ext_amount: i64,
    pub fee: u64,
    pub ciphertexts: [Vec<u8>; 2],
}

#[program]
pub mod polypus_pool {
    use super::*;

    /// Create the pool, its tree and its vault for `mint`. `chain_domain` is
    /// the per-cluster constant bound into every ext_data_hash.
    pub fn init_pool(ctx: Context<InitPool>, chain_domain: [u8; 32]) -> Result<()> {
        let a = &mut *ctx.accounts;
        let pool_key = a.pool.key();
        let pool = &mut a.pool;
        pool.admin = a.admin.key();
        pool.mint = a.mint.key();
        pool.vault = a.vault.key();
        pool.tree = a.tree.key();
        pool.asset_id = crypto::asset_id(&a.mint.key().to_bytes())?;
        pool.chain_domain = chain_domain;
        pool.bump = ctx.bumps.pool;
        pool.tree_bump = ctx.bumps.tree;
        pool.vault_bump = ctx.bumps.vault;
        a.tree.load_init()?.init(pool_key);
        msg!("kernel vk sha256 = {}", hex(&kernel_vk::VK_SHA256));
        Ok(())
    }

    /// Shield: move `ext_amount` (> 0) from `public_account` into the vault.
    pub fn deposit(ctx: Context<Deposit>, args: ActionArgs) -> Result<()> {
        require!(args.ext_amount > 0, PoolError::WrongExtAmountSign);
        let a = &*ctx.accounts;
        let (amount, fee) = (args.ext_amount as u64, args.fee);
        process_action(
            &a.pool,
            &a.tree,
            Some(a.public_account.key()),
            a.relayer_token.as_ref().map(|r| r.key()),
            args,
        )?;
        token::transfer(
            CpiContext::new(
                a.token_program.key(),
                Transfer {
                    from: a.public_account.to_account_info(),
                    to: a.vault.to_account_info(),
                    authority: a.depositor.to_account_info(),
                },
            ),
            amount,
        )?;
        if let Some(relayer) = &a.relayer_token {
            vault_pay(&a.token_program, &a.pool, &a.vault, relayer.to_account_info(), fee)?;
        }
        Ok(())
    }

    /// Private transfer (program 0): `ext_amount == 0`, only the fee leaves the vault.
    pub fn transact(ctx: Context<Transact>, args: ActionArgs) -> Result<()> {
        require!(args.ext_amount == 0, PoolError::WrongExtAmountSign);
        let a = &*ctx.accounts;
        let fee = args.fee;
        process_action(
            &a.pool,
            &a.tree,
            None,
            a.relayer_token.as_ref().map(|r| r.key()),
            args,
        )?;
        if let Some(relayer) = &a.relayer_token {
            vault_pay(&a.token_program, &a.pool, &a.vault, relayer.to_account_info(), fee)?;
        }
        Ok(())
    }

    /// Unshield: send `|ext_amount|` (ext_amount < 0) from the vault to `public_account`.
    pub fn withdraw(ctx: Context<Withdraw>, args: ActionArgs) -> Result<()> {
        require!(args.ext_amount < 0, PoolError::WrongExtAmountSign);
        let a = &*ctx.accounts;
        let (amount, fee) = (args.ext_amount.unsigned_abs(), args.fee);
        process_action(
            &a.pool,
            &a.tree,
            Some(a.public_account.key()),
            a.relayer_token.as_ref().map(|r| r.key()),
            args,
        )?;
        vault_pay(&a.token_program, &a.pool, &a.vault, a.public_account.to_account_info(), amount)?;
        if let Some(relayer) = &a.relayer_token {
            vault_pay(&a.token_program, &a.pool, &a.vault, relayer.to_account_info(), fee)?;
        }
        Ok(())
    }
}

/// The shared action core. The caller has already checked the sign of
/// `ext_amount` for its instruction and the account constraints have created
/// both nullifier PDAs (failing if either exists).
fn process_action(
    pool: &Account<Pool>,
    tree: &AccountLoader<Tree>,
    public_account: Option<Pubkey>,
    relayer_token: Option<Pubkey>,
    args: ActionArgs,
) -> Result<()> {
    // SPEC §7: |ext_amount| < 2^62 and fee < 2^62, so ext_amount − fee cannot
    // overflow and |public_amount| < 2^63 (inside the kernel's K2 range).
    require!(
        args.ext_amount.unsigned_abs() < MAX_EXT_MAGNITUDE,
        PoolError::ExtAmountOutOfRange
    );
    require!(args.fee < MAX_EXT_MAGNITUDE, PoolError::FeeOutOfRange);
    // The relayer field is the fee recipient, and zero iff fee == 0 (SPEC §7):
    // a relayer account must be present exactly when a fee is paid.
    require!(
        relayer_token.is_some() == (args.fee > 0),
        PoolError::RelayerAccountMismatch
    );
    for acc in [public_account, relayer_token].into_iter().flatten() {
        // Paying the vault to itself would make the action a no-op transfer.
        require_keys_neq!(acc, pool.vault, PoolError::VaultAsCounterparty);
    }

    require!(
        Clock::get()?.slot >= args.not_before_slot,
        PoolError::NotBeforeSlot
    );

    // SPEC §1: reject non-canonical encodings of root / nf / cm.
    for x in [&args.root, &args.nf[0], &args.nf[1], &args.cm_out[0], &args.cm_out[1]] {
        require!(crypto::is_canonical(x), PoolError::NonCanonicalFieldElement);
    }
    // K6, re-checked on-chain (the second `init` would fail anyway).
    require!(args.nf[0] != args.nf[1], PoolError::DuplicateNullifier);

    let mut tree_state = tree.load_mut()?;
    require!(tree_state.is_known_root(&args.root), PoolError::UnknownRoot);

    // SPEC §7. The pool, not the prover, picks pool_id, chain_domain, the
    // token accounts (zero if absent) and the ciphertext hashes.
    let zero = [0u8; 32];
    let pool_id = pool.key().to_bytes();
    let public_account = public_account.map(|k| k.to_bytes()).unwrap_or(zero);
    let relayer = relayer_token.map(|k| k.to_bytes()).unwrap_or(zero);
    let ext_data_hash = crypto::ExtData {
        pool_id: &pool_id,
        chain_domain: &pool.chain_domain,
        public_account: &public_account,
        relayer: &relayer,
        ext_amount: args.ext_amount,
        fee: args.fee,
        not_before_slot: args.not_before_slot,
        ct_hash: [
            crypto::sha256(&args.ciphertexts[0]),
            crypto::sha256(&args.ciphertexts[1]),
        ],
    }
    .hash();

    // SPEC §6.1. public_asset_id is revealed only if tokens move. program_id
    // and program_io_hash are fixed to 0: the M2 pool supports program 0 only,
    // so notes locked to a program (K10) cannot be spent here.
    let moves_tokens = args.ext_amount != 0 || args.fee != 0;
    let pi_hash = crypto::PublicValues {
        root: args.root,
        nf: args.nf,
        cm_out: args.cm_out,
        public_amount: crypto::embed_signed(args.ext_amount as i128 - args.fee as i128),
        public_asset_id: if moves_tokens { pool.asset_id } else { zero },
        ext_data_hash,
        program_id: zero,
        program_io_hash: zero,
    }
    .pi_hash()?;

    // The public witness is built here from pi_hash; it is never client-supplied.
    verify_kernel_proof(&args.proof, &pi_hash)?;

    let first = tree_state.append_pair(&args.cm_out[0], &args.cm_out[1])?;
    let new_root = tree_state.root();
    drop(tree_state);

    emit!(ActionEvent {
        pool: pool.key(),
        leaf_index: [first, first + 1],
        cm_out: args.cm_out,
        nf: args.nf,
        new_root,
        ext_amount: args.ext_amount,
        fee: args.fee,
        ciphertexts: args.ciphertexts,
    });
    Ok(())
}

/// Verify a kernel proof whose only public input is `pi_hash`.
fn verify_kernel_proof(proof: &[u8], pi_hash: &Fe) -> Result<()> {
    use kernel_vk::{NR_INPUTS, N_COMMITMENTS, PROOF_LEN, VK};
    require!(proof.len() == PROOF_LEN, PoolError::MalformedProof);
    let proof = GnarkProof::<N_COMMITMENTS>::from_bytes(proof)
        .map_err(|_| error!(PoolError::MalformedProof))?;
    let witness = GnarkWitness::<NR_INPUTS> { entries: [*pi_hash] };
    GnarkVerifier::<NR_INPUTS>::new(&VK)
        .verify(proof, witness)
        .map_err(|_| {
            // Public data only; lets clients debug pi_hash mismatches.
            msg!("kernel proof rejected; on-chain pi_hash = {}", hex(pi_hash));
            error!(PoolError::InvalidProof)
        })
}

/// Transfer `amount` out of the vault, signed by the pool PDA.
fn vault_pay<'info>(
    token_program: &Program<'info, Token>,
    pool: &Account<'info, Pool>,
    vault: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let bump = [pool.bump];
    let seeds: &[&[u8]] = &[POOL_SEED, pool.mint.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault.to_account_info(),
                to,
                authority: pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

fn hex(b: &[u8; 32]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for x in b {
        s.push(D[(x >> 4) as usize] as char);
        s.push(D[(x & 15) as usize] as char);
    }
    s
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// Classic SPL Token mint (Token-2022 is not supported in the MVP).
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init, payer = admin, space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, mint.key().as_ref()], bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init, payer = admin, space = 8 + core::mem::size_of::<Tree>(),
        seeds = [TREE_SEED, pool.key().as_ref()], bump,
    )]
    pub tree: AccountLoader<'info, Tree>,
    #[account(
        init, payer = admin,
        seeds = [VAULT_SEED, pool.key().as_ref()], bump,
        token::mint = mint, token::authority = pool,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ActionArgs)]
pub struct Deposit<'info> {
    /// Authority of `public_account`; pays the nullifier rent.
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, address = pool.tree)]
    pub tree: AccountLoader<'info, Tree>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// Depositor's source token account (ext_data.public_account).
    #[account(mut, token::mint = pool.mint)]
    pub public_account: Box<Account<'info, TokenAccount>>,
    /// Relayer fee token account (ext_data.relayer); present iff fee > 0.
    #[account(mut, token::mint = pool.mint)]
    pub relayer_token: Option<Box<Account<'info, TokenAccount>>>,
    #[account(
        init, payer = depositor, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, pool.key().as_ref(), args.nf[0].as_ref()], bump,
    )]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(
        init, payer = depositor, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, pool.key().as_ref(), args.nf[1].as_ref()], bump,
    )]
    pub nullifier1: Account<'info, Nullifier>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ActionArgs)]
pub struct Transact<'info> {
    /// Transaction fee payer (typically the relayer); pays the nullifier rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, address = pool.tree)]
    pub tree: AccountLoader<'info, Tree>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// Relayer fee token account (ext_data.relayer); present iff fee > 0.
    #[account(mut, token::mint = pool.mint)]
    pub relayer_token: Option<Box<Account<'info, TokenAccount>>>,
    #[account(
        init, payer = payer, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, pool.key().as_ref(), args.nf[0].as_ref()], bump,
    )]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(
        init, payer = payer, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, pool.key().as_ref(), args.nf[1].as_ref()], bump,
    )]
    pub nullifier1: Account<'info, Nullifier>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ActionArgs)]
pub struct Withdraw<'info> {
    /// Transaction fee payer (typically the relayer); pays the nullifier rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, address = pool.tree)]
    pub tree: AccountLoader<'info, Tree>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// Withdrawal destination token account (ext_data.public_account).
    #[account(mut, token::mint = pool.mint)]
    pub public_account: Box<Account<'info, TokenAccount>>,
    /// Relayer fee token account (ext_data.relayer); present iff fee > 0.
    #[account(mut, token::mint = pool.mint)]
    pub relayer_token: Option<Box<Account<'info, TokenAccount>>>,
    #[account(
        init, payer = payer, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, pool.key().as_ref(), args.nf[0].as_ref()], bump,
    )]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(
        init, payer = payer, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, pool.key().as_ref(), args.nf[1].as_ref()], bump,
    )]
    pub nullifier1: Account<'info, Nullifier>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
