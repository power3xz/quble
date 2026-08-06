//! `.qubc` 소스에서 핸들러 타입(`.d.ts`)을 낸다. 바이트코드를 거치지 않고 AST를 직접 걸어,
//! 합성 트리의 fullname마다 data(payload)/props/context 타입을 산출한다. 바이트코드는 props
//! 이름을 버리므로(scope 인덱스만) 이름이 살아 있는 AST에서 뽑는 게 유일한 길이다.
//!
//! props는 값이 아니라 leafIndex(주소기)라 `TLeafIndex<T>`로 낸다 - `get(k)`가 그 값을 내주고
//! `set(k, v)`가 받는다(REACTIVITY.md #7.1). 배열 leaf는 push/removeAt/replace로 조작한다.
//! store는 런타임이 루트(defs[0]) 기준 leafIndex 트리로 넘기지만 여기서는 `any`로 둔다 -
//! 타입을 정확히 내려면 루트 props를 시그니처마다 실어야 하고, 그 대상 트리가 아직 미정이다.
//! props의 T는 선언 타입을 TS로 매핑한다(bool->boolean, T[]->T[], 객체->{...}).
//! 핸들러 반환은 `void | Promise<void>`다 - 런타임은 반환값을 await하지 않지만(그래서 async
//! 핸들러의 실패는 조용히 사라진다), 핸들러를 받아 감싸는 쪽이 그 Promise를 잡아 건질 수
//! 있어야 하므로 타입에 드러낸다.

use crate::ast::{ArgValue, Component, LitValue, Node, Prop, Type};
use crate::flatten::{flatten, FlatComp, SourceLoader};
use crate::CompileError;

/// 엔트리 소스에서 핸들러 d.ts 텍스트를 낸다. use 그래프를 평탄화해 루트(0)에서 합성 트리를
/// 걸어 fullname마다 시그니처를 낸다.
pub fn handlers_dts(
    entry_path: &str,
    src: &str,
    loader: &impl SourceLoader,
) -> Result<String, CompileError> {
    let comps = flatten(entry_path, src, loader).map_err(CompileError::Flatten)?;
    Ok(render(&comps))
}

/// 엔트리 소스에서 핸들러 fullname 목록만 낸다(트리 순서). d.ts와 같은 순회를 쓰되 타입을
/// 렌더하지 않는다 - 에디터 자동완성처럼 이름만 필요한 쪽이 텍스트를 되파싱하지 않게 한다.
pub fn handler_names(
    entry_path: &str,
    src: &str,
    loader: &impl SourceLoader,
) -> Result<Vec<String>, CompileError> {
    let comps = flatten(entry_path, src, loader).map_err(CompileError::Flatten)?;
    Ok(collect(&comps).into_iter().map(|h| h.fullname).collect())
}

/// 파일 경로로 d.ts를 낸다. 엔트리를 읽고 fs loader로 use를 해소한다.
pub fn handlers_dts_from_path(path: &str) -> Result<String, CompileError> {
    let not_found = || {
        CompileError::Flatten(crate::FlattenError::NotFound {
            base: String::new(),
            target: path.to_string(),
        })
    };
    let entry = std::fs::canonicalize(path).map_err(|_| not_found())?;
    let src = std::fs::read_to_string(&entry).map_err(|_| not_found())?;
    handlers_dts(&entry.to_string_lossy(), &src, &crate::fs_loader)
}

/// 한 fullname에 대응하는 핸들러 시그니처.
struct Handler {
    fullname: String,
    /// event payload 필드: (필드명, 값 출처). data는 값이라 리터럴/변수로 타입이 갈린다.
    data: Vec<(String, ArgValue)>,
    /// 이벤트가 묶인 컴포넌트. props 타입 이름을 여기서 만든다.
    comp_name: String,
    /// 그 컴포넌트의 props(leafIndex 주소기). T는 선언 타입을 TS로 매핑한다.
    props: Vec<Prop>,
    /// 발생 시점 활성 @with 컨텍스트: (컨텍스트명, 필드들). 안쪽 우선(뒤가 이김).
    contexts: Vec<(String, Vec<(String, ArgValue)>)>,
    /// 이 이벤트에 누적된 @for 깊이 = 핸들러가 받는 회차 인덱스 개수($0..$(loop_depth-1)).
    /// fullname의 [$n] 개수와 같다(Row[$0].Col[$1] -> 2).
    loop_depth: u16,
}

