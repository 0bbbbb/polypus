# ADR-0005: Kernel v1 (M1) scope — what is in the circuit, what is deferred

- Status: accepted (M1)
- Date: 2026-11-03

## Decisions

1. **Arity 2-in/2-out**, as in design §3.3. Fixed shape, no padding variants.
2. **Dummy inputs = zero-amount inputs.** They skip Merkle membership (K4) but
   still produce nullifiers (K5), which the pool publishes. Wallets must use a
   fresh random `rseed` for every dummy. Ownership of dummies is not enforced,
   which is harmless because they carry no value.
3. **One `(ask, nk)` per action**, and a diversifier `d` per input. Merging
   notes received on different diversified addresses of one wallet works;
   merging notes of two different wallets needs two actions.
4. **Output well-formedness:** an unlocked output must have `lock_data = 0`
   and `escape = 0` (canonical form). A locked output must have a non-zero
   `escape` (the design's "escape is mandatory" rule, enforced when the note is
   created).
5. **Lock rule, M1 subset (K10):** an input with `lock_program ≠ 0` can only be
   spent in an action whose `program_id` equals it. **The escape path (open
   `escape = H(refund_owner, unlock_after)`, prove ownership of
   `refund_owner`, expose `unlock_after`) is deferred to M3**, together with
   the program registry and program-proof verification.
   - *Safety:* the M2 pool rejects `program_id ≠ 0`, so locked notes cannot be
     spent at all yet. Funds locked on devnet before M3 stay locked until the
     M3 kernel ships, and the M3 kernel needs a new VK, hence a new pool.
     Wallets must not create locked outputs before M3.
6. **Program binding (K11)** is already in the circuit:
   `program_io_hash = H_7(T_IO, program_id, nf0, nf1, cm0, cm1,
   program_params_hash)`, or 0 for program 0. M3 adds the program-side half.
7. **`nf[0] ≠ nf[1]`** is enforced in-circuit (K6) even though the pool's
   nullifier PDAs would also reject a duplicate.

## Consequences

- M3 must change the kernel: the escape path adds an extra owner-derivation
  input and exposes `unlock_after` through a public value. Kernel VK v1 is
  therefore an M1/M2 artefact, not the launch VK.
- The full constraint list K1–K12 is in `spec/SPEC.md` §6.3, and each
  constraint has a named negative test in `circuits/kernel/src/tests.nr`.
