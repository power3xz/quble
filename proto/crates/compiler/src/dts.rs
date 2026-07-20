//! `.qubc` 소스에서 핸들러 타입(`.d.ts`)을 낸다. 바이트코드를 거치지 않고 AST를 직접 걸어,
//! 합성 트리의 fullname마다 data(payload)·props·context 타입을 산출한다. 바이트코드는 props
//! 이름을 버리므로(scope 인덱스만) 이름이 살아 있는 AST에서 뽑는 게 유일한 길이다.
//!
//! props는 값이 아니라 leafIndex(주소기)라 `LeafIndex<T>`로 낸다 - `get(k)`가 T를 내주고
//! `set(k, v)`가 T를 받는다(REACTIVITY.md §7.1). store/get의 대상 트리는 아직 미정이라 store는
//! 뺀다. props의 T는 선언 타입을 TS로 매핑한다(bool->boolean, T[]->T[], 객체->{...}).

use crate::ast::{ArgValue, Component, LitValue, Node, Prop, Type};
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
    /// 이벤트가 묶인 컴포넌트의 props(leafIndex 주소기). T는 선언 타입을 TS로 매핑한다.
    props: Vec<Prop>,
    /// 발생 시점 활성 @with 컨텍스트: (컨텍스트명, 필드들). 안쪽 우선(뒤가 이김).
    contexts: Vec<(String, Vec<(String, ArgValue)>)>,
    /// 이 이벤트에 누적된 @for 깊이 = 핸들러가 받는 회차 인덱스 개수($0..$(loop_depth-1)).
    /// fullname의 [$n] 개수와 같다(Row[$0].Col[$1] -> 2).
    loop_depth: u16,
}

/// d.ts 서두: 공통 타입. `Handler<Data, Props, Ctx>`가 핸들러 하나의 모양(params 배치, get/set)을
/// 담고, 각 fullname은 자기 Data/Props/Ctx만 인자로 채운다. get/set은 지금 하나(<T> 제네릭)로
/// 퉁친다 - props에 타입 표기가 오면 분리가 필요해질 수 있다.
const PRELUDE: &str = "\
type LeafIndex<T> = number & { readonly __leaf: T };
type Handler<Data, Props, Ctx, Loop> = (
  data: Data,
  params: { context: Ctx; props: Props; get: <T>(k: LeafIndex<T>) => T; set: <T>(k: LeafIndex<T>, v: T) => void } & Loop,
) => void;
";

