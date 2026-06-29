//! AST -> 바이트코드 Module. 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간.

use crate::ast::{ArgValue, AttrValue, Event, Node};
use crate::resolve::FlatComp;
use bytecode::{encode, tags, CompDef, ConstPool, EventDef, Module, Op};

#[derive(Debug, PartialEq, Eq)]
pub enum CodegenError {
    /// 내장 태그 테이블에 없는 태그.
    UnknownTag(String),
    /// props에 선언되지 않은 변수 참조.
    UnknownProp(String),
    /// 호출했지만 파일에 정의가 없는 컴포넌트.
    UnknownComponent(String),
    /// 자식 prop명이 자식 props 선언에 없음 (use-site 바인딩 오류).
    UnknownArg { comp: String, prop: String },
    /// `@click:EVENT`이 이 컴포넌트 events에 없는 이벤트명을 가리킴.
    UnknownEvent(String),
}

/// 컴포넌트 이름 -> (ID, props 선언) 룩업. 합성 호출(`Comp(...)`)을 만났을 때 RENDER에 박을 ID를
/// 찾고, PUSH_ARG를 자식 props 순서로 정렬하려고 props 선언도 같이 돌려준다. 컴포넌트 ID = 정의 순서.
struct CompLookup<'a> {
    by_name: std::collections::HashMap<&'a str, (u16, &'a [String])>,
}

impl<'a> CompLookup<'a> {
    fn build(comps: &'a [FlatComp]) -> Self {
        let by_name = comps
            .iter()
            .enumerate()
            .map(|(i, fc)| (fc.comp.name.as_str(), (i as u16, fc.comp.props.as_slice())))
            .collect();
        CompLookup { by_name }
    }

    /// 이름으로 (컴포넌트 ID, 자식 props 선언)을 찾는다.
    fn get(&self, name: &str) -> Option<(u16, &'a [String])> {
        self.by_name.get(name).copied()
    }
}

/// 파일의 컴포넌트 정의들을 하나의 직렬화된 Module로. 컴포넌트 ID = 정의 순서.
/// 두 번째 반환값은 리소스 사이드맵 — 인덱스가 모듈 전역 resId, 값이 정규화 경로.
/// 빌드 단계가 이걸 받아 내용 해시·복사·URL화를 한다(BYTECODE.md §5 LOAD_RES 메모).
pub fn generate(comps: &[FlatComp]) -> Result<(Box<[u8]>, Vec<String>), CodegenError> {
    let comp_lookup = CompLookup::build(comps);
    let mut pool = ConstPool::new();
    let mut code = Vec::new();
    let mut defs = Vec::new();
    // 정규화 경로 -> resId. 등장 순서로 0,1,2…. 같은 경로는 같은 resId(모듈 전역 dedup).
    let mut res_ids: Vec<String> = Vec::new();

    // 각 컴포넌트 코드를 이어붙이고 off/len으로 구획한다.
    for fc in comps {
        let comp = &fc.comp;
        let name_idx = pool.intern(&comp.name);
        let code_off = code.len() as u32;
        // 리소스 로드를 정의 앞머리에 깐다. lazy build에서 이 컴포넌트가 실제로 그려질 때만
        // 실행돼 리소스가 로드된다(같은 파일 컴포넌트가 같은 LOAD_RES를 내도 런타임이 URL dedup).
        for res_path in &fc.resources {
            let res_id = res_id_for(&mut res_ids, res_path);
            code.push(Op::LoadRes as u8);
            code.extend_from_slice(&res_id.to_le_bytes());
        }
        for node in &comp.template {
            emit_node(
                node,
                &comp.props,
                &comp.events,
                &comp_lookup,
                &mut pool,
                &mut code,
            )?;
        }
        code.push(Op::Halt as u8);
        // events를 직렬화용 EventDef로 변환(코드와 무관 — 컴포넌트 테이블로 간다).
        // payload의 prop명을 scope offset으로, 필드명을 상수풀 인덱스로.
        let events = comp
            .events
            .iter()
            .map(|e| {
                let payload = e
                    .payload
                    .iter()
                    .map(|(field, prop)| Ok((pool.intern(field), prop_index(prop, &comp.props)?)))
                    .collect::<Result<Vec<_>, CodegenError>>()?;
                Ok(EventDef {
                    name_idx: pool.intern(&e.name),
                    payload,
                })
            })
            .collect::<Result<Vec<_>, CodegenError>>()?;
        defs.push(CompDef {
            name_idx,
            code_off,
            code_len: code.len() as u32 - code_off,
            events,
        });
    }

    let module = Module::new(pool, defs, code);
    Ok((encode(&module).into_boxed_slice(), res_ids))
}

/// 정규화 경로의 모듈 전역 resId. 이미 본 경로면 그 인덱스, 처음이면 끝에 추가하고 새 인덱스.
fn res_id_for(res_ids: &mut Vec<String>, path: &str) -> u16 {
    if let Some(i) = res_ids.iter().position(|p| p == path) {
        return i as u16;
    }
    res_ids.push(path.to_string());
    (res_ids.len() - 1) as u16
}

/// 변수명을 scope 인덱스로. 선언 순서 = scope 인덱스. 미선언이면 에러.
fn prop_index(name: &str, props: &[String]) -> Result<u16, CodegenError> {
    props
        .iter()
        .position(|p| p == name)
        .map(|i| i as u16)
        .ok_or_else(|| CodegenError::UnknownProp(name.to_string()))
}

