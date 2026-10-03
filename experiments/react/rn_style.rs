//! CSS를 React Native 스타일로 바꾼다(experiments/react/README.md). 단일 클래스 선택자와 RN이 받는
//! 선언만 변환하고, 나머지는 조용히 버리지 않고 에러로 낸다.

/// 클래스 이름 -> (RN 스타일 속성 이름, JS 리터럴) 목록. 선언 순서를 유지한다.
pub type TClassStyles = Vec<(String, Vec<(String, String)>)>;

#[derive(Debug, PartialEq, Eq)]
pub enum CssError {
    /// `.a:hover`, `span.dark`, `.a, .b`, `@media`처럼 단일 클래스가 아닌 선택자
    UnsupportedSelector(String),
    UnsupportedDeclaration {
        class: String,
        prop: String,
        value: String,
    },
    /// 클래스 이름. 단위 없는 line-height는 같은 클래스의 font-size(px)가 있어야 px로 바꾼다.
    LineHeightWithoutFontSize(String),
    Syntax(String),
}

pub fn css_to_styles(css: &str) -> Result<TClassStyles, CssError> {
    let mut rest = strip_comments(css);
    let mut out: TClassStyles = Vec::new();
    while !rest.trim().is_empty() {
        let (selector, after) = rest
            .split_once('{')
            .ok_or_else(|| CssError::Syntax(format!("'{{'가 없다: {}", rest.trim())))?;
        let (body, after) = after
            .split_once('}')
            .ok_or_else(|| CssError::Syntax(format!("'}}'가 없다: {}", selector.trim())))?;
        let class = class_name(selector.trim())?;
        let decls = convert_rule(&class, body)?;
        let slot = match out.iter().position(|(name, _)| *name == class) {
            Some(i) => &mut out[i].1,
            None => {
                out.push((class, Vec::new()));
                &mut out.last_mut().expect("방금 넣었다").1
            }
        };
        // 같은 클래스를 다시 선언하면 속성별로 나중 것이 이긴다. 자리는 먼저 선언한 곳을 지킨다.
        for (prop, value) in decls {
            match slot.iter_mut().find(|(name, _)| *name == prop) {
                Some(existing) => existing.1 = value,
                None => slot.push((prop, value)),
            }
        }
        rest = after.to_string();
    }
    Ok(out)
}

