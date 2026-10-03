//! .qubc 소스를 React 컴포넌트 모듈(TSX)로 컴파일한다.
//! `use "./x.css"` 리소스는 산출 파일 위치에서 본 상대 경로로 import한다.
//! 사용: quble-react <component.qubc> [--out <file.tsx>]
//!   --out이 없으면 stdout으로 내고, 리소스 경로는 현재 디렉터리 기준이다.

use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut path = None;
    let mut out = None;
    while let Some(arg) = args.next() {
        if arg == "--out" {
            match args.next() {
                Some(file) => out = Some(file),
                None => {
                    eprintln!("--out 뒤에 산출 파일 경로가 필요합니다");
                    return ExitCode::FAILURE;
                }
            }
        } else if path.is_none() {
            path = Some(arg);
        } else {
            eprintln!("인자가 너무 많습니다: {arg}");
            return ExitCode::FAILURE;
        }
    }
    let Some(path) = path else {
        eprintln!("usage: quble-react <component.qubc> [--out <file.tsx>]");
        return ExitCode::FAILURE;
    };

    // 리소스 상대 경로의 기준. 정규화된 절대 경로여야 loader가 낸 리소스 경로와 견줄 수 있다.
    let out_dir = match &out {
        Some(file) => {
            let dir = Path::new(file).parent().unwrap_or(Path::new("."));
            let dir = if dir.as_os_str().is_empty() {
                Path::new(".")
            } else {
                dir
            };
            if let Err(e) = std::fs::create_dir_all(dir) {
                eprintln!("디렉터리 만들기 실패 {}: {e}", dir.display());
                return ExitCode::FAILURE;
            }
            std::fs::canonicalize(dir)
        }
        None => std::env::current_dir(),
    };
    let out_dir = match out_dir {
        Ok(dir) => dir.to_string_lossy().into_owned(),
        Err(e) => {
            eprintln!("산출 디렉터리를 못 찾음: {e}");
            return ExitCode::FAILURE;
        }
    };

    let tsx = match compiler::react_tsx_from_path(&path, &out_dir) {
        Ok(tsx) => tsx,
        Err(e) => {
            eprintln!("{}", quble::compile_error_text(&path, &e));
            return ExitCode::FAILURE;
        }
    };

    let written = match &out {
        Some(file) => std::fs::write(file, tsx.as_bytes()),
        None => std::io::stdout().write_all(tsx.as_bytes()),
    };
    if let Err(e) = written {
        eprintln!("쓰기 실패: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
