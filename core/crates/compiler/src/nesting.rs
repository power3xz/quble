//! HTML 파서가 구조를 바꾸는 중첩을 컴파일 때 막는다.
//!
//! SSR이 낸 HTML을 브라우저가 파싱하면 `<p><div>`는 `<p></p><div>`로, `<table><tr>`은
//! `<table><tbody><tr>`로 바뀐다. CSR은 `createElement`로 만들어 바뀌지 않으므로 두 트리가 달라져
//! resume이 실패한다. 호출된 컴포넌트의 최상위 element와 슬롯 내용도 호출 자리의 조상에 견준다.

use crate::ast::{Component, Node};
use crate::codegen::{CodegenError, CodegenErrorKind};
use crate::flatten::{FlatComp, Sourced};
use crate::src_range::SrcRange;
use std::collections::HashMap;

/// 컴포넌트 이름 -> 정의. 호출된 컴포넌트의 최상위와 슬롯 자리를 찾는 데 쓴다.
struct Ctx<'a> {
    comps: HashMap<&'a str, &'a Component>,
}

/// 조상 element 하나 - 태그와, 텍스트 자식을 탓할 때 짚을 자리.
#[derive(Clone, Copy)]
struct Anc<'a> {
    tag: &'a str,
    at: SrcRange,
}

enum Child<'a> {
    Tag(&'a str),
    /// 공백이 아닌 텍스트나 `${}`.
    Text,
}

/// 모든 컴포넌트의 템플릿을 훑어 파서가 구조를 바꾸는 중첩을 찾는다.
pub fn check_nesting(comps: &[FlatComp]) -> Result<(), Sourced<CodegenError>> {
    let ctx = Ctx {
        comps: comps
            .iter()
            .map(|fc| (fc.comp.name.as_str(), &fc.comp))
            .collect(),
    };
    for fc in comps {
        walk(&fc.comp.template, &mut Vec::new(), &ctx)
            .map_err(|e| Sourced::from_origin(&fc.origin, e))?;
    }
    Ok(())
}

/// child가 ancestors 아래에 놓일 수 없으면 at을 탓하는 에러를 낸다.
fn check(ancestors: &[Anc], child: &Child, at: SrcRange) -> Result<(), CodegenError> {
    match conflict(ancestors, child) {
        None => Ok(()),
        Some((parent, direct, reason)) => {
            let child = match child {
                Child::Tag(tag) => tag.to_string(),
                Child::Text => "text".to_string(),
            };
            let relation = if direct { "a child of" } else { "inside" };
            let mut message = format!("`{child}` cannot be {relation} `{parent}`");
            if let Some(reason) = reason {
                message.push_str(": ");
                message.push_str(reason);
            }
            Err(CodegenErrorKind::InvalidNesting {
                child,
                parent: parent.to_string(),
                message,
            }
            .at(at))
        }
    }
}

