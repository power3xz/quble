//! React 산출기(experiments/react/README.md). 평탄화한 컴포넌트를 React 컴포넌트(TSX) 한 모듈로 낸다.
//! 컴파일러 크레이트가 `experimental-react` feature로 이 파일을 모듈로 끼워 넣는다.

use crate::ast::{BinaryOp, Component, Expr, ForCount, Lit, Node, Type, UnaryOp};
use crate::dts::type_to_ts;
use crate::expr_type::{expr_type, path_type};
use crate::flatten::{flatten, FlatComp, SourceLoader};
use crate::scope::ForVar;
use crate::{codegen, fs_loader, CompileError};
use std::path::Path;

#[path = "rn_style.rs"]
mod rn_style;

/// 엔트리 소스를 React 컴포넌트 모듈(TSX)로 낸다. 검증은 qubb codegen이 하고 바이트코드는 버린다 -
/// 같은 소스가 qubb에서 에러면 여기서도 같은 에러다.
///
/// out_dir는 산출 TSX가 놓일 디렉터리다. `use "./x.css"` 리소스를 거기서 본 상대 경로로 import한다.
pub fn react_tsx(
    entry_path: &str,
    src: &str,
    loader: &impl SourceLoader,
    out_dir: &str,
) -> Result<String, CompileError> {
    let comps = flatten(entry_path, src, loader).map_err(CompileError::Flatten)?;
    codegen::generate(&comps).map_err(CompileError::Codegen)?;
    Ok(generate(&comps, out_dir))
}

/// 파일 경로로 React 모듈을 낸다. 엔트리를 읽고 fs loader로 use를 해소한다.
pub fn react_tsx_from_path(path: &str, out_dir: &str) -> Result<String, CompileError> {
    let not_found = || CompileError::EntryNotFound(path.to_string());
    let entry = std::fs::canonicalize(path).map_err(|_| not_found())?;
    let src = std::fs::read_to_string(&entry).map_err(|_| not_found())?;
    react_tsx(&entry.to_string_lossy(), &src, &fs_loader, out_dir)
}

/// 런타임(`runtime/index.ts`)은 `$q`로 싣는다 - 사용자 컴포넌트 이름(`Segment`, `String`)과 부딪히지 않게.
/// 컴포넌트 안에서 props는 `p`, 런타임 손잡이는 `q`다. 컴포넌트 이름은 대문자로 시작해 둘과 안 겹친다.
///
/// `use "./x.css"` 리소스는 산출 파일(out_dir)에서 본 상대 경로로 import한다. 같은 파일은 한 번만 싣는다.
fn generate(comps: &[FlatComp], out_dir: &str) -> String {
    let mut out = String::from("import * as $q from \"quble-react\";\n");
    let mut seen: Vec<&str> = Vec::new();
    for res in comps.iter().flat_map(|fc| &fc.resources) {
        if seen.contains(&res.as_str()) {
            continue;
        }
        seen.push(res);
        out.push_str(&format!("import {};\n", js_str(&relative_path(out_dir, res))));
    }
    for fc in comps {
        out.push('\n');
        emit_comp(&fc.comp, &mut out);
    }
    out
}

/// from 디렉터리에서 to 파일로 가는 상대 경로. 둘 다 정규화된 절대 경로다.
/// ("/proj/gen", "/proj/app/page.css") -> "../app/page.css"
fn relative_path(from: &str, to: &str) -> String {
    let from = Path::new(from).components().collect::<Vec<_>>();
    let to = Path::new(to).components().collect::<Vec<_>>();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    let rest = to[common..]
        .iter()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();
    parts.extend(rest.iter().map(|s| s.as_ref()));
    let joined = parts.join("/");
    if joined.starts_with("..") {
        joined
    } else {
        format!("./{joined}")
    }
}

