//! AST → 바이트코드 Module. MVP: 단일 컴포넌트, 문자열 속성, 표현식 없음.

use crate::ast::{Component, Node};
use bytecode::{encode, tags, CompDef, ConstPool, Module, Op};

#[derive(Debug, PartialEq, Eq)]
pub enum CodegenError {
    /// 내장 태그 테이블에 없는 태그.
    UnknownTag(String),
}

/// AST를 직렬화된 바이트코드로. 바이트코드의 정체는 `[u8]`이므로 Box<[u8]>로 반환한다
/// (컴파일 후 불변·고정 크기). Module은 빌드 도구로만 내부에서 쓴다.
pub fn generate(comp: &Component) -> Result<Box<[u8]>, CodegenError> {
    let mut pool = ConstPool::new();
    let name_idx = pool.intern(&comp.name);

    let mut code = Vec::new();
    for node in &comp.template {
        emit_node(node, &mut pool, &mut code)?;
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

fn emit_node(node: &Node, pool: &mut ConstPool, code: &mut Vec<u8>) -> Result<(), CodegenError> {
    match node {
        Node::Text(s) => {
            let idx = pool.intern(s);
            code.push(Op::Text as u8);
            code.extend_from_slice(&idx.to_le_bytes());
        }
        Node::Element { tag, attrs, children } => {
            let tag_id = tags::tag_id(tag).ok_or_else(|| CodegenError::UnknownTag(tag.clone()))?;

            code.push(Op::ElemOpen as u8);
            code.extend_from_slice(&tag_id.to_le_bytes());

            for (name, value) in attrs {
                let n = pool.intern(name);
                let v = pool.intern(value);
                code.push(Op::Attr as u8);
                code.extend_from_slice(&n.to_le_bytes());
                code.extend_from_slice(&v.to_le_bytes());
            }

            code.push(Op::ElemCloseOpen as u8);

            for child in children {
                emit_node(child, pool, code)?;
            }

            code.push(Op::ElemEnd as u8);
            code.extend_from_slice(&tag_id.to_le_bytes());
        }
    }
    Ok(())
}
