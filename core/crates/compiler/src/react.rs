//! React 산출기. 평탄화한 컴포넌트를 React 컴포넌트(TSX) 한 모듈로 낸다(docs/react-target.draft.md).
//! 입력은 qubb codegen의 검증을 통과한 것이라 여기서는 에러를 내지 않는다.

use crate::ast::{BinaryOp, Component, Expr, ForCount, Lit, Node, Type, UnaryOp};
use crate::dts::type_to_ts;
use crate::flatten::FlatComp;

/// 런타임(`core/react`)은 `$q`로 싣는다 - 사용자 컴포넌트 이름(`Segment`, `String`)과 부딪히지 않게.
/// 컴포넌트 안에서 props는 `p`, 런타임 손잡이는 `q`다. 컴포넌트 이름은 대문자로 시작해 둘과 안 겹친다.
pub fn generate(comps: &[FlatComp]) -> String {
    let mut out = String::from("import * as $q from \"quble-react\";\n");
    for fc in comps {
        out.push('\n');
        emit_comp(&fc.comp, &mut out);
    }
    out
}

fn emit_comp(comp: &Component, out: &mut String) {
    let props_ty = Type::Object(
        comp.props
            .iter()
            .map(|p| (p.name.clone(), p.type_.clone()))
            .collect(),
    );
    out.push_str(&format!(
        "export const {} = (p: {}) => {{\n",
        comp.name,
        type_to_ts(&props_ty)
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

fn line(out: &mut String, depth: usize, text: &str) {
    out.push_str(&"  ".repeat(depth));
    out.push_str(text);
    out.push('\n');
}

/// vars는 감싼 @for들이 연 변수 이름이다. 식에서 이 이름은 prop(`p.이름`)이 아니라 콜백 인자(`이름$`)다.
fn emit_node(node: &Node, comp: &Component, vars: &[String], depth: usize, out: &mut String) {
    let js_expr = |expr: &Expr| js_expr(expr, vars);
    match node {
        Node::Text(s) => line(out, depth, &format!("{{{}}}", js_str(s))),
        // React는 boolean을 안 찍는다. qubb처럼 "true"/"false"로 찍으려고 문자열로 바꾼다.
        Node::Interpolation(expr) => line(out, depth, &format!("{{$q.str({})}}", js_expr(expr))),
        Node::Element {
            tag,
            attrs,
            event_bindings,
            children,
        } => {
            let mut open = format!("<{}", tag.name);
            for (name, value) in attrs {
                open.push_str(&format!(" {}={{{}}}", attr_name(name), attr_value(value, vars)));
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
            if !contents.is_empty() {
                todo!("슬롯 콘텐츠")
            }
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
            line(out, depth + 1, &format!("<{elem} />"));
            line(out, depth, "</$q.Segment>");
        }
        Node::SlotPlaceholderDef { .. } => todo!("슬롯 자리"),
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
            let mut inner = vars.to_vec();
            inner.push(item.name.clone());
            if let Some(index) = index {
                inner.push(index.name.clone());
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

fn emit_fragment(nodes: &[Node], comp: &Component, vars: &[String], depth: usize, out: &mut String) {
    line(out, depth, "<>");
    for node in nodes {
        emit_node(node, comp, vars, depth + 1, out);
    }
    line(out, depth, "</>");
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

/// JSX 속성 이름. JS 예약어와 겹치는 둘만 React 이름으로 바꾼다.
fn attr_name(name: &str) -> &str {
    match name {
        "class" => "className",
        "for" => "htmlFor",
        _ => name,
    }
}

/// 속성값. 배열은 class에서만 오고 qubb처럼 컴파일타임에 공백으로 잇는다.
/// ["card", "lg"] -> "card lg"
fn attr_value(value: &Expr, vars: &[String]) -> String {
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
        _ => format!("$q.str({})", js_expr(value, vars)),
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
fn js_expr(expr: &Expr, vars: &[String]) -> String {
    let js_expr = |expr: &Expr| js_expr(expr, vars);
    match expr {
        Expr::Var(name, _) if vars.contains(name) => format!("{name}$"),
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
    use crate::react_tsx;

    fn tsx(src: &str) -> String {
        react_tsx("entry", src, &(|_: &str, _: &str| None)).unwrap()
    }

    #[test]
    fn event_and_interpolation() {
        let out = tsx(r#"
            component Toggle {
              props { label: string, on: bool }
              events { TOGGLE({ label, on: !on }) }
              template {
                button(class="btn" @click:TOGGLE) { "x: " ${label} }
              }
            }
        "#);
        assert_eq!(
            out,
            r#"import * as $q from "quble-react";

export const Toggle = (p: { label: string; on: boolean }) => {
  const q = $q.useQ();
  return (
    <>
      <button className={"btn"} onClick={(e) => q.emit("TOGGLE", { label: p.label, on: (!p.on) }, e)}>
        {"x: "}
        {$q.str(p.label)}
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
        {$q.str(p.text)}
      </span>
    </>
  );
};
"#
        );
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
            {$q.str(i$)}
            {$q.str(row$.title)}
          </button>
          <$q.Segment name="Item" props={{ text: q.at("row", "title") }}>
            <Cell text={row$.title} />
          </$q.Segment>
        </>
      ))}
      {q.each(2, null, "n", null, (q, n$) => (
        <>
          <span>
            {$q.str((n$ * 2))}
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
