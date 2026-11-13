//! Polypus Keys registry on NEAR testnet. UNAUDITED — hackathon demo only.
#![allow(clippy::too_many_arguments)]

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::U128;
use schemars::JsonSchema;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

const MAX_FEED_CIPHERTEXT: usize = 2048;
const MAX_HANDLE: usize = 64;
const MAX_BIO: usize = 512;
const MAX_RECEIPT: usize = 256;
const POLY1Q_LEN: usize = 133;
const EVENT_STANDARD: &str = "polypus_keys";
const EVENT_VERSION: &str = "1.0.0";

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Traders,
    TraderIndex,
    Subscriptions,
    FollowersByTrader,
    TradersByFollower,
    Sealed,
    Feed,
    FeedSeq,
    Operators,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct TraderProfile {
    pub handle: String,
    pub shielded_address: String,
    pub solana_address: String,
    pub derivation_path: String,
    pub price: u128,
    pub period_days: u32,
    pub attestor_pubkey: String,
    pub attestor_attestation_digest: String,
    pub bio: String,
    pub current_epoch: u32,
    pub subscriber_count: u32,
    pub latest_pnl_statement: String,
    pub latest_pnl_signature: String,
    pub latest_pnl_at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Eq)]
#[borsh(use_discriminant = true)]
pub enum SubStatus {
    Active = 0,
    Cancelled = 1,
    Expired = 2,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct Subscription {
    pub follower: AccountId,
    pub trader: AccountId,
    pub agent_pubkey: String,
    pub agent_attestation_digest: String,
    pub guardrails_hash: String,
    pub starts_at: u64,
    pub expires_at: u64,
    pub status: SubStatus,
    pub last_sealed_epoch: u32,
    pub payment_receipt: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct FeedEntry {
    pub seq: u64,
    pub epoch: u32,
    pub ciphertext: String,
    pub posted_at: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct KeysRegistry {
    owner: AccountId,
    operators: LookupMap<AccountId, bool>,
    traders: LookupMap<AccountId, TraderProfile>,
    trader_index: Vector<AccountId>,
    /// (follower, trader) -> Subscription
    subscriptions: LookupMap<(AccountId, AccountId), Subscription>,
    followers_by_trader: LookupMap<AccountId, Vec<AccountId>>,
    traders_by_follower: LookupMap<AccountId, Vec<AccountId>>,
    /// (trader, follower, epoch) -> sealed_key base64
    sealed: LookupMap<(AccountId, AccountId, u32), String>,
    feed: LookupMap<AccountId, Vector<FeedEntry>>,
    feed_seq: LookupMap<AccountId, u64>,
}

#[near]
impl KeysRegistry {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            operators: LookupMap::new(StorageKey::Operators),
            traders: LookupMap::new(StorageKey::Traders),
            trader_index: Vector::new(StorageKey::TraderIndex),
            subscriptions: LookupMap::new(StorageKey::Subscriptions),
            followers_by_trader: LookupMap::new(StorageKey::FollowersByTrader),
            traders_by_follower: LookupMap::new(StorageKey::TradersByFollower),
            sealed: LookupMap::new(StorageKey::Sealed),
            feed: LookupMap::new(StorageKey::Feed),
            feed_seq: LookupMap::new(StorageKey::FeedSeq),
        }
    }

    pub fn set_operator(&mut self, account: AccountId, enabled: bool) {
        self.assert_owner();
        if enabled {
            self.operators.insert(&account, &true);
        } else {
            self.operators.remove(&account);
        }
    }

    pub fn register_trader(
        &mut self,
        handle: String,
        shielded_address: String,
        solana_address: String,
        derivation_path: String,
        price: U128,
        period_days: u32,
        attestor_pubkey: String,
        attestor_attestation_digest: String,
        bio: Option<String>,
    ) {
        validate_trader_formats(&shielded_address, &solana_address, &handle, bio.as_deref());
        let account = env::predecessor_account_id();
        let bio = bio.unwrap_or_default();
        if !self.traders.contains_key(&account) {
            self.trader_index.push(&account);
        }
        let existing = self.traders.get(&account);
        let current_epoch = existing.as_ref().map(|t| t.current_epoch).unwrap_or(0);
        let subscriber_count = existing.as_ref().map(|t| t.subscriber_count).unwrap_or(0);
        let (latest_pnl_statement, latest_pnl_signature, latest_pnl_at) = existing
            .as_ref()
            .map(|t| {
                (
                    t.latest_pnl_statement.clone(),
                    t.latest_pnl_signature.clone(),
                    t.latest_pnl_at,
                )
            })
            .unwrap_or_default();

        self.traders.insert(
            &account,
            &TraderProfile {
                handle,
                shielded_address,
                solana_address,
                derivation_path,
                price: price.0,
                period_days,
                attestor_pubkey,
                attestor_attestation_digest,
                bio,
                current_epoch,
                subscriber_count,
                latest_pnl_statement,
                latest_pnl_signature,
                latest_pnl_at,
            },
        );
    }

    pub fn set_attestor(
        &mut self,
        attestor_pubkey: String,
        attestor_attestation_digest: String,
    ) {
        let account = env::predecessor_account_id();
        let mut t = self.traders.get(&account).expect("not a trader");
        t.attestor_pubkey = attestor_pubkey;
        t.attestor_attestation_digest = attestor_attestation_digest;
        self.traders.insert(&account, &t);
    }

    #[payable]
    pub fn subscribe(
        &mut self,
        trader: AccountId,
        agent_pubkey: String,
        agent_attestation_digest: String,
        guardrails_hash: String,
    ) {
        let follower = env::predecessor_account_id();
        let profile = self.traders.get(&trader).expect("unknown trader");
        let price = profile.price;
        let attached = env::attached_deposit();
        require!(
            attached.as_yoctonear() >= price,
            "insufficient deposit for subscription price"
        );
        let period_ns = u128::from(profile.period_days) * 86_400_000_000_000u128;
        let now = env::block_timestamp();
        let expires_at = now.saturating_add(period_ns as u64);

        let key = (follower.clone(), trader.clone());
        let mut sub = self.subscriptions.get(&key).unwrap_or(Subscription {
            follower: follower.clone(),
            trader: trader.clone(),
            agent_pubkey: agent_pubkey.clone(),
            agent_attestation_digest: agent_attestation_digest.clone(),
            guardrails_hash: guardrails_hash.clone(),
            starts_at: now,
            expires_at,
            status: SubStatus::Active,
            last_sealed_epoch: profile.current_epoch,
            payment_receipt: String::new(),
        });
        sub.agent_pubkey = agent_pubkey;
        sub.agent_attestation_digest = agent_attestation_digest;
        sub.guardrails_hash = guardrails_hash;
        sub.expires_at = expires_at;
        sub.status = SubStatus::Active;
        self.subscriptions.insert(&key, &sub);
        push_unique(&mut self.followers_by_trader, &trader, &follower);
        push_unique(&mut self.traders_by_follower, &follower, &trader);

        let mut tp = profile;
        tp.subscriber_count = count_active_subs(self, &trader);
        self.traders.insert(&trader, &tp);

        emit_event(
            "subscribe",
            serde_json::json!([{
                "follower": follower,
                "trader": trader,
                "expires_at": expires_at,
            }]),
        );

        let refund = attached
            .as_yoctonear()
            .saturating_sub(price);
        let mut promise = Promise::new(trader).transfer(NearToken::from_yoctonear(price));
        if refund > 0 {
            promise = promise.transfer(NearToken::from_yoctonear(refund));
        }
        promise.as_return();
    }

    pub fn record_external_subscription(
        &mut self,
        follower: AccountId,
        trader: AccountId,
        agent_pubkey: String,
        agent_attestation_digest: String,
        guardrails_hash: String,
        receipt: String,
    ) {
        self.assert_operator();
        require!(receipt.len() <= MAX_RECEIPT, "receipt too long");
        let profile = self.traders.get(&trader).expect("unknown trader");
        let now = env::block_timestamp();
        let period_ns = u128::from(profile.period_days) * 86_400_000_000_000u128;
        let expires_at = now.saturating_add(period_ns as u64);
        let key = (follower.clone(), trader.clone());
        let sub = Subscription {
            follower: follower.clone(),
            trader: trader.clone(),
            agent_pubkey,
            agent_attestation_digest,
            guardrails_hash,
            starts_at: now,
            expires_at,
            status: SubStatus::Active,
            last_sealed_epoch: profile.current_epoch,
            payment_receipt: receipt,
        };
        self.subscriptions.insert(&key, &sub);
        push_unique(&mut self.followers_by_trader, &trader, &follower);
        push_unique(&mut self.traders_by_follower, &follower, &trader);
        let mut tp = profile;
        tp.subscriber_count = count_active_subs(self, &trader);
        self.traders.insert(&trader, &tp);
        emit_event(
            "subscribe",
            serde_json::json!([{
                "follower": follower,
                "trader": trader,
                "external": true,
            }]),
        );
    }

    pub fn unsubscribe(&mut self, trader: AccountId) {
        let follower = env::predecessor_account_id();
        let key = (follower.clone(), trader.clone());
        let mut sub = self.subscriptions.get(&key).expect("no subscription");
        sub.status = SubStatus::Cancelled;
        self.subscriptions.insert(&key, &sub);
        if let Some(mut tp) = self.traders.get(&trader) {
            tp.subscriber_count = count_active_subs(self, &trader);
            self.traders.insert(&trader, &tp);
        }
        emit_event(
            "unsubscribe",
            serde_json::json!([{"follower": follower, "trader": trader}]),
        );
    }

    pub fn update_guardrails(&mut self, trader: AccountId, guardrails_hash: String) {
        let follower = env::predecessor_account_id();
        require!(guardrails_hash.len() <= MAX_RECEIPT, "guardrails_hash too long");
        let key = (follower.clone(), trader.clone());
        let mut sub = self.subscriptions.get(&key).expect("no subscription");
        require!(sub.status == SubStatus::Active, "subscription not active");
        sub.guardrails_hash = guardrails_hash.clone();
        self.subscriptions.insert(&key, &sub);
        emit_event(
            "guardrails",
            serde_json::json!([{"follower": follower, "trader": trader, "guardrails_hash": guardrails_hash}]),
        );
    }

    pub fn rotate_epoch(
        &mut self,
        epoch: u32,
        sealed: Vec<SealedKeyItem>,
    ) {
        let trader = env::predecessor_account_id();
        let mut profile = self.traders.get(&trader).expect("not a trader");
        require!(
            epoch == profile.current_epoch || epoch == profile.current_epoch + 1,
            "invalid epoch"
        );
        profile.current_epoch = epoch;
        let sealed_count = sealed.len();
        for item in sealed {
            let follower: AccountId = item
                .follower
                .parse()
                .unwrap_or_else(|_| env::panic_str("invalid follower account"));
            let k = (trader.clone(), follower, epoch);
            self.sealed.insert(&k, &item.sealed_key);
        }
        self.traders.insert(&trader, &profile);
        emit_event(
            "epoch",
            serde_json::json!([{"trader": trader, "epoch": epoch, "sealed_count": sealed_count}]),
        );
    }

    pub fn post_feed(&mut self, epoch: u32, ciphertext: String) {
        let trader = env::predecessor_account_id();
        require!(
            self.traders.contains_key(&trader),
            "not a trader"
        );
        require!(
            ciphertext.len() <= MAX_FEED_CIPHERTEXT,
            "ciphertext too large"
        );
        let seq = self.feed_seq.get(&trader).unwrap_or(0) + 1;
        self.feed_seq.insert(&trader, &seq);
        let entry = FeedEntry {
            seq,
            epoch,
            ciphertext,
            posted_at: env::block_timestamp(),
        };
        let mut vec = self.feed.get(&trader).unwrap_or_else(|| Vector::new(feed_prefix(&trader)));
        vec.push(&entry);
        self.feed.insert(&trader, &vec);
        emit_event(
            "feed",
            serde_json::json!([{"trader": trader, "seq": seq, "epoch": epoch}]),
        );
    }

    /// Early deployments gave every trader's feed vector the same storage prefix, so entries collided.
    /// Moves the caller's feed to its own prefix; sequence numbers keep counting up.
    pub fn reset_feed(&mut self) {
        let trader = env::predecessor_account_id();
        require!(self.traders.contains_key(&trader), "not a trader");
        self.feed.insert(&trader, &Vector::new(feed_prefix(&trader)));
        emit_event("feed_reset", serde_json::json!([{"trader": trader}]));
    }

    pub fn publish_pnl(
        &mut self,
        trader: AccountId,
        statement: String,
        signature: String,
    ) {
        let profile = self.traders.get(&trader).expect("unknown trader");
        verify_ed25519_statement(&profile.attestor_pubkey, &statement, &signature);
        let mut tp = profile;
        tp.latest_pnl_statement = statement;
        tp.latest_pnl_signature = signature;
        tp.latest_pnl_at = env::block_timestamp();
        self.traders.insert(&trader, &tp);
        emit_event("pnl", serde_json::json!([{"trader": trader}]));
    }

    pub fn get_trader(&self, account: AccountId) -> Option<TraderView> {
        self.traders.get(&account).map(|t| trader_view(&account, &t))
    }

    pub fn get_traders(&self, from_index: u64, limit: u32) -> Vec<TraderView> {
        let len = self.trader_index.len();
        let mut out = Vec::new();
        let end = (from_index + u64::from(limit)).min(len);
        for i in from_index..end {
            if let Some(acc) = self.trader_index.get(i) {
                if let Some(t) = self.traders.get(&acc) {
                    out.push(trader_view(&acc, &t));
                }
            }
        }
        out
    }

    pub fn get_subscription(&self, follower: AccountId, trader: AccountId) -> Option<SubscriptionView> {
        self.subscriptions
            .get(&(follower, trader))
            .map(subscription_view)
    }

    pub fn get_followers(&self, trader: AccountId) -> Vec<SubscriptionView> {
        self.followers_by_trader
            .get(&trader)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| self.subscriptions.get(&(f, trader.clone())))
            .map(subscription_view)
            .collect()
    }