/// nodes를 ancestors 아래에 놓인 것으로 보고 훑는다. `@if`/`@for`/`@with`는 조상을 바꾸지 않는다.
fn walk<'a>(
    nodes: &'a [Node],
    ancestors: &mut Vec<Anc<'a>>,
    ctx: &Ctx<'a>,
) -> Result<(), CodegenError> {
    for node in nodes {
        match node {
            Node::Element { tag, children, .. } => {
                check(ancestors, &Child::Tag(&tag.name), tag.range.0)?;
                ancestors.push(Anc {
                    tag: &tag.name,
                    at: tag.range.0,
                });
                walk(children, ancestors, ctx)?;
                ancestors.pop();
            }
            Node::Text(text) => {
                if !text.trim().is_empty() {
                    let at = ancestors.last().map_or(SrcRange::new(0, 0), |a| a.at);
                    check(ancestors, &Child::Text, at)?;
                }
            }
            Node::Interpolation(expr) => check(ancestors, &Child::Text, expr.range().0)?,
            Node::Component { name, contents, .. } => {
                // 없는 컴포넌트는 codegen이 에러로 낸다.
                if let Some(callee) = ctx.comps.get(name.name.as_str()) {
                    let roots = root_children(&callee.template, ctx, &mut vec![&callee.name]);
                    for child in &roots {
                        check(ancestors, child, name.range.0)?;
                    }
                    for content in contents {
                        let slot = content.name.as_ref().map(|n| n.name.as_str());
                        // 없는 슬롯은 codegen이 에러로 낸다.
                        if let Some(inside) = slot_ancestors(&callee.template, slot) {
                            let outer = ancestors.len();
                            ancestors.extend(inside.into_iter().map(|tag| Anc {
                                tag,
                                at: name.range.0,
                            }));
                            walk(&content.nodes, ancestors, ctx)?;
                            ancestors.truncate(outer);
                        }
                    }
                }
            }
            Node::If { then, else_, .. } => {
                walk(then, ancestors, ctx)?;
                walk(else_, ancestors, ctx)?;
            }
            Node::For { body, .. } => walk(body, ancestors, ctx)?,
            Node::With { children, .. } => walk(children, ancestors, ctx)?,
            Node::SlotPlaceholderDef { .. } => {}
        }
    }
    Ok(())
}

/// 컴포넌트 최상위에 놓이는 것들. 호출한 컴포넌트는 따라 들어가고, `@slot`은 호출 자리에서 견주므로 뺀다.
/// seen은 따라 들어가는 중인 컴포넌트 이름으로, 서로 부르는 순환을 끊는다.
fn root_children<'a>(
    nodes: &'a [Node],
    ctx: &Ctx<'a>,
    seen: &mut Vec<&'a str>,
) -> Vec<Child<'a>> {
    let mut out = Vec::new();
    for node in nodes {
        match node {
            Node::Element { tag, .. } => out.push(Child::Tag(&tag.name)),
            Node::Text(text) => {
                if !text.trim().is_empty() {
                    out.push(Child::Text);
                }
            }
            Node::Interpolation(_) => out.push(Child::Text),
            Node::Component { name, .. } => {
                if let Some(callee) = ctx.comps.get(name.name.as_str()) {
                    if !seen.contains(&callee.name.as_str()) {
                        seen.push(&callee.name);
                        out.extend(root_children(&callee.template, ctx, seen));
                        seen.pop();
                    }
                }
            }
            Node::If { then, else_, .. } => {
                out.extend(root_children(then, ctx, seen));
                out.extend(root_children(else_, ctx, seen));
            }
            Node::For { body, .. } => out.extend(root_children(body, ctx, seen)),
            Node::With { children, .. } => out.extend(root_children(children, ctx, seen)),
            Node::SlotPlaceholderDef { .. } => {}
        }
    }
    out
}

/// 템플릿 안에서 `@slot(slot)`을 품은 element 조상들(바깥부터). 최상위에 있으면 빈 목록이고,
/// 그런 `@slot`이 없으면 None이다(없는 슬롯은 다른 곳에서 에러가 난다).
fn slot_ancestors<'a>(nodes: &'a [Node], slot: Option<&str>) -> Option<Vec<&'a str>> {
    find_slot(nodes, slot, &mut Vec::new())
}