fn emit_comp(comp: &Component, out: &mut String) {
    let mut fields = comp
        .props
        .iter()
        .map(|p| format!("{}: {}", p.name, type_to_ts(&p.type_)))
        .collect::<Vec<_>>();
    // 슬롯 콘텐츠는 이름 -> 콘텐츠로 한 prop에 모은다. `$`는 quble 이름에 못 오므로 prop과 안 겹친다.
    if has_slot(&comp.template) {
        fields.push("$slots?: $q.TSlots".to_string());
    }
    let props_ty = if fields.is_empty() {
        "{}".to_string()
    } else {
        format!("{{ {} }}", fields.join("; "))
    };
    out.push_str(&format!(
        "export const {} = (p: {props_ty}) => {{\n",
        comp.name
    ));
    out.push_str("  const q = $q.useQ();\n");
    out.push_str("  return (\n");
    line(out, 2, "<>");
    for node in &comp.template {
        emit_node(node, comp, &[], 3, out);
    }
    line(out, 2, "</>");
    out.push_str("  );\n};\n");
}

/// 이 템플릿에 `@slot` 자리가 있는가. 합성의 슬롯 콘텐츠는 쓰는 쪽 것이라 세지 않는다.
fn has_slot(nodes: &[Node]) -> bool {
    nodes.iter().any(|node| match node {
        Node::SlotPlaceholderDef { .. } => true,
        Node::Element { children, .. } | Node::With { children, .. } => has_slot(children),
        Node::If { then, else_, .. } => has_slot(then) || has_slot(else_),
        Node::For { body, .. } => has_slot(body),
        Node::Text(_) | Node::Interpolation(_) | Node::Component { .. } => false,
    })
}

fn line(out: &mut String, depth: usize, text: &str) {
    out.push_str(&"  ".repeat(depth));
    out.push_str(text);
    out.push('\n');
}

