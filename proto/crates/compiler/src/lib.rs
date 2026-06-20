//! Quble 프로토타입 컴파일러: `.qubc` 소스 → 직렬화된 바이트코드(`Box<[u8]>`).
//! 프론트엔드(lexer/parse → ast)와 백엔드(codegen)를 모듈로 나눠 담는다.
//! MVP 스코프: 단일 컴포넌트, 문자열 속성값, 표현식 없음. 상세는 proto/BYTECODE.md.

mod ast;
mod codegen;
mod lexer;
mod parse;
mod resolve;

pub use resolve::{ResolveError, Resolver};

use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub enum CompileError {
    Resolve(resolve::ResolveError),
    Codegen(codegen::CodegenError),
}

/// 엔트리 소스를 직렬화된 바이트코드로 컴파일. use 그래프를 resolver로 따라가
/// 모든 컴포넌트를 한 모듈로 평탄화한다. entry_path는 엔트리 소스 자신의 정규화 경로로,
/// 첫 use의 base가 된다(엔트리 컴포넌트가 ID 0).
pub fn compile_src(
    entry_path: &str,
    src: &str,
    resolver: &impl Resolver,
) -> Result<Box<[u8]>, CompileError> {
    let comps = resolve::flatten(entry_path, src, resolver).map_err(CompileError::Resolve)?;
    codegen::generate(&comps).map_err(CompileError::Codegen)
}

/// 파일 경로로 컴파일. 엔트리 파일을 읽고, use는 importer 파일 기준 상대경로를
/// 정규화한 절대경로로 해소한다(파일시스템 resolver).
pub fn compile_file(path: &str) -> Result<Box<[u8]>, CompileError> {
    let not_found = || {
        CompileError::Resolve(ResolveError::NotFound {
            base: String::new(),
            target: path.to_string(),
        })
    };
    let entry = std::fs::canonicalize(path).map_err(|_| not_found())?;
    let src = std::fs::read_to_string(&entry).map_err(|_| not_found())?;
    compile_src(&entry.to_string_lossy(), &src, &fs_resolver)
}

