//! 루트 크레이트: 컴파일러와 렌더러를 잇는 통합 지점.

use std::path::Path;

/// 콘텐츠 해시(FNV-1a 64bit). 자산 파일명·dedup용. 알고리즘이 고정 상수(offset basis·prime)라
/// 버전 간 안정 — 표준 라이브러리 해시류와 달리 산출물 식별자로 오래 쓸 수 있다.
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

/// 원본 경로 + 내용 → 산출 자산 경로 `res/<basename>.<내용해시>.<ext>`.
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

/// 문자열 배열을 JSON 배열 문자열로(의존 없이 직접 조립). 따옴표·백슬래시만 이스케이프 —
/// 경로엔 제어문자가 없다고 본다.
pub fn json_array(items: &[String]) -> String {
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

#[derive(Debug)]
pub enum RenderError {
    Compile(compiler::CompileError),
    Render(renderer::RenderError),
}

/// use 없는 단일 .qubc 소스를 컴파일하고 comp_id를 진입점으로 렌더해 HTML을 만든다.
pub fn render_source(src: &str, comp_id: u16, scope: &[String]) -> Result<String, RenderError> {
    // 단일 소스 — resolver는 호출되지 않는다.
    render_with("entry", src, &(|_: &str, _: &str| None), comp_id, scope)
}

/// 엔트리 소스를 use resolver와 함께 컴파일·렌더한다. resolver로 외부 소스를 합성한다.
pub fn render_with(
    entry_path: &str,
    src: &str,
    resolver: &impl compiler::Resolver,
    comp_id: u16,
    scope: &[String],
) -> Result<String, RenderError> {
    let output = compiler::compile_src(entry_path, src, resolver).map_err(RenderError::Compile)?;
    renderer::render_to_string(&output.bytecode, comp_id, scope, &output.resources)
        .map_err(RenderError::Render)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 합성 end-to-end: 부모(Card)가 자식(Label)을 호출하며 자기 scope의 값을 바인딩한다.
    /// Label(text={title}) — title은 부모 offset1. 자식은 그 값을 받아 출력.
    #[test]
    fn composition_passes_parent_value_to_child() {
        let src = r#"
            component Card {
              props { heading, title }
              template {
                div(class="card") {
                  h2() { {heading} }
                  Label(text={title}) {}
                }
              }
            }
            component Label {
              props { text }
              template { span(class="label") { {text} } }
            }
        "#;
        // Card = comp_id 0. scope=[heading, title].
        let html = render_source(src, 0, &["제목".to_string(), "본문".to_string()]).unwrap();
        assert_eq!(
            html,
            r#"<div class="card"><h2>제목</h2><span class="label">본문</span></div>"#
        );
    }

    /// use-site 리터럴 인자: 부모가 자식에 변수가 아닌 리터럴을 직접 넘긴다(`Label(text="고정")`).
    /// 부모 scope에 없는 값이라 PUSH_ARG_LIT로 상수풀에서 자식에 전달된다.
    #[test]
    fn composition_passes_literal_to_child() {
        let src = r#"
            component Card {
              template {
                div(class="card") {
                  Label(text="고정") {}
                }
              }
            }
            component Label {
              props { text }
              template { span(class="label") { {text} } }
            }
        "#;
        let html = render_source(src, 0, &[]).unwrap();
        assert_eq!(
            html,
            r#"<div class="card"><span class="label">고정</span></div>"#
        );
    }

    /// 한 자식에 리터럴 인자와 변수 인자를 섞어 넘긴다 — PUSH_ARG_LIT·PUSH_ARG가 자식 prop
    /// 선언 순서대로 정렬돼 함께 전달된다.
    #[test]
    fn composition_mixes_literal_and_var_args() {
        let src = r#"
            component Parent {
              props { name }
              template { Child(label="이름:" value={name}) {} }
            }
            component Child {
              props { label, value }
              template { div() { {label} " " {value} } }
            }
        "#;
        let html = render_source(src, 0, &["철수".to_string()]).unwrap();
        assert_eq!(html, "<div>이름: 철수</div>");
    }

    /// 자식 props 선언 순서대로 PUSH_ARG가 정렬된다 — use-site 인자 순서와 무관.
    #[test]
    fn composition_reorders_args_to_child_prop_order() {
        let src = r#"
            component Parent {
              props { a, b }
              template { Child(second={b} first={a}) {} }
            }
            component Child {
              props { first, second }
              template { div() { {first} "-" {second} } }
            }
        "#;
        let html = render_source(src, 0, &["A".to_string(), "B".to_string()]).unwrap();
        assert_eq!(html, "<div>A-B</div>");
    }

    /// use로 외부 소스의 컴포넌트를 합성. 메모리맵 resolver가 경로를 정규화 없이 그대로 키로 쓴다.
    /// 단일 파일(composition_passes_parent_value_to_child)과 같은 HTML이 나와야 한다 — 평탄화 동등성.
    #[test]
    fn use_composes_external_source() {
        let entry = r#"
            use Label from "./label.qubc"
            component Card {
              props { heading, title }
              template {
                div(class="card") {
                  h2() { {heading} }
                  Label(text={title}) {}
                }
              }
            }
        "#;
        let label = r#"
            component Label {
              props { text }
              template { span(class="label") { {text} } }
            }
        "#;
        // resolver: base 무시, target을 그대로 키로. "./label.qubc" -> label 소스.
        let resolve = |_base: &str, target: &str| {
            (target == "./label.qubc").then(|| (target.to_string(), label.to_string()))
        };
        let html = render_with(
            "entry",
            entry,
            &resolve,
            0,
            &["제목".to_string(), "본문".to_string()],
        )
        .unwrap();
        assert_eq!(
            html,
            r#"<div class="card"><h2>제목</h2><span class="label">본문</span></div>"#
        );
    }

    /// 한 외부 소스에서 여러 컴포넌트를 use 해 둘 다 합성. compile -> 바이트코드 -> render 전 과정.
    /// Thumb·Badge 둘 다 출력에 나타나야 한다.
    #[test]
    fn use_multiple_components_render() {
        let entry = r#"
            use Thumb, Badge from "./parts.qubc"
            component Card {
              props { img, role }
              template {
                div(class="card") {
                  Thumb(src={img}) {}
                  Badge(text={role}) {}
                }
              }
            }
        "#;
        let parts = r#"
            component Thumb {
              props { src }
              template { img(src={src}) {} }
            }
            component Badge {
              props { text }
              template { span(class="badge") { {text} } }
            }
        "#;
        let resolve = |_base: &str, target: &str| {
            (target == "./parts.qubc").then(|| (target.to_string(), parts.to_string()))
        };
        let html = render_with(
            "entry",
            entry,
            &resolve,
            0,
            &["/img/a".to_string(), "엔지니어".to_string()],
        )
        .unwrap();
        assert_eq!(
            html,
            r#"<div class="card"><img src="/img/a"></img><span class="badge">엔지니어</span></div>"#
        );
    }
}
