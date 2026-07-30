//! 루트 크레이트: 컴파일러와 렌더러를 잇는 통합 지점.

use std::path::Path;

/// 콘텐츠 해시(FNV-1a 64bit). 자산 파일명/dedup용. 알고리즘이 고정 상수(offset basis/prime)라
/// 버전 간 안정 - 표준 라이브러리 해시류와 달리 산출물 식별자로 오래 쓸 수 있다.
pub fn content_hash(bytes: &[u8]) -> String {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET_BASIS;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// 원본 경로 + 내용 -> 산출 자산 경로 `res/<basename>.<내용해시>.<ext>`.
/// 평탄화 시 동명 충돌 방지 + 캐시 버스팅.
pub fn asset_path(origin: &Path, content: &[u8]) -> String {
    let stem = origin.file_stem().and_then(|s| s.to_str()).unwrap_or("res");
    let ext = origin.extension().and_then(|s| s.to_str()).unwrap_or("");
    let hash = content_hash(content);
    if ext.is_empty() {
        format!("res/{stem}.{hash}")
    } else {
        format!("res/{stem}.{hash}.{ext}")
    }
}

/// 문자열 배열을 JSON 배열 문자열로(의존 없이 직접 조립). 따옴표/백슬래시만 이스케이프 -
/// 경로엔 제어문자가 없다고 본다.
/// 문자열 하나를 JSON 문자열 리터럴(`"..."`)로. `"`/`\`만 이스케이프(경로엔 이 둘이면 충분).
fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

pub fn json_array(items: &[String]) -> String {
    let mut out = String::from("[");
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&json_string(item));
    }
    out.push(']');
    out
}

/// 루트 컴포넌트 실행 명세(manifest) JSON. `resources`는 LOAD_RES가 인덱스로 참조하는 CSS 경로.
/// `handlers`는 짝 핸들러 JS 경로 - 없으면 필드를 생략한다(바이트 절약).
pub fn manifest_json(resources: &[String], handlers: Option<&str>) -> String {
    let mut out = format!("{{\"resources\":{}", json_array(resources));
    if let Some(h) = handlers {
        out.push_str(",\"handlers\":");
        out.push_str(&json_string(h));
    }
    out.push('}');
    out
}

/// 컴파일 실패를 진단 텍스트로. 소스를 파일에서 읽고 현재 디렉터리로 경로를 줄여
/// `compiler::format_error`에 넘긴다 - 바이너리 넷이 같은 형식으로 내도록 여기 한 번만 둔다.
/// 파일시스템과 cwd를 보므로 컴파일러(wasm에서도 도는)가 아니라 이 크레이트의 몫이다.
///
/// 소스를 못 읽으면(경로 자체가 틀린 경우) 빈 소스로 - 그 에러는 소스 안 위치가 없어
/// 첫 줄만 난다.
pub fn compile_error_text(path: &str, err: &compiler::CompileError) -> String {
    let src = std::fs::read_to_string(path).unwrap_or_default();
    let cwd = std::env::current_dir().ok();
    let base = cwd.as_deref().map(|p| p.to_string_lossy());
    compiler::format_error(base.as_deref(), path, &src, err)
}

// 렌더(SSR)는 보류 - renderer 크레이트가 타입화된 상수풀에 미대응이라 의존을 끊었다.
// render_source/render_with와 그 통합 테스트는 SSR 재개 시 복구한다(ISSUES.md).

#[cfg(test)]
mod tests {
    use super::*;

    /// manifest: resources는 항상, handlers는 없으면 생략.
    #[test]
    fn manifest_omits_handlers_when_none() {
        let res = vec!["res/a.css".to_string(), "res/b.css".to_string()];
        assert_eq!(
            manifest_json(&res, None),
            r#"{"resources":["res/a.css","res/b.css"]}"#
        );
        assert_eq!(
            manifest_json(&res, Some("res/x.handlers.js")),
            r#"{"resources":["res/a.css","res/b.css"],"handlers":"res/x.handlers.js"}"#
        );
    }
}