/// 파일시스템 resolver: base 파일의 디렉터리 기준으로 target을 풀어 정규화한 절대경로와 소스를 반환.
fn fs_resolver(base_canonical_path: &str, target_path: &str) -> Option<(String, String)> {
    let dir = Path::new(base_canonical_path).parent()?;
    let abs = std::fs::canonicalize(dir.join(target_path)).ok()?;
    let src = std::fs::read_to_string(&abs).ok()?;
    Some((abs.to_string_lossy().into_owned(), src))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{AttrValue, Node};

    /// use 없는 단일 소스를 컴파일(테스트용). resolver는 호출되지 않으므로 항상 None.
    fn compile(src: &str) -> Result<Box<[u8]>, CompileError> {
        compile_src("entry", src, &(|_: &str, _: &str| None))
    }

    /// 경로->소스 메모리맵으로 컴파일(테스트용). 경로 정규화 없이 문자열 그대로 키.
    fn compile_map(entry_src: &str, files: &[(&str, &str)]) -> Result<Box<[u8]>, CompileError> {
        let files: Vec<(String, String)> = files
            .iter()
            .map(|(p, s)| (p.to_string(), s.to_string()))
            .collect();
        let resolver = |_base: &str, target: &str| {
            files
                .iter()
                .find(|(p, _)| p == target)
                .map(|(p, s)| (p.clone(), s.clone()))
        };
        compile_src("entry", entry_src, &resolver)
    }

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
        let source = parse::parse(&toks).unwrap();
        assert!(source.uses.is_empty());
        assert_eq!(source.comps.len(), 1);
        let comp = &source.comps[0];
        assert_eq!(comp.name, "Hello");
        assert_eq!(comp.template.len(), 1);
        match &comp.template[0] {
            Node::Element {
                tag,
                attrs,
                children,
            } => {
                assert_eq!(tag, "div");
                assert_eq!(
                    attrs,
                    &[(
                        "class".to_string(),
                        AttrValue::Static("greeting".to_string())
                    )]
                );
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
        let greeting = pool.intern("greeting");
        let _hello_txt = pool.intern("Hello"); // 텍스트, 같은 인덱스
        let sub = pool.intern("sub");
        let world = pool.intern("world");
        // "class"는 전역 속성명 → 컴포넌트 상수풀이 아니라 전역 ID로 참조.
        let class_g = bytecode::attrs::attr_id("class").unwrap();

        let mut code = Vec::new();
        let div = tags::tag_id("div").unwrap();
        let h1 = tags::tag_id("h1").unwrap();
        let p = tags::tag_id("p").unwrap();
        let push16 = |c: &mut Vec<u8>, v: u16| c.extend_from_slice(&v.to_le_bytes());

        code.push(Op::ElemOpen as u8);
        push16(&mut code, div);
        code.push(Op::AttrG as u8);
        push16(&mut code, class_g);
        push16(&mut code, greeting);
        code.push(Op::ElemCloseOpen as u8);
        code.push(Op::ElemOpen as u8);
        push16(&mut code, h1);
        code.push(Op::ElemCloseOpen as u8);
        code.push(Op::Text as u8);
        push16(&mut code, hello);
        code.push(Op::ElemEnd as u8);
        code.push(Op::ElemOpen as u8);
        push16(&mut code, p);
        code.push(Op::AttrG as u8);
        push16(&mut code, class_g);
        push16(&mut code, sub);
        code.push(Op::ElemCloseOpen as u8);
        code.push(Op::Text as u8);
        push16(&mut code, world);
        code.push(Op::ElemEnd as u8);
        code.push(Op::ElemEnd as u8);
        code.push(Op::Halt as u8);

        let expected = Module::new(
            pool,
            vec![CompDef {
                name_idx: hello,
                code_off: 0,
                code_len: code.len() as u32,
            }],
            code,
        );

        let got = compile(HELLO).unwrap();
        assert_eq!(&got[..], encode(&expected).as_slice());
    }

    /// `class={c}`는 전역 name + 변수값 → AttrGVar(name=전역 ID, value=scope offset),
    /// `data-x={d}`는 로컬 name + 변수값 → AttrLVar(name=상수풀 인덱스, value=scope offset).
    #[test]
    fn compiles_attr_var_opcodes() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              props { c, d }
              template { div(class={c} data-x={d}) {} }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // ELEM_OPEN div | ATTR_G_VAR class 0 | ATTR_L_VAR <data-x> 1 | CLOSE_OPEN | END | HALT
        let class_g = bytecode::attrs::attr_id("class").unwrap();
        // data-x 상수풀 인덱스를 선형 탐색으로 찾는다(테스트 전용).
        let data_x = (0..u16::MAX)
            .find(|&i| module.pool.get(i) == Some("data-x"))
            .unwrap();
        let mut want = Vec::new();
        let push16 = |c: &mut Vec<u8>, v: u16| c.extend_from_slice(&v.to_le_bytes());
        want.push(Op::ElemOpen as u8);
        push16(&mut want, bytecode::tags::tag_id("div").unwrap());
        want.push(Op::AttrGVar as u8);
        push16(&mut want, class_g);
        push16(&mut want, 0); // c = scope offset 0
        want.push(Op::AttrLVar as u8);
        push16(&mut want, data_x);
        push16(&mut want, 1); // d = scope offset 1
        want.push(Op::ElemCloseOpen as u8);
        want.push(Op::ElemEnd as u8);
        want.push(Op::Halt as u8);

        assert_eq!(code, want.as_slice());
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
        assert!(matches!(
            compile(src),
            Err(CompileError::Resolve(ResolveError::Parse(_)))
        ));
    }

    /// 한 .qubc에서 여러 컴포넌트를 use. 셋 다 한 모듈로 평탄화돼야 한다 —
    /// decode해서 def 개수(3)와 이름(Card/Thumb/Badge), 엔트리 Card가 ID 0인지 확인.
    #[test]
    fn use_multiple_from_one_source() {
        use bytecode::decode;

        let entry = r#"
            use Thumb, Badge from "./parts.qubc"
            component Card {
              props { img, role }
              template { div() { Thumb(src={img}) {} Badge(text={role}) {} } }
            }
        "#;
        let parts = r#"
            component Thumb {
              props { src }
              template { img(src={src}) {} }
            }
            component Badge {
              props { text }
              template { span() { {text} } }
            }
        "#;
        let bytes = compile_map(entry, &[("./parts.qubc", parts)]).unwrap();
        let module = decode(&bytes).unwrap();

        // def(0..)를 순서대로 읽어 이름을 모은다 — None이 나오면 끝.
        let mut names = Vec::new();
        let mut id = 0;
        while let Some(def) = module.def(id) {
            names.push(module.pool.get(def.name_idx).unwrap().to_string());
            id += 1;
        }
        assert_eq!(names.len(), 3, "Card+Thumb+Badge 셋 다 들어가야 함");
        assert_eq!(names[0], "Card", "엔트리가 ID 0");
        assert!(names.contains(&"Thumb".to_string()));
        assert!(names.contains(&"Badge".to_string()));
    }

    /// resolver가 경로를 못 찾으면 NotFound.
    #[test]
    fn use_unresolved_path_errors() {
        let entry = r#"
            use Label from "./missing.qubc"
            component Card { template { Label() {} } }
        "#;
        assert!(matches!(
            compile_map(entry, &[]),
            Err(CompileError::Resolve(ResolveError::NotFound { .. }))
        ));
    }

    /// use 한 이름이 대상 소스에 없으면 MissingExport.
    #[test]
    fn use_missing_export_errors() {
        let entry = r#"
            use Nope from "./parts.qubc"
            component Card { template { div() {} } }
        "#;
        let parts = r#"component Label { template { span() {} } }"#;
        assert!(matches!(
            compile_map(entry, &[("./parts.qubc", parts)]),
            Err(CompileError::Resolve(ResolveError::MissingExport { .. }))
        ));
    }

    /// 서로 다른 소스에 같은 이름의 컴포넌트가 있으면 DuplicateComponent.
    #[test]
    fn use_duplicate_component_errors() {
        let entry = r#"
            use Card from "./other.qubc"
            component Card { template { div() {} } }
        "#;
        let other = r#"component Card { template { span() {} } }"#;
        assert!(matches!(
            compile_map(entry, &[("./other.qubc", other)]),
            Err(CompileError::Resolve(ResolveError::DuplicateComponent(_)))
        ));
    }

    /// use 그래프에 순환이 있으면 Cycle. entry -> a -> entry.
    #[test]
    fn use_cycle_errors() {
        let entry = r#"
            use A from "./a.qubc"
            component Entry { template { A() {} } }
        "#;
        // a가 다시 entry를 use. resolver는 "entry"(엔트리 path)도 매핑한다.
        let a = r#"
            use Entry from "./entry.qubc"
            component A { template { Entry() {} } }
        "#;
        let resolver = move |_base: &str, target: &str| match target {
            "./a.qubc" => Some(("./a.qubc".to_string(), a.to_string())),
            "./entry.qubc" => Some(("entry".to_string(), String::new())),
            _ => None,
        };
        assert!(matches!(
            compile_src("entry", entry, &resolver),
            Err(CompileError::Resolve(ResolveError::Cycle(_)))
        ));
    }
}
