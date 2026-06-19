//! 루트 크레이트: 컴파일러와 렌더러를 잇는 통합 지점.

#[derive(Debug)]
pub enum RenderError {
    Compile(compiler::CompileError),
    Render(renderer::RenderError),
}

/// .qubc 소스를 컴파일하고 comp_id를 진입점으로 렌더해 HTML을 만든다.
pub fn render_source(src: &str, comp_id: u16, scope: &[String]) -> Result<String, RenderError> {
    let bytecode = compiler::compile(src).map_err(RenderError::Compile)?;
    renderer::render_to_string(&bytecode, comp_id, scope).map_err(RenderError::Render)
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
}