/// 평탄화된 컴포넌트들에서 루트(0)의 합성 트리를 걸어 d.ts 텍스트를 만든다.
fn render(comps: &[FlatComp]) -> String {
    let mut handlers = Vec::new();
    let mut seen = Vec::new();
    walk(comps, 0, "", &[], &[], 0, &mut handlers, &mut seen);

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

/// 핸들러 하나를 `Handler<Data, Props, Ctx, Loop>`로 낸다. context 없으면 Ctx는 `{}`,
/// @for 밖이면 Loop는 `{}`.
fn signature(h: &Handler) -> String {
    let data = format!("{{ {} }}", fields_type(&h.data, value_type));
    let props = format!(
        "{{ {} }}",
        join(
            h.props
                .iter()
                .map(|p| format!("{}: LeafIndex<{}>", p.name, type_to_ts(&p.type_)))
        )
    );
    let ctx = if h.contexts.is_empty() {
        "{}".to_string()
    } else {
        let fields = join(h.contexts.iter().map(|(name, fields)| {
            format!("{name}: {{ {} }}", fields_type(fields, value_type))
        }));
        format!("{{ {fields} }}")
    };
    // Loop: 회차 인덱스 $0..$(loop_depth-1). 전부 number(회차 번호). @for 밖이면 {}.
    let loops = if h.loop_depth == 0 {
        "{}".to_string()
    } else {
        format!(
            "{{ {} }}",
            join((0..h.loop_depth).map(|i| format!("${i}: number")))
        )
    };
    format!("Handler<{data}, {props}, {ctx}, {loops}>")
}

/// prop 선언 타입 -> TS 타입 문자열. 원시는 이름 매핑, 배열은 `T[]`, 객체는 `{ k: T; ... }`.
fn type_to_ts(ty: &Type) -> String {
    match ty {
        Type::Bool => "boolean".to_string(),
        Type::Number => "number".to_string(),
        Type::String => "string".to_string(),
        Type::Array(inner) => format!("{}[]", type_to_ts(inner)),
        Type::Object(fields) => {
            let body = join(fields.iter().map(|(k, t)| format!("{k}: {}", type_to_ts(t))));
            format!("{{ {body} }}")
        }
        Type::Ref(n) => unreachable!("resolve가 Type::Ref({n})를 안 풀었다"),
        Type::Omit(..) | Type::Pick(..) => unreachable!("resolve가 유틸 타입을 안 풀었다"),
    }
}

/// 값 필드(payload/context)의 TS 타입. 리터럴은 그 값으로 좁히고(문자열은 "..", 숫자·불리언은
/// 값 그대로), 변수는 string(소스에 타입 없음 - Var 타입은 다음 스텝).
fn value_type(v: &ArgValue) -> String {
    match v {
        ArgValue::Literal(LitValue::Str(s)) => format!("{s:?}"),
        ArgValue::Literal(LitValue::Number(n)) => n.to_string(),
        ArgValue::Literal(LitValue::Bool(b)) => b.to_string(),
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

/// @for 인덱스는 세그먼트에 접미한다(Mid[$0]) - fullname을 사람이 읽는 핸들러 키라 인덱스가
/// 대상 뒤에 오는 게 자연스럽다(분리 세그먼트 [$0].Mid는 인덱스가 앞에 떠 안 읽힘). 대신 컴포넌트
/// (세그먼트 접미)와 element 직속(익명 세그먼트 [$n])의 두 케이스가 생긴다.
///
/// pending: 아직 세그먼트에 못 붙인 @for 깊이들. @for 진입 시 push, 컴포넌트 세그먼트를 만나면
/// 전부 그 이름에 접미하고 비운다. 세그먼트 없이 element에서 이벤트가 나면 익명 세그먼트로 싣는다.
fn seg_index_suffix(pending: &[u16]) -> String {
    pending.iter().map(|d| format!("[${d}]")).collect()
}

/// 합성 트리를 걷는다(disasm.js collectEventFullnames와 같은 규칙).
/// path_prefix: alias/type-name 세그먼트 누적. context_stack: 활성 @with(바깥->안쪽).
/// pending: 접미 대기 중인 @for 깊이(위 참고). 자식 컴포넌트 use-site의 @for 깊이를 이어받는다.
/// @if는 then·else 둘 다 순회(어느 가지든 발생 가능). 같은 fullname은 한 번만(의도된 공유).
fn walk(
    comps: &[FlatComp],
    comp_id: usize,
    path_prefix: &str,
    context_stack: &[(String, Vec<(String, ArgValue)>)],
    pending: &[u16],
    depth_base: u16,
    handlers: &mut Vec<Handler>,
    seen: &mut Vec<String>,
) {
    let comp = &comps[comp_id].comp;
    walk_nodes(comps, comp, &comp.template, path_prefix, context_stack, pending, depth_base, handlers, seen);
}

/// depth_base: 다음 @for가 쓸 인덱스 번호(use-site부터 누적). pending을 컴포넌트가 소비해도
/// 이어진다 - Mid[$0] 안의 @for는 depth_base 1이라 Inner[$1]이 된다(같은 컴포넌트 안 중첩과 동일).
fn walk_nodes(
    comps: &[FlatComp],
    comp: &Component,
    nodes: &[Node],
    path_prefix: &str,
    context_stack: &[(String, Vec<(String, ArgValue)>)],
    pending: &[u16],
    depth_base: u16,
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
                // 이벤트가 @for 직속(세그먼트 만드는 컴포넌트 없이)이면 익명 세그먼트로 인덱스를
                // 싣는다([$0].SELECT). element는 세그먼트를 안 만들어 pending을 소비하지 않는다 -
                // 같은 @for 안 형제·중첩 element가 모두 같은 인덱스를 실을 수 있게 유지한다.
                let suffix = seg_index_suffix(pending);
                let event_prefix = if suffix.is_empty() {
                    path_prefix.to_string()
                } else if path_prefix.is_empty() {
                    suffix
                } else {
                    format!("{path_prefix}.{suffix}")
                };
                for (_dom, event_name) in event_bindings {
                    emit(comp, event_name, &event_prefix, context_stack, depth_base, handlers, seen);
                }
                walk_nodes(comps, comp, children, path_prefix, context_stack, pending, depth_base, handlers, seen);
            }
            Node::Component { alias, name, .. } => {
                // 컴포넌트 세그먼트가 pending 인덱스를 전부 접미(Mid[$0]). 자식으로 내려가면 pending은
                // 비우되(이미 실림) depth_base는 유지 - Mid[$0] 안 @for는 Inner[$1]로 이어진다.
                let segment = alias.as_deref().unwrap_or(name);
                let segment = format!("{segment}{}", seg_index_suffix(pending));
                let child_prefix = if path_prefix.is_empty() {
                    segment
                } else {
                    format!("{path_prefix}.{segment}")
                };
                if let Some(child_id) = comps.iter().position(|c| &c.comp.name == name) {
                    walk(comps, child_id, &child_prefix, context_stack, &[], depth_base, handlers, seen);
                }
            }
            Node::With { context, children } => {
                let mut stack = context_stack.to_vec();
                if let Some(def) = comp.contexts.iter().find(|c| &c.name == context) {
                    stack.push((def.name.clone(), def.fields.clone()));
                }
                walk_nodes(comps, comp, children, path_prefix, &stack, pending, depth_base, handlers, seen);
            }
            Node::If { then, else_, .. } => {
                walk_nodes(comps, comp, then, path_prefix, context_stack, pending, depth_base, handlers, seen);
                walk_nodes(comps, comp, else_, path_prefix, context_stack, pending, depth_base, handlers, seen);
            }
            Node::For { body, .. } => {
                // @for 진입 - depth_base를 pending에 추가(다음 세그먼트/이벤트가 접미), 다음 @for는
                // depth_base+1. 자식 컴포넌트 경계를 넘어도 depth_base로 이어진다(use-site 누적).
                let mut nested = pending.to_vec();
                nested.push(depth_base);
                walk_nodes(comps, comp, body, path_prefix, context_stack, &nested, depth_base + 1, handlers, seen);
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
    loop_depth: u16,
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
        loop_depth,
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
              template { img(@click:CLICK /) }
            }
        "#);
        assert!(out.contains("type LeafIndex<T> = number & { readonly __leaf: T };"));
        assert!(out.contains("type Handler<Data, Props, Ctx, Loop> = ("));
    }

    /// 단순 event - data(값)·props(leafIndex). context 없으면 Ctx는 {}.
    /// props 타입이 leafIndex의 T로 매핑된다(string/number/bool 각각).
    #[test]
    fn single_event_props_and_leafindex() {
        let out = dts(r#"
            component Thumb {
              props { avatar: string, size: number, active: bool }
              events { CLICK({ avatar }) }
              template { img(@click:CLICK /) }
            }
        "#);
        assert!(out.contains(
            "'CLICK': Handler<{ avatar: string }, { avatar: LeafIndex<string>; size: LeafIndex<number>; active: LeafIndex<boolean> }, {}, {}>;"
        ), "실제 출력:\n{out}");
    }

    /// 배열·객체 prop 타입이 재귀적으로 TS 타입으로 매핑된다(T[], { k: T }).
    #[test]
    fn array_and_object_prop_types() {
        let out = dts(r#"
            component C {
              props { tags: string[], owner: { name: string, id: number } }
              events { GO({ tags }) }
              template { button(@click:GO /) }
            }
        "#);
        assert!(out.contains(
            "{ tags: LeafIndex<string[]>; owner: LeafIndex<{ name: string; id: number }> }"
        ), "실제 출력:\n{out}");
    }

    /// alias가 fullname path 세그먼트가 된다.
    #[test]
    fn alias_becomes_fullname_segment() {
        let out = dts(r#"
            component Outer { template { div() { Done: Inner( /) } } }
            component Inner {
              events { TOGGLE({ on }) }
              template { button(@click:TOGGLE /) }
            }
        "#);
        assert!(out.contains("'Done.TOGGLE':"), "실제 출력:\n{out}");
    }

    /// alias 없는 type-name은 그대로 세그먼트(§1.3 의도적 공유). 같은 fullname은 한 번만.
    #[test]
    fn unaliased_type_name_shared_once() {
        let out = dts(r#"
            component Outer { template { div() { Inner( /) Inner( /) } } }
            component Inner {
              events { TOGGLE({ on }) }
              template { button(@click:TOGGLE /) }
            }
        "#);
        assert_eq!(out.matches("'Inner.TOGGLE':").count(), 1, "실제 출력:\n{out}");
    }

    /// @with 활성 컨텍스트가 Ctx에 필드째 들어간다. 리터럴은 값으로 좁힌다.
    #[test]
    fn with_context_and_literal_field() {
        let out = dts(r#"
            component C {
              props { userId: string }
              contexts { Area { section: "actions", user: userId } }
              events { GO({ userId }) }
              template {
                @with Area {
                  button(@click:GO /)
                }
              }
            }
        "#);
        assert!(out.contains(r#", { Area: { section: "actions"; user: string } }, {}>"#), "실제 출력:\n{out}");
    }

    /// 리터럴 payload 필드는 그 값으로 좁혀지고, 변수 필드는 string.
    #[test]
    fn literal_payload_narrowed() {
        let out = dts(r#"
            component C {
              props { count: number }
              events { BUMP({ count, label: "clicks" }) }
              template { button(@click:BUMP /) }
            }
        "#);
        assert!(out.contains(r#"Handler<{ count: string; label: "clicks" }"#), "실제 출력:\n{out}");
    }

    /// payload 리터럴은 타입대로 좁혀진다 - 숫자는 그 값, 불리언은 true/false, 문자열은 "..".
    #[test]
    fn typed_literal_payload_narrowed() {
        let out = dts(r#"
            component C {
              events { E({ n: 42, b: true, s: "hi" }) }
              template { button(@click:E /) }
            }
        "#);
        assert!(out.contains(r#"Handler<{ n: 42; b: true; s: "hi" }"#), "실제 출력:\n{out}");
    }

    /// @if 양가지를 다 순회한다 - then·else 안의 이벤트가 둘 다 나온다.
    #[test]
    fn if_visits_both_branches() {
        let out = dts(r#"
            component Outer {
              props { flag: bool }
              template {
                @if (flag) { A: Inner( /) } @else { B: Inner( /) }
              }
            }
            component Inner {
              events { TOGGLE({ on }) }
              template { button(@click:TOGGLE /) }
            }
        "#);
        assert!(out.contains("'A.TOGGLE':"), "then 가지 이벤트\n{out}");
        assert!(out.contains("'B.TOGGLE':"), "else 가지 이벤트\n{out}");
    }

    /// @for 몸체 자식 컴포넌트 세그먼트가 @for 인덱스를 접미(Row[$0]).
    #[test]
    fn for_component_segment_suffix() {
        let out = dts(r#"
            component List { template { @for (item of 3) { Row: Inner( /) } } }
            component Inner {
              events { PICK({ id }) }
              template { button(@click:PICK /) }
            }
        "#);
        assert!(out.contains("'Row[$0].PICK':"), "실제 출력:\n{out}");
    }

    /// element 직속(세그먼트 만드는 컴포넌트 없음)은 익명 세그먼트로 인덱스를 싣는다([$0].SELECT).
    #[test]
    fn for_element_direct_anonymous_segment() {
        let out = dts(r#"
            component Menu {
              events { SELECT({ i }) }
              template { @for (item of 3) { li(@click:SELECT /) } }
            }
        "#);
        assert!(out.contains("'[$0].SELECT':"), "실제 출력:\n{out}");
    }

    /// 형제 자식 여럿 - 각자 제 세그먼트에 같은 @for 인덱스를 접미.
    #[test]
    fn for_siblings_share_index() {
        let out = dts(r#"
            component List {
              template { @for (item of 3) { A: Inner( /) B: Inner( /) } }
            }
            component Inner {
              events { CLICK({ id }) }
              template { button(@click:CLICK /) }
            }
        "#);
        assert!(out.contains("'A[$0].CLICK':"), "실제 출력:\n{out}");
        assert!(out.contains("'B[$0].CLICK':"), "실제 출력:\n{out}");
    }

    /// 같은 @for 안 중첩 element - 형제·중첩 모두 같은 회차라 같은 [$0]을 싣는다(소진 아님).
    #[test]
    fn for_nested_element_same_index() {
        let out = dts(r#"
            component Menu {
              events { A({ x }) B({ y }) }
              template {
                @for (item of 3) {
                  div(@click:A) { span(@click:B /) }
                }
              }
            }
        "#);
        assert!(out.contains("'[$0].A':"), "실제 출력:\n{out}");
        assert!(out.contains("'[$0].B':"), "실제 출력:\n{out}");
    }

    /// 중첩 @for - 각 컴포넌트 세그먼트가 자기 @for 깊이를 접미(Row[$0].Cell[$1]).
    /// @for가 서로 다른 컴포넌트에 있어도 use-site 깊이를 이어받는다(리셋 X).
    #[test]
    fn nested_for_depths_across_components() {
        let out = dts(r#"
            component List {
              template {
                @for (row of 3) { Row: Mid( /) }
              }
            }
            component Mid {
              template { @for (cell of 3) { Cell: Inner( /) } }
            }
            component Inner {
              events { PICK({ id }) }
              template { button(@click:PICK /) }
            }
        "#);
        assert!(out.contains("'Row[$0].Cell[$1].PICK':"), "실제 출력:\n{out}");
    }

    /// @for 안 @if는 깊이를 안 늘린다 - 가지 안 세그먼트도 같은 @for 인덱스.
    #[test]
    fn for_with_if_keeps_depth() {
        let out = dts(r#"
            component List {
              props { flag: bool }
              template {
                @for (item of 3) { @if (flag) { Row: Inner( /) } }
              }
            }
            component Inner {
              events { PICK({ id }) }
              template { button(@click:PICK /) }
            }
        "#);
        assert!(out.contains("'Row[$0].PICK':"), "실제 출력:\n{out}");
    }

    /// 같은 컴포넌트가 @for 안/밖에서 쓰이면 use-site 깊이에 따라 인덱스가 다르다.
    #[test]
    fn same_component_index_by_use_site() {
        let out = dts(r#"
            component Menu {
              template {
                @for (a of 3) { Mid( /) }
                Mid( /)
              }
            }
            component Mid { template { @for (b of 3) { Inner( /) } } }
            component Inner {
              events { PICK({ id }) }
              template { button(@click:PICK /) }
            }
        "#);
        // @for 안 Mid: b가 [$1] (a 안). @for 밖 Mid: b가 [$0].
        assert!(out.contains("'Mid[$0].Inner[$1].PICK':"), "@for 안 use-site\n{out}");
        assert!(out.contains("'Mid.Inner[$0].PICK':"), "@for 밖 use-site\n{out}");
    }

    /// @for 밖 컴포넌트/이벤트는 [$n] 없음(회귀 - 반복 아니면 구분자 불필요).
    #[test]
    fn outside_for_no_index() {
        let out = dts(r#"
            component List { template { Row: Inner( /) } }
            component Inner {
              events { PICK({ id }) }
              template { button(@click:PICK /) }
            }
        "#);
        assert!(out.contains("'Row.PICK':"), "실제 출력:\n{out}");
        assert!(!out.contains("[$"), "@for 밖은 인덱스 없음\n{out}");
    }
}
