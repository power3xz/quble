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

    // 리소스를 dist/res/로 복사(해시 파일명)하고, 루트 실행 명세(manifest)를 낸다. resources는
    // resId -> 산출 상대경로. 산출물이 자립적이도록 CSS 파일도 함께 둔다. URL prefix(CDN 등)는
    // 이후 빌드/배포가 붙인다(BYTECODE.md §5 LOAD_RES 메모). 핸들러(짝 .qubc.handlers.ts) 트랜스파일은
    // 빌드 파이프라인의 몫 - 여기선 아직 CSS 리소스가 있을 때만 manifest를 낸다.
    if !output.resources.is_empty() {
        let emitted = match emit_resources(out_dir, &output.resources) {
            Ok(paths) => paths,
            Err(e) => {
                eprintln!("리소스 복사 실패: {e}");
                return ExitCode::FAILURE;
            }
        };
        let manifest_path = out_dir.join(format!("{name}.manifest.json"));
        if let Err(e) = std::fs::write(&manifest_path, quble::manifest_json(&emitted, None)) {
            eprintln!("manifest 쓰기 실패 {}: {e}", manifest_path.display());
            return ExitCode::FAILURE;
        }
        println!("{} ({} resources)", manifest_path.display(), emitted.len());
    }

    println!("{} ({} bytes)", out_path.display(), bytes.len());
    ExitCode::SUCCESS
}

/// 리소스 정규화 경로들을 dist/res/로 복사한다. 파일명은 `<basename>.<내용해시>.css` -
/// 평탄화 시 동명 충돌을 막고 캐시 버스팅도 겸한다. resId 순서대로 산출 상대경로(`res/...`)를 반환.
fn emit_resources(out_dir: &Path, resources: &[String]) -> std::io::Result<Vec<String>> {
    let res_dir = out_dir.join("res");
    std::fs::create_dir_all(&res_dir)?;
    let mut emitted = Vec::with_capacity(resources.len());
    for path in resources {
        let bytes = std::fs::read(path)?;
        let out_path = quble::asset_path(Path::new(path), &bytes);
        // out_path는 "res/<name>" - res_dir엔 파일명만 쓰고, 사이드맵엔 상대경로 그대로 둔다.
        let out_name = out_path.strip_prefix("res/").unwrap_or(&out_path);
        std::fs::write(res_dir.join(out_name), &bytes)?;
        emitted.push(out_path);
    }
    Ok(emitted)
}
