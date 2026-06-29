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

/// 컴파일 산출물. 바이트코드와 리소스 사이드맵을 함께 낸다 — 빌드 파이프라인이 사이드맵으로
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
                events: vec![],
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

    /// `@input:EVENT`이 닫힌 DOM 이벤트 집합의 input ID(1)로 BIND_EVENT를 낸다.
    /// (click 외 이벤트가 끝까지 — 렉서 -> 파서 -> codegen — 흐르는지.)
    #[test]
    fn compiles_non_click_dom_event() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              props { value }
              events { EDIT({ value }) }
              template { input(@input:EDIT) {} }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // BIND_EVENT event_type=1(input) event_idx=0 가 코드에 있어야 한다.
        let input_id = bytecode::dom_events::dom_event_id("input").unwrap();
        let mut bind = vec![Op::BindEvent as u8];
        bind.extend_from_slice(&input_id.to_le_bytes());
        bind.extend_from_slice(&0u16.to_le_bytes()); // EDIT = event_idx 0
        assert!(
            code.windows(bind.len()).any(|w| w == bind.as_slice()),
            "BIND_EVENT input(1) idx 0 가 코드에 있어야",
        );
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

    /// `use "./x.css"` — 리소스를 use한 컴포넌트는 정의 코드 앞머리에 LOAD_RES 0을 낸다.
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

    /// 같은 파일의 두 컴포넌트는 같은 리소스를 공유 — 둘 다 LOAD_RES 0을 내고 resId는 하나(dedup).
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
        // C는 여러 CSS를 use — app·b는 이미 발급된 resId 재사용, c만 신규.
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
                .find(|&i| module.def(i).map(|d| module.pool.get(d.name_idx).unwrap()) == Some(name))
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
        // C는 app(0)·b(2) 재사용 + c(3) 신규 — use 순서대로 셋.
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
            names.push(module.pool.get(def.name_idx).unwrap().to_string());
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

    /// 합성은 RENDER 직전에 PUSH_PATH_SEGMENT를 낸다 — operand는 자식 type-name 상수풀 인덱스.
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
        let seg_idx = u16::from_le_bytes([code[seg_pos + 1], code[seg_pos + 2]]);
        assert_eq!(module.pool.get(seg_idx).unwrap(), "Inner");

        // 바로 뒤에 RENDER가 온다 — 세그먼트를 소비하는 합성.
        assert_eq!(code[seg_pos + 3], Op::Render as u8);
    }

    /// 같은 자식을 두 번 합성하면 PUSH_PATH_SEGMENT가 같은 세그먼트로 두 번 나온다 —
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
        assert_eq!(module.pool.get(seg_indices[0]).unwrap(), "Inner");
    }

    /// `Alias: Comp(...)` — alias가 있으면 세그먼트는 type-name이 아니라 alias다.
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
        let seg_idx = u16::from_le_bytes([code[seg_pos + 1], code[seg_pos + 2]]);
        assert_eq!(module.pool.get(seg_idx).unwrap(), "Done");
    }

    /// 같은 type-name이라도 alias가 다르면 세그먼트가 갈린다 — alias 부여는 분리의 명시적 행위(§1.3).
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
        assert_eq!(module.pool.get(seg_indices[0]).unwrap(), "Save");
        assert_eq!(module.pool.get(seg_indices[1]).unwrap(), "Cancel");
    }

    /// 요소 속성은 공백 구분 — 속성 사이 콤마는 우리 문법이 아니라 ParseError로 거부한다.
    #[test]
    fn element_attrs_reject_comma_separator() {
        let src = r#"component A { template { div(class="x", id="y") {} } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Resolve(ResolveError::Parse(_)))
        ));
    }
}
