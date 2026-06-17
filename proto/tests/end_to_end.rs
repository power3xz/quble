//! 통합 테스트: 소스 → 컴파일 → 렌더 → HTML. compiler·vm 계약 회귀를 잡는다.

use quble::render_source;

#[test]
fn hello_renders_expected_html() {
    let src = r#"
        component Hello {
          template {
            div(class="greeting") {
              h1() { "Hello" }
              p(class="sub") { "world" }
            }
          }
        }
    "#;
    assert_eq!(
        render_source(src, 0, &[]).unwrap(),
        r#"<div class="greeting"><h1>Hello</h1><p class="sub">world</p></div>"#
    );
}

#[test]
fn escapes_text_and_attr_values() {
    let src = r#"
        component C {
          template {
            div(title="a&b") { "x < y & z" }
          }
        }
    "#;
    assert_eq!(
        render_source(src, 0, &[]).unwrap(),
        r#"<div title="a&amp;b">x &lt; y &amp; z</div>"#
    );
}

#[test]
fn unknown_tag_is_error() {
    let src = r#"component C { template { table() {} } }"#;
    assert!(render_source(src, 0, &[]).is_err());
}
