//! `.qubc` 소스에서 핸들러 타입(`.d.ts`)을 낸다. 바이트코드를 거치지 않고 AST를 직접 걸어,
//! 합성 트리의 fullname마다 data(payload)·props·context 타입을 산출한다. 바이트코드는 props
//! 이름을 버리므로(scope 인덱스만) 이름이 살아 있는 AST에서 뽑는 게 유일한 길이다.
//!
//! props는 값이 아니라 leafIndex(주소기)라 `LeafIndex<T>`로 낸다 - `get(k)`가 T를 내주고
//! `set(k, v)`가 T를 받는다(REACTIVITY.md §7.1). store/get의 대상 트리는 아직 미정이라 store는
//! 뺀다. props의 T는 지금 전부 string(props에 타입 표기가 없다).

use crate::ast::{ArgValue, Component, Node};
use crate::resolve::{flatten, FlatComp, Resolver};
use crate::CompileError;

/// 엔트리 소스에서 핸들러 d.ts 텍스트를 낸다(compile_src와 대칭). use 그래프를 평탄화해
/// 루트(0)에서 합성 트리를 걸어 fullname마다 시그니처를 낸다.
pub fn handlers_dts_src(
    entry_path: &str,
    src: &str,
    resolver: &impl Resolver,
) -> Result<String, CompileError> {
    let comps = flatten(entry_path, src, resolver).map_err(CompileError::Resolve)?;
    Ok(render(&comps))
}

/// 파일 경로로 d.ts를 낸다(compile_file과 대칭). 엔트리를 읽고 fs resolver로 use를 해소한다.
pub fn handlers_dts_file(path: &str) -> Result<String, CompileError> {
    let not_found = || {
        CompileError::Resolve(crate::ResolveError::NotFound {
            base: String::new(),
            target: path.to_string(),
        })
    };
    let entry = std::fs::canonicalize(path).map_err(|_| not_found())?;
    let src = std::fs::read_to_string(&entry).map_err(|_| not_found())?;
    handlers_dts_src(&entry.to_string_lossy(), &src, &crate::fs_resolver)
}

/// 한 fullname에 대응하는 핸들러 시그니처.
struct Handler {
    fullname: String,
    /// event payload 필드: (필드명, 값 출처). data는 값이라 리터럴/변수로 타입이 갈린다.
    data: Vec<(String, ArgValue)>,
    /// 이벤트가 묶인 컴포넌트의 props 이름(leafIndex 주소기). 지금 T는 전부 string.
    props: Vec<String>,
    /// 발생 시점 활성 @with 컨텍스트: (컨텍스트명, 필드들). 안쪽 우선(뒤가 이김).
    contexts: Vec<(String, Vec<(String, ArgValue)>)>,
}

/// d.ts 서두: 공통 타입. `Handler<Data, Props, Ctx>`가 핸들러 하나의 모양(params 배치, get/set)을
/// 담고, 각 fullname은 자기 Data/Props/Ctx만 인자로 채운다. get/set은 지금 하나(<T> 제네릭)로
/// 퉁친다 - props에 타입 표기가 오면 분리가 필요해질 수 있다.
const PRELUDE: &str = "\
type LeafIndex<T> = number & { readonly __leaf: T };
type Handler<Data, Props, Ctx> = (
  data: Data,
  params: { context: Ctx; props: Props; get: <T>(k: LeafIndex<T>) => T; set: <T>(k: LeafIndex<T>, v: T) => void },
) => void;
";

/// 평탄화된 컴포넌트들에서 루트(0)의 합성 트리를 걸어 d.ts 텍스트를 만든다.
fn render(comps: &[FlatComp]) -> String {
    let mut handlers = Vec::new();
    let mut seen = Vec::new();
    walk(comps, 0, "", &[], &mut handlers, &mut seen);

    let mut out = String::new();
    out.push_str(PRELUDE);
    out.push('\n');
    out.push_str("export interface Handlers {\n");
    for h in &handlers {
        out.push_str(&format!("  '{}': {};\n", h.fullname, signature(h)));
    }
    out.push_str("}\n");
    out
}