fn find_slot<'a>(
    nodes: &'a [Node],
    slot: Option<&str>,
    path: &mut Vec<&'a str>,
) -> Option<Vec<&'a str>> {
    for node in nodes {
        let found = match node {
            Node::SlotPlaceholderDef { name, .. }
                if name.as_ref().map(|n| n.name.as_str()) == slot =>
            {
                Some(path.clone())
            }
            Node::Element { tag, children, .. } => {
                path.push(&tag.name);
                let found = find_slot(children, slot, path);
                path.pop();
                found
            }
            Node::If { then, else_, .. } => {
                find_slot(then, slot, path).or_else(|| find_slot(else_, slot, path))
            }
            Node::For { body, .. } => find_slot(body, slot, path),
            Node::With { children, .. } => find_slot(children, slot, path),
            // 합성 경계 - 안쪽 슬롯은 호출된 컴포넌트의 것이다.
            _ => None,
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// `<p>`가 열려 있으면 파서가 먼저 닫는 태그.
const CLOSES_P: &[&str] = &[
    "article",
    "aside",
    "blockquote",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
];

/// 조상 목록을 안쪽부터 거슬러 올라가며 tag인 첫 조상을 찾는다. stops에 든 태그를 만나면 거기서 멈춘다.
fn nearest<'a>(ancestors: &[Anc<'a>], tag: &str, stops: &[&str]) -> Option<&'a str> {
    for anc in ancestors.iter().rev() {
        if anc.tag == tag {
            return Some(anc.tag);
        }
        if stops.contains(&anc.tag) {
            return None;
        }
    }
    None
}

/// child가 ancestors 아래에서 파서에게 구조를 바꾸게 하면 (탓할 조상 태그, 직계 자식으로만 막히는지, 이유).
/// 조상이 없으면(컴포넌트 최상위) 알 수 있는 것이 없어 None이다 - 호출 자리에서 견준다.
fn conflict<'a>(
    ancestors: &[Anc<'a>],
    child: &Child,
) -> Option<(&'a str, bool, Option<&'static str>)> {
    let parent = ancestors.last()?.tag;
    let tag = match child {
        Child::Text => {
            return match parent {
                "table" | "thead" | "tbody" | "tr" => Some((parent, true, None)),
                _ => None,
            };
        }
        Child::Tag(tag) => *tag,
    };
    let structural = match (parent, tag) {
        ("table", "thead" | "tbody") => None,
        ("table", _) => Some("<table> takes only <thead> and <tbody>"),
        ("thead" | "tbody", "tr") => None,
        ("thead" | "tbody", _) => Some("<thead> and <tbody> take only <tr>"),
        ("tr", "td" | "th") => None,
        ("tr", _) => Some("<tr> takes only <td> and <th>"),
        ("select", "option") => None,
        ("select", _) => Some("<select> takes only <option>"),
        (_, "tr") => Some("<tr> must be inside <thead> or <tbody>"),
        (_, "td" | "th") => Some("<td> and <th> must be inside <tr>"),
        (_, "thead" | "tbody") => Some("<thead> and <tbody> must be inside <table>"),
        _ => None,
    };
    if let Some(reason) = structural {
        return Some((parent, true, Some(reason)));
    }
    let table_edge = ["table", "td", "th"];
    if CLOSES_P.contains(&tag) {
        let stops = ["button", "table", "td", "th"];
        if let Some(p) = nearest(ancestors, "p", &stops) {
            return Some((p, false, Some("<p> takes only inline elements")));
        }
    }
    let same = match tag {
        "a" => nearest(ancestors, "a", &["button", "table", "td", "th"]),
        "button" => nearest(ancestors, "button", &table_edge),
        "form" => nearest(ancestors, "form", &[]),
        _ => None,
    };
    same.map(|ancestor| (ancestor, false, None))
}

#[cfg(test)]
mod tests {
    use crate::codegen::{CodegenError, CodegenErrorKind};
    use crate::{compile_src, CompileError};

    fn compile(src: &str) -> Result<(), CompileError> {
        compile_src("entry", src, &(|_: &str, _: &str| None)).map(|_| ())
    }

    /// 컴파일이 InvalidNesting으로 실패했으면 (child, parent), 아니면 패닉.
    fn nesting_error(src: &str) -> (String, String) {
        match compile(src) {
            Err(CompileError::Codegen(e)) => match e.err {
                CodegenError {
                    kind: CodegenErrorKind::InvalidNesting { child, parent, .. },
                    ..
                } => (child, parent),
                other => panic!("다른 에러: {other:?}"),
            },
            other => panic!("InvalidNesting이 아니다: {:?}", other.map(|_| ())),
        }
    }

