//! Incremental Poseidon Merkle tree (spec §5). Two flavours:
//! - [`Frontier`]: the O(depth) state the pool keeps on-chain (filled subtrees +
//!   root history), used as the reference for the program;
//! - [`MerkleTree`]: a client-side tree that also produces witnesses (paths).

use crate::field::Fr;
use crate::hash::merkle_node;
use ark_ff::Zero;
use std::sync::OnceLock;
use thiserror::Error;

pub const DEPTH: usize = 26;
pub const ROOT_HISTORY: usize = 128;
pub const CAPACITY: u64 = 1 << DEPTH;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MerkleError {
    #[error("tree is full")]
    Full,
    #[error("pair insertion requires an even next_index")]
    Unaligned,
    #[error("leaf index {0} out of range")]
    OutOfRange(u64),
}

/// `Z_0 = 0`, `Z_{i+1} = H_2(Z_i, Z_i)`; `zeros()[DEPTH]` is the empty root.
pub fn zeros() -> &'static [Fr; DEPTH + 1] {
    static Z: OnceLock<[Fr; DEPTH + 1]> = OnceLock::new();
    Z.get_or_init(|| {
        let mut z = [Fr::zero(); DEPTH + 1];
        for i in 0..DEPTH {
            z[i + 1] = merkle_node(&z[i], &z[i]);
        }
        z
    })
}

/// Recompute the root from a leaf, its index and its authentication path.
pub fn root_from_path(leaf: &Fr, index: u64, path: &[Fr; DEPTH]) -> Fr {
    let mut cur = *leaf;
    for (i, sib) in path.iter().enumerate() {
        cur = if (index >> i) & 1 == 0 { merkle_node(&cur, sib) } else { merkle_node(sib, &cur) };
    }
    cur
}

/// On-chain-equivalent incremental tree state.
#[derive(Clone, Debug)]
pub struct Frontier {
    pub filled_subtrees: [Fr; DEPTH],
    pub next_index: u64,
    pub roots: [Fr; ROOT_HISTORY],
    pub current_root_index: usize,
}

impl Default for Frontier {
    fn default() -> Self {
        let z = zeros();
        let mut filled = [Fr::zero(); DEPTH];
        filled.copy_from_slice(&z[..DEPTH]);
        let mut roots = [Fr::zero(); ROOT_HISTORY];
        roots[0] = z[DEPTH];
        Frontier { filled_subtrees: filled, next_index: 0, roots, current_root_index: 0 }
    }
}

impl Frontier {
    pub fn root(&self) -> Fr {
        self.roots[self.current_root_index]
    }

    /// Unused ring slots hold 0, so 0 is never a known root.
    pub fn is_known_root(&self, r: &Fr) -> bool {
        !r.is_zero() && self.roots.iter().any(|x| x == r)
    }

    /// Append two leaves at an even index; 26 hashes (the pair, then 25 levels).
    /// Returns the index of the first leaf.
    pub fn append_pair(&mut self, a: Fr, b: Fr) -> Result<u64, MerkleError> {
        if self.next_index % 2 != 0 {
            return Err(MerkleError::Unaligned);
        }
        if self.next_index + 2 > CAPACITY {
            return Err(MerkleError::Full);
        }
        let first = self.next_index;
        let z = zeros();
        let mut idx = first >> 1;
        let mut cur = merkle_node(&a, &b);
        for level in 1..DEPTH {
            if idx & 1 == 0 {
                self.filled_subtrees[level] = cur;
                cur = merkle_node(&cur, &z[level]);
            } else {
                cur = merkle_node(&self.filled_subtrees[level], &cur);
            }
            idx >>= 1;
        }
        self.next_index += 2;
        self.current_root_index = (self.current_root_index + 1) % ROOT_HISTORY;
        self.roots[self.current_root_index] = cur;
        Ok(first)
    }
}

/// Client-side tree with full witness generation. Stores only non-empty nodes.
#[derive(Clone, Debug, Default)]
pub struct MerkleTree {
    /// levels[0] = leaves; levels[i][k] = node k at height i.
    levels: Vec<Vec<Fr>>,
}

impl MerkleTree {
    pub fn new() -> Self {
        MerkleTree { levels: vec![Vec::new(); DEPTH + 1] }
    }

    pub fn len(&self) -> u64 {
        self.levels[0].len() as u64
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn node(&self, level: usize, k: u64) -> Fr {
        self.levels[level].get(k as usize).copied().unwrap_or(zeros()[level])
    }

    pub fn append(&mut self, leaf: Fr) -> Result<u64, MerkleError> {
        let index = self.len();
        if index >= CAPACITY {
            return Err(MerkleError::Full);
        }
        self.levels[0].push(leaf);
        let mut k = index;
        for level in 0..DEPTH {
            let parent = merkle_node(&self.node(level, k & !1), &self.node(level, k | 1));
            k >>= 1;
            let row = &mut self.levels[level + 1];
            if (k as usize) < row.len() {
                row[k as usize] = parent;
            } else {
                row.push(parent);
            }
        }
        Ok(index)
    }

    pub fn root(&self) -> Fr {
        self.node(DEPTH, 0)
    }

    pub fn leaf(&self, index: u64) -> Option<Fr> {
        self.levels[0].get(index as usize).copied()
    }

    pub fn path(&self, index: u64) -> Result<[Fr; DEPTH], MerkleError> {
        if index >= self.len() {
            return Err(MerkleError::OutOfRange(index));
        }
        let mut path = [Fr::zero(); DEPTH];
        let mut k = index;
        for (level, p) in path.iter_mut().enumerate() {
            *p = self.node(level, k ^ 1);
            k >>= 1;
        }
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::from_u64;

    #[test]
    fn empty_roots_agree() {
        assert_eq!(MerkleTree::new().root(), zeros()[DEPTH]);
        assert_eq!(Frontier::default().root(), zeros()[DEPTH]);
    }

    #[test]
    fn frontier_matches_full_tree_and_paths_verify() {
        let mut t = MerkleTree::new();
        let mut f = Frontier::default();
        for i in 0..20u64 {
            let (a, b) = (from_u64(1000 + 2 * i), from_u64(1001 + 2 * i));
            t.append(a).unwrap();
            t.append(b).unwrap();
            assert_eq!(f.append_pair(a, b).unwrap(), 2 * i);
            assert_eq!(t.root(), f.root());
        }
        for i in 0..t.len() {
            let p = t.path(i).unwrap();
            assert_eq!(root_from_path(&t.leaf(i).unwrap(), i, &p), t.root());
            assert_ne!(root_from_path(&t.leaf(i).unwrap(), i ^ 1, &p), t.root());
        }
    }

    #[test]
    fn root_history_ring() {
        let mut f = Frontier::default();
        let empty = f.root();
        assert!(f.is_known_root(&empty));
        assert!(!f.is_known_root(&Fr::zero()));
        let mut first_root = None;
        for i in 0..ROOT_HISTORY as u64 {
            f.append_pair(from_u64(i + 1), from_u64(i + 1)).unwrap();
            if i == 0 {
                first_root = Some(f.root());
            }
        }
        // 128 appends overwrite the empty root (slot 0); the first root is still known.
        assert!(!f.is_known_root(&empty));
        assert!(f.is_known_root(&first_root.unwrap()));
        f.append_pair(from_u64(7), from_u64(7)).unwrap();
        assert!(!f.is_known_root(&first_root.unwrap()));
    }
}
