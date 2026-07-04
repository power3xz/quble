//! AST -> 바이트코드 Module. 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간.

use crate::ast::{ArgValue, AttrValue, Context, Event, LitValue, Node, Prop, Type, VarRef};
use crate::resolve::FlatComp;
use bytecode::{
    encode, tags, CompDef, Const, ConstPool, ContextDef, EventDef, Field, FieldValue, Module, Op,
};

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
    /// `@with Context`가 이 컴포넌트 contexts에 없는 컨텍스트명을 가리킴.
    UnknownContext(String),
    /// prop 경로가 존재하지 않는 필드를 가리킴(객체 아닌 값에 `.field`, 또는 없는 필드명).
    UnknownField { root: String, field: String },
    /// 값 자리(보간·속성·payload·context)에 leaf(원시)가 아닌 객체/배열 경로가 왔다.
    /// 반응성·값 자리엔 leaf만 올 수 있다 - 객체 통째는 안 넘긴다.
    NotLeaf(String),
}

/// 컴포넌트 이름 -> (ID, props 선언) 룩업. 합성 호출(`Comp(...)`)을 만났을 때 RENDER에 박을 ID를
/// 찾고, PUSH_ARG를 자식 props 순서로 정렬하려고 props 선언도 같이 돌려준다. 컴포넌트 ID = 정의 순서.
struct CompLookup<'a> {
    by_name: std::collections::HashMap<&'a str, (u16, &'a [Prop])>,
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
    fn get(&self, name: &str) -> Option<(u16, &'a [Prop])> {
        self.by_name.get(name).copied()
    }
}