/// d.ts 서두: 공통 타입. `THandler<Data, Props, Ctx>`가 핸들러 하나의 모양(params 배치, 조작 함수)을
/// 담고, 각 fullname은 자기 Data/Props/Ctx만 인자로 채운다.
///
/// 배열 조작(push/removeAt/replace)은 대상이 배열 leaf여야 한다 - `TLeafIndex<TElement[]>`로
/// 받아 배열 아닌 leaf를 넘기면 타입에서 걸리고, 요소 타입도 함께 맞춘다. removeAt은 요소
/// 타입을 안 쓰므로 제네릭 없이 `unknown[]`으로 둔다.
///
/// 제네릭 이름을 자리별로 나눈 이유 - `get`의 것은 leaf가 담은 값(TValue)이고 `push`의 것은
/// 그 배열의 요소(TElement)라 뜻이 다르다. 한 이름으로 두면 나란히 놓였을 때 같은 것으로 읽힌다.
const PRELUDE: &str = "\
type TLeafIndex<T> = number & { readonly __leaf: T };
type THandler<Data, Props, Ctx, Loop> = (
  data: Data,
  params: {
    context: Ctx;
    props: Props;
    event: Event;
    store: any;
    get: <TValue>(k: TLeafIndex<TValue>) => TValue;
    set: <TValue>(k: TLeafIndex<TValue>, v: TValue) => void;
    push: <TElement>(k: TLeafIndex<TElement[]>, v: TElement) => void;
    removeAt: (k: TLeafIndex<unknown[]>, i: number) => void;
    replace: <TElement>(k: TLeafIndex<TElement[]>, v: TElement[]) => void;
  } & Loop,
) => void | Promise<void>;
";

/// 평탄화된 컴포넌트들에서 루트(0)의 합성 트리를 걸어 핸들러들을 모은다(트리 순서).
fn collect(comps: &[FlatComp]) -> Vec<Handler> {
    let mut handlers = Vec::new();
    let mut seen = Vec::new();
    walk(comps, 0, "", &[], &[], 0, &mut handlers, &mut seen);
    handlers
}

/// 평탄화된 컴포넌트들에서 루트(0)의 합성 트리를 걸어 d.ts 텍스트를 만든다.
///
/// props 타입은 컴포넌트마다 한 번 내고 핸들러는 이름으로 참조한다 - 시그니처에 인라인으로
/// 펴면 한 컴포넌트의 핸들러 수만큼 같은 텍스트가 반복된다.
fn render(comps: &[FlatComp]) -> String {
    let handlers = collect(comps);

    let mut out = String::new();
    out.push_str(PRELUDE);
    out.push('\n');

    let mut emitted: Vec<&str> = Vec::new();
    for h in &handlers {
        if emitted.contains(&h.comp_name.as_str()) {
            continue;
        }
        emitted.push(&h.comp_name);
        out.push_str(&format!(
            "type {} = {};\n",
            props_type_name(&h.comp_name),
            props_type(&h.props)
        ));
    }
    if !emitted.is_empty() {
        out.push('\n');
    }

    out.push_str("export interface THandlers {\n");
    for h in &handlers {
        out.push_str(&format!("  '{}': {};\n", h.fullname, signature(h)));
    }
    out.push_str("}\n");
    out
}

/// 컴포넌트 props 타입의 이름. 밑줄이 "여기서부터 컴포넌트 이름"을 나눈다 - 붙여 쓰면
/// 이름이 Props로 시작하거나 소문자로 시작할 때 경계가 흐려진다.
fn props_type_name(comp_name: &str) -> String {
    format!("TProps_{comp_name}")
}

/// props 선언을 leafIndex 트리 객체 타입으로.
fn props_type(props: &[Prop]) -> String {
    format!(
        "{{ {} }}",
        join(
            props
                .iter()
                .map(|p| format!("{}: {}", p.name, leaf_tree_to_ts(&p.type_)))
        )
    )
}

