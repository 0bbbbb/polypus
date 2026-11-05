#!/usr/bin/env bash
set -euo pipefail
REG=polypus-keys-18e5.testnet
ALICE=alice-18e5.testnet
BOB=bob-18e5.testnet
SHIELD_ALICE="poly1q8rln83648xzns23vxms90m53dlr07dthdeuctlfvy0fn6huhc58ee5t4erm7cf9r3knvqsxxmymqzunyf5t28636nv3e7eh7fw9scec6pxwcacz869hh9e8jygl4lkl"
SHIELD_BOB="poly1q8e6vz3ydskm09f4p46tsxw3k6t7ze8z32pgy2zfar87zfw6lws84lhzq5nr3v855y62yje8trq6qx775n53c3lqwyrcsqcva2raws6mlcjpvevckdsczrpyf5s2umyr"
SOL_ALICE="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
SOL_BOB="11111111111111111111111111111112"
ATTESTOR="4Hj8qesSoj3AAZL2bQbofAxgcNbX6yVQkFaz3xJGZJqA"

register() {
  local signer=$1
  local args=$2
  NEAR_ENV=testnet near contract call-function as-transaction "$REG" register_trader json-args "$args" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$signer" network-config testnet sign-with-keychain send
}

register "$ALICE" "{\"handle\":\"kestrel\",\"shielded_address\":\"$SHIELD_ALICE\",\"solana_address\":\"$SOL_ALICE\",\"derivation_path\":\"solana-1\",\"price\":\"500000000000000000000000\",\"period_days\":30,\"attestor_pubkey\":\"$ATTESTOR\",\"attestor_attestation_digest\":\"simulated\",\"bio\":\"Hackathon demo trader\"}"
register "$BOB" "{\"handle\":\"heron\",\"shielded_address\":\"$SHIELD_BOB\",\"solana_address\":\"$SOL_BOB\",\"derivation_path\":\"solana-1\",\"price\":\"300000000000000000000000\",\"period_days\":30,\"attestor_pubkey\":\"$ATTESTOR\",\"attestor_attestation_digest\":\"simulated\",\"bio\":\"Demo trader 2\"}"
