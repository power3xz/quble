//! 벤치용: .qubc 파일을 컴파일해 qubb 바이트를 stdout으로. 사용: emit <file.qubc>
use std::io::Write;

fn main() {
    let path = std::env::args().nth(1).expect("usage: emit <file.qubc>");
    let src = std::fs::read_to_string(&path).expect("read");
    let bytes = compiler::compile(&src).expect("compile");
    std::io::stdout().write_all(&bytes).unwrap();
}
