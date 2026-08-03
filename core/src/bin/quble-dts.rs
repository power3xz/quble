//! .qubc 소스에서 핸들러 타입(.d.ts) 텍스트만 stdout으로 낸다(파일 부작용 없음).
//! 바이트코드를 거치지 않고 AST를 직접 걸어 props 이름을 살린다(quble-bytecode와 대칭).
//! 사용: quble-dts <component.qubc> > component.qubc.d.ts  (또는 파이프)

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: quble-dts <component.qubc>");
        return ExitCode::FAILURE;
    };

    let dts = match compiler::handlers_dts_from_path(&path) {
        Ok(dts) => dts,
        Err(e) => {
            eprintln!("{}", quble::compile_error_text(&path, &e));
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = std::io::stdout().write_all(dts.as_bytes()) {
        eprintln!("stdout 쓰기 실패: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
