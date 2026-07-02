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

#[test]
fn props_var_interpolated_from_scope() {
    let src = r#"
        component Greeting {
          props { name: string }
          template {
            h1() { "Hello, " {name} "!" }
          }
        }
    "#;
    let scope = vec!["세계 <b>".to_string()];
    assert_eq!(
        render_source(src, 0, &scope).unwrap(),
        "<h1>Hello, 세계 &lt;b&gt;!</h1>"
    );
}

#[test]
fn undeclared_prop_is_error() {
    let src = r#"
        component C {
          template { h1() { {missing} } }
        }
    "#;
    assert!(render_source(src, 0, &[]).is_err());
}

#[test]
fn if_else_renders_active_branch() {
    let src = r#"
        component C {
          props { ok: bool }
          template {
            div() {
              @if (ok) { p() { "yes" } }
              @else { p() { "no" } }
            }
          }
        }
    "#;
    assert_eq!(
        render_source(src, 0, &["true".to_string()]).unwrap(),
        "<div><p>yes</p></div>"
    );
    assert_eq!(
        render_source(src, 0, &["false".to_string()]).unwrap(),
        "<div><p>no</p></div>"
    );
}

#[test]
fn if_only_skips_when_false() {
    let src = r#"
        component C {
          props { show: bool }
          template {
            div() {
              @if (show) { span() { "x" } }
            }
          }
        }
    "#;
    assert_eq!(
        render_source(src, 0, &["true".to_string()]).unwrap(),
        "<div><span>x</span></div>"
    );
    assert_eq!(
        render_source(src, 0, &["false".to_string()]).unwrap(),
        "<div></div>"
    );
}
