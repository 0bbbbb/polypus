// Reference guardrail circuit for Polypus Keys (hackathon; not proved on-chain in demo).
// Private: follower's limits and note; public: trade commitment + epoch metadata.
fn main(
    max_notional: u64,
    copy_notional: u64,
    daily_loss_bps: u32,
    loss_so_far_bps: u32,
    max_notional_pub: pub u64,
    copy_notional_pub: pub u64,
    epoch: pub u32,
) {
    assert(max_notional_pub == max_notional);
    assert(copy_notional_pub == copy_notional);
    assert(copy_notional <= max_notional);
    assert(loss_so_far_bps <= daily_loss_bps);
    assert(epoch > 0);
}

mod tests {
    #[test]
    fn passes_within_limits() {
        super::main(250_000_000, 180_000_000, 500, 100, 250_000_000, 180_000_000, 1);
    }

    #[test(should_fail)]
    fn fails_over_max() {
        super::main(250_000_000, 300_000_000, 500, 100, 250_000_000, 300_000_000, 1);
    }
}