/// vars는 감싼 @for들이 연 변수다. 식에서 이 이름은 prop(`p.이름`)이 아니라 콜백 인자(`이름$`)다.
fn emit_node(node: &Node, comp: &Component, vars: &[ForVar], depth: usize, out: &mut String) {
    let js_expr = |expr: &Expr| js_expr(expr, vars);
    match node {
        Node::Text(s) => line(out, depth, &format!("{{{}}}", js_str(s))),
        Node::Interpolation(expr) => {
            line(out, depth, &format!("{{{}}}", js_text(expr, comp, vars)))
        }
        Node::Element {
            tag,
            attrs,
            event_bindings,
            children,
        } => {
            let mut open = format!("<{}", tag.name);
            for (name, value) in attrs {
                let react_name = attr_name(name);
                open.push_str(&format!(
                    " {react_name}={{{}}}",
                    attr_value(react_name, value, comp, vars)
                ));
            }
            for (dom_event, event_name) in event_bindings {
                let event = comp
                    .events
                    .iter()
                    .find(|e| e.name == event_name.name)
                    .expect("codegen이 선언된 이벤트만 통과시킨다");
                let data = js_object(
                    event
                        .payload
                        .iter()
                        .map(|(field, value)| (field.clone(), js_expr(value))),
                );
                open.push_str(&format!(
                    " {}={{(e) => q.emit({}, {data}, e)}}",
                    react_event_prop(dom_event),
                    js_str(&event.name)
                ));
            }
            // textarea의 자식 텍스트는 초기값이다. React는 그것을 defaultValue로 받는다.
            // textarea() { "> " ${text} } -> defaultValue={"> " + $q.str(p.text)}
            let text_only = children
                .iter()
                .all(|c| matches!(c, Node::Text(_) | Node::Interpolation(_)));
            if tag.name == "textarea" && !children.is_empty() && text_only {
                let parts = children
                    .iter()
                    .map(|c| match c {
                        Node::Text(s) => js_str(s),
                        Node::Interpolation(expr) => format!("$q.str({})", js_expr(expr)),
                        _ => unreachable!("위에서 텍스트만 걸렀다"),
                    })
                    .collect::<Vec<_>>()
                    .join(" + ");
                line(out, depth, &format!("{open} defaultValue={{{parts}}} />"));
                return;
            }
            if children.is_empty() {
                line(out, depth, &format!("{open} />"));
                return;
            }
            line(out, depth, &format!("{open}>"));
            for child in children {
                emit_node(child, comp, vars, depth + 1, out);
            }
            line(out, depth, &format!("</{}>", tag.name));
        }
        Node::Component {
            alias,
            name,
            args,
            contents,
        } => {
            // 자식이 받는 props 주소. 핸들러가 `set(props.text, v)`로 쓰면 이 주소가 가리키는
            // store 자리가 바뀐다. 리터럴 인자는 값을 그대로 주소로 싣는다.
            let addrs = js_object(args.iter().map(|(arg, value)| {
                let addr = match value {
                    Expr::Lit(..) => format!("q.lit({})", js_expr(value)),
                    _ => js_at(value),
                };
                (arg.name.clone(), addr)
            }));
            let segment = alias.as_deref().unwrap_or(&name.name);
            line(
                out,
                depth,
                &format!(
                    "<$q.Segment name={} props={{{addrs}}}>",
                    js_str(segment)
                ),
            );
            let mut elem = name.name.clone();
            for (arg, value) in args {
                elem.push_str(&format!(" {}={{{}}}", arg.name, js_expr(value)));
            }
            if contents.is_empty() {
                line(out, depth + 1, &format!("<{elem} />"));
            } else {
                // 슬롯 콘텐츠는 쓰는 쪽 경로, 컨텍스트, 회차로 해석한다. q.slot이 지금 q의 것을
                // 다시 깔아 자식 안에 붙어도 그것을 보게 한다. 무기명 슬롯의 키는 "".
                line(out, depth + 1, &format!("<{elem} $slots={{{{"));
                for content in contents {
                    let key = content.name.as_ref().map_or("", |n| n.name.as_str());
                    line(out, depth + 2, &format!("{}: q.slot(", js_str(key)));
                    emit_fragment(&content.nodes, comp, vars, depth + 3, out);
                    line(out, depth + 2, "),");
                }
                line(out, depth + 1, "}} />");
            }
            line(out, depth, "</$q.Segment>");
        }
        Node::SlotPlaceholderDef { name, .. } => {
            let key = name.as_ref().map_or("", |n| n.name.as_str());
            line(out, depth, &format!("{{p.$slots?.[{}]}}", js_str(key)));
        }
        Node::If { cond, then, else_ } => {
            line(out, depth, &format!("{{{} ? (", js_expr(cond)));
            emit_fragment(then, comp, vars, depth + 1, out);
            if else_.is_empty() {
                line(out, depth, ") : null}");
                return;
            }
            line(out, depth, ") : (");
            emit_fragment(else_, comp, vars, depth + 1, out);
            line(out, depth, ")}");
        }
        Node::For {
            item,
            index,
            count,
            body,
        } => {
            // 순회 대상의 주소를 함께 넘긴다 - 요소를 자식에 넘기면 그 주소 아래가 요소의 주소다.
            let (source, addr) = match count {
                ForCount::Literal(n) => (n.to_string(), "null".to_string()),
                ForCount::Var(expr) => (js_expr(expr), js_at(expr)),
            };
            let index_name = match index {
                Some(index) => js_str(&index.name),
                None => "null".to_string(),
            };
            let mut params = format!("q, {}$", item.name);
            if let Some(index) = index {
                params.push_str(&format!(", {}$", index.name));
            }
            line(
                out,
                depth,
                &format!(
                    "{{q.each({source}, {addr}, {}, {index_name}, ({params}) => (",
                    js_str(&item.name)
                ),
            );
            // 수를 돌면 item이 회차 번호고, 배열을 돌면 요소다.
            let item_type = match count {
                ForCount::Literal(_) => Type::Number,
                ForCount::Var(expr) => {
                    match path_type(expr, &comp.props, vars).expect("codegen이 검사한 대상") {
                        Type::Array(elem) => *elem,
                        _ => Type::Number,
                    }
                }
            };
            let mut inner = vars.to_vec();
            inner.push(for_var(&item.name, item_type));
            if let Some(index) = index {
                inner.push(for_var(&index.name, Type::Number));
            }
            emit_fragment(body, comp, &inner, depth + 1, out);
            line(out, depth, "))}");
        }
        Node::With { context, children } => {
            let def = comp
                .contexts
                .iter()
                .find(|c| c.name == context.name)
                .expect("codegen이 선언된 컨텍스트만 통과시킨다");
            let value = js_object(
                def.fields
                    .iter()
                    .map(|(field, value)| (field.clone(), js_expr(value))),
            );
            line(
                out,
                depth,
                &format!("<$q.With name={} value={{{value}}}>", js_str(&def.name)),
            );
            // 안쪽 요소가 이 컨텍스트를 보는 q를 쓰도록 With가 넘기는 q로 바깥 q를 가린다.
            line(out, depth + 1, "{(q) => (");
            emit_fragment(children, comp, vars, depth + 2, out);
            line(out, depth + 1, ")}");
            line(out, depth, "</$q.With>");
        }
    }
}

