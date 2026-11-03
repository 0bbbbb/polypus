use anchor_lang::prelude::*;

use crate::merkle::{DEPTH, ROOT_HISTORY};

pub const POOL_SEED: &[u8] = b"pool";
pub const TREE_SEED: &[u8] = b"tree";
pub const VAULT_SEED: &[u8] = b"vault";
pub const NULLIFIER_SEED: &[u8] = b"nf";

/// Pool state, PDA `["pool", mint]`. Its address is `pool_id` in ext_data
/// (SPEC §7), so proofs are bound to one pool.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub mint: Pubkey,
    /// Token account PDA `["vault", pool]`, authority = this pool PDA.
    pub vault: Pubkey,
    /// Tree PDA `["tree", pool]`.
    pub tree: Pubkey,
    /// `H_3(T_ASSET, be(mint[0..16]), be(mint[16..32]))`, computed at init.
    pub asset_id: [u8; 32],
    /// Per-cluster constant bound into every ext_data_hash (SPEC §7).
    pub chain_domain: [u8; 32],
    pub bump: u8,
    pub tree_bump: u8,
    pub vault_bump: u8,
}

/// Commitment tree (zero-copy), PDA `["tree", pool]`. See `merkle.rs`.
#[account(zero_copy)]
#[repr(C)]
pub struct Tree {
    pub pool: Pubkey,
    /// Next free leaf index; always even.
    pub next_index: u64,
    /// Slot of the current root in `roots`.
    pub current_root_index: u64,
    /// `filled_subtrees[l]`: last left node written at level `l` (1 ≤ l < 26);
    /// slot 0 is unused because leaves are appended in pairs.
    pub filled_subtrees: [[u8; 32]; DEPTH],
    /// Ring buffer of the 128 most recent roots; unused slots are 0.
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

/// Spent-nullifier marker, PDA `["nf", pool, nf]`. Its existence is the
/// double-spend guard: creation with `init` fails if it already exists.
#[account]
#[derive(InitSpace)]
pub struct Nullifier {}