fn strip_comments(css: &str) -> String {
    let mut out = String::new();
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = match rest[start + 2..].find("*/") {
            Some(end) => &rest[start + 2 + end + 2..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

/// ".ticket__btn" -> "ticket__btn". 단일 클래스가 아니면 에러다.
fn class_name(selector: &str) -> Result<String, CssError> {
    let name = selector.strip_prefix('.').unwrap_or("");
    let is_class = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if is_class {
        Ok(name.to_string())
    } else {
        Err(CssError::UnsupportedSelector(selector.to_string()))
    }
}

/// 규칙 하나의 선언들을 RN 속성으로 바꾼다. 단위 없는 line-height는 font-size를 본 뒤에 정한다.
fn convert_rule(class: &str, body: &str) -> Result<Vec<(String, String)>, CssError> {
    let mut out = Vec::new();
    let mut font_size = None;
    let mut unitless_line_height = None;
    for decl in body.split(';').map(str::trim).filter(|d| !d.is_empty()) {
        let (prop, value) = decl
            .split_once(':')
            .ok_or_else(|| CssError::Syntax(format!(".{class}: ':'가 없다: {decl}")))?;
        let (prop, value) = (prop.trim().to_ascii_lowercase(), value.trim());
        let unsupported = || CssError::UnsupportedDeclaration {
            class: class.to_string(),
            prop: prop.clone(),
            value: value.to_string(),
        };
        let mut push = |name: &str, literal: String| out.push((name.to_string(), literal));
        match prop.as_str() {
            // RN에는 커서가 없고 View는 이미 flex다.
            "cursor" => {}
            "display" => match value {
                "flex" => {}
                "none" => push("display", quote("none")),
                _ => return Err(unsupported()),
            },
            "font-size" => {
                let size = to_px(value).ok_or_else(unsupported)?;
                font_size = Some(size);
                push("fontSize", number(size));
            }
            "line-height" => match to_px(value) {
                Some(size) => push("lineHeight", number(size)),
                None => {
                    unitless_line_height =
                        Some(value.parse::<f64>().map_err(|_| unsupported())?);
                }
            },
            "margin" | "padding" => {
                let sides = box_sides(value).ok_or_else(unsupported)?;
                match sides.as_slice() {
                    [all] => push(&prop, all.clone()),
                    _ => {
                        for (side, literal) in ["Top", "Right", "Bottom", "Left"].iter().zip(sides) {
                            push(&format!("{prop}{side}"), literal);
                        }
                    }
                }
            }
            "border" => {
                if value == "none" {
                    push("borderWidth", "0".to_string());
                    continue;
                }
                for token in split_tokens(value) {
                    if let Some(width) = to_px(&token) {
                        push("borderWidth", number(width));
                    } else if ["solid", "dashed", "dotted"].contains(&token.as_str()) {
                        push("borderStyle", quote(&token));
                    } else if is_color(&token) {
                        push("borderColor", quote(&token));
                    } else {
                        return Err(unsupported());
                    }
                }
            }
            "background" | "background-color" | "color" | "border-color" => {
                if !is_color(value) {
                    return Err(unsupported());
                }
                let name = match prop.as_str() {
                    "background" | "background-color" => "backgroundColor",
                    "border-color" => "borderColor",
                    _ => "color",
                };
                push(name, quote(value));
            }
            "flex" | "flex-grow" | "flex-shrink" | "opacity" | "z-index" => {
                let n = value.parse::<f64>().map_err(|_| unsupported())?;
                push(&camel(&prop), number(n));
            }
            "width" | "height" | "min-width" | "min-height" | "max-width" | "max-height"
            | "top" | "right" | "bottom" | "left" | "gap" | "row-gap" | "column-gap"
            | "border-radius" | "border-width" | "letter-spacing" | "margin-top"
            | "margin-right" | "margin-bottom" | "margin-left" | "padding-top"
            | "padding-right" | "padding-bottom" | "padding-left" => {
                push(&camel(&prop), length(value).ok_or_else(unsupported)?);
            }
            "flex-direction" | "flex-wrap" | "align-items" | "align-self" | "justify-content"
            | "text-align" | "font-weight" | "font-style" | "position" | "overflow"
            | "text-transform" => {
                if !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                    return Err(unsupported());
                }
                push(&camel(&prop), quote(value));
            }
            "text-decoration" => push("textDecorationLine", quote(value)),
            _ => return Err(unsupported()),
        }
    }
    if let Some(ratio) = unitless_line_height {
        let size = font_size.ok_or_else(|| CssError::LineHeightWithoutFontSize(class.to_string()))?;
        out.push((
            "lineHeight".to_string(),
            number((size * ratio * 100.0).round() / 100.0),
        ));
    }
    Ok(out)
}

/// 1rem의 px. core/web/styles/global.css가 html font-size를 62.5%로 둬 웹에서 1rem이 10px이다.
/// RN에는 루트 font-size가 없어, 같은 .qubc가 두 곳에서 같은 크기가 되도록 이 값에 맞춘다.
const REM_PX: f64 = 10.0;

/// "16px" -> 16, "1.6rem" -> 16. 단위 없는 0도 0이다. 다른 단위(em, %)는 None.
fn to_px(value: &str) -> Option<f64> {
    if value == "0" {
        return Some(0.0);
    }
    if let Some(rem) = value.strip_suffix("rem") {
        // 1.1 * 10 = 11.000000000000002 같은 부동소수 꼬리를 소수 둘째 자리에서 자른다.
        return Some((rem.parse::<f64>().ok()? * REM_PX * 100.0).round() / 100.0);
    }
    value.strip_suffix("px")?.parse().ok()
}

/// 길이 리터럴. px와 rem은 px 수로, %는 문자열로 낸다.
fn length(value: &str) -> Option<String> {
    if let Some(n) = to_px(value) {
        return Some(number(n));
    }
    let percent = value.strip_suffix('%')?;
    percent.parse::<f64>().ok()?;
    Some(quote(value))
}

/// margin/padding 값 1~4개를 리터럴로. 1개면 한 줄, 2~4개면 위 오른쪽 아래 왼쪽 네 개로 편다.
fn box_sides(value: &str) -> Option<Vec<String>> {
    let parts = split_tokens(value)
        .iter()
        .map(|t| length(t))
        .collect::<Option<Vec<_>>>()?;
    match parts.as_slice() {
        [_] => Some(parts),
        [v, h] => Some(vec![v.clone(), h.clone(), v.clone(), h.clone()]),
        [t, h, b] => Some(vec![t.clone(), h.clone(), b.clone(), h.clone()]),
        [_, _, _, _] => Some(parts),
        _ => None,
    }
}

/// 공백으로 나누되 괄호 안은 한 토큰이다. "1px solid rgba(1, 2, 3, 0.5)" -> 셋
fn split_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut depth = 0;
    for c in value.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if c.is_whitespace() && depth == 0 {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn is_color(value: &str) -> bool {
    value.starts_with('#')
        || value.starts_with("rgb")
        || value.starts_with("hsl")
        || (!value.is_empty() && value.chars().all(|c| c.is_ascii_alphabetic()))
}

/// "border-radius" -> "borderRadius"
fn camel(prop: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in prop.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn number(n: f64) -> String {
    format!("{n}")
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn styles(css: &str) -> TClassStyles {
        css_to_styles(css).unwrap()
    }

    /// 한 클래스의 선언을 (이름, 리터럴) 쌍으로 본다.
    fn decls(css: &str, class: &str) -> Vec<(String, String)> {
        styles(css)
            .into_iter()
            .find(|(name, _)| name == class)
            .unwrap_or_else(|| panic!("클래스 {class} 없음"))
            .1
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn px_and_keywords_and_colors() {
        let css = ".a { font-size: 16px; color: #1f2328; font-weight: 600; flex: 1; gap: 8px; }";
        assert_eq!(
            decls(css, "a"),
            pairs(&[
                ("fontSize", "16"),
                ("color", "\"#1f2328\""),
                ("fontWeight", "\"600\""),
                ("flex", "1"),
                ("gap", "8"),
            ])
        );
    }

    #[test]
    fn shorthands_expand() {
        let css = ".a { padding: 8px 12px; margin: 0; border: 1px solid #d7dde5; border-radius: 10px; }";
        assert_eq!(
            decls(css, "a"),
            pairs(&[
                ("paddingTop", "8"),
                ("paddingRight", "12"),
                ("paddingBottom", "8"),
                ("paddingLeft", "12"),
                ("margin", "0"),
                ("borderWidth", "1"),
                ("borderStyle", "\"solid\""),
                ("borderColor", "\"#d7dde5\""),
                ("borderRadius", "10"),
            ])
        );
    }

    #[test]
    fn color_function_with_spaces_stays_one_token() {
        let css = ".a { border: 1px solid rgba(15, 23, 42, 0.06); }";
        assert_eq!(
            decls(css, "a"),
            pairs(&[
                ("borderWidth", "1"),
                ("borderStyle", "\"solid\""),
                ("borderColor", "\"rgba(15, 23, 42, 0.06)\""),
            ])
        );
    }

    #[test]
    fn rn_noops_are_dropped() {
        let css = ".a { display: flex; cursor: pointer; color: red; }";
        assert_eq!(decls(css, "a"), pairs(&[("color", "\"red\"")]));
    }

    #[test]
    fn unitless_line_height_multiplies_font_size() {
        let css = ".a { font-size: 14px; line-height: 1.6; }";
        assert_eq!(
            decls(css, "a"),
            pairs(&[("fontSize", "14"), ("lineHeight", "22.4")])
        );
    }

    #[test]
    fn rem_converts_at_10px() {
        // core/web/styles/global.css가 html font-size를 62.5%로 둬 1rem이 10px이다.
        let css = ".a { font-size: 1.6rem; padding: 0.4rem 1.1rem; gap: 2rem; border-radius: 0.5rem; line-height: 2.4rem; }";
        assert_eq!(
            decls(css, "a"),
            pairs(&[
                ("fontSize", "16"),
                ("paddingTop", "4"),
                ("paddingRight", "11"),
                ("paddingBottom", "4"),
                ("paddingLeft", "11"),
                ("gap", "20"),
                ("borderRadius", "5"),
                ("lineHeight", "24"),
            ])
        );
    }

    #[test]
    fn unitless_line_height_uses_rem_font_size() {
        let css = ".a { font-size: 1.4rem; line-height: 1.5; }";
        assert_eq!(
            decls(css, "a"),
            pairs(&[("fontSize", "14"), ("lineHeight", "21")])
        );
    }

    #[test]
    fn unitless_line_height_without_font_size_is_error() {
        assert_eq!(
            css_to_styles(".a { line-height: 1.6; }"),
            Err(CssError::LineHeightWithoutFontSize("a".to_string()))
        );
    }

    #[test]
    fn unsupported_selectors_are_errors() {
        for selector in [".a:hover", "span.dark", ".a, .b", ".a .b", "@media (x)", "div"] {
            let css = format!("{selector} {{ color: red; }}");
            assert_eq!(
                css_to_styles(&css),
                Err(CssError::UnsupportedSelector(selector.to_string())),
                "{selector}"
            );
        }
    }

    #[test]
    fn unsupported_declarations_are_errors() {
        for (prop, value) in [
            ("box-shadow", "0 1px 3px red"),
            ("margin", "1em"),
            ("width", "calc(100% - 4px)"),
            ("color", "var(--x)"),
        ] {
            let css = format!(".a {{ {prop}: {value}; }}");
            assert_eq!(
                css_to_styles(&css),
                Err(CssError::UnsupportedDeclaration {
                    class: "a".to_string(),
                    prop: prop.to_string(),
                    value: value.to_string(),
                }),
                "{prop}: {value}"
            );
        }
    }

    #[test]
    fn comments_ignored_and_same_class_merges_in_order() {
        let css = "/* c */ .a { color: red; padding: 4px; } .b { gap: 2px; } .a { color: blue; /* x */ }";
        let all = styles(css);
        assert_eq!(
            all.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(
            decls(css, "a"),
            pairs(&[("color", "\"blue\""), ("padding", "4")])
        );
    }

    #[test]
    fn unterminated_rule_is_syntax_error() {
        assert!(matches!(
            css_to_styles(".a { color: red"),
            Err(CssError::Syntax(_))
        ));
        assert!(matches!(
            css_to_styles(".a color: red; }"),
            Err(CssError::Syntax(_))
        ));
    }
}
