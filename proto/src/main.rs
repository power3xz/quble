//! Quble 컴파일러 바이너리: .qubc 소스 파일 → 컴파일 → 현재 디렉토리의 dist/<name>.qubb.
//! 사용: quble <path/to/component.qubc>

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: quble <component.qubc>");
        return ExitCode::FAILURE;
    };

    // compile_file이 엔트리 파일을 읽고, use는 importer 기준 상대경로로 해소한다.
    let output = match compiler::compile_file(&path) {
        Ok(output) => output,
        Err(e) => {
            eprintln!("컴파일 실패: {e:?}");
            return ExitCode::FAILURE;
        }
    };
    let bytes = output.bytecode;

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

    // 리소스를 dist/res/로 복사(해시 파일명)하고, resId -> 산출 상대경로 사이드맵을 JSON 배열로 낸다.
    // 산출물이 자립적이도록 CSS 파일도 함께 둔다. URL prefix(CDN 등)는 이후 빌드/배포가 붙인다
    // (BYTECODE.md §5 LOAD_RES 메모). 리소스가 없으면 res/도 resmap도 만들지 않는다.
    if !output.resources.is_empty() {
        let emitted = match emit_resources(out_dir, &output.resources) {
            Ok(paths) => paths,
            Err(e) => {
                eprintln!("리소스 복사 실패: {e}");
                return ExitCode::FAILURE;
            }
        };
        let resmap_path = out_dir.join(format!("{name}.resmap.json"));
        if let Err(e) = std::fs::write(&resmap_path, json_array(&emitted)) {
            eprintln!("리소스맵 쓰기 실패 {}: {e}", resmap_path.display());
            return ExitCode::FAILURE;
        }
        println!("{} ({} resources)", resmap_path.display(), emitted.len());
    }

    println!("{} ({} bytes)", out_path.display(), bytes.len());
    ExitCode::SUCCESS
}

/// 리소스 정규화 경로들을 dist/res/로 복사한다. 파일명은 `<basename>.<내용해시>.css` —
/// 평탄화 시 동명 충돌을 막고 캐시 버스팅도 겸한다. resId 순서대로 산출 상대경로(`res/...`)를 반환.
fn emit_resources(out_dir: &Path, resources: &[String]) -> std::io::Result<Vec<String>> {
    let res_dir = out_dir.join("res");
    std::fs::create_dir_all(&res_dir)?;
    let mut emitted = Vec::with_capacity(resources.len());
    for path in resources {
        let bytes = std::fs::read(path)?;
        let src = Path::new(path);
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("res");
        let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
        let hash = content_hash(&bytes);
        let out_name = if ext.is_empty() {
            format!("{stem}.{hash}")
        } else {
            format!("{stem}.{hash}.{ext}")
        };
        std::fs::write(res_dir.join(&out_name), &bytes)?;
        emitted.push(format!("res/{out_name}"));
    }
    Ok(emitted)
}

/// 콘텐츠 해시(FNV-1a 64bit). 자산 파일명·dedup용. 알고리즘이 고정 상수(offset basis·prime)라
/// 버전 간 안정 — 표준 라이브러리 해시류와 달리 산출물 식별자로 오래 쓸 수 있다.
fn content_hash(bytes: &[u8]) -> String {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET_BASIS;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// 문자열 배열을 JSON 배열 문자열로(의존 없이 직접 조립). 따옴표·백슬래시만 이스케이프 —
/// 경로엔 제어문자가 없다고 본다.
fn json_array(items: &[String]) -> String {
    let mut out = String::from("[");
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        for ch in item.chars() {
            if ch == '"' || ch == '\\' {
                out.push('\\');
            }
            out.push(ch);
        }
        out.push('"');
    }
    out.push(']');
    out
}
