//! Quble 프로토타입 컴파일러: `.qubc` 소스 → 직렬화된 바이트코드(`Box<[u8]>`).
//! 프론트엔드(lexer/parse → ast)와 백엔드(codegen)를 모듈로 나눠 담는다.
//! MVP 스코프: 단일 컴포넌트, 문자열 속성값, 표현식 없음. 상세는 proto/BYTECODE.md.

mod ast;
mod codegen;
mod dts;
mod lexer;
mod parse;
mod resolve;

pub use dts::handlers_dts_file;
pub use resolve::{ResolveError, Resolver};

use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub enum CompileError {
    Resolve(resolve::ResolveError),
    Codegen(codegen::CodegenError),
}

/// 컴파일 산출물. 바이트코드와 리소스 사이드맵을 함께 낸다 - 빌드 파이프라인이 사이드맵으로
/// 내용 해시·복사·URL화를 한다(BYTECODE.md §5 LOAD_RES 메모).
pub struct CompileOutput {
    pub bytecode: Box<[u8]>,
    /// 인덱스 = 모듈 전역 resId, 값 = 리소스 정규화 경로.
    pub resources: Vec<String>,
}

/// 엔트리 소스를 직렬화된 바이트코드로 컴파일. use 그래프를 resolver로 따라가
/// 모든 컴포넌트를 한 모듈로 평탄화한다. entry_path는 엔트리 소스 자신의 정규화 경로로,
/// 첫 use의 base가 된다(엔트리 컴포넌트가 ID 0).
pub fn compile_src(
    entry_path: &str,
    src: &str,
    resolver: &impl Resolver,
) -> Result<CompileOutput, CompileError> {
    let comps = resolve::flatten(entry_path, src, resolver).map_err(CompileError::Resolve)?;
    let (bytecode, resources) = codegen::generate(&comps).map_err(CompileError::Codegen)?;
    Ok(CompileOutput { bytecode, resources })
}