fn emit_fragment(nodes: &[Node], comp: &Component, vars: &[ForVar], depth: usize, out: &mut String) {
    line(out, depth, "<>");
    for node in nodes {
        emit_node(node, comp, vars, depth + 1, out);
    }
    line(out, depth, "</>");
}

/// 타입 조회용 @for 변수. offset은 qubb 슬롯 자리라 여기서는 안 쓴다.
fn for_var(name: &str, type_: Type) -> ForVar {
    ForVar {
        name: Some(name.to_string()),
        offset: 0,
        type_,
    }
}

/// 보간 값. React는 boolean을 안 찍으므로 bool만 qubb처럼 "true"/"false"로 바꾼다.
/// 문자열과 수는 그대로 둔다 - React가 수를 String()과 같게 찍는다.
fn js_text(expr: &Expr, comp: &Component, vars: &[ForVar]) -> String {
    match expr_type(expr, &comp.props, vars).expect("codegen이 검사한 식") {
        Type::Bool => format!("$q.str({})", js_expr(expr, vars)),
        _ => js_expr(expr, vars),
    }
}

/// 참조의 주소. user.name -> q.at("user", "name")
fn js_at(expr: &Expr) -> String {
    let segments = ref_segments(expr)
        .iter()
        .map(|s| js_str(s))
        .collect::<Vec<_>>()
        .join(", ");
    format!("q.at({segments})")
}

/// 참조를 마디로 편다. 합성 인자와 @for 대상은 참조와 경로 접근뿐이다(codegen이 거른다).
/// user.name -> ["user", "name"]
fn ref_segments(expr: &Expr) -> Vec<String> {
    match expr {
        Expr::Var(name, _) => vec![name.clone()],
        Expr::Field(base, field, _) => {
            let mut segments = ref_segments(base);
            segments.push(field.clone());
            segments
        }
        _ => unreachable!("codegen이 합성 인자를 참조와 경로로 거른다"),
    }
}

/// JSX 속성 이름. React가 다른 이름으로 받는 HTML 속성만 바꾼다. 나머지(`id`, `data-*`,
/// `aria-*`)는 그대로다.
fn attr_name(name: &str) -> &str {
    match name {
        "class" => "className",
        "for" => "htmlFor",
        "tabindex" => "tabIndex",
        "readonly" => "readOnly",
        "maxlength" => "maxLength",
        "minlength" => "minLength",
        "colspan" => "colSpan",
        "rowspan" => "rowSpan",
        "contenteditable" => "contentEditable",
        "autocomplete" => "autoComplete",
        "autofocus" => "autoFocus",
        "accesskey" => "accessKey",
        "crossorigin" => "crossOrigin",
        "datetime" => "dateTime",
        "enctype" => "encType",
        "inputmode" => "inputMode",
        "novalidate" => "noValidate",
        "spellcheck" => "spellCheck",
        "srcset" => "srcSet",
        "usemap" => "useMap",
        _ => name,
    }
}

/// React 타입이 number만 받는 속성(React 이름). @types/react의 `?: number | undefined` 속성들.
const NUMBER_ATTRS: &[&str] = &[
    "tabIndex",
    "results",
    "cols",
    "colSpan",
    "high",
    "low",
    "marginHeight",
    "marginWidth",
    "maxLength",
    "minLength",
    "optimum",
    "rows",
    "rowSpan",
    "size",
    "span",
    "start",
    "border",
];