fn emit_node(
    node: &Node,
    props: &[String],
    events: &[Event],
    comp_lookup: &CompLookup,
    pool: &mut ConstPool,
    code: &mut Vec<u8>,
) -> Result<(), CodegenError> {
    match node {
        Node::Text(s) => {
            let idx = pool.intern(s);
            code.push(Op::Text as u8);
            code.extend_from_slice(&idx.to_le_bytes());
        }
        Node::Var(name) => {
            let idx = prop_index(name, props)?;
            code.push(Op::TextVar as u8);
            code.extend_from_slice(&idx.to_le_bytes());
        }
        Node::Element {
            tag,
            attrs,
            event_bindings,
            children,
        } => {
            let tag_id = tags::tag_id(tag).ok_or_else(|| CodegenError::UnknownTag(tag.clone()))?;

            code.push(Op::ElemOpen as u8);
            code.extend_from_slice(&tag_id.to_le_bytes());

            // 이벤트 바인딩 — 속성과 같은 자리(여는 태그 진행 중). event_idx는 이 컴포넌트
            // events에서 이벤트명으로 찾는다(선언 순서 = idx).
            for (dom_event, event_name) in event_bindings {
                // 렉서가 닫힌 집합(Keyword)으로 걸러 알려진 DOM 이벤트만 온다.
                let event_type = bytecode::dom_events::dom_event_id(dom_event)
                    .expect("렉서가 거른 DOM 이벤트만 온다");
                let event_idx = events
                    .iter()
                    .position(|e| &e.name == event_name)
                    .ok_or_else(|| CodegenError::UnknownEvent(event_name.clone()))?
                    as u16;
                code.push(Op::BindEvent as u8);
                code.extend_from_slice(&event_type.to_le_bytes());
                code.extend_from_slice(&event_idx.to_le_bytes());
            }

            for (name, value) in attrs {
                // 두 축이 opcode를 가른다.
                //   name : 전역 속성명 테이블에 있으면 G(전역 ID), 없으면 L(상수풀 인덱스)
                //   value: 정적이면 상수풀 인덱스, 변수면 scope offset
                let is_var = matches!(value, AttrValue::Var(_));
                let (op, name_operand) = match bytecode::attrs::attr_id(name) {
                    Some(global_id) => (if is_var { Op::AttrGVar } else { Op::AttrG }, global_id),
                    None => (
                        if is_var { Op::AttrLVar } else { Op::AttrL },
                        pool.intern(name),
                    ),
                };
                let value_operand = match value {
                    AttrValue::Static(s) => pool.intern(s),
                    AttrValue::Var(v) => prop_index(v, props)?,
                };
                code.push(op as u8);
                code.extend_from_slice(&name_operand.to_le_bytes());
                code.extend_from_slice(&value_operand.to_le_bytes());
            }

            code.push(Op::ElemCloseOpen as u8);

            for child in children {
                emit_node(child, props, events, comp_lookup, pool, code)?;
            }

            // END는 operand 없음 — 가장 최근에 연 태그를 닫는다(중첩이 보장됨).
            code.push(Op::ElemEnd as u8);
        }
        Node::Component { alias, name, args } => {
            // 자식 ID와 props 선언을 찾는다.
            let (child_id, child_props) = comp_lookup
                .get(name)
                .ok_or_else(|| CodegenError::UnknownComponent(name.clone()))?;

            // 자식 props 선언 순서대로 인자를 낸다. 변수 바인딩(`prop={x}`)은 부모 offset을 싣는
            // PUSH_ARG, 리터럴(`prop="lit"`)은 상수풀 인덱스를 싣는 PUSH_ARG_LIT.
            // (지금은 전부 바인딩 가정 — 순서만으로 매핑.)
            for child_prop in child_props {
                let arg_value = args
                    .iter()
                    .find(|(p, _)| p == child_prop)
                    .map(|(_, v)| v)
                    .ok_or_else(|| CodegenError::UnknownArg {
                        comp: name.clone(),
                        prop: child_prop.clone(),
                    })?;
                match arg_value {
                    ArgValue::Var(parent_var) => {
                        let offset = prop_index(parent_var, props)?;
                        code.push(Op::PushArg as u8);
                        code.extend_from_slice(&offset.to_le_bytes());
                    }
                    ArgValue::Literal(literal) => {
                        let value_index = pool.intern(literal);
                        code.push(Op::PushArgLit as u8);
                        code.extend_from_slice(&value_index.to_le_bytes());
                    }
                }
            }

            // 합성 경로 세그먼트 = use-site alias가 있으면 alias, 없으면 자식 type-name.
            // 뒤따르는 RENDER가 소비해 자식 경로 prefix에 잇는다 — 이벤트 fullname의 path 축.
            // (alias 생략 = 동일 type-name 공유, alias 부여 = 분리. §1.3)
            let segment = alias.as_deref().unwrap_or(name);
            let segment_index = pool.intern(segment);
            code.push(Op::PushPathSegment as u8);
            code.extend_from_slice(&segment_index.to_le_bytes());

            code.push(Op::Render as u8);
            code.extend_from_slice(&child_id.to_le_bytes());
        }
        Node::If { cond, then, else_ } => {
            // cond는 불리언 prop — scope offset 하나. (표현식은 이후 단계)
            let offset = prop_index(cond, props)?;
            code.push(Op::If as u8);
            code.extend_from_slice(&offset.to_le_bytes());

            for node in then {
                emit_node(node, props, events, comp_lookup, pool, code)?;
            }

            if !else_.is_empty() {
                code.push(Op::Else as u8);
                for node in else_ {
                    emit_node(node, props, events, comp_lookup, pool, code)?;
                }
            }

            code.push(Op::IfEnd as u8);
        }
    }
    Ok(())
}