/// 핸들러 하나를 `Handler<Data, Props, Ctx>`로 낸다. context 없으면 Ctx는 `{}`.
fn signature(h: &Handler) -> String {
    let data = format!("{{ {} }}", fields_type(&h.data, value_type));
    let props = format!(
        "{{ {} }}",
        join(h.props.iter().map(|p| format!("{p}: LeafIndex<string>")))
    );
    let ctx = if h.contexts.is_empty() {
        "{}".to_string()
    } else {
        let fields = join(h.contexts.iter().map(|(name, fields)| {
            format!("{name}: {{ {} }}", fields_type(fields, value_type))
        }));
        format!("{{ {fields} }}")
    };
    format!("Handler<{data}, {props}, {ctx}>")
}

/// 값 필드(payload/context)의 TS 타입. 리터럴은 그 값으로 좁히고, 변수는 string(소스에 타입 없음).
fn value_type(v: &ArgValue) -> String {
    match v {
        ArgValue::Literal(s) => format!("{s:?}"),
        ArgValue::Var(_) => "string".to_string(),
    }
}

/// (필드명, 값) 목록 -> `a: T; b: U` 객체 본문.
fn fields_type(fields: &[(String, ArgValue)], ty: fn(&ArgValue) -> String) -> String {
    join(fields.iter().map(|(name, v)| format!("{name}: {}", ty(v))))
}

fn join(parts: impl Iterator<Item = String>) -> String {
    parts.collect::<Vec<_>>().join("; ")
}

/// 합성 트리를 걷는다(disasm.js collectEventFullnames와 같은 규칙).
/// path_prefix: alias/type-name 세그먼트 누적. context_stack: 활성 @with(바깥->안쪽).
/// @if는 then·else 둘 다 순회(어느 가지든 발생 가능). 같은 fullname은 한 번만(의도된 공유).
fn walk(
    comps: &[FlatComp],
    comp_id: usize,
    path_prefix: &str,
    context_stack: &[(String, Vec<(String, ArgValue)>)],
    handlers: &mut Vec<Handler>,
    seen: &mut Vec<String>,
) {
    let comp = &comps[comp_id].comp;
    walk_nodes(comps, comp, &comp.template, path_prefix, context_stack, handlers, seen);
}

fn walk_nodes(
    comps: &[FlatComp],
    comp: &Component,
    nodes: &[Node],
    path_prefix: &str,
    context_stack: &[(String, Vec<(String, ArgValue)>)],
    handlers: &mut Vec<Handler>,
    seen: &mut Vec<String>,
) {
    for node in nodes {
        match node {
            Node::Element {
                event_bindings,
                children,
                ..
            } => {
                for (_dom, event_name) in event_bindings {
                    emit(comp, event_name, path_prefix, context_stack, handlers, seen);
                }
                walk_nodes(comps, comp, children, path_prefix, context_stack, handlers, seen);
            }
            Node::Component { alias, name, .. } => {
                let segment = alias.as_deref().unwrap_or(name);
                let child_prefix = if path_prefix.is_empty() {
                    segment.to_string()
                } else {
                    format!("{path_prefix}.{segment}")
                };
                if let Some(child_id) = comps.iter().position(|c| &c.comp.name == name) {
                    walk(comps, child_id, &child_prefix, context_stack, handlers, seen);
                }
            }
            Node::With { context, children } => {
                let mut stack = context_stack.to_vec();
                if let Some(def) = comp.contexts.iter().find(|c| &c.name == context) {
                    stack.push((def.name.clone(), def.fields.clone()));
                }
                walk_nodes(comps, comp, children, path_prefix, &stack, handlers, seen);
            }
            Node::If { then, else_, .. } => {
                walk_nodes(comps, comp, then, path_prefix, context_stack, handlers, seen);
                walk_nodes(comps, comp, else_, path_prefix, context_stack, handlers, seen);
            }
            Node::Text(_) | Node::Var(_) => {}
        }
    }
}

