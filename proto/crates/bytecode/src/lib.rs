//! Quble 프로토타입 바이트코드: 포맷의 단일 정의처(컴파일러/렌더러/런타임 공용).
//! 상세는 proto/BYTECODE.md 참고.

pub mod attrs;
pub mod dom_events;
pub mod tags;
mod module;
mod opcode;
mod pool;
mod serialize;

pub use module::{CompDef, ContextDef, EventDef, Field, FieldValue, Module, TypeEntry};
pub use opcode::Op;
pub use pool::{Const, ConstPool};
pub use serialize::{decode, encode, DecodeError};

#[cfg(test)]
mod tests {
    use super::*;

    /// BYTECODE.md §6의 hello 예시를 손으로 만들어 라운드트립.
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
            TypeEntry::Array(1),                       // string[][]
            TypeEntry::Array(2),                       // string[]
            TypeEntry::Scalar,                         // string
            TypeEntry::Object(vec![(0, 0), (1, 2)]),   // { field0: string[][], field1: string }
        ];
        let m = Module::new(ConstPool::new(), types.clone(), vec![], vec![]);
        let back = decode(&encode(&m)).unwrap();
        assert_eq!(back.types, types);
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
        assert_eq!(Op::from_u8(0xff), None);
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
        assert_eq!(m.pool.get(name_const_index), Some(&Const::Str("Hello".into())));
        assert!(m.def(1).is_none());
    }
}
