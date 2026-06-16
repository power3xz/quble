//! end-to-end: .qubc 소스 파일 → 컴파일 → VM 렌더 → stdout.
//! 사용: cargo run -- <file.qubc>  (생략 시 examples/hello.qubc)

use std::process::ExitCode;

fn main() -> ExitCode {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "examples/hello.qubc".to_string());

    let src = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("파일 읽기 실패 {path}: {e}");
            return ExitCode::FAILURE;
        }
    };

    // 진입점은 컴포넌트 ID 0 (프로토타입은 단일 컴포넌트).
    match quble::render_source(&src, 0) {
        Ok(html) => {
            println!("{html}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("렌더 실패: {e:?}");
            ExitCode::FAILURE
        }
    }
}