/// 핸들러 하나를 `THandler<Data, Props, Ctx, Loop>`로 낸다. context 없으면 Ctx는 `{}`,
/// @for 밖이면 Loop는 `{}`.
fn signature(h: &Handler) -> String {
    let data = format!("{{ {} }}", fields_type(&h.data, value_type));
    let props = props_type_name(&h.comp_name);
    let ctx = if h.contexts.is_empty() {
        "{}".to_string()
    } else {
        let fields =
            join(h.contexts.iter().map(|(name, fields)| {
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
    format!("THandler<{data}, {props}, {ctx}, {loops}>")
}

/// prop 선언 타입 -> 핸들러가 받는 leafIndex 트리(runtime.ts leafTree와 같은 규칙).
///
/// ```text
/// 원시  string              -> TLeafIndex<string>
/// 배열  { title }[]         -> TLeafIndex<{ title: string }[]>
/// 객체  { name, id }        -> { name: TLeafIndex<string>; id: TLeafIndex<number> }
/// ```
///
/// 객체는 주소가 아니라 필드마다 leaf가 따로 서서(`set(props.ghost.title, ..)`) 감싸지 않고
/// 내려간다. 배열은 칸 하나가 leaf라(push/removeAt가 그걸 받는다) 요소 안쪽은 값이므로
/// type_to_ts로 넘긴다 - 감싸는 규칙과 값 규칙이 여기서 갈린다.
fn leaf_tree_to_ts(ty: &Type) -> String {
    match ty {
        Type::Object(fields) => {
            let body = join(
                fields
                    .iter()
                    .map(|(k, t)| format!("{k}: {}", leaf_tree_to_ts(t))),
            );
            format!("{{ {body} }}")
        }
        _ => format!("TLeafIndex<{}>", type_to_ts(ty)),
    }
}

/// prop 선언 타입 -> TS 타입 문자열. 원시는 이름 매핑, 배열은 `T[]`, 객체는 `{ k: T; ... }`.
fn type_to_ts(ty: &Type) -> String {
    match ty {
        Type::Bool => "boolean".to_string(),
        Type::Number => "number".to_string(),
        Type::String => "string".to_string(),
        Type::Array(inner) => format!("{}[]", type_to_ts(inner)),
        Type::Object(fields) => {
            let body = join(
                fields
                    .iter()
                    .map(|(k, t)| format!("{k}: {}", type_to_ts(t))),
            );
            format!("{{ {body} }}")
        }
        Type::Ref(n) => unreachable!("expand가 Type::Ref({n})를 안 풀었다"),
        Type::Omit(..) | Type::Pick(..) => unreachable!("expand가 유틸 타입을 안 풀었다"),
    }
}

/// 값 필드(payload/context)의 TS 타입. 리터럴은 그 값으로 좁히고(문자열은 "..", 숫자/불리언은
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
/// @if는 then/else 둘 다 순회(어느 가지든 발생 가능). 같은 fullname은 한 번만(의도된 공유).
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
    walk_nodes(
        comps,
        comp,
        &comp.template,
        path_prefix,
        context_stack,
        pending,
        depth_base,
        handlers,
        seen,
    );
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
                // 같은 @for 안 형제/중첩 element가 모두 같은 인덱스를 실을 수 있게 유지한다.
                let suffix = seg_index_suffix(pending);
                let event_prefix = if suffix.is_empty() {
                    path_prefix.to_string()
                } else if path_prefix.is_empty() {
                    suffix
                } else {
                    format!("{path_prefix}.{suffix}")
                };
                for (_dom, event_name) in event_bindings {
                    emit(
                        comp,
                        &event_name.name,
                        &event_prefix,
                        context_stack,
                        depth_base,
                        handlers,
                        seen,
                    );
                }
                walk_nodes(
                    comps,
                    comp,
                    children,
                    path_prefix,
                    context_stack,
                    pending,
                    depth_base,
                    handlers,
                    seen,
                );
            }
            Node::SlotPlaceholderDef { .. } => {}
            Node::Component {
                alias,
                name,
                contents,
                ..
            } => {
                // 슬롯 콘텐츠는 쓰는 쪽 컨텍스트로 해석된다(SYNTAX #3.3) - 자식 prefix가 아니라
                // 지금 이 경로(path_prefix)로 건다. 콘텐츠를 쓴 자리가 곧 그 노드의 트리 위치다.
                for content in contents {
                    walk_nodes(
                        comps,
                        comp,
                        &content.nodes,
                        path_prefix,
                        context_stack,
                        pending,
                        depth_base,
                        handlers,
                        seen,
                    );
                }
                // 컴포넌트 세그먼트가 pending 인덱스를 전부 접미(Mid[$0]). 자식으로 내려가면 pending은
                // 비우되(이미 실림) depth_base는 유지 - Mid[$0] 안 @for는 Inner[$1]로 이어진다.
                let segment = alias.as_deref().unwrap_or(&name.name);
                let segment = format!("{segment}{}", seg_index_suffix(pending));
                let child_prefix = if path_prefix.is_empty() {
                    segment
                } else {
                    format!("{path_prefix}.{segment}")
                };
                if let Some(child_id) = comps.iter().position(|c| c.comp.name == name.name) {
                    walk(
                        comps,
                        child_id,
                        &child_prefix,
                        context_stack,
                        &[],
                        depth_base,
                        handlers,
                        seen,
                    );
                }
            }
            Node::With { context, children } => {
                let mut stack = context_stack.to_vec();
                if let Some(def) = comp.contexts.iter().find(|c| c.name == context.name) {
                    stack.push((def.name.clone(), def.fields.clone()));
                }
                walk_nodes(
                    comps,
                    comp,
                    children,
                    path_prefix,
                    &stack,
                    pending,
                    depth_base,
                    handlers,
                    seen,
                );
            }
            Node::If { then, else_, .. } => {
                walk_nodes(
                    comps,
                    comp,
                    then,
                    path_prefix,
                    context_stack,
                    pending,
                    depth_base,
                    handlers,
                    seen,
                );
                walk_nodes(
                    comps,
                    comp,
                    else_,
                    path_prefix,
                    context_stack,
                    pending,
                    depth_base,
                    handlers,
                    seen,
                );
            }
            Node::For { body, .. } => {
                // @for 진입 - depth_base를 pending에 추가(다음 세그먼트/이벤트가 접미), 다음 @for는
                // depth_base+1. 자식 컴포넌트 경계를 넘어도 depth_base로 이어진다(use-site 누적).
                let mut nested = pending.to_vec();
                nested.push(depth_base);
                walk_nodes(
                    comps,
                    comp,
                    body,
                    path_prefix,
                    context_stack,
                    &nested,
                    depth_base + 1,
                    handlers,
                    seen,
                );
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
        comp_name: comp.name.clone(),
        props: comp.props.clone(),
        contexts,
        loop_depth,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// use 없는 단일 소스로 d.ts를 낸다(loader 미호출).
    fn dts(src: &str) -> String {
        handlers_dts("entry", src, &(|_: &str, _: &str| None)).unwrap()
    }

    /// use 없는 단일 소스로 fullname 목록을 낸다(loader 미호출).
    fn names(src: &str) -> Vec<String> {
        handler_names("entry", src, &(|_: &str, _: &str| None)).unwrap()
    }

    /// 서두 공통 타입(TLeafIndex, THandler)이 나온다.
    #[test]
    fn prelude_defines_common_types() {
        let out = dts(r#"
            component Thumb {
              events { CLICK({ x }) }
              template { img(@click:CLICK /) }
            }
        "#);
        assert!(out.contains("type TLeafIndex<T> = number & { readonly __leaf: T };"));
        assert!(out.contains("type THandler<Data, Props, Ctx, Loop> = ("));
    }

    /// 핸들러 params에 배열 조작 3종이 있다. 대상을 `TLeafIndex<TElement[]>`로 받아야 배열 아닌
    /// leaf가 걸리고 요소 타입도 그 배열에 묶인다 - 제약이 실제로 서는지는 dts-types.test.ts.
    #[test]
    fn prelude_has_array_ops() {
        let out = dts(r#"
            component Thumb {
              events { CLICK({ x }) }
              template { img(@click:CLICK /) }
            }
        "#);
        assert!(out.contains("push: <TElement>(k: TLeafIndex<TElement[]>, v: TElement) => void;"));
        assert!(out.contains("removeAt: (k: TLeafIndex<unknown[]>, i: number) => void;"));
        assert!(
            out.contains("replace: <TElement>(k: TLeafIndex<TElement[]>, v: TElement[]) => void;")
        );
    }

    /// 핸들러 params에 event와 store가 있다. 런타임이 실제로 넘기는 것들이라 빠지면 핸들러가
    /// 그것을 받는 순간 타입이 안 맞는다(core/web/runtime.ts의 핸들러 호출부).
    #[test]
    fn prelude_has_event_and_store() {
        let out = dts(r#"
            component Thumb {
              events { CLICK({ x }) }
              template { img(@click:CLICK /) }
            }
        "#);
        assert!(out.contains("event: Event;"));
        assert!(out.contains("store: any;"));
    }

    /// 반환 타입이 async를 드러낸다. `=> void`로도 async 핸들러를 넣는 것 자체는 통과하지만
    /// (TS의 void 반환 특례), 그 타입을 읽는 쪽이 Promise를 못 본다 - 핸들러를 받아 감싸며
    /// `handler(...)?.catch(..)`로 실패를 건지려면 반환 타입에 Promise가 있어야 한다.
    #[test]
    fn prelude_allows_async_handler() {
        let out = dts(r#"
            component Thumb {
              events { CLICK({ x }) }
              template { img(@click:CLICK /) }
            }
        "#);
        assert!(out.contains(") => void | Promise<void>;"));
    }

    /// 한 컴포넌트의 배열 prop들이 저마다 다른 요소 타입으로 나온다 - push/replace의 TElement는
    /// 넘긴 leaf에서 추론되므로, 원시 배열과 객체 배열이 섞여 있어도 서로 안 넘나든다.
    #[test]
    fn array_props_keep_distinct_element_types() {
        let out = dts(r#"
            component C {
              props { tags: string[], sizes: number[], cards: { title: string }[] }
              events { GO({ tags }) }
              template { button(@click:GO /) }
            }
        "#);
        assert!(
            out.contains(
                "{ tags: TLeafIndex<string[]>; sizes: TLeafIndex<number[]>; cards: TLeafIndex<{ title: string }[]> }"
            ),
            "실제 출력:\n{out}"
        );
    }

    /// 객체 배열 안에 또 배열이 있는 prop(보드의 columns 모양) - 안쪽까지 재귀로 펼쳐져야
    /// push/replace가 요소 모양을 통째로 강제한다.
    #[test]
    fn nested_array_inside_object_element() {
        let out = dts(r#"
            component C {
              props { columns: { name: string, cards: { title: string }[] }[] }
              events { GO({ name }) }
              template { button(@click:GO /) }
            }
        "#);
        assert!(
            out.contains("columns: TLeafIndex<{ name: string; cards: { title: string }[] }[]>"),
            "실제 출력:\n{out}"
        );
    }

    /// 단순 event - data(값)/props(leafIndex). context 없으면 Ctx는 {}.
    /// 한 컴포넌트의 핸들러가 여럿이면 props 타입은 한 번만 선언되고 시그니처들이 그 이름을
    /// 나눠 쓴다 - 인라인으로 펴던 때는 같은 텍스트가 핸들러 수만큼 반복됐다.
    #[test]
    fn props_type_declared_once_per_component() {
        let out = dts(r#"
            component C {
              props { title: string, count: number }
              events { OPEN({ }) CLOSE({ }) }
              template { div() { button(@click:OPEN /) span(@click:CLOSE /) } }
            }
        "#);
        assert_eq!(
            out.matches("type TProps_C =").count(),
            1,
            "props 타입 선언이 한 번이어야 한다:\n{out}"
        );
        assert!(out.contains("'OPEN': THandler<{  }, TProps_C, {}, {}>;"), "실제 출력:\n{out}");
        assert!(out.contains("'CLOSE': THandler<{  }, TProps_C, {}, {}>;"), "실제 출력:\n{out}");
        // 인라인 잔재가 없어야 한다 - 있으면 참조가 아니라 펴 쓴 것이다.
        assert!(
            !out.contains("{ title: TLeafIndex<string>; count: TLeafIndex<number> }, {}"),
            "props가 시그니처에 인라인으로 남았다:\n{out}"
        );
    }

    /// props 타입이 leafIndex의 T로 매핑된다(string/number/bool 각각). 그 타입은 컴포넌트마다
    /// 한 번 선언되고 시그니처는 이름으로 참조한다.
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
            "type TProps_Thumb = { avatar: TLeafIndex<string>; size: TLeafIndex<number>; active: TLeafIndex<boolean> };"
        ), "실제 출력:\n{out}");
        assert!(
            out.contains("'CLICK': THandler<{ avatar: string }, TProps_Thumb, {}, {}>;"),
            "실제 출력:\n{out}"
        );
    }

    /// 배열은 칸 하나가 leaf(TLeafIndex<T[]>)지만 객체는 필드마다 leaf가 따로 선다 - 객체를
    /// 통째로 감싸면 `set(props.owner.name, ..)`을 못 쓴다(runtime.ts leafTree와 같은 규칙).
    #[test]
    fn array_is_one_leaf_object_splits_per_field() {
        let out = dts(r#"
            component C {
              props { tags: string[], owner: { name: string, id: number } }
              events { GO({ tags }) }
              template { button(@click:GO /) }
            }
        "#);
        assert!(
            out.contains(
                "{ tags: TLeafIndex<string[]>; owner: { name: TLeafIndex<string>; id: TLeafIndex<number> } }"
            ),
            "실제 출력:\n{out}"
        );
    }

    /// 객체 안 객체도 끝까지 내려가 잎에만 leafIndex가 붙는다(보드의 ghost 모양).
    #[test]
    fn nested_object_leaves_only_at_scalars() {
        let out = dts(r#"
            component C {
              props { ghost: { style: string, card: { title: string, urgent: bool } } }
              events { GO({ style }) }
              template { button(@click:GO /) }
            }
        "#);
        assert!(
            out.contains(
                "ghost: { style: TLeafIndex<string>; card: { title: TLeafIndex<string>; urgent: TLeafIndex<boolean> } }"
            ),
            "실제 출력:\n{out}"
        );
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

    /// alias 없는 type-name은 그대로 세그먼트(#1.3 의도적 공유). 같은 fullname은 한 번만.
    #[test]
    fn unaliased_type_name_shared_once() {
        let out = dts(r#"
            component Outer { template { div() { Inner( /) Inner( /) } } }
            component Inner {
              events { TOGGLE({ on }) }
              template { button(@click:TOGGLE /) }
            }
        "#);
        assert_eq!(
            out.matches("'Inner.TOGGLE':").count(),
            1,
            "실제 출력:\n{out}"
        );
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
        assert!(
            out.contains(r#", { Area: { section: "actions"; user: string } }, {}>"#),
            "실제 출력:\n{out}"
        );
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
        assert!(
            out.contains(r#"THandler<{ count: string; label: "clicks" }"#),
            "실제 출력:\n{out}"
        );
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
        assert!(
            out.contains(r#"THandler<{ n: 42; b: true; s: "hi" }"#),
            "실제 출력:\n{out}"
        );
    }

    /// @if 양가지를 다 순회한다 - then/else 안의 이벤트가 둘 다 나온다.
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

    /// 같은 @for 안 중첩 element - 형제/중첩 모두 같은 회차라 같은 [$0]을 싣는다(소진 아님).
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
        assert!(
            out.contains("'Row[$0].Cell[$1].PICK':"),
            "실제 출력:\n{out}"
        );
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
        assert!(
            out.contains("'Mid[$0].Inner[$1].PICK':"),
            "@for 안 use-site\n{out}"
        );
        assert!(
            out.contains("'Mid.Inner[$0].PICK':"),
            "@for 밖 use-site\n{out}"
        );
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

    /// fullname만 뽑는 경로 - d.ts와 같은 순회라 같은 이름이, 트리 순서대로 나온다.
    #[test]
    fn names_follow_tree_order() {
        let out = names(
            r#"
            component List {
              events { ADD({ x }) }
              template {
                button(@click:ADD /)
                @for (item of 3) { Row: Inner( /) }
              }
            }
            component Inner {
              events { PICK({ id }) }
              template { button(@click:PICK /) }
            }
        "#,
        );
        assert_eq!(out, vec!["ADD", "Row[$0].PICK"], "실제 출력:\n{out:?}");
    }

    /// 이름 목록과 d.ts가 같은 집합을 낸다 - 한쪽만 고치면 어긋나는 회귀를 잡는다.
    #[test]
    fn names_match_dts_keys() {
        let src = r#"
            component Outer {
              props { flag: bool }
              contexts { Area { section: "actions" } }
              template {
                @with Area {
                  @for (row of 3) {
                    @if (flag) { A: Inner( /) } @else { B: Inner( /) }
                  }
                }
              }
            }
            component Inner {
              events { TOGGLE({ on }) }
              template { button(@click:TOGGLE /) }
            }
        "#;
        let text = dts(src);
        for name in names(src) {
            assert!(
                text.contains(&format!("'{name}':")),
                "d.ts에 없다: {name}\n{text}"
            );
        }
    }

    /// 이벤트가 없으면 빈 목록(에러 아님) - 자동완성이 후보 없음으로 다룰 수 있어야 한다.
    #[test]
    fn no_events_gives_empty_list() {
        assert!(names(r#"component C { template { div( /) } }"#).is_empty());
    }
}
