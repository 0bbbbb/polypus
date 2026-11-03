use poseidon::poseidon::bn254;
fn main(a: Field, b: Field, out: pub Field) {
    assert(bn254::hash_2([a, b]) == out);
}
#[test]
fn t() {
    let h = bn254::hash_2([1, 2]);
    std::println(h);
    assert(h == 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a);
}
