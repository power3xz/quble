//! Quble 바이트코드: 포맷의 단일 정의처(컴파일러/렌더러/런타임 공용).
//! 상세는 core/BYTECODE.md 참고.

pub mod attrs;
pub mod dom_events;
mod module;
mod opcode;
mod pool;
mod serialize;
pub mod tags;

pub use module::{
    CompDef, ContextDef, EventDef, ExprDef, Field, FieldValue, Module, TernaryOperand, TypeEntry,
};
pub use opcode::{ExprOp, Op};
pub use pool::{Const, ConstPool};
pub use serialize::{decode, encode, DecodeError};

#[cfg(test)]
mod tests {
    use super::*;

    /// BYTECODE.md #6의 hello 예시를 손으로 만들어 라운드트립.
    fn hello_module() -> Module {
        let mut pool = ConstPool::new();
        let class = pool.intern_str("class");
        let greeting = pool.intern_str("greeting");
        let hello_name = pool.intern_str("Hello"); // 컴포넌트명
        let hello_txt = pool.intern_str("Hello");
        let sub = pool.intern_str("sub");
        let world = pool.intern_str("world");

        // "Hello"가 컴포넌트명이자 텍스트라 intern이 같은 인덱스를 줘야 한다.
        assert_eq!(hello_name, hello_txt);

        let mut code = Vec::new();
        let div = tags::tag_id("div").unwrap();
        let h1 = tags::tag_id("h1").unwrap();
        let p = tags::tag_id("p").unwrap();

        emit_open(&mut code, div);
        emit_attr(&mut code, class, greeting);
        code.push(Op::ElemCloseOpen as u8);
        emit_open(&mut code, h1);
        code.push(Op::ElemCloseOpen as u8);
        emit_text(&mut code, hello_txt);
        emit_end(&mut code);
        emit_open(&mut code, p);
        emit_attr(&mut code, class, sub);
        code.push(Op::ElemCloseOpen as u8);
        emit_text(&mut code, world);
        emit_end(&mut code);
        emit_end(&mut code);
        code.push(Op::Halt as u8);

        let defs = vec![CompDef {
            name_const_index: hello_name,
            props_type_ref: 0,
            code_off: 0,
            code_len: code.len() as u32,
            events: vec![],
            contexts: vec![],
            exprs: vec![],
        }];
        Module::new(pool, vec![], defs, code)
    }

    fn emit_open(code: &mut Vec<u8>, tag: u16) {
        code.push(Op::ElemOpen as u8);
        code.extend_from_slice(&tag.to_le_bytes());
    }
    fn emit_end(code: &mut Vec<u8>) {
        code.push(Op::ElemEnd as u8);
    }
    fn emit_attr(code: &mut Vec<u8>, name: u16, value: u16) {
        code.push(Op::AttrL as u8);
        code.extend_from_slice(&name.to_le_bytes());
        code.extend_from_slice(&value.to_le_bytes());
    }
    fn emit_text(code: &mut Vec<u8>, text: u16) {
        code.push(Op::Text as u8);
        code.extend_from_slice(&text.to_le_bytes());
    }