/// 파일의 컴포넌트 정의들을 하나의 직렬화된 Module로. 컴포넌트 ID = 정의 순서.
/// 두 번째 반환값은 리소스 사이드맵 - 인덱스가 모듈 전역 resId, 값이 정규화 경로.
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
        let name_const_index = pool.intern_str(&comp.name);
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
                &comp.contexts,
                &comp_lookup,
                &mut pool,
                &mut code,
            )?;
        }
        code.push(Op::Halt as u8);
        // events를 직렬화용 EventDef로 변환(코드와 무관 - 컴포넌트 테이블로 간다).
        // payload의 prop명을 scope index로, 필드명을 상수풀 인덱스로.
        let events = comp
            .events
            .iter()
            .map(|e| {
                let fields = e
                    .payload
                    .iter()
                    .map(|(field, value)| {
                        Ok(Field {
                            name_const_index: pool.intern_str(field),
                            value: arg_to_field_value(value, &comp.props, &mut pool)?,
                        })
                    })
                    .collect::<Result<Vec<_>, CodegenError>>()?;
                Ok(EventDef {
                    name_const_index: pool.intern_str(&e.name),
                    fields,
                })
            })
            .collect::<Result<Vec<_>, CodegenError>>()?;
        // contexts를 ContextDef로 변환(events와 같은 패턴). 값이 ArgValue라 Var/Literal로 갈린다.
        let contexts = comp
            .contexts
            .iter()
            .map(|c| {
                let fields = c
                    .fields
                    .iter()
                    .map(|(field, value)| {
                        Ok(Field {
                            name_const_index: pool.intern_str(field),
                            value: arg_to_field_value(value, &comp.props, &mut pool)?,
                        })
                    })
                    .collect::<Result<Vec<_>, CodegenError>>()?;
                Ok(ContextDef {
                    name_const_index: pool.intern_str(&c.name),
                    fields,
                })
            })
            .collect::<Result<Vec<_>, CodegenError>>()?;
        defs.push(CompDef {
            name_const_index,
            code_off,
            code_len: code.len() as u32 - code_off,
            events,
            contexts,
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

/// 타입의 leaf(원시) 개수. 객체·배열은 펼친 leaf 수의 합. 원시는 1.
/// scope 인덱스는 props를 선언 순서로 펼친 평탄 leaf 번호라, 앞 prop들이 차지하는 칸을
/// 세려면 타입별 leaf 수가 필요하다. (배열은 요소 타입 leaf 수 - `@for` 회수 전까지 요소 1벌.)
fn leaf_count(ty: &Type) -> u16 {
    match ty {
        Type::Bool | Type::Number | Type::String => 1,
        Type::Array(inner) => leaf_count(inner),
        Type::Object(fields) => fields.iter().map(|(_, t)| leaf_count(t)).sum(),
        Type::Ref(n) => unreachable!("resolve가 Type::Ref({n})를 안 풀었다"),
        Type::Omit(..) | Type::Pick(..) => unreachable!("resolve가 유틸 타입을 안 풀었다"),
    }
}

/// prop 참조(root + 객체 경로)를 평탄 scope 인덱스로. props를 선언 순서로 펼친 leaf 번호를
/// 매기되, 경로는 root prop 타입을 필드로 파고들어 도달한 leaf의 offset을 더한다. 경로가
/// leaf(원시)에서 끝나지 않으면(객체/배열) 에러 - 값 자리엔 leaf만 온다.
fn var_ref_to_scope_index(var: &VarRef, props: &[Prop]) -> Result<u16, CodegenError> {
    // root prop까지의 평탄 offset(앞 prop들의 leaf 수 합)을 세며 root prop을 찾는다.
    let mut base = 0u16;
    let mut ty = None;
    for p in props {
        if p.name == var.root {
            ty = Some(&p.ty);
            break;
        }
        base += leaf_count(&p.ty);
    }
    let mut ty = ty.ok_or_else(|| CodegenError::UnknownProp(var.root.clone()))?;

    // 경로를 타입 따라 내려가며 offset을 누적한다. 각 단계에서 앞 형제 필드의 leaf 수를 더한다.
    for key in &var.path {
        let fields = match ty {
            Type::Object(fields) => fields,
            _ => {
                return Err(CodegenError::UnknownField {
                    root: var.root.clone(),
                    field: key.clone(),
                })
            }
        };
        let mut found = None;
        for (name, field_ty) in fields {
            if name == key {
                found = Some(field_ty);
                break;
            }
            base += leaf_count(field_ty);
        }
        ty = found.ok_or_else(|| CodegenError::UnknownField {
            root: var.root.clone(),
            field: key.clone(),
        })?;
    }

    // 도달 타입이 leaf(원시)여야 한다.
    match ty {
        Type::Bool | Type::Number | Type::String => Ok(base),
        _ => Err(CodegenError::NotLeaf(var_ref_display(var))),
    }
}

/// props를 선언 순서로 펼친 leaf 경로들. `var_ref_to_scope_index`와 같은 순회라
/// 결과 벡터의 인덱스 = scope 인덱스다. 스칼라는 이름 그대로(`heading`), 객체는 필드까지
/// 점 경로(`general.a.title`). manifest.props가 되어 런타임 paths[i]를 store 경로에 잇는다.
pub fn flatten_prop_paths(props: &[Prop]) -> Vec<String> {
    let mut paths = Vec::new();
    for p in props {
        push_leaf_paths(&p.name, &p.ty, &mut paths);
    }
    paths
}

/// 한 타입의 leaf 경로들을 prefix 아래로 펼쳐 push. 객체는 필드 선언 순서로 재귀.
/// (배열은 요소 타입으로 - leaf_count와 동일하게 요소 1벌 취급.)
fn push_leaf_paths(prefix: &str, ty: &Type, out: &mut Vec<String>) {
    match ty {
        Type::Bool | Type::Number | Type::String => out.push(prefix.to_string()),
        Type::Array(inner) => push_leaf_paths(prefix, inner, out),
        Type::Object(fields) => {
            for (name, field_ty) in fields {
                push_leaf_paths(&format!("{prefix}.{name}"), field_ty, out);
            }
        }
        Type::Ref(n) => unreachable!("resolve가 Type::Ref({n})를 안 풀었다"),
        Type::Omit(..) | Type::Pick(..) => unreachable!("resolve가 유틸 타입을 안 풀었다"),
    }
}

/// 에러 메시지용 경로 표기: `root.a.b`.
fn var_ref_display(var: &VarRef) -> String {
    if var.path.is_empty() {
        var.root.clone()
    } else {
        format!("{}.{}", var.root, var.path.join("."))
    }
}

/// ArgValue를 FieldValue로. Var는 prop을 scope 인덱스로, Literal은 상수풀에 intern해 Const로.
fn arg_to_field_value(
    value: &ArgValue,
    props: &[Prop],
    pool: &mut ConstPool,
) -> Result<FieldValue, CodegenError> {
    Ok(match value {
        ArgValue::Var(var) => FieldValue::Scope(var_ref_to_scope_index(var, props)?),
        ArgValue::Literal(lit) => FieldValue::Const(pool.intern(lit_to_const(lit))),
    })
}

/// 리터럴을 상수풀 엔트리로. 소스의 타입을 그대로 실어 런타임이 올바른 JS 값으로 복원한다.
fn lit_to_const(lit: &LitValue) -> Const {
    match lit {
        LitValue::Str(s) => Const::Str(s.clone()),
        LitValue::Number(n) => Const::Num(*n),
        LitValue::Bool(b) => Const::Bool(*b),
    }
}

fn emit_node(
    node: &Node,
    props: &[Prop],
    events: &[Event],
    contexts: &[Context],
    comp_lookup: &CompLookup,
    pool: &mut ConstPool,
    code: &mut Vec<u8>,
) -> Result<(), CodegenError> {
    match node {
        Node::Text(s) => {
            let index = pool.intern_str(s);
            code.push(Op::Text as u8);
            code.extend_from_slice(&index.to_le_bytes());
        }
        Node::Var(var) => {
            let index = var_ref_to_scope_index(var, props)?;
            code.push(Op::TextVar as u8);
            code.extend_from_slice(&index.to_le_bytes());
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

            // 이벤트 바인딩 - 속성과 같은 자리(여는 태그 진행 중). event_index는 이 컴포넌트
            // events에서 이벤트명으로 찾는다(선언 순서 = index).
            for (dom_event, event_name) in event_bindings {
                // 렉서가 닫힌 집합(Directive)으로 걸러 알려진 DOM 이벤트만 온다.
                let event_type = bytecode::dom_events::dom_event_id(dom_event)
                    .expect("렉서가 거른 DOM 이벤트만 온다");
                let event_index = events
                    .iter()
                    .position(|e| &e.name == event_name)
                    .ok_or_else(|| CodegenError::UnknownEvent(event_name.clone()))?
                    as u16;
                code.push(Op::BindEvent as u8);
                code.extend_from_slice(&event_type.to_le_bytes());
                code.extend_from_slice(&event_index.to_le_bytes());
            }

            for (name, value) in attrs {
                // 두 축이 opcode를 가른다.
                //   name : 전역 속성명 테이블에 있으면 G(전역 ID), 없으면 L(상수풀 인덱스)
                //   value: 정적이면 상수풀 인덱스, 변수면 scope index
                let is_var = matches!(value, AttrValue::Var(_));
                let (op, name_operand) = match bytecode::attrs::attr_id(name) {
                    Some(global_id) => (if is_var { Op::AttrGVar } else { Op::AttrG }, global_id),
                    None => (
                        if is_var { Op::AttrLVar } else { Op::AttrL },
                        pool.intern_str(name),
                    ),
                };
                let value_operand = match value {
                    AttrValue::Static(s) => pool.intern_str(s),
                    AttrValue::Var(v) => var_ref_to_scope_index(v, props)?,
                };
                code.push(op as u8);
                code.extend_from_slice(&name_operand.to_le_bytes());
                code.extend_from_slice(&value_operand.to_le_bytes());
            }

            code.push(Op::ElemCloseOpen as u8);

            for child in children {
                emit_node(child, props, events, contexts, comp_lookup, pool, code)?;
            }

            // END는 operand 없음 - 가장 최근에 연 태그를 닫는다(중첩이 보장됨).
            code.push(Op::ElemEnd as u8);
        }
        Node::Component { alias, name, args } => {
            // 자식 ID와 props 선언을 찾는다.
            let (child_id, child_props) = comp_lookup
                .get(name)
                .ok_or_else(|| CodegenError::UnknownComponent(name.clone()))?;

            // 자식 props 선언 순서대로 인자를 낸다. 변수 바인딩(`prop={x}`)은 부모 scope index을 싣는
            // PUSH_ARG, 리터럴(`prop="lit"`)은 상수풀 인덱스를 싣는 PUSH_ARG_LIT.
            // (지금은 전부 바인딩 가정 - 순서만으로 매핑.)
            for child_prop in child_props {
                let arg_value = args
                    .iter()
                    .find(|(p, _)| *p == child_prop.name)
                    .map(|(_, v)| v)
                    .ok_or_else(|| CodegenError::UnknownArg {
                        comp: name.clone(),
                        prop: child_prop.name.clone(),
                    })?;
                match arg_value {
                    ArgValue::Var(parent_var) => {
                        let scope_index = var_ref_to_scope_index(parent_var, props)?;
                        code.push(Op::PushArg as u8);
                        code.extend_from_slice(&scope_index.to_le_bytes());
                    }
                    ArgValue::Literal(literal) => {
                        let value_index = pool.intern(lit_to_const(literal));
                        code.push(Op::PushArgLit as u8);
                        code.extend_from_slice(&value_index.to_le_bytes());
                    }
                }
            }

            // 합성 경로 세그먼트 = use-site alias가 있으면 alias, 없으면 자식 type-name.
            // 뒤따르는 RENDER가 소비해 자식 경로 prefix에 잇는다 - 이벤트 fullname의 path 축.
            // (alias 생략 = 동일 type-name 공유, alias 부여 = 분리. §1.3)
            let segment = alias.as_deref().unwrap_or(name);
            let segment_index = pool.intern_str(segment);
            code.push(Op::PushPathSegment as u8);
            code.extend_from_slice(&segment_index.to_le_bytes());

            code.push(Op::Render as u8);
            code.extend_from_slice(&child_id.to_le_bytes());
        }
        Node::If { cond, then, else_ } => {
            // cond는 불리언 prop 참조 - 경로를 평탄 scope index로. leaf여야 한다. (표현식은 이후 단계)
            let scope_index = var_ref_to_scope_index(cond, props)?;
            code.push(Op::If as u8);
            code.extend_from_slice(&scope_index.to_le_bytes());

            for node in then {
                emit_node(node, props, events, contexts, comp_lookup, pool, code)?;
            }

            if !else_.is_empty() {
                code.push(Op::Else as u8);
                for node in else_ {
                    emit_node(node, props, events, contexts, comp_lookup, pool, code)?;
                }
            }

            code.push(Op::IfEnd as u8);
        }
        Node::With { context, children } => {
            // context_index는 이 컴포넌트 contexts에서 이름으로 찾는다(선언 순서 = index,
            // event_index 찾기와 동형). 미선언 컨텍스트는 에러.
            let context_index = contexts
                .iter()
                .position(|c| &c.name == context)
                .ok_or_else(|| CodegenError::UnknownContext(context.clone()))?
                as u16;
            code.push(Op::EnterContext as u8);
            code.extend_from_slice(&context_index.to_le_bytes());

            for node in children {
                emit_node(node, props, events, contexts, comp_lookup, pool, code)?;
            }

            // ExitContext는 operand 없는 마커(IfEnd 동형).
            code.push(Op::ExitContext as u8);
        }
    }
    Ok(())
}