/// 파일 경로로 컴파일. 엔트리 파일을 읽고, use는 importer 파일 기준 상대경로를
/// 정규화한 절대경로로 해소한다(파일시스템 resolver).
pub fn compile_file(path: &str) -> Result<CompileOutput, CompileError> {
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
    use bytecode::Const;

    /// 상수풀 인덱스의 문자열 값(테스트용). 이름·속성명 등 문자열 상수 검사에 쓴다.
    /// 문자열이 아닌 엔트리(Num/Bool)면 None.
    fn str_at(module: &bytecode::Module, index: u16) -> Option<&str> {
        match module.pool.get(index) {
            Some(Const::Str(s)) => Some(s),
            _ => None,
        }
    }

    /// use 없는 단일 소스를 컴파일(테스트용). resolver는 호출되지 않으므로 항상 None.
    fn compile(src: &str) -> Result<Box<[u8]>, CompileError> {
        compile_src("entry", src, &(|_: &str, _: &str| None)).map(|o| o.bytecode)
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
        compile_src("entry", entry_src, &resolver).map(|o| o.bytecode)
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
                ..
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

    #[test]
    fn lex_dot_between_idents() {
        use lexer::Token;
        // `.`은 식별자 사이에서 Dot 토큰. `assignee.name` -> Ident Dot Ident.
        let toks = lexer::lex("assignee.name").unwrap();
        assert_eq!(
            toks,
            vec![
                Token::Ident("assignee".to_string()),
                Token::Dot,
                Token::Ident("name".to_string()),
            ]
        );
    }

    #[test]
    fn lex_number_dot_is_decimal_not_dot() {
        use lexer::Token;
        // 숫자 안의 `.`은 소수점으로 먹어 Dot 토큰이 생기지 않는다(숫자 분기가 먼저 소비).
        let toks = lexer::lex("3.14").unwrap();
        assert_eq!(toks, vec![Token::Num("3.14".to_string())]);
    }

    /// 컴파일 산출물이 손으로 구성한 기대 바이트와 일치하는지.
    #[test]
    fn compile_hello_matches_expected_bytes() {
        use bytecode::{encode, tags, CompDef, ConstPool, Module, Op};

        let mut pool = ConstPool::new();
        let hello = pool.intern_str("Hello"); // 컴포넌트명
        let greeting = pool.intern_str("greeting");
        let _hello_txt = pool.intern_str("Hello"); // 텍스트, 같은 인덱스
        let sub = pool.intern_str("sub");
        let world = pool.intern_str("world");
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
            // props 없는 컴포넌트라도 루트 props를 빈 객체 타입으로 intern한다(엔트리 #0).
            vec![bytecode::TypeEntry::Object(vec![])],
            0,
            vec![CompDef {
                name_const_index: hello,
                code_off: 0,
                code_len: code.len() as u32,
                events: vec![],
                contexts: vec![],
            }],
            code,
        );

        let got = compile(HELLO).unwrap();
        assert_eq!(&got[..], encode(&expected).as_slice());
    }

    /// `class={c}`는 전역 name + 변수값 → AttrGVar(name=전역 ID, value=scope index),
    /// `data-x={d}`는 로컬 name + 변수값 → AttrLVar(name=상수풀 인덱스, value=scope index).
    #[test]
    fn compiles_attr_var_opcodes() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              props { c: string, d: string }
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
            .find(|&i| str_at(&module, i) == Some("data-x"))
            .unwrap();
        let mut want = Vec::new();
        let push16 = |c: &mut Vec<u8>, v: u16| c.extend_from_slice(&v.to_le_bytes());
        want.push(Op::ElemOpen as u8);
        push16(&mut want, bytecode::tags::tag_id("div").unwrap());
        want.push(Op::AttrGVar as u8);
        push16(&mut want, class_g);
        push16(&mut want, 0); // c = scope index 0
        want.push(Op::AttrLVar as u8);
        push16(&mut want, data_x);
        push16(&mut want, 1); // d = scope index 1
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

    /// `@input:EVENT`이 닫힌 DOM 이벤트 집합의 input ID(1)로 BIND_EVENT를 낸다.
    /// (click 외 이벤트가 끝까지 - 렉서 -> 파서 -> codegen - 흐르는지.)
    #[test]
    fn compiles_non_click_dom_event() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              props { value: string }
              events { EDIT({ value }) }
              template { input(@input:EDIT) {} }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // BIND_EVENT event_type=1(input) event_index=0 가 코드에 있어야 한다.
        let input_id = bytecode::dom_events::dom_event_id("input").unwrap();
        let mut bind = vec![Op::BindEvent as u8];
        bind.extend_from_slice(&input_id.to_le_bytes());
        bind.extend_from_slice(&0u16.to_le_bytes()); // EDIT = event_index 0
        assert!(
            code.windows(bind.len()).any(|w| w == bind.as_slice()),
            "BIND_EVENT input(1) index 0 가 코드에 있어야",
        );
    }

    /// `@with`가 끝까지(렉서 -> 파서 -> codegen) 흐르는지. contexts 테이블에 fields가
    /// Var(Scope)/Literal(Const)로 들어가고, 코드에 EnterContext/ExitContext가 나는지 직접 검사.
    #[test]
    fn compiles_with_context() {
        use bytecode::{decode, FieldValue, Op};

        let src = r#"
            component C {
              props { assignee: string }
              contexts { Area { section: "actions", userId: assignee } }
              template {
                @with Area {
                  div() { "x" }
                }
              }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();

        // 컨텍스트 테이블: Area 하나, fields 2개(section=Const 리터럴, userId=Scope assignee).
        assert_eq!(def.contexts.len(), 1);
        let area = &def.contexts[0];
        assert_eq!(str_at(&module, area.name_const_index), Some("Area"));
        assert_eq!(area.fields.len(), 2);
        // section: "actions" -> 스칼라 field, ref가 Const(상수풀이 "actions"를 가리킴).
        assert_eq!(str_at(&module, area.fields[0].name_const_index), Some("section"));
        match area.fields[0].value {
            FieldValue::Const(actions_index) => {
                assert_eq!(str_at(&module, actions_index), Some("actions"));
            }
            other => panic!("section은 리터럴 스칼라라 Const ref여야: {other:?}"),
        }
        // userId: assignee -> 스칼라 field, ref가 Scope(assignee 슬롯 0, offset 0).
        assert_eq!(str_at(&module, area.fields[1].name_const_index), Some("userId"));
        assert_eq!(area.fields[1].value, FieldValue::Scope(0, 0));

        // 코드: EnterContext context_index=0 ... ExitContext.
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
        let mut enter = vec![Op::EnterContext as u8];
        enter.extend_from_slice(&0u16.to_le_bytes());
        assert!(
            code.windows(enter.len()).any(|w| w == enter.as_slice()),
            "EnterContext index 0 가 코드에 있어야",
        );
        assert!(
            code.contains(&(Op::ExitContext as u8)),
            "ExitContext가 코드에 있어야",
        );
    }

    /// `@for (x of N)` 리터럴 count가 끝까지(렉서 -> 파서 -> codegen) 흐르는지.
    /// ForRaw operand에 count 값이 직접 실리고 FOR_END로 닫힌다.
    #[test]
    fn compiles_for_literal_count() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              template {
                @for (item of 3) {
                  div() { "x" }
                }
              }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        let mut for_raw = vec![Op::ForRaw as u8];
        for_raw.extend_from_slice(&3u16.to_le_bytes());
        assert!(
            code.windows(for_raw.len()).any(|w| w == for_raw.as_slice()),
            "ForRaw count=3 이 코드에 있어야",
        );
        assert!(code.contains(&(Op::ForEnd as u8)), "ForEnd가 코드에 있어야");
    }

    /// `@for (x of count)` 숫자 prop count는 ForCountVar + (scope_index, offset).
    #[test]
    fn compiles_for_prop_count() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              props { count: number }
              template {
                @for (item of count) {
                  div() { "x" }
                }
              }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // count는 유일한 prop이라 scope index 0, root 참조라 offset 0.
        let for_op = vec![Op::ForCountVar as u8, 0, 0];
        assert!(
            code.windows(for_op.len()).any(|w| w == for_op.as_slice()),
            "ForCountVar scope=0 offset=0 이 코드에 있어야",
        );
        assert!(code.contains(&(Op::ForEnd as u8)), "ForEnd가 코드에 있어야");
    }

    /// `@for (tag of tags)` 스칼라 배열 순회. tags(배열)는 슬롯 1개라 ForArrayVar (scope=0, offset=0).
    /// 회차변수 tag는 props 슬롯 뒤(offset 1)에 앉아 {tag}가 TextVar 1을 낸다.
    #[test]
    fn compiles_for_scalar_array() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              props { tags: string[] }
              template {
                @for (tag of tags) {
                  p() { {tag} }
                }
              }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // 배열은 슬롯 0(유일 prop), root 참조라 offset 0.
        let for_op = vec![Op::ForArrayVar as u8, 0, 0];
        assert!(
            code.windows(for_op.len()).any(|w| w == for_op.as_slice()),
            "ForArrayVar(배열 scope=0 offset=0)이 있어야:\n{code:?}",
        );
        // {tag} 회차변수는 props 슬롯(1개) 뒤 scope_index 1, 요소가 스칼라라 offset 0.
        let text_var = vec![Op::TextVar as u8, 1, 0];
        assert!(
            code.windows(text_var.len()).any(|w| w == text_var.as_slice()),
            "TextVar(회차변수 tag scope=1 offset=0)가 있어야:\n{code:?}",
        );
    }

    /// 회차변수를 자식 컴포넌트 인자로 넘긴다(`Card(title={tag})`). 회차변수 offset(1)이
    /// PushArg에 실려 자식 prop으로 전달된다.
    #[test]
    fn for_item_passed_to_child_component() {
        use bytecode::{decode, Op};

        let src = r#"
            component Card { props { title: string } template { p() { {title} } } }
            component C {
              props { tags: string[] }
              template {
                @for (tag of tags) {
                  Card(title={tag}) {}
                }
              }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        // C는 두 번째 정의(id 1).
        let def = module.def(1).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // title={tag} - 경로 없는 회차변수 tag를 통째로 THROUGH. tag 슬롯 = props(tags:0) 뒤
        // 회차변수 자리라 순번 1. THROUGH operand는 scope_index u8 하나.
        let push_arg = vec![Op::PushThrough as u8, 1u8];
        assert!(
            code.windows(push_arg.len()).any(|w| w == push_arg.as_slice()),
            "PushThrough(회차변수 tag=1)가 있어야:\n{code:?}",
        );
    }

    /// 회차변수는 부모 값일 뿐 자식 props 인터페이스에 안 샌다 - 자식이 tag를 선언 안 하면
    /// `Card(tag={tag})`는 UnknownArg(자식엔 그런 prop 없음).
    #[test]
    fn for_item_does_not_leak_into_child_props() {
        let src = r#"
            component Card { props { title: string } template { p() { {title} } } }
            component C {
              props { tags: string[] }
              template {
                @for (tag of tags) {
                  Card(tag={tag}) {}
                }
              }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(codegen::CodegenError::UnknownArg { .. }))
        ));
    }

    /// 회차변수 이름이 prop과 겹치면 에러(섀도잉 금지).
    #[test]
    fn for_item_name_collision_is_error() {
        let src = r#"
            component C {
              props { tag: string, tags: string[] }
              template {
                @for (tag of tags) {
                  p() { {tag} }
                }
              }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(codegen::CodegenError::DuplicateBinding(_)))
        ));
    }

    /// 컴포넌트 상수풀에서 문자열의 인덱스를 찾는다(테스트용 - 세그먼트 operand 확인).
    fn str_index(module: &bytecode::Module, s: &str) -> u16 {
        (0..)
            .find(|&i| str_at(module, i) == Some(s))
            .expect("문자열이 상수풀에 있어야")
    }

    /// @for 안 자식 컴포넌트는 PushPathSegment(Row) 직후 PushPathIndexSegment(깊이 0)를 낸다
    /// (런타임이 Row[$0]으로 접미 조립). 깊이는 컴포넌트-로컬.
    #[test]
    fn for_component_pushes_index_segment() {
        use bytecode::{decode, Op};

        let src = r#"
            component List { template { @for (item of 3) { Row: Inner() {} } } }
            component Inner {
              events { PICK({ id: "x" }) }
              template { button(@click:PICK) {} }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // PushPathSegment(Row) 다음 바로 PushPathIndexSegment(0) - 접미 관계.
        let mut seq = vec![Op::PushPathSegment as u8];
        seq.extend_from_slice(&str_index(&module, "Row").to_le_bytes());
        seq.push(Op::PushPathIndexSegment as u8);
        seq.extend_from_slice(&0u16.to_le_bytes());
        assert!(
            code.windows(seq.len()).any(|w| w == seq.as_slice()),
            "PushPathSegment(Row) 직후 PushPathIndexSegment(0):\n{code:?}",
        );
    }

    /// @for 안 중첩 @for는 컴포넌트-로컬 깊이 0,1을 각각 낸다 - Row 세그먼트가 [$0][$1] 둘 다 접미.
    #[test]
    fn nested_for_local_depths() {
        use bytecode::{decode, Op};

        let src = r#"
            component List {
              template {
                @for (a of 3) { @for (b of 3) { Row: Inner() {} } }
              }
            }
            component Inner {
              events { PICK({ id: "x" }) }
              template { button(@click:PICK) {} }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // PushPathSegment(Row) 다음 PushPathIndexSegment(0) 그다음 (1) - 세그먼트가 둘 다 접미.
        let mut seq = vec![Op::PushPathSegment as u8];
        seq.extend_from_slice(&str_index(&module, "Row").to_le_bytes());
        seq.push(Op::PushPathIndexSegment as u8);
        seq.extend_from_slice(&0u16.to_le_bytes());
        seq.push(Op::PushPathIndexSegment as u8);
        seq.extend_from_slice(&1u16.to_le_bytes());
        assert!(
            code.windows(seq.len()).any(|w| w == seq.as_slice()),
            "Row 세그먼트가 인덱스 0,1을 연달아 접미:\n{code:?}",
        );
    }

    /// @for 직속 element 이벤트는 익명 인덱스 세그먼트를 낸다(런타임이 [$0]으로 조립).
    #[test]
    fn for_element_pushes_index_segment() {
        use bytecode::{decode, Op};

        let src = r#"
            component Menu {
              events { SELECT({ i: "x" }) }
              template { @for (item of 3) { li(@click:SELECT) {} } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // 익명 PushPathIndexSegment(0) 직후 BindEvent - 이벤트 앞에 인덱스 세그먼트가 실린다.
        let mut seq = vec![Op::PushPathIndexSegment as u8];
        seq.extend_from_slice(&0u16.to_le_bytes());
        seq.push(Op::BindEvent as u8);
        assert!(
            code.windows(seq.len()).any(|w| w == seq.as_slice()),
            "익명 PushPathIndexSegment(0) 직후 BindEvent:\n{code:?}",
        );
    }

    /// @for 밖 컴포넌트는 PushPathIndexSegment를 안 낸다(회귀).
    #[test]
    fn outside_for_no_index_segment() {
        use bytecode::{decode, Op};

        let src = r#"
            component List { template { Row: Inner() {} } }
            component Inner {
              events { PICK({ id: "x" }) }
              template { button(@click:PICK) {} }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        assert!(
            !code.contains(&(Op::PushPathIndexSegment as u8)),
            "@for 밖은 인덱스 세그먼트 없음:\n{code:?}",
        );
    }

    /// count 리터럴이 u16 상한을 넘으면 파싱 에러(0..=65535).
    #[test]
    fn for_count_over_u16_rejected() {
        let src = r#"
            component C {
              template { @for (x of 70000) { div() {} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Resolve(ResolveError::Parse(_)))
        ));
    }

    /// `of` 없이 쓰면 파싱 에러.
    #[test]
    fn for_missing_of_rejected() {
        let src = r#"
            component C {
              template { @for (x 3) { div() {} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Resolve(ResolveError::Parse(_)))
        ));
    }

    /// contexts 필드 단축형 `key`는 `key: key`(Scope)로 푼다 - payload 단축형과 같은 규칙.
    #[test]
    fn context_field_shorthand() {
        use bytecode::{decode, FieldValue};

        let src = r#"
            component C {
              props { tier: string }
              contexts { Area { tier } }
              template { @with Area { div() {} } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let area = &module.def(0).unwrap().contexts[0];
        // 단축형 tier -> 필드명 "tier", 값은 tier prop(scope 0, offset 0). 스칼라.
        assert_eq!(str_at(&module, area.fields[0].name_const_index), Some("tier"));
        assert_eq!(area.fields[0].value, FieldValue::Scope(0, 0));
    }

    /// events 페이로드 값도 리터럴(Const)을 받는다 - contexts와 같은 arg_to_field_value 경로.
    #[test]
    fn event_payload_literal() {
        use bytecode::{decode, FieldValue};

        let src = r#"
            component C {
              props { count: string }
              events { BUMP({ count, label: "clicks" }) }
              template { button(@click:BUMP) { "x" } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let event = &module.def(0).unwrap().events[0];
        // count: 단축형 -> Scope(0, 0). label: "clicks" -> Const. 둘 다 스칼라.
        assert_eq!(str_at(&module, event.fields[0].name_const_index), Some("count"));
        assert_eq!(event.fields[0].value, FieldValue::Scope(0, 0));
        assert_eq!(str_at(&module, event.fields[1].name_const_index), Some("label"));
        match event.fields[1].value {
            FieldValue::Const(clicks_index) => {
                assert_eq!(str_at(&module, clicks_index), Some("clicks"));
            }
            other => panic!("label은 리터럴 스칼라라 Const ref여야: {other:?}"),
        }
    }

    /// 리터럴은 소스의 타입대로 상수풀에 들어간다 - 숫자는 Const::Num, 불리언은 Const::Bool,
    /// 문자열은 Const::Str. 런타임이 인덱스로 꺼내면 이미 올바른 값이 되도록.
    #[test]
    fn literal_types_in_pool() {
        use bytecode::{decode, Const, FieldValue};

        let src = r#"
            component C {
              events { E({ n: 42, ratio: 3.5, b: true, s: "hi" }) }
              template { button(@click:E) { "x" } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let fields = &module.def(0).unwrap().events[0].fields;
        // 각 필드가 스칼라이고 그 ref가 Const를 가리키며, 그 상수가 타입대로다.
        let const_of = |i: usize| match fields[i].value {
            FieldValue::Const(idx) => module.pool.get(idx).cloned(),
            other => panic!("리터럴 스칼라라 Const ref여야: {other:?}"),
        };
        assert_eq!(const_of(0), Some(Const::Num(42.0)));
        assert_eq!(const_of(1), Some(Const::Num(3.5)));
        assert_eq!(const_of(2), Some(Const::Bool(true)));
        assert_eq!(const_of(3), Some(Const::Str("hi".into())));
    }

    /// payload에 객체를 담으면(`SAVE({ user })`, user가 객체) field가 Object type_ref +
    /// 그 슬롯 위치(Scope ref 하나)로 인코딩된다(안 펼침). 타입 테이블에 구조가 실린다.
    #[test]
    fn object_payload_encodes_type_tree_and_leaves() {
        use bytecode::{decode, FieldValue, TypeEntry};

        let src = r#"
            component C {
              props { user: { name: string, age: number } }
              events { SAVE({ user }) }
              template { button(@click:SAVE) { "x" } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let field = &module.def(0).unwrap().events[0].fields[0];

        // field 이름은 user, ref는 user 슬롯 하나(Scope(0, 0)) - 안 펼쳐 객체도 슬롯 하나.
        assert_eq!(str_at(&module, field.name_const_index), Some("user"));
        assert_eq!(field.value, FieldValue::Scope(0, 0));

        // type_ref가 Object이고, 필드가 (name, age) 순으로 각각 Scalar를 가리킨다.
        match &module.types[field.type_ref as usize] {
            TypeEntry::Object(fields) => {
                assert_eq!(fields.len(), 2);
                assert_eq!(str_at(&module, fields[0].0), Some("name"));
                assert_eq!(str_at(&module, fields[1].0), Some("age"));
                assert!(matches!(module.types[fields[0].1 as usize], TypeEntry::Scalar));
                assert!(matches!(module.types[fields[1].1 as usize], TypeEntry::Scalar));
            }
            other => panic!("user는 객체라 Object여야: {other:?}"),
        }
    }

    /// 같은 구조의 두 객체를 각각 payload에 담으면 타입 테이블에서 한 엔트리로 dedup된다
    /// (필드명·순서·자식 타입이 모두 같으면 같은 type_ref).
    #[test]
    fn identical_object_types_dedup() {
        use bytecode::decode;

        let src = r#"
            component C {
              props { user: { name: string, age: number }, newUser: { name: string, age: number } }
              events { SAVE({ user, newUser }) }
              template { button(@click:SAVE) { "x" } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let fields = &module.def(0).unwrap().events[0].fields;
        // 두 field의 type_ref가 같다(같은 구조 = 한 엔트리 공유).
        assert_eq!(fields[0].type_ref, fields[1].type_ref);
    }

    /// 스칼라 payload는 타입 테이블에 Scalar 엔트리 하나만 만들고 여러 스칼라 field가 공유한다.
    #[test]
    fn scalar_fields_share_one_scalar_entry() {
        use bytecode::{decode, TypeEntry};

        let src = r#"
            component C {
              props { a: string, b: number }
              events { E({ a, b }) }
              template { button(@click:E) { "x" } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let fields = &module.def(0).unwrap().events[0].fields;
        // 두 스칼라 field가 같은 Scalar 엔트리를 가리킨다.
        assert_eq!(fields[0].type_ref, fields[1].type_ref);
        assert!(matches!(module.types[fields[0].type_ref as usize], TypeEntry::Scalar));
        // 테이블엔 Scalar 하나 + 루트 props 객체({a,b}) 하나뿐 - 두 스칼라 field는 Scalar를 공유.
        assert_eq!(module.types.len(), 2);
    }

    /// 예약어(true/false/bool/number/string)는 prop 이름으로 못 쓴다 - 렉서가 토큰을 분리해
    /// props 자리에서 Ident가 아니라 예약 토큰이 와 파싱이 거부한다.
    #[test]
    fn reserved_word_as_prop_name_errors() {
        let src = r#"
            component C {
              props { true: bool }
              template { div() {} }
            }
        "#;
        assert!(compile(src).is_err());
    }

    /// contexts 값이 props에 없는 prop을 참조하면 UnknownProp 에러(payload와 같은 검증 경로).
    #[test]
    fn context_unknown_prop_errors() {
        let src = r#"
            component C {
              contexts { Area { userId: missing } }
              template { @with Area { div() {} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(codegen::CodegenError::UnknownProp(_)))
        ));
    }

    /// 닫힌 집합 밖 디렉티브(`@hover`)는 렉서가 그 자리에서 거부한다(확정적 검증).
    #[test]
    fn unknown_dom_event_directive_errors() {
        let src = r#"
            component C {
              events { X({ a }) }
              template { div(@hover:X) {} }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Resolve(ResolveError::Lex(_)))
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

    /// resolve가 푼 루트 props를 leaf 경로로 펼쳐(객체는 필드까지, 배열은 요소 타입) 유틸
    /// 타입(Ref/Omit/Pick) 해소·선언 순서·객체 재귀 순서를 검증한다. 펼침은 이 검증만의 관찰
    /// 창이라 테스트 지역에 둔다(런타임은 타입 테이블로 심어 이 leaf 경로를 안 쓴다).
    fn compile_props(src: &str) -> Vec<String> {
        let comps = resolve::flatten("entry", src, &(|_: &str, _: &str| None)).unwrap();
        fn push_leaf_paths(prefix: &str, ty: &ast::Type, out: &mut Vec<String>) {
            match ty {
                ast::Type::Bool | ast::Type::Number | ast::Type::String => out.push(prefix.to_string()),
                ast::Type::Array(inner) => push_leaf_paths(prefix, inner, out),
                ast::Type::Object(fields) => {
                    for (name, field_ty) in fields {
                        push_leaf_paths(&format!("{prefix}.{name}"), field_ty, out);
                    }
                }
                ast::Type::Ref(n) => unreachable!("resolve가 Type::Ref({n})를 안 풀었다"),
                ast::Type::Omit(..) | ast::Type::Pick(..) => unreachable!("resolve가 유틸 타입을 안 풀었다"),
            }
        }
        let mut paths = Vec::new();
        for p in &comps[0].comp.props {
            push_leaf_paths(&p.name, &p.type_, &mut paths);
        }
        paths
    }

    /// prop 타입에 컴포넌트명 참조(`sec: Section`)를 쓰면 그 컴포넌트 props가 Object로
    /// 펼쳐진다 - 인라인 객체로 쓴 것과 같은 leaf 경로가 나온다.
    #[test]
    fn prop_type_ref_expands_like_inline() {
        let ref_props = compile_props(r#"
            component C {
              props { heading: string, sec: Section }
              template { div() { {heading} } }
            }
            component Section {
              props { title: string, on: bool }
              template { div() {} }
            }
        "#);
        let inline_props = compile_props(r#"
            component C {
              props { heading: string, sec: { title: string, on: bool } }
              template { div() { {heading} } }
            }
        "#);
        assert_eq!(ref_props, inline_props);
        assert_eq!(ref_props, vec!["heading", "sec.title", "sec.on"]);
    }

    /// `Omit<Section, 'title'>` - Section props에서 title을 뺀 leaf만 남는다.
    #[test]
    fn prop_type_omit() {
        let props = compile_props(r#"
            component C {
              props { sec: Omit<Section, 'title'> }
              template { div() {} }
            }
            component Section {
              props { title: string, desc: string, on: bool }
              template { div() {} }
            }
        "#);
        assert_eq!(props, vec!["sec.desc", "sec.on"]);
    }

    /// `Pick<Section, 'title' | 'on'>` - 나열한 키만 남는다(유니온 키).
    #[test]
    fn prop_type_pick_union() {
        let props = compile_props(r#"
            component C {
              props { sec: Pick<Section, 'title' | 'on'> }
              template { div() {} }
            }
            component Section {
              props { title: string, desc: string, on: bool }
              template { div() {} }
            }
        "#);
        assert_eq!(props, vec!["sec.title", "sec.on"]);
    }

    /// 유틸 타입이 안쪽에 없는 키를 나열하면 UnknownKey.
    #[test]
    fn prop_type_util_unknown_key_errors() {
        let err = compile_src(
            "entry",
            r#"
                component C { props { s: Omit<Section, 'nope'> } template { div() {} } }
                component Section { props { title: string } template { div() {} } }
            "#,
            &(|_: &str, _: &str| None),
        );
        assert!(matches!(
            err,
            Err(CompileError::Resolve(ResolveError::UnknownKey(k))) if k == "nope"
        ));
    }

    /// 없는 타입을 참조하면 UnknownType.
    #[test]
    fn prop_type_ref_unknown_errors() {
        let err = compile_src(
            "entry",
            r#"component C { props { x: Nope } template { div() {} } }"#,
            &(|_: &str, _: &str| None),
        );
        assert!(matches!(
            err,
            Err(CompileError::Resolve(ResolveError::UnknownType(n))) if n == "Nope"
        ));
    }

    /// 타입 참조가 순환하면 TypeCycle - 무한 전개를 막는다.
    #[test]
    fn prop_type_ref_cycle_errors() {
        let err = compile_src(
            "entry",
            r#"
                component A { props { b: B } template { div() {} } }
                component B { props { a: A } template { div() {} } }
            "#,
            &(|_: &str, _: &str| None),
        );
        assert!(matches!(
            err,
            Err(CompileError::Resolve(ResolveError::TypeCycle(_)))
        ));
    }

    #[test]
    fn props_flatten_scalars_and_objects() {
        let src = r#"
            component C {
              props {
                heading: string, dirty: bool,
                general: {
                  open: bool,
                  a: { title: string, on: bool }
                }
              }
              template { div() { {heading} } }
            }
        "#;
        assert_eq!(
            compile_props(src),
            vec![
                "heading", "dirty",
                "general.open", "general.a.title", "general.a.on",
            ],
        );
    }

    /// 객체 필드 참조의 TEXT_VAR = (root 슬롯 순번, root 안 필드까지의 store 칸 offset).
    /// props 순번 heading=0, dirty=1, general=2. general 안 general.a.on offset = open(1)+title(1)=2.
    #[test]
    fn props_index_matches_scope_index() {
        use bytecode::{decode, Op};
        let src = r#"
            component C {
              props {
                heading: string, dirty: bool,
                general: { open: bool, a: { title: string, on: bool } }
              }
              template { div() { {general.a.on} } }
            }
        "#;
        let out = compile_src("entry", src, &(|_: &str, _: &str| None)).unwrap();

        let module = decode(&out.bytecode).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
        let pos = code.iter().position(|&b| b == Op::TextVar as u8).unwrap();
        assert_eq!((code[pos + 1], code[pos + 2]), (2, 2), "TEXT_VAR = (general 슬롯 2, a.on offset 2)");
    }

    /// 객체 통째 전달(`row={a}`) - 부모 객체 prop을 자식 객체 prop에 통째로 넘긴다. 안 펼치므로
    /// 객체도 슬롯 하나라 THROUGH 하나. a 슬롯 = title(0) 뒤 순번 1.
    #[test]
    fn compiles_whole_object_arg_passes_slot_through() {
        use bytecode::{decode, Op};
        let src = r#"
            component C {
              props { title: string, a: { label: string, on: bool } }
              template { div() { Row(row={a}) {} } }
            }
            component Row {
              props { row: { label: string, on: bool } }
              template { span() { {row.label} } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // 부모 슬롯: title=0, a=1. row={a} -> THROUGH 1 하나(펼치지 않음). operand는 u8.
        let pushes: Vec<u8> = code
            .iter()
            .enumerate()
            .filter(|(_, &b)| b == Op::PushThrough as u8)
            .map(|(i, _)| code[i + 1])
            .collect();
        assert_eq!(pushes, vec![1], "객체 통째는 그 슬롯(a=1) 하나를 THROUGH");
    }

    /// 통째 전달인데 도달 타입과 자식 prop 타입 구조가 다르면(필드 이름 불일치) PropTypeMismatch.
    #[test]
    fn whole_object_arg_type_mismatch_errors() {
        let src = r#"
            component C {
              props { a: { label: string, on: bool } }
              template { div() { Row(row={a}) {} } }
            }
            component Row {
              props { row: { text: string, on: bool } }
              template { span() { {row.text} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(
                codegen::CodegenError::PropTypeMismatch { .. }
            ))
        ));
    }

    /// 통째 전달은 합성 인자 자리에서만 - 텍스트 보간(`{a}`)에 객체를 넣으면 여전히 NotLeaf.
    /// 값·반응성 자리엔 leaf만 온다는 경계가 인자 허용으로 무너지지 않아야 한다.
    #[test]
    fn object_in_text_node_still_errors() {
        let src = r#"
            component C {
              props { a: { label: string, on: bool } }
              template { div() { {a} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(codegen::CodegenError::NotLeaf(_)))
        ));
    }

    /// 스칼라 인자는 회귀 없이 그대로 - leaf 1개라 PushArg 하나(도달 타입=자식 타입=string).
    #[test]
    fn scalar_arg_still_single_pusharg() {
        use bytecode::{decode, Op};
        let src = r#"
            component C {
              props { name: string }
              template { div() { Row(label={name}) {} } }
            }
            component Row {
              props { label: string }
              template { span() { {label} } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
        let count = code.iter().filter(|&&b| b == Op::PushThrough as u8).count();
        assert_eq!(count, 1, "스칼라는 PushArg 하나");
    }

    /// 한 .qubc에서 여러 컴포넌트를 use. 셋 다 한 모듈로 평탄화돼야 한다 -
    /// decode해서 def 개수(3)와 이름(Card/Thumb/Badge), 엔트리 Card가 ID 0인지 확인.
    #[test]
    fn use_multiple_from_one_source() {
        use bytecode::decode;

        let entry = r#"
            use Thumb, Badge from "./parts.qubc"
            component Card {
              props { img: string, role: string }
              template { div() { Thumb(src={img}) {} Badge(text={role}) {} } }
            }
        "#;
        let parts = r#"
            component Thumb {
              props { src: string }
              template { img(src={src}) {} }
            }
            component Badge {
              props { text: string }
              template { span() { {text} } }
            }
        "#;
        let bytes = compile_map(entry, &[("./parts.qubc", parts)]).unwrap();
        let module = decode(&bytes).unwrap();

        // def(0..)를 순서대로 읽어 이름을 모은다 - None이 나오면 끝.
        let mut names = Vec::new();
        let mut id = 0;
        while let Some(def) = module.def(id) {
            names.push(str_at(&module, def.name_const_index).unwrap().to_string());
            id += 1;
        }
        assert_eq!(names.len(), 3, "Card+Thumb+Badge 셋 다 들어가야 함");
        assert_eq!(names[0], "Card", "엔트리가 ID 0");
        assert!(names.contains(&"Thumb".to_string()));
        assert!(names.contains(&"Badge".to_string()));
    }

    /// `use "./x.css"` - 리소스를 use한 컴포넌트는 정의 코드 앞머리에 LOAD_RES 0을 낸다.
    /// 사이드맵 resources[0]은 정규화 경로(dedup 키). resolver가 정규화 경로를 돌려준다(소스는 버려짐).
    #[test]
    fn compiles_load_res_for_used_css() {
        use bytecode::{decode, Op};

        let entry = r#"
            use "./card.css"
            component Card { template { div() {} } }
        "#;
        // 정규화 경로를 직접 매핑("./card.css" -> "/abs/card.css"). 소스는 빈 문자열(컴파일러가 안 씀).
        let resolver = |_base: &str, target: &str| match target {
            "./card.css" => Some(("/abs/card.css".to_string(), String::new())),
            _ => None,
        };
        let output = compile_src("entry", entry, &resolver).unwrap();

        // 사이드맵: resId 0 -> 정규화 경로.
        assert_eq!(output.resources, vec!["/abs/card.css".to_string()]);

        // 코드 앞머리가 LOAD_RES 0.
        let module = decode(&output.bytecode).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
        assert_eq!(code[0], Op::LoadRes as u8);
        assert_eq!(u16::from_le_bytes([code[1], code[2]]), 0);
    }

    /// 같은 파일의 두 컴포넌트는 같은 리소스를 공유 - 둘 다 LOAD_RES 0을 내고 resId는 하나(dedup).
    #[test]
    fn same_file_components_share_res_id() {
        use bytecode::{decode, Op};

        let entry = r#"
            use "./shared.css"
            component A { template { div() {} } }
            component B { template { span() {} } }
        "#;
        let resolver = |_base: &str, target: &str| match target {
            "./shared.css" => Some(("/abs/shared.css".to_string(), String::new())),
            _ => None,
        };
        let output = compile_src("entry", entry, &resolver).unwrap();

        // 리소스는 하나만(dedup).
        assert_eq!(output.resources, vec!["/abs/shared.css".to_string()]);

        // 두 컴포넌트 모두 코드 앞머리가 LOAD_RES 0.
        let module = decode(&output.bytecode).unwrap();
        for id in 0..2 {
            let def = module.def(id).unwrap();
            let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
            assert_eq!(code[0], Op::LoadRes as u8, "def {id} 앞머리 LOAD_RES");
            assert_eq!(u16::from_le_bytes([code[1], code[2]]), 0);
        }
    }

    /// 여러 파일이 각자 다른 CSS를 use하면 resId가 모듈 전역으로 0,1,2…로 매겨진다.
    /// 한 컴포넌트가 여러 CSS를 use하면 LOAD_RES를 여러 개 내고, 이미 쓰인 경로는 resId를
    /// 재사용한다(전역 dedup). entry(app)=0, A(a)=1, B(b)=2, C(app·b·c)는 0·2 재사용 + c=3.
    #[test]
    fn res_ids_are_module_global() {
        use bytecode::{decode, Op};

        let entry = r#"
            use "./app.css"
            use A from "./a.qubc"
            use B from "./b.qubc"
            use C from "./c.qubc"
            component App { template { div() { A() {} B() {} C() {} } } }
        "#;
        let a = r#"
            use "./a.css"
            component A { template { span() {} } }
        "#;
        let b = r#"
            use "./b.css"
            component B { template { p() {} } }
        "#;
        // C는 여러 CSS를 use - app·b는 이미 발급된 resId 재사용, c만 신규.
        let c = r#"
            use "./app.css"
            use "./b.css"
            use "./c.css"
            component C { template { a() {} } }
        "#;
        // .qubc는 소스를, .css는 정규화 경로 + 빈 소스를 돌려준다.
        let resolver = |_base: &str, target: &str| match target {
            "./a.qubc" => Some(("./a.qubc".to_string(), a.to_string())),
            "./b.qubc" => Some(("./b.qubc".to_string(), b.to_string())),
            "./c.qubc" => Some(("./c.qubc".to_string(), c.to_string())),
            "./app.css" => Some(("/abs/app.css".to_string(), String::new())),
            "./a.css" => Some(("/abs/a.css".to_string(), String::new())),
            "./b.css" => Some(("/abs/b.css".to_string(), String::new())),
            "./c.css" => Some(("/abs/c.css".to_string(), String::new())),
            _ => None,
        };
        let output = compile_src("entry", entry, &resolver).unwrap();

        // 사이드맵: 등장 순서대로 전역 0,1,2,3. entry(app), a, b, 그다음 C의 신규 c.
        // C의 app·b는 재사용이라 사이드맵에 새로 추가되지 않는다.
        assert_eq!(
            output.resources,
            vec![
                "/abs/app.css".to_string(),
                "/abs/a.css".to_string(),
                "/abs/b.css".to_string(),
                "/abs/c.css".to_string(),
            ]
        );

        let module = decode(&output.bytecode).unwrap();
        // 컴포넌트 ID로 이름을 확인해 매핑이 어긋나도 잡히게 한다.
        let id_of = |name: &str| {
            (0..)
                .find(|&i| module.def(i).map(|d| str_at(&module, d.name_const_index).unwrap()) == Some(name))
                .unwrap()
        };
        // 한 컴포넌트의 코드 앞머리 LOAD_RES들을 순서대로 모은다(연속한 LOAD_RES만).
        let load_res_ids = |id: u16| {
            let def = module.def(id).unwrap();
            let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
            let mut ids = Vec::new();
            let mut pc = 0;
            while pc < code.len() && code[pc] == Op::LoadRes as u8 {
                ids.push(u16::from_le_bytes([code[pc + 1], code[pc + 2]]));
                pc += 3;
            }
            ids
        };
        assert_eq!(load_res_ids(id_of("App")), vec![0], "App은 app.css=0");
        assert_eq!(load_res_ids(id_of("A")), vec![1], "A는 a.css=1");
        assert_eq!(load_res_ids(id_of("B")), vec![2], "B는 b.css=2");
        // C는 app(0)·b(2) 재사용 + c(3) 신규 - use 순서대로 셋.
        assert_eq!(load_res_ids(id_of("C")), vec![0, 2, 3], "C는 app=0·b=2 재사용 + c=3");
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

    /// 모듈의 컴포넌트 이름들을 정의 순서대로 뽑는다(테스트용).
    fn component_names(bytes: &[u8]) -> Vec<String> {
        let module = bytecode::decode(bytes).unwrap();
        let mut names = Vec::new();
        let mut id = 0;
        while let Some(def) = module.def(id) {
            names.push(str_at(&module, def.name_const_index).unwrap().to_string());
            id += 1;
        }
        names
    }

    /// 트리셰이킹: use에 나열 안 한 컴포넌트는 병합에서 빠진다.
    /// parts에 Used·Unused 둘 다 있지만 Used만 use → 산출물에 Used만.
    #[test]
    fn use_excludes_unlisted_components() {
        let entry = r#"
            use Used from "./parts.qubc"
            component Card { template { Used() {} } }
        "#;
        let parts = r#"
            component Used { template { span() {} } }
            component Unused { template { div() {} } }
        "#;
        let bytes = compile_map(entry, &[("./parts.qubc", parts)]).unwrap();
        let names = component_names(&bytes);
        assert_eq!(names, vec!["Card", "Used"], "Unused는 제외돼야 함");
    }

    /// 같은 파일을 두 곳에서 서로 다른 이름으로 use(다이아몬드) → 둘 다 들어간다(합집합).
    #[test]
    fn use_diamond_unions_wanted_names() {
        let entry = r#"
            use Left from "./left.qubc"
            use Right from "./right.qubc"
            component Card { template { Left() {} Right() {} } }
        "#;
        // Left·Right는 같은 parts에서 각각 X·Y를 use한다.
        let left = r#"
            use X from "./parts.qubc"
            component Left { template { X() {} } }
        "#;
        let right = r#"
            use Y from "./parts.qubc"
            component Right { template { Y() {} } }
        "#;
        let parts = r#"
            component X { template { span() {} } }
            component Y { template { div() {} } }
            component Z { template { p() {} } }
        "#;
        let bytes = compile_map(
            entry,
            &[
                ("./left.qubc", left),
                ("./right.qubc", right),
                ("./parts.qubc", parts),
            ],
        )
        .unwrap();
        let names = component_names(&bytes);
        assert!(names.contains(&"X".to_string()), "Left가 use한 X");
        assert!(names.contains(&"Y".to_string()), "Right가 use한 Y");
        assert!(!names.contains(&"Z".to_string()), "아무도 use 안 한 Z는 제외");
    }

    /// 합성은 RENDER 직전에 PUSH_PATH_SEGMENT를 낸다 - operand는 자식 type-name 상수풀 인덱스.
    /// 이벤트 fullname의 path 축(누가 쐈나)을 누적할 세그먼트다(alias 도입 전엔 type-name 그대로).
    #[test]
    fn composition_emits_push_path_segment_of_child_type_name() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Inner() {} } } }
            component Inner { template { span() {} } }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        // Outer(엔트리=ID 0) 코드에서 PUSH_PATH_SEGMENT를 찾는다.
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
        let seg_pos = code
            .iter()
            .position(|&b| b == Op::PushPathSegment as u8)
            .expect("합성이 PUSH_PATH_SEGMENT를 내야 한다");

        // operand는 "Inner"를 가리킨다.
        let seg_index = u16::from_le_bytes([code[seg_pos + 1], code[seg_pos + 2]]);
        assert_eq!(str_at(&module, seg_index).unwrap(), "Inner");

        // 바로 뒤에 RENDER가 온다 - 세그먼트를 소비하는 합성.
        assert_eq!(code[seg_pos + 3], Op::Render as u8);
    }

    /// 같은 자식을 두 번 합성하면 PUSH_PATH_SEGMENT가 같은 세그먼트로 두 번 나온다 -
    /// alias 없는 동일 type-name은 같은 fullname을 의도적으로 공유한다(§1.3).
    #[test]
    fn duplicate_composition_repeats_same_segment() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Inner() {} Inner() {} } } }
            component Inner { template { span() {} } }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
        let seg_indices: Vec<u16> = code
            .iter()
            .enumerate()
            .filter(|(_, &b)| b == Op::PushPathSegment as u8)
            .map(|(i, _)| u16::from_le_bytes([code[i + 1], code[i + 2]]))
            .collect();

        assert_eq!(seg_indices.len(), 2, "Inner 두 번 합성 → 세그먼트 둘");
        assert_eq!(seg_indices[0], seg_indices[1], "같은 type-name은 같은 상수풀 인덱스");
        assert_eq!(str_at(&module, seg_indices[0]).unwrap(), "Inner");
    }

    /// `Alias: Comp(...)` - alias가 있으면 세그먼트는 type-name이 아니라 alias다.
    #[test]
    fn alias_replaces_type_name_in_path_segment() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Done: Inner() {} } } }
            component Inner { template { span() {} } }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
        let seg_pos = code
            .iter()
            .position(|&b| b == Op::PushPathSegment as u8)
            .expect("합성이 PUSH_PATH_SEGMENT를 내야 한다");

        // operand는 type-name "Inner"가 아니라 alias "Done".
        let seg_index = u16::from_le_bytes([code[seg_pos + 1], code[seg_pos + 2]]);
        assert_eq!(str_at(&module, seg_index).unwrap(), "Done");
    }

    /// 같은 type-name이라도 alias가 다르면 세그먼트가 갈린다 - alias 부여는 분리의 명시적 행위(§1.3).
    #[test]
    fn distinct_aliases_split_shared_type_name() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Save: Inner() {} Cancel: Inner() {} } } }
            component Inner { template { span() {} } }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];
        let seg_indices: Vec<u16> = code
            .iter()
            .enumerate()
            .filter(|(_, &b)| b == Op::PushPathSegment as u8)
            .map(|(i, _)| u16::from_le_bytes([code[i + 1], code[i + 2]]))
            .collect();

        assert_eq!(seg_indices.len(), 2, "Inner 두 번 합성 → 세그먼트 둘");
        assert_ne!(seg_indices[0], seg_indices[1], "다른 alias는 다른 세그먼트");
        assert_eq!(str_at(&module, seg_indices[0]).unwrap(), "Save");
        assert_eq!(str_at(&module, seg_indices[1]).unwrap(), "Cancel");
    }

    /// 요소 속성은 공백 구분 - 속성 사이 콤마는 우리 문법이 아니라 ParseError로 거부한다.
    #[test]
    fn element_attrs_reject_comma_separator() {
        let src = r#"component A { template { div(class="x", id="y") {} } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Resolve(ResolveError::Parse(_)))
        ));
    }

    /// 타입 필드 구분자 콤마는 필수 - 누락하면 ParseError. (지금은 완전 optional이었다.)
    #[test]
    fn type_field_missing_comma_rejected() {
        // props에서 콤마 누락.
        let src = r#"component A { props { a: string b: number } template { div() {} } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Resolve(ResolveError::Parse(_)))
        ));
        // 중첩 object 타입에서 콤마 누락.
        let nested = r#"component B { props { o: { a: string b: number } } template { div() {} } }"#;
        assert!(matches!(
            compile(nested),
            Err(CompileError::Resolve(ResolveError::Parse(_)))
        ));
    }

    /// 마지막 필드 뒤 콤마는 생략 가능하고 trailing 콤마도 허용(TS 규칙). 둘 다 컴파일 성공.
    #[test]
    fn type_field_last_comma_optional() {
        // 마지막 생략.
        let omitted = r#"component A { props { a: string, b: number } template { div() {} } }"#;
        assert!(compile(omitted).is_ok());
        // trailing 콤마.
        let trailing = r#"component B { props { a: string, b: number, } template { div() {} } }"#;
        assert!(compile(trailing).is_ok());
        // 중첩 object에서도 동일.
        let nested = r#"component C { props { o: { a: string, b: number, } } template { div() {} } }"#;
        assert!(compile(nested).is_ok());
    }

    /// 객체 경로 보간 `{user.name}` - props를 선언 순서로 평탄하게 펼친 leaf 번호로 해석한다.
    /// 값 자리 TEXT_VAR는 (scope_index, offset) 두 u8. 슬롯 순번 title=0, user=1, done=2.
    /// 객체 필드는 root 슬롯 + 필드까지의 store 칸 offset: user.name=(1,0), user.contact.email=(1,1).
    #[test]
    fn object_path_flat_scope_index() {
        use bytecode::{decode, Op};
        let src = r#"
            component C {
              props {
                title: string,
                user: { name: string, contact: { email: string } },
                done: bool
              }
              template {
                div() { {title} {user.name} {user.contact.email} }
              }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // TEXT_VAR의 (scope_index, offset) 쌍을 순서대로 뽑아 검증한다.
        let mut vars = Vec::new();
        let mut i = 0;
        while i < code.len() {
            let op = code[i];
            if op == Op::TextVar as u8 {
                vars.push((code[i + 1], code[i + 2]));
                i += 3;
            } else if op == Op::ElemOpen as u8 {
                i += 3;
            } else {
                i += 1;
            }
        }
        // title=(0,0), user.name=(1,0), user.contact.email=(1,1)
        assert_eq!(vars, vec![(0, 0), (1, 0), (1, 1)]);
    }

    /// 값 자리(보간)에 leaf가 아닌 객체 경로가 오면 NotLeaf 에러. 객체 통째는 안 넘긴다.
    #[test]
    fn object_whole_in_value_slot_rejected() {
        let src = r#"
            component C {
              props { user: { name: string } }
              template { div() { {user} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(codegen::CodegenError::NotLeaf(_)))
        ));
    }

    /// 없는 필드 경로는 UnknownField 에러.
    #[test]
    fn unknown_object_field_rejected() {
        let src = r#"
            component C {
              props { user: { name: string } }
              template { div() { {user.age} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(codegen::CodegenError::UnknownField { .. }))
        ));
    }

    /// 원시 prop에 `.field`로 파고들면 UnknownField(객체 아닌데 접근).
    #[test]
    fn dot_into_primitive_rejected() {
        let src = r#"
            component C {
              props { title: string }
              template { div() { {title.x} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(codegen::CodegenError::UnknownField { .. }))
        ));
    }
}
