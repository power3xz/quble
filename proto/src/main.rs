//! Quble 컴파일러 바이너리: .qubc 소스 파일 → 컴파일 → 현재 디렉토리의 dist/<name>.qubb.
//! 사용: quble <path/to/component.qubc>

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: quble <component.qubc>");
        return ExitCode::FAILURE;
    };

    let src = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("파일 읽기 실패 {path}: {e}");
            return ExitCode::FAILURE;
        }
    };

    let bytes = match compiler::compile(&src) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("컴파일 실패: {e:?}");
            return ExitCode::FAILURE;
        }
    };

    // 산출물 이름은 입력 파일 stem. 현재 디렉토리의 dist/ 아래에 .qubb로.
    let name = Path::new(&path).file_stem().and_then(|s| s.to_str()).unwrap_or("out");
    let out_dir = Path::new("dist");
    if let Err(e) = std::fs::create_dir_all(out_dir) {
        eprintln!("dist 생성 실패: {e}");
        return ExitCode::FAILURE;
    }
    let out_path = out_dir.join(format!("{name}.qubb"));
    if let Err(e) = std::fs::write(&out_path, &bytes) {
        eprintln!("산출물 쓰기 실패 {}: {e}", out_path.display());
        return ExitCode::FAILURE;
    }

    println!("{} ({} bytes)", out_path.display(), bytes.len());
    ExitCode::SUCCESS
}
