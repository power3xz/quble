//! AST → 바이트코드 Module. 단일 컴포넌트, 문자열 속성. 1단계: props 문자열 보간.

use crate::ast::{AttrValue, Component, Node};
use bytecode::{encode, tags, CompDef, ConstPool, Module, Op};

#[derive(Debug, PartialEq, Eq)]
pub enum CodegenError {
    /// 내장 태그 테이블에 없는 태그.
    UnknownTag(String),
    /// props에 선언되지 않은 변수 참조.
    UnknownProp(String),
}

/// AST를 직렬화된 바이트코드로. 바이트코드의 정체는 `[u8]`이므로 Box<[u8]>로 반환한다
/// (컴파일 후 불변·고정 크기). Module은 빌드 도구로만 내부에서 쓴다.
pub fn generate(comp: &Component) -> Result<Box<[u8]>, CodegenError> {
    let mut pool = ConstPool::new();
    let name_idx = pool.intern(&comp.name);

    let mut code = Vec::new();
    for node in &comp.template {
        emit_node(node, &comp.props, &mut pool, &mut code)?;
    }
    code.push(Op::Halt as u8);

    let defs = vec![CompDef {
        name_idx,
        code_off: 0,
        code_len: code.len() as u32,
    }];
    let module = Module::new(pool, defs, code);
    Ok(encode(&module).into_boxed_slice())
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
        Node::Element { tag, attrs, children } => {
            let tag_id = tags::tag_id(tag).ok_or_else(|| CodegenError::UnknownTag(tag.clone()))?;

            code.push(Op::ElemOpen as u8);
            code.extend_from_slice(&tag_id.to_le_bytes());

            for (name, value) in attrs {
                // 두 축이 opcode를 가른다.
                //   name : 전역 속성명 테이블에 있으면 G(전역 ID), 없으면 L(상수풀 인덱스)
                //   value: 정적이면 상수풀 인덱스, 변수면 scope offset
                let is_var = matches!(value, AttrValue::Var(_));
                let (op, name_operand) = match bytecode::attrs::attr_id(name) {
                    Some(global_id) => (if is_var { Op::AttrGVar } else { Op::AttrG }, global_id),
                    None => (if is_var { Op::AttrLVar } else { Op::AttrL }, pool.intern(name)),
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
                emit_node(child, props, pool, code)?;
            }

            // END는 operand 없음 — 가장 최근에 연 태그를 닫는다(중첩이 보장됨).
            code.push(Op::ElemEnd as u8);
        }
    }
    Ok(())
}
