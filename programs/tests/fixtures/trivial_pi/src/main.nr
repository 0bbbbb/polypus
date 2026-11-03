// TEST-ONLY, INSECURE: a "kernel" whose single public input `pi_hash` is bound
// to the proof but carries no protocol constraints. A pool built with this VK
// (POLYPUS_KERNEL_VK=.../trivial_pi.vk) lets anyone mint; it exists only so the
// LiteSVM tests can drive full deposit / transact / withdraw flows before the
// real kernel exists. NEVER deploy a pool built with it.
fn main(pi_hash: pub Field, x: Field) {
    // Non-linear, so the public input cannot be optimised out of the R1CS.
    assert(x * pi_hash == pi_hash * pi_hash);
    assert(x == pi_hash);
}
