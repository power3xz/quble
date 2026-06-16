//! Quble 프로토타입 컴파일러: `.qubc` 소스 → 직렬화된 바이트코드(`Box<[u8]>`).
//! 프론트엔드(lexer/parse → ast)와 백엔드(codegen)를 모듈로 나눠 담는다.
//! MVP 스코프: 단일 컴포넌트, 문자열 속성값, 표현식 없음. 상세는 proto/BYTECODE.md.

pub mod ast;
pub mod codegen;
pub mod lexer;
pub mod parse;

#[derive(Debug, PartialEq, Eq)]
pub enum CompileError {
    Lex(lexer::LexError),
    Parse(parse::ParseError),
    Codegen(codegen::CodegenError),
}

/// 소스 문자열을 직렬화된 바이트코드로 컴파일.
pub fn compile(src: &str) -> Result<Box<[u8]>, CompileError> {
    let tokens = lexer::lex(src).map_err(CompileError::Lex)?;
    let comp = parse::parse(&tokens).map_err(CompileError::Parse)?;
    codegen::generate(&comp).map_err(CompileError::Codegen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::Node;

    const HELLO: &str = r#"
        component Hello {
          template {
            div(class="greeting") {
              h1() { "Hello" }
              p(class="sub") { "world" }
            }
          }
        }
    "#;

    #[test]
    fn lex_then_parse_hello() {
        let toks = lexer::lex(HELLO).unwrap();
        let comp = parse::parse(&toks).unwrap();
        assert_eq!(comp.name, "Hello");
        assert_eq!(comp.template.len(), 1);
        match &comp.template[0] {
            Node::Element { tag, attrs, children } => {
                assert_eq!(tag, "div");
                assert_eq!(attrs, &[("class".to_string(), "greeting".to_string())]);
                assert_eq!(children.len(), 2);
            }
            _ => panic!("expected element"),
        }
    }

    /// 컴파일 산출물이 손으로 구성한 기대 바이트와 일치하는지.
    #[test]
    fn compile_hello_matches_expected_bytes() {
        use bytecode::{encode, tags, CompDef, ConstPool, Module, Op};

        let mut pool = ConstPool::new();
        let hello = pool.intern("Hello"); // 컴포넌트명
        let class = pool.intern("class");
        let greeting = pool.intern("greeting");
        let _hello_txt = pool.intern("Hello"); // 텍스트, 같은 인덱스
        let sub = pool.intern("sub");
        let world = pool.intern("world");

        let mut code = Vec::new();
        let div = tags::tag_id("div").unwrap();
        let h1 = tags::tag_id("h1").unwrap();
        let p = tags::tag_id("p").unwrap();
        let push16 = |c: &mut Vec<u8>, v: u16| c.extend_from_slice(&v.to_le_bytes());

        code.push(Op::ElemOpen as u8);
        push16(&mut code, div);
        code.push(Op::Attr as u8);
        push16(&mut code, class);
        push16(&mut code, greeting);
        code.push(Op::ElemCloseOpen as u8);
        code.push(Op::ElemOpen as u8);
        push16(&mut code, h1);
        code.push(Op::ElemCloseOpen as u8);
        code.push(Op::Text as u8);
        push16(&mut code, hello);
        code.push(Op::ElemEnd as u8);
        push16(&mut code, h1);
        code.push(Op::ElemOpen as u8);
        push16(&mut code, p);
        code.push(Op::Attr as u8);
        push16(&mut code, class);
        push16(&mut code, sub);
        code.push(Op::ElemCloseOpen as u8);
        code.push(Op::Text as u8);
        push16(&mut code, world);
        code.push(Op::ElemEnd as u8);
        push16(&mut code, p);
        code.push(Op::ElemEnd as u8);
        push16(&mut code, div);
        code.push(Op::Halt as u8);

        let expected = Module::new(
            pool,
            vec![CompDef { name_idx: hello, code_off: 0, code_len: code.len() as u32 }],
            code,
        );

        let got = compile(HELLO).unwrap();
        assert_eq!(&got[..], encode(&expected).as_slice());
    }

    #[test]
    fn unknown_tag_errors() {
        let src = r#"component C { template { table() {} } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(codegen::CodegenError::UnknownTag(_)))
        ));
    }

    #[test]
    fn missing_brace_errors() {
        let src = r#"component C { template { div() { } "#;
        assert!(matches!(compile(src), Err(CompileError::Parse(_))));
    }
}