    fn pair(child: &str, parent: &str) -> (String, String) {
        (child.to_string(), parent.to_string())
    }

    fn message(src: &str) -> String {
        match compile(src) {
            Err(CompileError::Codegen(e)) => e.err.kind.to_string(),
            other => panic!("에러가 아니다: {:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn message_says_inside_for_descendant_rules() {
        assert_eq!(
            message("component A { template { p() { span() { div( /) } } } }"),
            "`div` cannot be inside `p`: <p> takes only inline elements"
        );
        assert_eq!(
            message("component A { template { a() { span() { a( /) } } } }"),
            "`a` cannot be inside `a`"
        );
    }

    #[test]
    fn message_says_child_of_for_direct_rules() {
        assert_eq!(
            message("component A { template { table() { tr( /) } } }"),
            "`tr` cannot be a child of `table`: <table> takes only <thead> and <tbody>"
        );
        assert_eq!(
            message(r#"component A { template { table() { tbody() { tr() { "x" } } } } }"#),
            "`text` cannot be a child of `tr`"
        );
    }

    #[test]
    fn block_inside_p_is_rejected() {
        let src = "component A { template { p() { div( /) } } }";
        assert_eq!(nesting_error(src), pair("div", "p"));
    }

    #[test]
    fn block_inside_p_through_inline_is_rejected() {
        let src = "component A { template { p() { span() { div( /) } } } }";
        assert_eq!(nesting_error(src), pair("div", "p"));
    }

    #[test]
    fn block_inside_p_behind_button_is_allowed() {
        let src = "component A { template { p() { button() { div( /) } } } }";
        assert!(compile(src).is_ok());
    }

    #[test]
    fn inline_inside_p_is_allowed() {
        let src = "component A { template { p() { span() { b( /) } } } }";
        assert!(compile(src).is_ok());
    }

    #[test]
    fn block_inside_p_under_if_and_for_is_rejected() {
        let src = r#"
            component A {
              props { n: number, on: bool }
              template { p() { @if (on) { @for (i of n) { ul( /) } } } }
            }
        "#;
        assert_eq!(nesting_error(src), pair("ul", "p"));
    }

    #[test]
    fn anchor_inside_anchor_is_rejected() {
        let src = "component A { template { a() { span() { a( /) } } } }";
        assert_eq!(nesting_error(src), pair("a", "a"));
    }

    #[test]
    fn button_inside_button_is_rejected() {
        let src = "component A { template { button() { span() { button( /) } } } }";
        assert_eq!(nesting_error(src), pair("button", "button"));
    }

    #[test]
    fn form_inside_form_is_rejected() {
        let src = "component A { template { form() { div() { form( /) } } } }";
        assert_eq!(nesting_error(src), pair("form", "form"));
    }

    #[test]
    fn tr_directly_under_table_is_rejected() {
        let src = "component A { template { table() { tr( /) } } }";
        assert_eq!(nesting_error(src), pair("tr", "table"));
    }

    #[test]
    fn table_with_sections_is_allowed() {
        let src = r#"
            component A {
              template {
                table() {
                  thead() { tr() { th() { "h" } } }
                  tbody() { tr() { td() { "c" } } }
                }
              }
            }
        "#;
        assert!(compile(src).is_ok());
    }

    #[test]
    fn td_outside_tr_is_rejected() {
        let src = "component A { template { div() { td( /) } } }";
        assert_eq!(nesting_error(src), pair("td", "div"));
    }

    #[test]
    fn div_directly_under_table_is_rejected() {
        let src = "component A { template { table() { div( /) } } }";
        assert_eq!(nesting_error(src), pair("div", "table"));
    }

    #[test]
    fn text_directly_under_tr_is_rejected() {
        let src = r#"component A { template { table() { tbody() { tr() { "x" } } } } }"#;
        assert_eq!(nesting_error(src), pair("text", "tr"));
    }

    #[test]
    fn interpolation_directly_under_table_is_rejected() {
        let src = r#"
            component A { props { a: string } template { table() { ${a} } } }
        "#;
        assert_eq!(nesting_error(src), pair("text", "table"));
    }

    #[test]
    fn div_inside_select_is_rejected() {
        let src = "component A { template { select() { div( /) } } }";
        assert_eq!(nesting_error(src), pair("div", "select"));
    }

    #[test]
    fn option_inside_select_is_allowed() {
        let src = r#"component A { template { select() { option() { "x" } } } }"#;
        assert!(compile(src).is_ok());
    }

    #[test]
    fn root_tag_of_library_component_is_not_checked_alone() {
        let src = "component Row { template { tr() { td( /) } } }";
        assert!(compile(src).is_ok());
    }

    #[test]
    fn called_component_root_is_checked_against_call_site() {
        let src = r#"
            component A { template { p() { Card( /) } } }
            component Card { template { div( /) } }
        "#;
        assert_eq!(nesting_error(src), pair("div", "p"));
    }

    #[test]
    fn called_component_root_through_other_component_is_checked() {
        let src = r#"
            component A { template { table() { Row( /) } } }
            component Row { template { Cell( /) } }
            component Cell { template { tr( /) } }
        "#;
        assert_eq!(nesting_error(src), pair("tr", "table"));
    }

    #[test]
    fn called_component_root_under_if_is_checked() {
        let src = r#"
            component A { template { tbody() { Row( /) } } }
            component Row {
              props { on: bool }
              template { @if (on) { div( /) } }
            }
        "#;
        assert_eq!(nesting_error(src), pair("div", "tbody"));
    }

    #[test]
    fn valid_called_component_root_is_allowed() {
        let src = r#"
            component A { template { table() { tbody() { Row( /) } } } }
            component Row { template { tr() { td( /) } } }
        "#;
        assert!(compile(src).is_ok());
    }

    #[test]
    fn component_cycle_does_not_hang() {
        let src = r#"
            component A { template { div() { B( /) } } }
            component B { template { A( /) } }
        "#;
        assert!(compile(src).is_ok());
    }

    #[test]
    fn slot_content_is_checked_under_slot_ancestors() {
        let src = r#"
            component A { template { Box() { div( /) } } }
            component Box { template { p() { @slot() } } }
        "#;
        assert_eq!(nesting_error(src), pair("div", "p"));
    }

    #[test]
    fn slot_content_at_callee_top_uses_call_site_ancestors() {
        let src = r#"
            component A { template { p() { Pass() { div( /) } } } }
            component Pass { template { @slot() } }
        "#;
        assert_eq!(nesting_error(src), pair("div", "p"));
    }

    #[test]
    fn named_slot_content_is_checked_under_its_own_slot() {
        let src = r#"
            component A {
              template {
                Panel() {
                  Head << div( /)
                  Body << p( /)
                }
              }
            }
            component Panel {
              template { section() { p() { @slot(Head) } div() { @slot(Body) } } }
            }
        "#;
        assert_eq!(nesting_error(src), pair("div", "p"));
    }

    #[test]
    fn valid_slot_content_is_allowed() {
        let src = r#"
            component A { template { Box() { span( /) } } }
            component Box { template { p() { @slot() } } }
        "#;
        assert!(compile(src).is_ok());
    }

    #[test]
    fn error_blames_the_call_site() {
        let src = "component A { template { p() { Card( /) } } }\ncomponent Card { template { div( /) } }";
        match compile(src) {
            Err(CompileError::Codegen(e)) => {
                let blamed = &e.src[e.err.range.start as usize..e.err.range.end as usize];
                assert_eq!(blamed, "Card");
            }
            other => panic!("에러가 아니다: {:?}", other.map(|_| ())),
        }
    }
}
