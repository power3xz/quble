//! .qubc 소스를 React 컴포넌트 모듈(TSX)로 컴파일해 stdout으로 낸다(파일 부작용 없음).
//! 사용: quble-react <component.qubc> > component.tsx  (또는 파이프)

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: quble-react <component.qubc>");
        return ExitCode::FAILURE;
    };

    let tsx = match compiler::react_tsx_from_path(&path) {
        Ok(tsx) => tsx,
        Err(e) => {
            eprintln!("{}", quble::compile_error_text(&path, &e));
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = std::io::stdout().write_all(tsx.as_bytes()) {
        eprintln!("stdout 쓰기 실패: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