/// 속성값. 배열은 class에서만 오고 qubb처럼 컴파일타임에 공백으로 잇는다.
/// ["card", "lg"] -> "card lg"
///
/// 식은 React 속성 타입에 맞춘다. number만 받는 속성에는 수를 그대로, 나머지에는 문자열로 낸다.
/// 어느 쪽이든 DOM에 찍히는 글자는 qubb와 같다.
fn attr_value(react_name: &str, value: &Expr, comp: &Component, vars: &[ForVar]) -> String {
    // React는 style에 객체만 받는다. qubb의 CSS 선언 문자열을 런타임이 객체로 바꾼다.
    if react_name == "style" {
        return format!("$q.style({})", js_expr(value, vars));
    }
    match value {
        Expr::Lit(..) => js_expr(value, vars),
        Expr::List(items, _) => {
            let joined = items
                .iter()
                .map(|item| match item {
                    Expr::Lit(lit, _) => match &lit.value {
                        Lit::Str(s) => s.as_str(),
                        _ => unreachable!("codegen이 class 배열을 문자열 리터럴로 거른다"),
                    },
                    _ => unreachable!("codegen이 class 배열을 문자열 리터럴로 거른다"),
                })
                .collect::<Vec<_>>()
                .join(" ");
            js_str(&joined)
        }
        _ => match expr_type(value, &comp.props, vars).expect("codegen이 검사한 식") {
            Type::String => js_expr(value, vars),
            Type::Number if NUMBER_ATTRS.contains(&react_name) => js_expr(value, vars),
            _ => format!("$q.str({})", js_expr(value, vars)),
        },
    }
}

/// DOM 이벤트 이름 -> React 이벤트 prop. 렉서의 닫힌 집합을 다 적는다.
fn react_event_prop(dom_event: &str) -> &'static str {
    match dom_event {
        "click" => "onClick",
        "input" => "onInput",
        "change" => "onChange",
        "submit" => "onSubmit",
        "focus" => "onFocus",
        "blur" => "onBlur",
        "keydown" => "onKeyDown",
        "keyup" => "onKeyUp",
        "mousedown" => "onMouseDown",
        "mouseup" => "onMouseUp",
        "mouseenter" => "onMouseEnter",
        "mouseleave" => "onMouseLeave",
        "scroll" => "onScroll",
        _ => unreachable!("렉서가 거른 DOM 이벤트만 온다"),
    }
}

/// [("a", "1"), ("b", "p.x")] -> { a: 1, b: p.x }
fn js_object(fields: impl Iterator<Item = (String, String)>) -> String {
    let body = fields
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(", ");
    if body.is_empty() {
        "{}".to_string()
    } else {
        format!("{{ {body} }}")
    }
}

/// 식 -> JS 식. 연산자 가지는 괄호로 감싸 우선순위를 원본 트리 그대로 둔다.
/// count * (a + 1) -> (p.count * (p.a + 1))
/// @for 변수는 콜백 인자로 읽는다. @for (row of rows)의 row.title -> row$.title
fn js_expr(expr: &Expr, vars: &[ForVar]) -> String {
    let js_expr = |expr: &Expr| js_expr(expr, vars);
    match expr {
        Expr::Var(name, _) if vars.iter().any(|v| v.name.as_ref() == Some(name)) => {
            format!("{name}$")
        }
        Expr::Var(name, _) => format!("p.{name}"),
        Expr::Lit(lit, _) => match &lit.value {
            Lit::Str(s) => js_str(s),
            Lit::Number(n) => format!("{n}"),
            Lit::Bool(b) => format!("{b}"),
        },
        Expr::List(items, _) => format!(
            "[{}]",
            items.iter().map(js_expr).collect::<Vec<_>>().join(", ")
        ),
        Expr::Field(base, field, _) => format!("{}.{field}", js_expr(base)),
        // 범위 밖 인덱스는 qubb처럼 RangeError를 낸다.
        Expr::Index(array, index, _) => format!("$q.idx({}, {})", js_expr(array), js_expr(index)),
        Expr::Unary(op, operand, _) => {
            let sym = match op {
                UnaryOp::Not => "!",
                UnaryOp::Neg => "-",
            };
            format!("({sym}{})", js_expr(operand))
        }
        Expr::Binary(op, left, right, _) => {
            // 같음 비교는 양쪽 타입이 같다(codegen이 검사) - 엄격 비교로 낸다.
            let sym = match op {
                BinaryOp::Eq => "===",
                BinaryOp::Ne => "!==",
                _ => op.sym(),
            };
            format!("({} {sym} {})", js_expr(left), js_expr(right))
        }
    }
}