/// 이벤트 하나를 fullname으로 확정해 핸들러에 넣는다. 같은 이름 컨텍스트는 안쪽(뒤)이 이긴다.
fn emit(
    comp: &Component,
    event_name: &str,
    path_prefix: &str,
    context_stack: &[(String, Vec<(String, ArgValue)>)],
    handlers: &mut Vec<Handler>,
    seen: &mut Vec<String>,
) {
    let fullname = if path_prefix.is_empty() {
        event_name.to_string()
    } else {
        format!("{path_prefix}.{event_name}")
    };
    if seen.iter().any(|s| s == &fullname) {
        return;
    }
    let data = comp
        .events
        .iter()
        .find(|e| e.name == event_name)
        .map(|e| e.payload.clone())
        .unwrap_or_default();

    // 같은 이름 컨텍스트는 안쪽(뒤)이 이긴다 - 뒤에서부터 이름 기준 dedup.
    let mut contexts: Vec<(String, Vec<(String, ArgValue)>)> = Vec::new();
    for ctx in context_stack.iter().rev() {
        if !contexts.iter().any(|(n, _)| n == &ctx.0) {
            contexts.push(ctx.clone());
        }
    }
    contexts.reverse();

    seen.push(fullname.clone());
    handlers.push(Handler {
        fullname,
        data,
        props: comp.props.clone(),
        contexts,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// use 없는 단일 소스로 d.ts를 낸다(resolver 미호출).
    fn dts(src: &str) -> String {
        handlers_dts_src("entry", src, &(|_: &str, _: &str| None)).unwrap()
    }

    /// 서두 공통 타입(LeafIndex, Handler)이 나온다.
    #[test]
    fn prelude_defines_common_types() {
        let out = dts(r#"
            component Thumb {
              events { CLICK({ x }) }
              template { img(@click:CLICK) {} }
            }
        "#);
        assert!(out.contains("type LeafIndex<T> = number & { readonly __leaf: T };"));
        assert!(out.contains("type Handler<Data, Props, Ctx> = ("));
    }

    /// 단순 event - data(값)·props(leafIndex). context 없으면 Ctx는 {}.
    #[test]
    fn single_event_props_and_leafindex() {
        let out = dts(r#"
            component Thumb {
              props { avatar, name }
              events { CLICK({ name, avatar }) }
              template { img(@click:CLICK) {} }
            }
        "#);
        assert!(out.contains(
            "'CLICK': Handler<{ name: string; avatar: string }, { avatar: LeafIndex<string>; name: LeafIndex<string> }, {}>;"
        ), "실제 출력:\n{out}");
    }

    /// alias가 fullname path 세그먼트가 된다.
    #[test]
    fn alias_becomes_fullname_segment() {
        let out = dts(r#"
            component Outer { template { div() { Done: Inner() {} } } }
            component Inner {
              events { TOGGLE({ on }) }
              template { button(@click:TOGGLE) {} }
            }
        "#);
        assert!(out.contains("'Done.TOGGLE':"), "실제 출력:\n{out}");
    }

    /// alias 없는 type-name은 그대로 세그먼트(§1.3 의도적 공유). 같은 fullname은 한 번만.
    #[test]
    fn unaliased_type_name_shared_once() {
        let out = dts(r#"
            component Outer { template { div() { Inner() {} Inner() {} } } }
            component Inner {
              events { TOGGLE({ on }) }
              template { button(@click:TOGGLE) {} }
            }
        "#);
        assert_eq!(out.matches("'Inner.TOGGLE':").count(), 1, "실제 출력:\n{out}");
    }

    /// @with 활성 컨텍스트가 Ctx에 필드째 들어간다. 리터럴은 값으로 좁힌다.
    #[test]
    fn with_context_and_literal_field() {
        let out = dts(r#"
            component C {
              props { userId }
              contexts { Area { section: "actions", user: userId } }
              events { GO({ userId }) }
              template {
                @with Area {
                  button(@click:GO) {}
                }
              }
            }
        "#);
        assert!(out.contains(r#", { Area: { section: "actions"; user: string } }>"#), "실제 출력:\n{out}");
    }

    /// 리터럴 payload 필드는 그 값으로 좁혀지고, 변수 필드는 string.
    #[test]
    fn literal_payload_narrowed() {
        let out = dts(r#"
            component C {
              props { count }
              events { BUMP({ count, label: "clicks" }) }
              template { button(@click:BUMP) {} }
            }
        "#);
        assert!(out.contains(r#"Handler<{ count: string; label: "clicks" }"#), "실제 출력:\n{out}");
    }

    /// @if 양가지를 다 순회한다 - then·else 안의 이벤트가 둘 다 나온다.
    #[test]
    fn if_visits_both_branches() {
        let out = dts(r#"
            component Outer {
              props { flag }
              template {
                @if (flag) { A: Inner() {} } @else { B: Inner() {} }
              }
            }
            component Inner {
              events { TOGGLE({ on }) }
              template { button(@click:TOGGLE) {} }
            }
        "#);
        assert!(out.contains("'A.TOGGLE':"), "then 가지 이벤트\n{out}");
        assert!(out.contains("'B.TOGGLE':"), "else 가지 이벤트\n{out}");
    }
}