    pub fn get_subscriptions_of(&self, follower: AccountId) -> Vec<SubscriptionView> {
        self.traders_by_follower
            .get(&follower)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|t| self.subscriptions.get(&(follower.clone(), t)))
            .map(subscription_view)
            .collect()
    }

    pub fn get_feed_len(&self, trader: AccountId) -> u64 {
        self.feed_seq.get(&trader).unwrap_or(0)
    }

    pub fn get_sealed_key(
        &self,
        trader: AccountId,
        follower: AccountId,
        epoch: u32,
    ) -> Option<String> {
        self.sealed.get(&(trader, follower, epoch))
    }

    pub fn get_feed(&self, trader: AccountId, from_seq: u64, limit: u32) -> Vec<FeedEntryView> {
        let Some(vec) = self.feed.get(&trader) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for i in 0..vec.len() {
            let e = vec.get(i).unwrap();
            if e.seq >= from_seq {
                out.push(FeedEntryView {
                    seq: e.seq,
                    epoch: e.epoch,
                    ciphertext: e.ciphertext,
                    posted_at: e.posted_at,
                });
                if out.len() >= limit as usize {
                    break;
                }
            }
        }
        out
    }
}

#[derive(Serialize, Deserialize, JsonSchema, BorshDeserialize, BorshSerialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SealedKeyItem {
    pub follower: String,
    pub agent_pubkey: String,
    pub sealed_key: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct TraderView {
    pub account: String,
    pub handle: String,
    pub shielded_address: String,
    pub solana_address: String,
    pub derivation_path: String,
    pub price: String,
    pub period_days: u32,
    pub attestor_pubkey: String,
    pub attestor_attestation_digest: String,
    pub bio: String,
    pub current_epoch: u32,
    pub subscriber_count: u32,
    pub latest_pnl_statement: String,
    pub latest_pnl_signature: String,
    pub latest_pnl_at: u64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct SubscriptionView {
    pub follower: String,
    pub trader: String,
    pub agent_pubkey: String,
    pub agent_attestation_digest: String,
    pub guardrails_hash: String,
    pub starts_at: u64,
    pub expires_at: u64,
    pub status: String,
    pub last_sealed_epoch: u32,
    pub payment_receipt: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct FeedEntryView {
    pub seq: u64,
    pub epoch: u32,
    pub ciphertext: String,
    pub posted_at: u64,
}

impl KeysRegistry {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_operator(&self) {
        let p = env::predecessor_account_id();
        require!(
            p == self.owner || self.operators.get(&p).unwrap_or(false),
            "operator only"
        );
    }
}

fn trader_view(account: &AccountId, t: &TraderProfile) -> TraderView {
    TraderView {
        account: account.to_string(),
        handle: t.handle.clone(),
        shielded_address: t.shielded_address.clone(),
        solana_address: t.solana_address.clone(),
        derivation_path: t.derivation_path.clone(),
        price: t.price.to_string(),
        period_days: t.period_days,
        attestor_pubkey: t.attestor_pubkey.clone(),
        attestor_attestation_digest: t.attestor_attestation_digest.clone(),
        bio: t.bio.clone(),
        current_epoch: t.current_epoch,
        subscriber_count: t.subscriber_count,
        latest_pnl_statement: t.latest_pnl_statement.clone(),
        latest_pnl_signature: t.latest_pnl_signature.clone(),
        latest_pnl_at: t.latest_pnl_at,
    }
}

fn subscription_view(s: Subscription) -> SubscriptionView {
    let status = match s.status {
        SubStatus::Active => "active",
        SubStatus::Cancelled => "cancelled",
        SubStatus::Expired => "expired",
    };
    SubscriptionView {
        follower: s.follower.to_string(),
        trader: s.trader.to_string(),
        agent_pubkey: s.agent_pubkey,
        agent_attestation_digest: s.agent_attestation_digest,
        guardrails_hash: s.guardrails_hash,
        starts_at: s.starts_at,
        expires_at: s.expires_at,
        status: status.into(),
        last_sealed_epoch: s.last_sealed_epoch,
        payment_receipt: s.payment_receipt,
    }
}

fn validate_trader_formats(
    shielded: &str,
    solana: &str,
    handle: &str,
    bio: Option<&str>,
) {
    require!(
        shielded.starts_with("poly1q") && shielded.len() == POLY1Q_LEN,
        "shielded_address must be poly1q… 133 chars"
    );
    require!(
        bs58::decode(solana).into_vec().map(|v| v.len() == 32).unwrap_or(false),
        "solana_address must be 32-byte base58"
    );
    require!(handle.len() <= MAX_HANDLE, "handle too long");
    if let Some(b) = bio {
        require!(b.len() <= MAX_BIO, "bio too long");
    }
}

fn verify_ed25519_statement(attestor_pubkey_b58: &str, statement: &str, signature_b58: &str) {
    let pk = bs58::decode(attestor_pubkey_b58)
        .into_vec()
        .expect("bad attestor_pubkey base58");
    require!(pk.len() == 32, "attestor_pubkey must be 32 bytes");
    let sig = bs58::decode(signature_b58)
        .into_vec()
        .expect("bad signature base58");
    require!(sig.len() == 64, "signature must be 64 bytes");
    let hash = env::sha256_array(statement.as_bytes());
    let mut pk_arr = [0u8; 32];
    pk_arr.copy_from_slice(&pk);
    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&sig);
    let ok = env::ed25519_verify(&sig_arr, &hash, &pk_arr);
    require!(ok, "ed25519 signature mismatch");
}

fn feed_prefix(trader: &AccountId) -> Vec<u8> {
    let mut p = b"fv".to_vec();
    p.extend_from_slice(&env::sha256_array(trader.as_bytes()));
    p
}

fn push_unique(
    map: &mut LookupMap<AccountId, Vec<AccountId>>,
    primary: &AccountId,
    other: &AccountId,
) {
    let mut v = map.get(primary).unwrap_or_default();
    if !v.iter().any(|a| a == other) {
        v.push(other.clone());
        map.insert(primary, &v);
    }
}

fn count_active_subs(contract: &KeysRegistry, trader: &AccountId) -> u32 {
    let Some(followers) = contract.followers_by_trader.get(trader) else {
        return 0;
    };
    let mut n = 0u32;
    for f in followers {
        if let Some(sub) = contract.subscriptions.get(&(f, trader.clone())) {
            if sub.status == SubStatus::Active && sub.expires_at > env::block_timestamp() {
                n += 1;
            }
        }
    }
    n
}

fn emit_event(event: &str, data: serde_json::Value) {
    let payload = serde_json::json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(predecessor);
        b
    }

    #[test]
    fn register_and_subscribe() {
        let owner = accounts(0);
        let alice = accounts(1);
        let carol = accounts(2);
        let mut contract = KeysRegistry::new(owner.clone());
        testing_env!(ctx(alice.clone()).build());
        contract.register_trader(
            "alice".into(),
            format!("poly1q{}", "q".repeat(POLY1Q_LEN - 6)),
            bs58::encode([1u8; 32]).into_string(),
            "solana-1".into(),
            U128(1),
            30,
            bs58::encode([2u8; 32]).into_string(),
            "abc".into(),
            None,
        );
        testing_env!(ctx(carol.clone()).attached_deposit(NearToken::from_yoctonear(1)).build());
        contract.subscribe(
            alice.clone(),
            bs58::encode([3u8; 32]).into_string(),
            "att".into(),
            "gh".into(),
        );
        let sub = contract.get_subscription(carol.clone(), alice.clone()).unwrap();
        assert_eq!(sub.status, "active");
        assert_eq!(contract.get_followers(alice.clone()).len(), 1);
        assert_eq!(contract.get_subscriptions_of(carol.clone()).len(), 1);
        testing_env!(ctx(carol.clone()).build());
        contract.update_guardrails(alice.clone(), "sha256-new".into());
        assert_eq!(contract.get_subscription(carol.clone(), alice.clone()).unwrap().guardrails_hash, "sha256-new");
    }

    #[test]
    fn feeds_do_not_collide() {
        let owner = accounts(0);
        let mut contract = KeysRegistry::new(owner);
        for t in [accounts(1), accounts(2)] {
            testing_env!(ctx(t.clone()).build());
            contract.register_trader(
                t.to_string(),
                format!("poly1q{}", "q".repeat(POLY1Q_LEN - 6)),
                bs58::encode([1u8; 32]).into_string(),
                "solana-1".into(),
                U128(1),
                30,
                bs58::encode([2u8; 32]).into_string(),
                "abc".into(),
                None,
            );
            contract.post_feed(1, format!("ct-{}", t));
        }
        assert_eq!(contract.get_feed(accounts(1), 0, 10)[0].ciphertext, format!("ct-{}", accounts(1)));
        assert_eq!(contract.get_feed(accounts(2), 0, 10)[0].ciphertext, format!("ct-{}", accounts(2)));
    }
}