    #[test]
    fn roundtrip_hello() {
        let m = hello_module();
        let bytes = encode(&m);
        let back = decode(&bytes).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn pool_interns_duplicates() {
        let mut pool = ConstPool::new();
        let a = pool.intern_str("x");
        let b = pool.intern_str("x");
        assert_eq!(a, b);
        assert_eq!(pool.len(), 1);
    }

    /// 상수풀 dedup은 값/타입 둘 다 같아야 동일 엔트리 - 문자열 "1"과 숫자 1은 다르다.
    #[test]
    fn pool_dedup_distinguishes_type() {
        let mut pool = ConstPool::new();
        let s = pool.intern(Const::Str("1".into()));
        let n = pool.intern(Const::Num(1.0));
        let b = pool.intern(Const::Bool(true));
        assert_ne!(s, n);
        assert_ne!(n, b);
        assert_eq!(pool.len(), 3);
        // 같은 값/타입은 같은 인덱스.
        assert_eq!(pool.intern(Const::Num(1.0)), n);
        assert_eq!(pool.len(), 3);
    }

    /// 타입 있는 상수풀(Str/Num/Bool)이 encode->decode로 정확히 복원된다.
    #[test]
    fn roundtrip_typed_pool() {
        let mut pool = ConstPool::new();
        pool.intern(Const::Str("hi".into()));
        pool.intern(Const::Num(42.5));
        pool.intern(Const::Bool(false));
        pool.intern(Const::Bool(true));
        let m = Module::new(pool, vec![], vec![], vec![]);
        let back = decode(&encode(&m)).unwrap();
        assert_eq!(m, back);
        assert_eq!(back.pool.get(0), Some(&Const::Str("hi".into())));
        assert_eq!(back.pool.get(1), Some(&Const::Num(42.5)));
        assert_eq!(back.pool.get(2), Some(&Const::Bool(false)));
        assert_eq!(back.pool.get(3), Some(&Const::Bool(true)));
    }

    /// 타입 테이블이 encode->decode로 복원된다. 배열의 배열을 담는다:
    ///   #0 Array(1)  = string[][]  (원소가 #1)
    ///   #1 Array(2)  = string[]    (원소가 #2)
    ///   #2 Scalar    = string
    /// 각 Array가 원소 타입을 인덱스로 가리켜 말단 Scalar까지 내려간다(재귀 없음).
    /// #3 Object는 그 엔트리들을 필드로 참조 - 세 variant를 한 번에 태운다.
    #[test]
    fn roundtrip_types() {
        let types = vec![
            TypeEntry::Array(1),                     // string[][]
            TypeEntry::Array(2),                     // string[]
            TypeEntry::Scalar,                       // string
            TypeEntry::Object(vec![(0, 0), (1, 2)]), // { field0: string[][], field1: string }
        ];
        let m = Module::new(ConstPool::new(), types.clone(), vec![], vec![]);
        let back = decode(&encode(&m)).unwrap();
        assert_eq!(back.types, types);
    }

    /// 식 테이블 하나를 가진 컴포넌트 하나짜리 모듈.
    fn module_with_exprs(exprs: Vec<ExprDef>) -> Module {
        let defs = vec![CompDef {
            name_const_index: 0,
            props_type_ref: 0,
            code_off: 0,
            code_len: 0,
            events: vec![],
            contexts: vec![],
            exprs,
        }];
        Module::new(ConstPool::new(), vec![], defs, vec![])
    }

    // props { ok: bool, price: number, base: number }의 슬롯 0, 1, 2.
    //   #0 = price > 0                 입력 없는 계산 식
    //   #1 = ok ? price : 0            삼항 (상수 0은 상수풀 2번이라고 둔다)
    //   #2 = base - #1                 #1을 입력으로 받는 계산 식
    fn calc_ternary_calc() -> Vec<ExprDef> {
        vec![
            ExprDef::Calc {
                code: vec![
                    ExprOp::LoadVar as u8,
                    1,
                    0,
                    ExprOp::LoadSmallInt as u8,
                    0,
                    ExprOp::Gt as u8,
                ],
                inputs: vec![],
            },
            ExprDef::Ternary {
                cond: TernaryOperand::Leaf(0, 0),
                then: TernaryOperand::Leaf(1, 0),
                else_: TernaryOperand::Const(2),
            },
            ExprDef::Calc {
                code: vec![
                    ExprOp::LoadVar as u8,
                    2,
                    0,
                    ExprOp::LoadInput as u8,
                    0,
                    ExprOp::Sub as u8,
                ],
                inputs: vec![1],
            },
        ]
    }

    /// 계산 식, 삼항, 입력이 있는 계산 식이 왕복하는지.
    #[test]
    fn roundtrip_exprs() {
        let m = module_with_exprs(calc_ternary_calc());
        assert_eq!(decode(&encode(&m)).unwrap(), m);
    }

    /// 삼항의 세 피연산자 종류(Leaf, Const, Expr)가 왕복하는지.
    #[test]
    fn roundtrip_ternary_operands() {
        let m = module_with_exprs(vec![
            ExprDef::Calc {
                code: vec![ExprOp::LoadVar as u8, 0, 0],
                inputs: vec![],
            },
            ExprDef::Ternary {
                cond: TernaryOperand::Leaf(1, 2),
                then: TernaryOperand::Expr(0),
                else_: TernaryOperand::Const(300),
            },
        ]);
        assert_eq!(decode(&encode(&m)).unwrap(), m);
    }

    /// 표현식 테이블에는 삼항이 len 0으로, 그래프 섹션에는 삼항과 입력이 있는 계산 식만 실린다.
    #[test]
    fn expr_inputs_lists_only_ternaries_and_calcs_with_inputs() {
        let bytes = encode(&module_with_exprs(calc_ternary_calc()));
        #[rustfmt::skip]
        let expected_tail = [
            // exprs: expr_count 3
            3,
            6, ExprOp::LoadVar as u8, 1, 0, ExprOp::LoadSmallInt as u8, 0, ExprOp::Gt as u8, // #0
            0,                                                                               // #1 삼항
            6, ExprOp::LoadVar as u8, 2, 0, ExprOp::LoadInput as u8, 0, ExprOp::Sub as u8,   // #2
            // expr_inputs: entry_count 2 - #0은 입력이 없어 싣지 않는다
            2,
            1, 255, 0, 0, 0, 0, 1, 0, 1, 2, 0, // #1: TERNARY, Scope(0, 0), Scope(1, 0), Const(2)
            2, 1, 1,                           // #2: 입력 1개, #1
            // 코드 길이 u32 0
            0, 0, 0, 0,
        ];
        assert!(
            bytes.ends_with(&expected_tail),
            "끝 바이트: {:?}",
            &bytes[bytes.len() - expected_tail.len()..]
        );
    }

    /// 삼항 피연산자에 Raw(tag 2)나 알 수 없는 태그가 오면 BadRefTag로 거부한다.
    #[test]
    fn decode_rejects_raw_ternary_operand() {
        let mut bytes = encode(&module_with_exprs(calc_ternary_calc()));
        // 끝에서 코드 길이(4), #2 항목(3), 삼항 피연산자 셋(9)을 거슬러 cond의 태그에 닿는다.
        let cond_tag = bytes.len() - 4 - 3 - 9;
        assert_eq!(bytes[cond_tag], 0, "cond의 Scope 태그여야 한다");
        bytes[cond_tag] = 2;
        assert_eq!(decode(&bytes), Err(DecodeError::BadRefTag(2)));
    }

    /// 필드 ref 네 종류가 왕복하는지. 이벤트와 컨텍스트가 같은 인코딩이라 둘 다 싣는다.
    #[test]
    fn roundtrip_field_refs() {
        let field = |value| Field {
            name_const_index: 0,
            type_ref: 0,
            value,
        };
        let defs = vec![CompDef {
            name_const_index: 0,
            props_type_ref: 0,
            code_off: 0,
            code_len: 0,
            events: vec![EventDef {
                name_const_index: 0,
                fields: vec![
                    field(FieldValue::Scope(1, 2)),
                    field(FieldValue::Const(3)),
                    field(FieldValue::Raw(4)),
                    field(FieldValue::Expr(5)),
                ],
            }],
            contexts: vec![ContextDef {
                name_const_index: 0,
                fields: vec![field(FieldValue::Expr(6))],
            }],
            exprs: vec![],
        }];
        let m = Module::new(ConstPool::new(), vec![], defs, vec![]);
        assert_eq!(decode(&encode(&m)).unwrap(), m);
    }

    /// 알 수 없는 타입 태그는 BadTypeTag로 거부한다.
    #[test]
    fn decode_rejects_bad_type_tag() {
        let m = Module::new(ConstPool::new(), vec![TypeEntry::Scalar], vec![], vec![]);
        let mut bytes = encode(&m);
        // MAGIC(4) + VERSION(2) + pool_count(2)=0 + type_count(2)=1 다음이 첫 타입 태그.
        bytes[10] = 0x7f;
        assert_eq!(decode(&bytes), Err(DecodeError::BadTypeTag(0x7f)));
    }

    /// 알 수 없는 상수 태그는 BadConstTag로 거부한다(첫 엔트리 태그 바이트를 오염).
    #[test]
    fn decode_rejects_bad_const_tag() {
        let mut pool = ConstPool::new();
        pool.intern_str("x");
        let mut bytes = encode(&Module::new(pool, vec![], vec![], vec![]));
        // MAGIC(4) + VERSION(2) + pool_count(2) 다음이 첫 엔트리 태그.
        bytes[8] = 0x7f;
        assert_eq!(decode(&bytes), Err(DecodeError::BadConstTag(0x7f)));
    }

    #[test]
    fn tag_table_roundtrips() {
        assert_eq!(tags::tag_name(0), Some("div"));
        assert_eq!(tags::tag_id("button"), Some(9));
        assert_eq!(tags::tag_id("table"), Some(36));
        assert_eq!(tags::tag_id("svg"), None); // SVG는 네임스페이스가 달라 이 테이블에 없다
    }

    #[test]
    fn opcode_from_u8() {
        assert_eq!(Op::from_u8(0x06), Some(Op::Render));
        assert_eq!(Op::from_u8(0x0c), Some(Op::If));
        assert_eq!(Op::from_u8(0x0d), Some(Op::Else));
        assert_eq!(Op::from_u8(0x0e), Some(Op::IfEnd));
        assert_eq!(Op::from_u8(0x0f), Some(Op::LoadRes));
        assert_eq!(Op::from_u8(0x1e), Some(Op::IfExpr));
        assert_eq!(Op::from_u8(0x22), Some(Op::ForCountExpr));
        assert_eq!(Op::from_u8(0xff), None);
    }

    #[test]
    fn expr_opcode_from_u8() {
        assert_eq!(ExprOp::from_u8(0x00), Some(ExprOp::LoadVar));
        assert_eq!(ExprOp::from_u8(0x04), Some(ExprOp::LoadSmallInt));
        assert_eq!(ExprOp::from_u8(0x06), Some(ExprOp::LoadFalse));
        assert_eq!(ExprOp::from_u8(0x19), Some(ExprOp::Gt));
        assert_eq!(ExprOp::from_u8(0x1e), Some(ExprOp::Neg));
        assert_eq!(ExprOp::from_u8(0x22), Some(ExprOp::LoadInput));
        assert_eq!(ExprOp::from_u8(0x23), None);
        // 잎 태그와 연산자 태그 사이는 비어 있다 - 연산자를 늘릴 자리로 남겨 둔다.
        assert_eq!(ExprOp::from_u8(0x07), None);
        assert_eq!(ExprOp::from_u8(0xff), None);
    }

    /// 두 태그는 이름공간이 다르다 - 같은 바이트가 서로 다른 뜻이다. 식 바이트를 `Op`로 읽거나
    /// 그 반대로 읽으면 조용히 엉뚱한 것이 되므로, 겹치는 값이 있다는 사실을 테스트로 박아 둔다.
    #[test]
    fn op_and_expr_op_are_separate_namespaces() {
        assert_eq!(Op::from_u8(0x1e), Some(Op::IfExpr));
        assert_eq!(ExprOp::from_u8(0x1e), Some(ExprOp::Neg));
    }

    #[test]
    fn decode_rejects_bad_magic() {
        let mut bytes = encode(&hello_module());
        bytes[0] = b'X';
        assert_eq!(decode(&bytes), Err(DecodeError::BadMagic));
    }

    #[test]
    fn decode_rejects_truncated() {
        let bytes = encode(&hello_module());
        let truncated = &bytes[..bytes.len() - 3];
        assert_eq!(decode(truncated), Err(DecodeError::UnexpectedEof));
    }

    #[test]
    fn def_lookup_by_id() {
        let m = hello_module();
        let name_const_index = m.def(0).unwrap().name_const_index;
        assert_eq!(
            m.pool.get(name_const_index),
            Some(&Const::Str("Hello".into()))
        );
        assert!(m.def(1).is_none());
    }
}
