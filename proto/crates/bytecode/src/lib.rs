//! Quble 프로토타입 바이트코드: 포맷의 단일 정의처(파서·VM 공용).
//! 상세는 proto/BYTECODE.md 참고.

pub mod module;
pub mod opcode;
pub mod pool;
pub mod serialize;
pub mod tags;

pub use module::{CompDef, Module};
pub use opcode::Op;
pub use pool::ConstPool;
pub use serialize::{decode, encode, DecodeError};

#[cfg(test)]
mod tests {
    use super::*;

    /// BYTECODE.md §6의 hello 예시를 손으로 만들어 라운드트립.
    fn hello_module() -> Module {
        let mut pool = ConstPool::new();
        let class = pool.intern("class");
        let greeting = pool.intern("greeting");
        let hello_name = pool.intern("Hello"); // 컴포넌트명
        let hello_txt = pool.intern("Hello");
        let sub = pool.intern("sub");
        let world = pool.intern("world");

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
        emit_end(&mut code, h1);
        emit_open(&mut code, p);
        emit_attr(&mut code, class, sub);
        code.push(Op::ElemCloseOpen as u8);
        emit_text(&mut code, world);
        emit_end(&mut code, p);
        emit_end(&mut code, div);
        code.push(Op::Halt as u8);

        let defs = vec![CompDef {
            name_idx: hello_name,
            code_off: 0,
            code_len: code.len() as u32,
        }];
        Module::new(pool, defs, code)
    }

    fn emit_open(code: &mut Vec<u8>, tag: u16) {
        code.push(Op::ElemOpen as u8);
        code.extend_from_slice(&tag.to_le_bytes());
    }
    fn emit_end(code: &mut Vec<u8>, tag: u16) {
        code.push(Op::ElemEnd as u8);
        code.extend_from_slice(&tag.to_le_bytes());
    }
    fn emit_attr(code: &mut Vec<u8>, name: u16, value: u16) {
        code.push(Op::Attr as u8);
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
        let a = pool.intern("x");
        let b = pool.intern("x");
        assert_eq!(a, b);
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn tag_table_roundtrips() {
        assert_eq!(tags::tag_name(0), Some("div"));
        assert_eq!(tags::tag_id("button"), Some(9));
        assert_eq!(tags::tag_id("table"), None);
    }

    #[test]
    fn opcode_from_u8() {
        assert_eq!(Op::from_u8(0x06), Some(Op::Render));
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
        let name_idx = m.def(0).unwrap().name_idx;
        assert_eq!(m.pool.get(name_idx), Some("Hello"));
        assert!(m.def(1).is_none());
    }
}
