//! .qubc 소스를 컴파일해 qubb 바이트코드만 stdout으로 낸다(파일 부작용 없음).
//! fullname 산출(disasm.js)에 바이트코드만 필요해, resmap/CSS는 만들지 않는다.
//! 사용: quble-bytecode <component.qubc> > out.qubb  (또는 파이프)

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: quble-bytecode <component.qubc>");
        return ExitCode::FAILURE;
    };

    let output = match compiler::compile_file(&path) {
        Ok(output) => output,
        Err(e) => {
            eprintln!("컴파일 실패: {e:?}");
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = std::io::stdout().write_all(&output.bytecode) {
        eprintln!("stdout 쓰기 실패: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