fn js_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::react_tsx;

    fn tsx(src: &str) -> String {
        react_tsx("entry", src, &(|_: &str, _: &str| None), "/").unwrap()
    }

    #[test]
    fn resources_import_relative_to_out_dir() {
        let src = r#"
            use "./page.css"
            use Card from "./card.qubc"
            component Page { template { Card( /) } }
        "#;
        let card = r#"
            use "../shared/card.css"
            use "./page.css"
            component Card { template { div( /) } }
        "#;
        let loader = |_base: &str, target: &str| match target {
            "./page.css" => Some(("/proj/app/page.css".to_string(), String::new())),
            "./card.qubc" => Some(("/proj/app/card.qubc".to_string(), card.to_string())),
            "../shared/card.css" => Some(("/proj/shared/card.css".to_string(), String::new())),
            _ => None,
        };
        let out = react_tsx("/proj/app/page.qubc", src, &loader, "/proj/gen").unwrap();
        // 같은 파일은 한 번만, 등장 순서대로 싣는다.
        assert!(
            out.starts_with(
                "import * as $q from \"quble-react\";\nimport \"../app/page.css\";\nimport \"../shared/card.css\";\n\n"
            ),
            "{out}"
        );
    }

    #[test]
    fn event_and_interpolation() {
        let out = tsx(r#"
            component Toggle {
              props { label: string, on: bool }
              events { TOGGLE({ label, on: !on }) }
              template {
                button(class="btn" title={on} tabindex={1 + 1} @click:TOGGLE) { "x: " ${label} ${on} }
              }
            }
        "#);
        // 문자열과 수는 그대로 낸다. bool만 qubb처럼 "true"/"false"로 찍게 감싼다.
        assert_eq!(
            out,
            r#"import * as $q from "quble-react";

export const Toggle = (p: { label: string; on: boolean }) => {
  const q = $q.useQ();
  return (
    <>
      <button className={"btn"} title={$q.str(p.on)} tabIndex={(1 + 1)} onClick={(e) => q.emit("TOGGLE", { label: p.label, on: (!p.on) }, e)}>
        {"x: "}
        {p.label}
        {$q.str(p.on)}
      </button>
    </>
  );
};
"#
        );
    }

    #[test]
    fn composition_with_if() {
        let out = tsx(r#"
            component Page {
              props { user: { name: string }, n: number }
              contexts { Area { section: "top", n: n } }
              template {
                @with Area {
                  @if (n > 0) {
                    First: Label(text={user.name} /)
                  } @else {
                    Label(text="none" /)
                  }
                }
              }
            }
            component Label {
              props { text: string }
              template { span() { ${text} } }
            }
        "#);
        assert_eq!(
            out,
            r#"import * as $q from "quble-react";

export const Page = (p: { user: { name: string }; n: number }) => {
  const q = $q.useQ();
  return (
    <>
      <$q.With name="Area" value={{ section: "top", n: p.n }}>
        {(q) => (
          <>
            {(p.n > 0) ? (
              <>
                <$q.Segment name="First" props={{ text: q.at("user", "name") }}>
                  <Label text={p.user.name} />
                </$q.Segment>
              </>
            ) : (
              <>
                <$q.Segment name="Label" props={{ text: q.lit("none") }}>
                  <Label text={"none"} />
                </$q.Segment>
              </>
            )}
          </>
        )}
      </$q.With>
    </>
  );
};

export const Label = (p: { text: string }) => {
  const q = $q.useQ();
  return (
    <>
      <span>
        {p.text}
      </span>
    </>
  );
};
"#
        );
    }

    #[test]
    fn style_text_to_object() {
        let out = tsx(r#"
            component Box {
              props { pos: string }
              template { div(style="color: red" /) div(style={pos} /) }
            }
        "#);
        assert!(out.contains(r#"<div style={$q.style("color: red")} />"#), "{out}");
        assert!(out.contains(r#"<div style={$q.style(p.pos)} />"#), "{out}");
    }

    #[test]
    fn textarea_children_to_default_value() {
        let out = tsx(r#"
            component Editor {
              props { text: string, n: number }
              template { textarea(rows={n}) { "> " ${text} } }
            }
        "#);
        assert!(
            out.contains(r#"<textarea rows={p.n} defaultValue={"> " + $q.str(p.text)} />"#),
            "{out}"
        );
    }

    #[test]
    fn slots() {
        let out = tsx(r#"
            component Page {
              props { title: string }
              template {
                Card() {
                  Header << h1() { ${title} }
                  Body << {
                    p() { "b" }
                    Label(text={title} /)
                  }
                }
                Plain() { span() { "x" } }
              }
            }
            component Card { template { div() { @slot(Header) @slot(Body) } } }
            component Plain { template { @slot() } }
            component Label { props { text: string } template { span() { ${text} } } }
        "#);
        let expected = [
            r#"      <$q.Segment name="Card" props={{}}>
        <Card $slots={{
          "Header": q.slot(
            <>
              <h1>
                {p.title}
              </h1>
            </>
          ),
          "Body": q.slot(
            <>
              <p>
                {"b"}
              </p>
              <$q.Segment name="Label" props={{ text: q.at("title") }}>
                <Label text={p.title} />
              </$q.Segment>
            </>
          ),
        }} />
      </$q.Segment>
      <$q.Segment name="Plain" props={{}}>
        <Plain $slots={{
          "": q.slot(
            <>
              <span>
                {"x"}
              </span>
            </>
          ),
        }} />
      </$q.Segment>
"#,
            r#"export const Card = (p: { $slots?: $q.TSlots }) => {
  const q = $q.useQ();
  return (
    <>
      <div>
        {p.$slots?.["Header"]}
        {p.$slots?.["Body"]}
      </div>
    </>
  );
};"#,
            r#"export const Plain = (p: { $slots?: $q.TSlots }) => {
  const q = $q.useQ();
  return (
    <>
      {p.$slots?.[""]}
    </>
  );
};"#,
            "export const Label = (p: { text: string }) => {",
        ];
        for piece in expected {
            assert!(out.contains(piece), "{piece}\n--- 산출 ---\n{out}");
        }
    }

    #[test]
    fn for_loops() {
        let out = tsx(r#"
            component List {
              props { rows: { title: string }[] }
              events { PICK({ }) }
              template {
                @for (row, i of rows) {
                  button(@click:PICK) { ${i} ${row.title} }
                  Item: Cell(text={row.title} /)
                }
                @for (n of 2) { span() { ${n * 2} } }
              }
            }
            component Cell {
              props { text: string }
              template { span() { ${text} } }
            }
        "#);
        let list = out
            .split("export const Cell")
            .next()
            .unwrap()
            .split("return (\n")
            .nth(1)
            .unwrap();
        assert_eq!(
            list,
            r#"    <>
      {q.each(p.rows, q.at("rows"), "row", "i", (q, row$, i$) => (
        <>
          <button onClick={(e) => q.emit("PICK", {}, e)}>
            {i$}
            {row$.title}
          </button>
          <$q.Segment name="Item" props={{ text: q.at("row", "title") }}>
            <Cell text={row$.title} />
          </$q.Segment>
        </>
      ))}
      {q.each(2, null, "n", null, (q, n$) => (
        <>
          <span>
            {(n$ * 2)}
          </span>
        </>
      ))}
    </>
  );
};

"#
        );
    }
}
