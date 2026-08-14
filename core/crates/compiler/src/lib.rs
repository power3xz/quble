//! Quble 컴파일러: `.qubc` 소스 -> 직렬화된 바이트코드(`Box<[u8]>`).
//! 프론트엔드(lexer/parse -> ast)와 백엔드(codegen)를 모듈로 나눠 담는다.
//! MVP 스코프: 단일 컴포넌트, 문자열 속성값, 표현식 없음. 상세는 core/BYTECODE.md.

mod ast;
mod codegen;
mod diagnostic;
mod dts;
mod flatten;
mod lexer;
mod parse;
mod scope;
mod src_range;

pub use diagnostic::{locate_utf16, Utf16Location};
pub use dts::{handler_names, handlers_dts, handlers_dts_from_path};
pub use flatten::{FlattenError, SourceLoader, TypeError, TypeErrorKind, UseError, UseErrorKind};
pub use src_range::SrcRange;

use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub enum CompileError {
    Flatten(flatten::FlattenError),
    /// codegen 에러도 어느 파일에서 났는지를 들고 온다(Sourced) - range는 에러가 난 그 파일의
    /// 바이트 오프셋이라, 엔트리 소스에 대고 세면 use한 파일의 에러가 엉뚱한 줄을 짚는다.
    Codegen(flatten::Sourced<codegen::CodegenError>),
    /// 엔트리 파일을 못 읽음. 파일을 읽는 건 여기(compile_file/handlers_dts_from_path)라
    /// flatten이 아니라 이 층의 에러다 - 소스가 없어 탓할 자리도 없다.
    EntryNotFound(String),
}

/// 컴파일 산출물. 바이트코드와 리소스 사이드맵을 함께 낸다 - 빌드 파이프라인이 사이드맵으로
/// 내용 해시/복사/URL화를 한다(BYTECODE.md #5 LOAD_RES 메모).
pub struct CompileOutput {
    pub bytecode: Box<[u8]>,
    /// 인덱스 = 모듈 전역 resId, 값 = 리소스 정규화 경로.
    pub resources: Vec<String>,
}

/// 엔트리 소스를 직렬화된 바이트코드로 컴파일. use 그래프를 loader로 따라가
/// 모든 컴포넌트를 한 모듈로 평탄화한다. entry_path는 엔트리 소스 자신의 정규화 경로로,
/// 첫 use의 base가 된다(엔트리 컴포넌트가 ID 0).
pub fn compile_src(
    entry_path: &str,
    src: &str,
    loader: &impl SourceLoader,
) -> Result<CompileOutput, CompileError> {
    let comps = flatten::flatten(entry_path, src, loader).map_err(CompileError::Flatten)?;
    let (bytecode, resources) = codegen::generate(&comps).map_err(CompileError::Codegen)?;
    Ok(CompileOutput {
        bytecode,
        resources,
    })
}

/// 컴파일 에러를 CLI에 그대로 찍을 진단 텍스트로 만든다(끝에 개행 없음).
///
/// ```text
/// card.qubc:6:14: error: no field `nope` on prop `user`
///   6 |       p() { {user.nope} }
///     |              ^^^^^^^^^
/// ```
///
/// lex/parse/codegen 에러는 어느 파일에서 났는지를 자신이 들고 있어(Sourced) 인자와 무관하게
/// 그 파일을 가리킨다. 엔트리는 위치 개념이 없는 나머지 flatten 에러(use 그래프/타입 참조)에만
/// 쓰인다. 탓할 자리를 모르는 에러(range None)는 파일명과 메시지만 낸다.
///
/// base_dir이 Some이면 파일 경로를 그 디렉터리 기준 상대경로로 줄여 낸다 - loader가 정규화한
/// 절대경로는 길어 읽기 나쁘다. CLI가 현재 디렉터리를 넘긴다. None이면 경로를 그대로 두는데,
/// wasm은 가상 경로를 써 줄일 기준이 없다.
pub fn format_error(
    base_dir: Option<&str>,
    entry_path: &str,
    entry_src: &str,
    err: &CompileError,
) -> String {
    let blamed = blame(entry_path, entry_src, err);
    let shown = base_dir
        .and_then(|dir| relative_to(dir, blamed.path))
        .unwrap_or(blamed.path);
    diagnostic::format(shown, blamed.src, blamed.range, &blamed.message)
}

/// 에러가 가리키는 파일과 그 안의 자리. `format_error`(CLI 텍스트)와 `diagnose`(에디터)가
/// 공유한다 - 어느 파일을 탓하느냐는 출력 형태와 무관하다.
struct Blamed<'a> {
    path: &'a str,
    src: &'a str,
    /// None이면 소스에 탓할 자리가 없다. 엔트리 파일을 못 읽은 경우(소스 자체가 없다)와
    /// 아직 위치를 안 붙인 flatten 에러(ISSUES.md)가 그렇다.
    range: Option<SrcRange>,
    message: String,
}

fn blame<'a>(entry_path: &'a str, entry_src: &'a str, err: &'a CompileError) -> Blamed<'a> {
    let (path, src, range) = match err {
        CompileError::Flatten(FlattenError::Lex(e)) => {
            (e.path.as_str(), e.src.as_str(), Some(e.err.range))
        }
        CompileError::Flatten(FlattenError::Parse(e)) => {
            (e.path.as_str(), e.src.as_str(), Some(e.err.range))
        }
        // use 줄 안의 자리를 안다 - 못 찾은 경로, 없는 이름, use 줄 전체(ast.rs `Use` 그림).
        CompileError::Flatten(FlattenError::Use(e)) => {
            (e.path.as_str(), e.src.as_str(), Some(e.err.range))
        }
        // prop 타입 표기 안의 자리를 안다 - 참조 이름, 키, 유틸 표기(ast.rs `Type` 그림).
        CompileError::Flatten(FlattenError::Type(e)) => {
            (e.path.as_str(), e.src.as_str(), Some(e.err.range))
        }
        // 아직 위치를 안 붙인 에러(ISSUES.md). 팔을 다 적어 두면 FlattenError에 variant를
        // 더할 때 여기가 컴파일 에러로 잡힌다 - `_`로 받으면 조용히 첫 줄로 떨어진다.
        CompileError::Flatten(FlattenError::DuplicateComponent(_)) => (entry_path, entry_src, None),
        // codegen 에러는 전부 자리를 안다(codegen.rs CodegenError).
        CompileError::Codegen(e) => (e.path.as_str(), e.src.as_str(), Some(e.err.range)),
        // 엔트리를 못 읽었으니 소스가 없다 - 인자로 온 것도 빈 문자열이다.
        CompileError::EntryNotFound(_) => (entry_path, entry_src, None),
    };
    let message = match err {
        CompileError::Flatten(e) => e.to_string(),
        CompileError::Codegen(e) => e.err.kind.to_string(),
        CompileError::EntryNotFound(path) => format!("cannot read entry file `{path}`"),
    };
    Blamed {
        path,
        src,
        range,
        message,
    }
}

/// 에디터가 밑줄을 그으려고 받는 진단. 위치는 **바이트 오프셋**(SrcRange)으로 둔다 -
/// 라인/컬럼 환산은 기준이 소비처마다 갈려(src_range.rs) 여기서 정하지 않는다.
/// `src`를 함께 내는 건 환산에 원본이 필요해서다.
pub struct Diagnostic<'a> {
    /// 에러가 난 파일. 엔트리가 아니라 `use`로 딸려 온 파일일 수 있다.
    pub path: &'a str,
    pub src: &'a str,
    pub message: String,
    /// None이면 탓할 자리를 모르는 에러(use 그래프/타입 참조 단위).
    pub range: Option<SrcRange>,
}

/// 컴파일 에러를 에디터가 쓸 진단으로 만든다. `format_error`의 구조화 판으로, 같은 자리를
/// 가리킨다 - 다른 건 사람이 읽는 텍스트로 합치느냐뿐이다.
pub fn diagnose<'a>(
    entry_path: &'a str,
    entry_src: &'a str,
    err: &'a CompileError,
) -> Diagnostic<'a> {
    let blamed = blame(entry_path, entry_src, err);
    Diagnostic {
        path: blamed.path,
        src: blamed.src,
        message: blamed.message,
        range: blamed.range,
    }
}

/// dir 아래에 있는 path를 dir 기준 상대경로로. 아래가 아니면 None(줄일 수 없으니 원본을 쓴다).
/// 문자열 접두어만 본다 - 두 경로 모두 loader가 정규화한 절대경로라 접두어 일치면 하위다.
fn relative_to<'a>(dir: &str, path: &'a str) -> Option<&'a str> {
    let dir = dir.strip_suffix('/').unwrap_or(dir);
    path.strip_prefix(dir)?.strip_prefix('/')
}

/// 파일 경로로 컴파일. 엔트리 파일을 읽고, use는 importer 파일 기준 상대경로를
/// 정규화한 절대경로로 해소한다(파일시스템 loader).
pub fn compile_file(path: &str) -> Result<CompileOutput, CompileError> {
    let not_found = || CompileError::EntryNotFound(path.to_string());
    let entry = std::fs::canonicalize(path).map_err(|_| not_found())?;
    let src = std::fs::read_to_string(&entry).map_err(|_| not_found())?;
    compile_src(&entry.to_string_lossy(), &src, &fs_loader)
}

/// 파일시스템 loader: base 파일의 디렉터리 기준으로 target을 풀어 정규화한 절대경로와 소스를 반환.
fn fs_loader(base_canonical_path: &str, target_path: &str) -> Option<(String, String)> {
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

    /// 상수풀 인덱스의 문자열 값(테스트용). 이름/속성명 등 문자열 상수 검사에 쓴다.
    /// 문자열이 아닌 엔트리(Num/Bool)면 None.
    fn str_at(module: &bytecode::Module, index: u16) -> Option<&str> {
        match module.pool.get(index) {
            Some(Const::Str(s)) => Some(s),
            _ => None,
        }
    }

    /// use 없는 단일 소스를 컴파일(테스트용). loader는 호출되지 않으므로 항상 None.
    fn compile(src: &str) -> Result<Box<[u8]>, CompileError> {
        compile_src("entry", src, &(|_: &str, _: &str| None)).map(|o| o.bytecode)
    }

    /// 경로->소스 메모리맵으로 컴파일(테스트용). 경로 정규화 없이 문자열 그대로 키.
    fn compile_map(entry_src: &str, files: &[(&str, &str)]) -> Result<Box<[u8]>, CompileError> {
        let files: Vec<(String, String)> = files
            .iter()
            .map(|(p, s)| (p.to_string(), s.to_string()))
            .collect();
        let loader = |_base: &str, target: &str| {
            files
                .iter()
                .find(|(p, _)| p == target)
                .map(|(p, s)| (p.clone(), s.clone()))
        };
        compile_src("entry", entry_src, &loader).map(|o| o.bytecode)
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
        let lexed = lexer::lex(HELLO).unwrap();
        let source = parse::parse(&lexed, HELLO.len()).unwrap();
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
                assert_eq!(tag.name, "div");
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
        let lexed = lexer::lex("assignee.name").unwrap();
        assert_eq!(
            lexed.tokens,
            vec![
                Token::Ident("assignee".to_string()),
                Token::Dot,
                Token::Ident("name".to_string()),
            ]
        );
    }

    /// `@if (COND)`의 조건식만 파싱해 꺼낸다 - 우선순위/결합이 어떻게 묶였는지 보려는 것.
    fn if_cond(cond: &str) -> ast::Expr {
        let src = format!("component C {{ template {{ @if ({cond}) {{ p( /) }} }} }}");
        let lexed = lexer::lex(&src).unwrap();
        let mut source = parse::parse(&lexed, src.len()).unwrap();
        match source.comps.remove(0).template.remove(0) {
            Node::If { cond, .. } => cond,
            other => panic!("@if를 기대했다: {other:?}"),
        }
    }

    /// 식의 묶인 모양을 괄호 표기로 편다 - `(a - b) - c`처럼 눈으로 결합을 확인한다.
    fn shape(e: &ast::Expr) -> String {
        use ast::Expr;
        match e {
            Expr::Var(v, _) => {
                if v.path.is_empty() {
                    v.root.clone()
                } else {
                    format!("{}.{}", v.root, v.path.join("."))
                }
            }
            Expr::Length(v, _) => format!("{}.length", v.root),
            Expr::Lit(ast::LitValue::Number(n), _) => format!("{n}"),
            Expr::Lit(ast::LitValue::Bool(b), _) => format!("{b}"),
            Expr::Lit(ast::LitValue::Str(s), _) => format!("\"{s}\""),
            Expr::Unary(op, x, _) => format!("({}{})", unary_sym(op), shape(x)),
            Expr::Binary(op, l, r, _) => {
                format!("({} {} {})", shape(l), binary_sym(op), shape(r))
            }
        }
    }

    fn unary_sym(op: &ast::UnaryOp) -> &'static str {
        match op {
            ast::UnaryOp::Not => "!",
            ast::UnaryOp::Neg => "-",
        }
    }

    fn binary_sym(op: &ast::BinaryOp) -> &'static str {
        use ast::BinaryOp as B;
        match op {
            B::Add => "+",
            B::Sub => "-",
            B::Mul => "*",
            B::Div => "/",
            B::Rem => "%",
            B::Eq => "==",
            B::Ne => "!=",
            B::Lt => "<",
            B::Le => "<=",
            B::Gt => ">",
            B::Ge => ">=",
            B::And => "&&",
            B::Or => "||",
        }
    }

    #[test]
    fn parse_expr_single_ref_stays_leaf() {
        // 연산자가 없는 식은 잎 하나 그대로 - codegen이 이걸 기존 슬롯 인코딩으로 낮춘다.
        assert_eq!(shape(&if_cond("done")), "done");
        assert_eq!(shape(&if_cond("gen.open")), "gen.open");
    }

    #[test]
    fn parse_expr_precedence_follows_js() {
        // 곱셈이 덧셈보다 먼저 묶인다.
        assert_eq!(shape(&if_cond("a + b * c")), "(a + (b * c))");
        // 비교가 산술보다 나중에 묶인다.
        assert_eq!(shape(&if_cond("a + b > c")), "((a + b) > c)");
        // &&가 ||보다 먼저 묶인다.
        assert_eq!(shape(&if_cond("a || b && c")), "(a || (b && c))");
        // 비교가 &&보다 먼저 묶인다.
        assert_eq!(shape(&if_cond("a > 0 && b")), "((a > 0) && b)");
        // == 는 비교보다 나중에 묶인다.
        assert_eq!(shape(&if_cond("a < b == c")), "((a < b) == c)");
    }

    #[test]
    fn parse_expr_binary_is_left_associative() {
        // 같은 우선순위는 왼쪽부터 - `a - b - c`가 `(a-b)-c`여야 10-3-2=5가 된다.
        assert_eq!(shape(&if_cond("a - b - c")), "((a - b) - c)");
        assert_eq!(shape(&if_cond("a / b / c")), "((a / b) / c)");
        assert_eq!(shape(&if_cond("a && b && c")), "((a && b) && c)");
    }

    #[test]
    fn parse_expr_unary_is_right_associative() {
        // 단항은 안쪽부터 - 바깥 !가 안쪽 !의 결과를 받는다.
        assert_eq!(shape(&if_cond("!!done")), "(!(!done))");
        // 단항이 이항보다 먼저 묶인다.
        assert_eq!(shape(&if_cond("!a && b")), "((!a) && b)");
        assert_eq!(shape(&if_cond("-a + b")), "((-a) + b)");
    }

    #[test]
    fn parse_expr_paren_overrides_precedence() {
        // 괄호 안은 우선순위가 초기화되고 그 결과가 피연산자 하나처럼 묶인다.
        // 괄호 자체는 AST에 안 남는다 - 묶는 순서를 바꿀 뿐이라 노드가 필요 없다.
        assert_eq!(shape(&if_cond("(a + b) * c")), "((a + b) * c)");
        assert_eq!(shape(&if_cond("!(a && b)")), "(!(a && b))");
    }

    #[test]
    fn parse_expr_literals_and_length() {
        assert_eq!(shape(&if_cond("count > 0")), "(count > 0)");
        assert_eq!(shape(&if_cond("name == \"a\"")), "(name == \"a\")");
        assert_eq!(shape(&if_cond("done == true")), "(done == true)");
        // `.length`는 배열 길이 - 대상이 배열이어야 한다(타입은 codegen이 본다).
        assert_eq!(shape(&if_cond("tags.length > 0")), "(tags.length > 0)");
    }

    #[test]
    fn parse_expr_division_in_condition_is_not_self_close() {
        // `/`는 self-close와 같은 토큰이지만 조건 자리에선 나눗셈이다 - 파서가 자리로 가른다.
        assert_eq!(shape(&if_cond("a / b > 1")), "((a / b) > 1)");
    }

    #[test]
    fn lex_operators() {
        use lexer::Token;
        // 산술/비교/논리 연산자가 각각 한 토큰으로 나온다.
        let lexed = lexer::lex("+ - * % == != < <= > >= && || !").unwrap();
        assert_eq!(
            lexed.tokens,
            vec![
                Token::Plus,
                Token::Minus,
                Token::Star,
                Token::Percent,
                Token::EqEq,
                Token::BangEq,
                Token::Lt,
                Token::Le,
                Token::Gt,
                Token::Ge,
                Token::AmpAmp,
                Token::PipePipe,
                Token::Bang,
            ]
        );
    }

    #[test]
    fn lex_longest_match_wins_over_prefix() {
        use lexer::Token;
        // 두 글자 연산자가 한 글자 짝보다 먼저 잡힌다 - `==`가 `=` 둘로 쪼개지지 않는다.
        // `<`/`>`는 제네릭 타입에도 쓰여(Omit<T, 'a'>) 한 글자로 남아야 한다.
        let lexed = lexer::lex("== = <= < >= > && | || !=").unwrap();
        assert_eq!(
            lexed.tokens,
            vec![
                Token::EqEq,
                Token::Eq,
                Token::Le,
                Token::Lt,
                Token::Ge,
                Token::Gt,
                Token::AmpAmp,
                Token::Pipe,
                Token::PipePipe,
                Token::BangEq,
            ]
        );
    }

    #[test]
    fn lex_slot_fill_still_beats_less_than() {
        use lexer::Token;
        // `<<`(슬롯 채움)는 `<=`/`<`보다 먼저 잡힌다 - 비교 연산자가 끼어들지 않는다.
        let lexed = lexer::lex("Header << h1").unwrap();
        assert_eq!(
            lexed.tokens,
            vec![
                Token::Ident("Header".to_string()),
                Token::LtLt,
                Token::Ident("h1".to_string()),
            ]
        );
    }

    #[test]
    fn lex_division_is_slash_token() {
        use lexer::Token;
        // 나눗셈과 self-close가 같은 `/` 토큰이다 - 렉서는 문맥을 모르고, 파서가 자리로 가른다.
        // Slash가 실은 앞 공백 여부를 싣는다(self-close 검증용).
        let lexed = lexer::lex("a / b").unwrap();
        assert_eq!(
            lexed.tokens,
            vec![
                Token::Ident("a".to_string()),
                Token::Slash(true),
                Token::Ident("b".to_string()),
            ]
        );
    }

    #[test]
    fn lex_number_dot_is_decimal_not_dot() {
        use lexer::Token;
        // 숫자 안의 `.`은 소수점으로 먹어 Dot 토큰이 생기지 않는다(숫자 분기가 먼저 소비).
        let lexed = lexer::lex("3.14").unwrap();
        assert_eq!(lexed.tokens, vec![Token::Num("3.14".to_string())]);
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
        // "class"는 전역 속성명 -> 컴포넌트 상수풀이 아니라 전역 ID로 참조.
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
            // props 없는 컴포넌트라도 props를 빈 객체 타입으로 intern한다(엔트리 #0).
            vec![bytecode::TypeEntry::Object(vec![])],
            vec![CompDef {
                name_const_index: hello,
                props_type_ref: 0,
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

    /// `class={c}`는 전역 name + 변수값 -> AttrGVar(name=전역 ID, value=scope index),
    /// `data-x={d}`는 로컬 name + 변수값 -> AttrLVar(name=상수풀 인덱스, value=scope index).
    #[test]
    fn compiles_attr_var_opcodes() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              props { c: string, d: string }
              template { div(class={c} data-x={d} /) }
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
        let src = r#"component C { template { svg( /) } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::UnknownTag(_),
                    ..
                },
                ..
            }))
        ));
    }

    /// self-close(`tag(attrs /)`)는 자식 없는 요소를 낸다 - void 요소가 자식 없이
    /// ELEM_OPEN..ELEM_CLOSE_OPEN..ELEM_END로 닫히는지(사이에 자식 opcode 없음).
    #[test]
    fn self_close_emits_childless_element() {
        use bytecode::{decode, Op};

        let src = r#"component C { template { img(src="a.png" /) } }"#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // CLOSE_OPEN 바로 뒤가 END여야 한다(그 사이에 자식 opcode가 없음 = 자식 없는 요소).
        let close = code
            .iter()
            .position(|&b| b == Op::ElemCloseOpen as u8)
            .unwrap();
        assert_eq!(
            code[close + 1],
            Op::ElemEnd as u8,
            "self-close는 CLOSE_OPEN 직후 END여야(자식 없음)",
        );
    }

    /// void 요소(img/input 등)는 self-close가 필수 - 자식 블록을 쓰면 파스 에러.
    #[test]
    fn void_element_with_child_block_errors() {
        let src = r#"component C { template { img(src="a.png") {} } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
    }

    /// `/` 앞 공백 강제 - 붙여 쓰면(`img(.../)`) 파스 에러(SYNTAX #3.1.1).
    #[test]
    fn self_close_requires_space_before_slash() {
        let src = r#"component C { template { img(src="a.png"/) } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
    }

    /// void가 아닌 일반 태그도 자식이 없으면 self-close로 쓸 수 있다(`div(class="x" /)`).
    #[test]
    fn non_void_tag_may_self_close() {
        let src = r#"component C { template { div(class="x" /) } }"#;
        assert!(compile(src).is_ok());
    }

    /// 자식 없으면 self-close 필수 - 빈 블록(`div( /)`)은 에러(요소).
    #[test]
    fn empty_element_block_errors() {
        let src = r#"component C { template { div() {} } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
    }

    /// 컴포넌트 합성도 자식 없으면 self-close 필수 - 빈 블록(`Comp() {}`)은 에러.
    #[test]
    fn empty_component_block_errors() {
        let src = r#"
            component C { template { Inner() {} } }
            component Inner { template { span() { "x" } } }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
    }

    /// 컴포넌트 합성 self-close(`Comp( /)`)는 정상 컴파일된다.
    #[test]
    fn component_self_close_ok() {
        let src = r#"
            component C { template { Inner( /) } }
            component Inner { template { span() { "x" } } }
        "#;
        assert!(compile(src).is_ok());
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
              template { input(@input:EDIT /) }
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
        assert_eq!(
            str_at(&module, area.fields[0].name_const_index),
            Some("section")
        );
        match area.fields[0].value {
            FieldValue::Const(actions_index) => {
                assert_eq!(str_at(&module, actions_index), Some("actions"));
            }
            other => panic!("section은 리터럴 스칼라라 Const ref여야: {other:?}"),
        }
        // userId: assignee -> 스칼라 field, ref가 Scope(assignee 슬롯 0, offset 0).
        assert_eq!(
            str_at(&module, area.fields[1].name_const_index),
            Some("userId")
        );
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
            code.windows(text_var.len())
                .any(|w| w == text_var.as_slice()),
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
                  Card(title={tag} /)
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
            code.windows(push_arg.len())
                .any(|w| w == push_arg.as_slice()),
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
                  Card(tag={tag} /)
                }
              }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::UnknownArg { .. },
                    ..
                },
                ..
            }))
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
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::DuplicateBinding(_),
                    ..
                },
                ..
            }))
        ));
    }

    /// `@for (tag, i of tags)` 인덱스변수. item(tag) 슬롯 뒤에 index(i) 슬롯이 항상 이어진다(모든 @for
    /// 2칸). props(tags:0) + item(tag:1) + index(i:2)라 {i}는 TextVar 2, {tag}는 TextVar 1.
    #[test]
    fn compiles_for_index_var() {
        use bytecode::{decode, Op};

        let src = r#"
            component C {
              props { tags: string[] }
              template {
                @for (tag, i of tags) {
                  p() { {i} {tag} }
                }
              }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let def = module.def(0).unwrap();
        let code = &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize];

        // {tag}=요소 슬롯 1(offset 0), {i}=인덱스 슬롯 2(요소 뒤, offset 0).
        for (name, scope) in [("tag", 1u8), ("i", 2u8)] {
            let text_var = vec![Op::TextVar as u8, scope, 0];
            assert!(
                code.windows(text_var.len())
                    .any(|w| w == text_var.as_slice()),
                "TextVar({name} scope={scope} offset=0)이 있어야:\n{code:?}",
            );
        }
    }

    /// 인덱스변수 이름이 회차변수(item)와 같으면 에러 - 같은 이름이 두 슬롯을 가질 수 없다(섀도잉 금지).
    #[test]
    fn for_index_var_same_as_item_is_error() {
        let src = r#"
            component C {
              props { tags: string[] }
              template {
                @for (tag, tag of tags) {
                  p() { {tag} }
                }
              }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::DuplicateBinding(_),
                    ..
                },
                ..
            }))
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
            component List { template { @for (item of 3) { Row: Inner( /) } } }
            component Inner {
              events { PICK({ id: "x" }) }
              template { button(@click:PICK /) }
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
                @for (a of 3) { @for (b of 3) { Row: Inner( /) } }
              }
            }
            component Inner {
              events { PICK({ id: "x" }) }
              template { button(@click:PICK /) }
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
              template { @for (item of 3) { li(@click:SELECT /) } }
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
            component List { template { Row: Inner( /) } }
            component Inner {
              events { PICK({ id: "x" }) }
              template { button(@click:PICK /) }
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
              template { @for (x of 70000) { div( /) } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
    }

    /// `of` 없이 쓰면 파싱 에러.
    #[test]
    fn for_missing_of_rejected() {
        let src = r#"
            component C {
              template { @for (x 3) { div( /) } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
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
              template { @with Area { div( /) } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();
        let area = &module.def(0).unwrap().contexts[0];
        // 단축형 tier -> 필드명 "tier", 값은 tier prop(scope 0, offset 0). 스칼라.
        assert_eq!(
            str_at(&module, area.fields[0].name_const_index),
            Some("tier")
        );
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
        assert_eq!(
            str_at(&module, event.fields[0].name_const_index),
            Some("count")
        );
        assert_eq!(event.fields[0].value, FieldValue::Scope(0, 0));
        assert_eq!(
            str_at(&module, event.fields[1].name_const_index),
            Some("label")
        );
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
                assert!(matches!(
                    module.types[fields[0].1 as usize],
                    TypeEntry::Scalar
                ));
                assert!(matches!(
                    module.types[fields[1].1 as usize],
                    TypeEntry::Scalar
                ));
            }
            other => panic!("user는 객체라 Object여야: {other:?}"),
        }
    }

    /// 같은 구조의 두 객체를 각각 payload에 담으면 타입 테이블에서 한 엔트리로 dedup된다
    /// (필드명/순서/자식 타입이 모두 같으면 같은 type_ref).
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
        assert!(matches!(
            module.types[fields[0].type_ref as usize],
            TypeEntry::Scalar
        ));
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
              template { div( /) }
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
              template { @with Area { div( /) } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::Scope(scope::ScopeErrorKind::UnknownProp(_)),
                    ..
                },
                ..
            }))
        ));
    }

    /// 닫힌 집합 밖 디렉티브(`@hover`)는 렉서가 그 자리에서 거부한다(확정적 검증).
    #[test]
    fn unknown_dom_event_directive_errors() {
        let src = r#"
            component C {
              events { X({ a }) }
              template { div(@hover:X /) }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Lex(_)))
        ));
    }

    #[test]
    fn missing_brace_errors() {
        let src = r#"component C { template { div() { } "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
    }

    /// expand가 푼 루트 props를 leaf 경로로 펼쳐(객체는 필드까지, 배열은 요소 타입) 유틸
    /// 타입(Ref/Omit/Pick) 해소/선언 순서/객체 재귀 순서를 검증한다. 펼침은 이 검증만의 관찰
    /// 창이라 테스트 지역에 둔다(런타임은 타입 테이블로 심어 이 leaf 경로를 안 쓴다).
    fn compile_props(src: &str) -> Vec<String> {
        let comps = flatten::flatten("entry", src, &(|_: &str, _: &str| None)).unwrap();
        fn push_leaf_paths(prefix: &str, ty: &ast::Type, out: &mut Vec<String>) {
            match ty {
                ast::Type::Bool | ast::Type::Number | ast::Type::String => {
                    out.push(prefix.to_string())
                }
                ast::Type::Array(inner) => push_leaf_paths(prefix, inner, out),
                ast::Type::Object(fields) => {
                    for (name, field_ty) in fields {
                        push_leaf_paths(&format!("{prefix}.{name}"), field_ty, out);
                    }
                }
                ast::Type::Ref(n) => unreachable!("expand가 Type::Ref({})를 안 풀었다", n.name),
                ast::Type::Omit(..) | ast::Type::Pick(..) => {
                    unreachable!("expand가 유틸 타입을 안 풀었다")
                }
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
        let ref_props = compile_props(
            r#"
            component C {
              props { heading: string, sec: Section }
              template { div() { {heading} } }
            }
            component Section {
              props { title: string, on: bool }
              template { div( /) }
            }
        "#,
        );
        let inline_props = compile_props(
            r#"
            component C {
              props { heading: string, sec: { title: string, on: bool } }
              template { div() { {heading} } }
            }
        "#,
        );
        assert_eq!(ref_props, inline_props);
        assert_eq!(ref_props, vec!["heading", "sec.title", "sec.on"]);
    }

    /// `Omit<Section, 'title'>` - Section props에서 title을 뺀 leaf만 남는다.
    #[test]
    fn prop_type_omit() {
        let props = compile_props(
            r#"
            component C {
              props { sec: Omit<Section, 'title'> }
              template { div( /) }
            }
            component Section {
              props { title: string, desc: string, on: bool }
              template { div( /) }
            }
        "#,
        );
        assert_eq!(props, vec!["sec.desc", "sec.on"]);
    }

    /// `Pick<Section, 'title' | 'on'>` - 나열한 키만 남는다(유니온 키).
    #[test]
    fn prop_type_pick_union() {
        let props = compile_props(
            r#"
            component C {
              props { sec: Pick<Section, 'title' | 'on'> }
              template { div( /) }
            }
            component Section {
              props { title: string, desc: string, on: bool }
              template { div( /) }
            }
        "#,
        );
        assert_eq!(props, vec!["sec.title", "sec.on"]);
    }

    /// 유틸 타입이 안쪽에 없는 키를 나열하면 UnknownKey.
    #[test]
    fn prop_type_util_unknown_key_errors() {
        let err = compile_src(
            "entry",
            r#"
                component C { props { s: Omit<Section, 'nope'> } template { div( /) } }
                component Section { props { title: string } template { div( /) } }
            "#,
            &(|_: &str, _: &str| None),
        );
        let err = err.map(|_| ()).expect_err("실패해야 한다");
        assert!(matches!(
            err,
            CompileError::Flatten(FlattenError::Type(ref e))
                if matches!(&e.err.kind, TypeErrorKind::UnknownKey(k) if k == "nope")
        ));
        // 탓할 자리는 그 키다 - 표기 전체가 아니라.
        assert_eq!(type_error_span(&err), "'nope'");
    }

    /// 유틸 타입의 안쪽이 객체가 아니면 NonObjectUtil - 표기 전체를 탓한다.
    #[test]
    fn prop_type_util_on_non_object_errors() {
        let err = compile_src(
            "entry",
            r#"component C { props { s: Omit<string, 'nope'> } template { div( /) } }"#,
            &(|_: &str, _: &str| None),
        )
        .map(|_| ())
        .expect_err("실패해야 한다");
        assert!(matches!(
            err,
            CompileError::Flatten(FlattenError::Type(ref e))
                if e.err.kind == TypeErrorKind::NonObjectUtil
        ));
        // 안쪽(string)만이 아니라 표기 전체 - 성립하지 않는 건 조합이다.
        assert_eq!(type_error_span(&err), "Omit<string, 'nope'>");
    }

    /// 없는 타입을 참조하면 UnknownType - 그 이름을 탓한다.
    #[test]
    fn prop_type_ref_unknown_errors() {
        let err = compile_src(
            "entry",
            r#"component C { props { x: Nope } template { div( /) } }"#,
            &(|_: &str, _: &str| None),
        )
        .map(|_| ())
        .expect_err("실패해야 한다");
        assert!(matches!(
            err,
            CompileError::Flatten(FlattenError::Type(ref e))
                if matches!(&e.err.kind, TypeErrorKind::UnknownType(n) if n == "Nope")
        ));
        assert_eq!(type_error_span(&err), "Nope");
    }

    /// 타입 참조가 순환하면 TypeCycle - 무한 전개를 막는다. 고리를 닫은 참조를 탓한다.
    #[test]
    fn prop_type_ref_cycle_errors() {
        let entry = r#"component A { props { b: B } template { div( /) } }
component B { props { a: A } template { div( /) } }"#;
        let err = compile_src("entry", entry, &(|_: &str, _: &str| None))
            .map(|_| ())
            .expect_err("실패해야 한다");
        assert!(matches!(
            err,
            CompileError::Flatten(FlattenError::Type(ref e))
                if matches!(e.err.kind, TypeErrorKind::TypeCycle(_))
        ));
        // A(b: B) -> B(a: A) -> A로 돌아와 b: B를 다시 만나 닫힌다 - 그 B를 짚는다.
        assert_eq!(type_error_span(&err), "B");
        assert_eq!(
            type_error_range(&err).start as usize,
            entry.find("b: B").expect("A의 b: B") + "b: ".len()
        );
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
                "heading",
                "dirty",
                "general.open",
                "general.a.title",
                "general.a.on",
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
        assert_eq!(
            (code[pos + 1], code[pos + 2]),
            (2, 2),
            "TEXT_VAR = (general 슬롯 2, a.on offset 2)"
        );
    }

    /// 객체 통째 전달(`row={a}`) - 부모 객체 prop을 자식 객체 prop에 통째로 넘긴다. 안 펼치므로
    /// 객체도 슬롯 하나라 THROUGH 하나. a 슬롯 = title(0) 뒤 순번 1.
    #[test]
    fn compiles_whole_object_arg_passes_slot_through() {
        use bytecode::{decode, Op};
        let src = r#"
            component C {
              props { title: string, a: { label: string, on: bool } }
              template { div() { Row(row={a} /) } }
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
              template { div() { Row(row={a} /) } }
            }
            component Row {
              props { row: { text: string, on: bool } }
              template { span() { {row.text} } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::PropTypeMismatch { .. },
                    ..
                },
                ..
            }))
        ));
    }

    /// 통째 전달은 합성 인자 자리에서만 - 텍스트 보간(`{a}`)에 객체를 넣으면 여전히 NotLeaf.
    /// 값/반응성 자리엔 leaf만 온다는 경계가 인자 허용으로 무너지지 않아야 한다.
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
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::Scope(scope::ScopeErrorKind::NotLeaf(_)),
                    ..
                },
                ..
            }))
        ));
    }

    /// 스칼라 인자는 회귀 없이 그대로 - leaf 1개라 PushArg 하나(도달 타입=자식 타입=string).
    #[test]
    fn scalar_arg_still_single_pusharg() {
        use bytecode::{decode, Op};
        let src = r#"
            component C {
              props { name: string }
              template { div() { Row(label={name} /) } }
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
              template { div() { Thumb(src={img} /) Badge(text={role} /) } }
            }
        "#;
        let parts = r#"
            component Thumb {
              props { src: string }
              template { img(src={src} /) }
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
    /// 사이드맵 resources[0]은 정규화 경로(dedup 키). loader가 정규화 경로를 돌려준다(소스는 버려짐).
    #[test]
    fn compiles_load_res_for_used_css() {
        use bytecode::{decode, Op};

        let entry = r#"
            use "./card.css"
            component Card { template { div( /) } }
        "#;
        // 정규화 경로를 직접 매핑("./card.css" -> "/abs/card.css"). 소스는 빈 문자열(컴파일러가 안 씀).
        let loader = |_base: &str, target: &str| match target {
            "./card.css" => Some(("/abs/card.css".to_string(), String::new())),
            _ => None,
        };
        let output = compile_src("entry", entry, &loader).unwrap();

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
            component A { template { div( /) } }
            component B { template { span( /) } }
        "#;
        let loader = |_base: &str, target: &str| match target {
            "./shared.css" => Some(("/abs/shared.css".to_string(), String::new())),
            _ => None,
        };
        let output = compile_src("entry", entry, &loader).unwrap();

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

    /// 여러 파일이 각자 다른 CSS를 use하면 resId가 모듈 전역으로 0,1,2...로 매겨진다.
    /// 한 컴포넌트가 여러 CSS를 use하면 LOAD_RES를 여러 개 내고, 이미 쓰인 경로는 resId를
    /// 재사용한다(전역 dedup). entry(app)=0, A(a)=1, B(b)=2, C(app/b/c)는 0/2 재사용 + c=3.
    #[test]
    fn res_ids_are_module_global() {
        use bytecode::{decode, Op};

        let entry = r#"
            use "./app.css"
            use A from "./a.qubc"
            use B from "./b.qubc"
            use C from "./c.qubc"
            component App { template { div() { A( /) B( /) C( /) } } }
        "#;
        let a = r#"
            use "./a.css"
            component A { template { span( /) } }
        "#;
        let b = r#"
            use "./b.css"
            component B { template { p( /) } }
        "#;
        // C는 여러 CSS를 use - app/b는 이미 발급된 resId 재사용, c만 신규.
        let c = r#"
            use "./app.css"
            use "./b.css"
            use "./c.css"
            component C { template { a( /) } }
        "#;
        // .qubc는 소스를, .css는 정규화 경로 + 빈 소스를 돌려준다.
        let loader = |_base: &str, target: &str| match target {
            "./a.qubc" => Some(("./a.qubc".to_string(), a.to_string())),
            "./b.qubc" => Some(("./b.qubc".to_string(), b.to_string())),
            "./c.qubc" => Some(("./c.qubc".to_string(), c.to_string())),
            "./app.css" => Some(("/abs/app.css".to_string(), String::new())),
            "./a.css" => Some(("/abs/a.css".to_string(), String::new())),
            "./b.css" => Some(("/abs/b.css".to_string(), String::new())),
            "./c.css" => Some(("/abs/c.css".to_string(), String::new())),
            _ => None,
        };
        let output = compile_src("entry", entry, &loader).unwrap();

        // 사이드맵: 등장 순서대로 전역 0,1,2,3. entry(app), a, b, 그다음 C의 신규 c.
        // C의 app/b는 재사용이라 사이드맵에 새로 추가되지 않는다.
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
                .find(|&i| {
                    module
                        .def(i)
                        .map(|d| str_at(&module, d.name_const_index).unwrap())
                        == Some(name)
                })
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
        // C는 app(0)/b(2) 재사용 + c(3) 신규 - use 순서대로 셋.
        assert_eq!(
            load_res_ids(id_of("C")),
            vec![0, 2, 3],
            "C는 app=0/b=2 재사용 + c=3"
        );
    }

    /// use 에러가 밑줄 칠 구간(테스트용). use 에러가 아니면 패닉.
    fn use_error_range(err: &CompileError) -> SrcRange {
        match err {
            CompileError::Flatten(FlattenError::Use(e)) => e.err.range,
            _ => panic!("use 에러여야 한다"),
        }
    }

    /// 그 구간의 소스 텍스트. 소스는 에러가 들고 온 것을 쓴다 - 탓하는 파일이 엔트리가
    /// 아닐 수 있어(use한 쪽) 엔트리에 대고 자르면 엉뚱한 데를 짚는다.
    fn use_error_span(err: &CompileError) -> &str {
        match err {
            CompileError::Flatten(FlattenError::Use(e)) => {
                &e.src[e.err.range.start as usize..e.err.range.end as usize]
            }
            _ => panic!("use 에러여야 한다"),
        }
    }

    /// prop 타입 에러가 밑줄 칠 구간(테스트용). 타입 에러가 아니면 패닉.
    fn type_error_range(err: &CompileError) -> SrcRange {
        match err {
            CompileError::Flatten(FlattenError::Type(e)) => e.err.range,
            _ => panic!("타입 에러여야 한다"),
        }
    }

    fn type_error_span(err: &CompileError) -> &str {
        match err {
            CompileError::Flatten(FlattenError::Type(e)) => {
                &e.src[e.err.range.start as usize..e.err.range.end as usize]
            }
            _ => panic!("타입 에러여야 한다"),
        }
    }

    /// loader가 경로를 못 찾으면 NotFound - 탓할 자리는 그 경로다.
    #[test]
    fn use_missing_path_errors() {
        let entry = r#"
            use Label from "./missing.qubc"
            component Card { template { Label( /) } }
        "#;
        let err = compile_map(entry, &[]).expect_err("실패해야 한다");
        assert!(matches!(
            err,
            CompileError::Flatten(FlattenError::Use(ref e))
                if matches!(e.err.kind, UseErrorKind::NotFound { .. })
        ));
        assert_eq!(use_error_span(&err), r#""./missing.qubc""#);
    }

    /// 리소스(css)를 못 찾아도 그 경로를 짚는다 - 컴포넌트 import와 같은 자리 규칙.
    #[test]
    fn missing_resource_blames_the_path() {
        let entry = r#"
            use "./gone.css"
            component Card { template { div( /) } }
        "#;
        let err = compile_map(entry, &[]).expect_err("실패해야 한다");
        assert_eq!(use_error_span(&err), r#""./gone.css""#);
    }

    /// use 한 이름이 대상 소스에 없으면 MissingExport. 에러는 대상 파일을 판 뒤 나지만
    /// 탓할 자리는 use한 쪽의 그 이름이다 - 이름이 여럿이면 없는 그것만 짚는다.
    #[test]
    fn use_missing_export_errors() {
        let entry = r#"
            use Label, Nope from "./parts.qubc"
            component Card { template { Label( /) } }
        "#;
        let parts = r#"component Label { template { span( /) } }"#;
        let err = compile_map(entry, &[("./parts.qubc", parts)]).expect_err("실패해야 한다");
        assert!(matches!(
            err,
            CompileError::Flatten(FlattenError::Use(ref e))
                if matches!(e.err.kind, UseErrorKind::MissingExport { .. })
        ));
        assert_eq!(use_error_span(&err), "Nope");
    }

    /// 서로 다른 소스에 같은 이름의 컴포넌트가 있으면 DuplicateComponent.
    #[test]
    fn use_duplicate_component_errors() {
        let entry = r#"
            use Card from "./other.qubc"
            component Card { template { div( /) } }
        "#;
        let other = r#"component Card { template { span( /) } }"#;
        let err = compile_map(entry, &[("./other.qubc", other)]).expect_err("실패해야 한다");
        assert!(matches!(
            err,
            CompileError::Flatten(FlattenError::Use(ref e))
                if matches!(e.err.kind, UseErrorKind::DuplicateComponent(_))
        ));
        // 탓할 자리는 그 이름을 끌어온 use다 - 이 파일의 component 선언이 아니라.
        // 둘 다 "Card"라 슬라이스로는 안 갈린다 - 시작 오프셋으로 못박는다.
        assert_eq!(use_error_span(&err), "Card");
        assert_eq!(
            use_error_range(&err).start as usize,
            entry.find("Card").expect("use의 Card가 먼저 나온다")
        );
    }

    /// use 그래프에 순환이 있으면 Cycle. entry -> a -> entry.
    #[test]
    fn use_cycle_errors() {
        let entry = r#"
            use A from "./a.qubc"
            component Entry { template { A( /) } }
        "#;
        // a가 다시 entry를 use. loader는 "entry"(엔트리 path)도 매핑한다.
        let a = r#"
            use Entry from "./entry.qubc"
            component A { template { Entry( /) } }
        "#;
        let loader = move |_base: &str, target: &str| match target {
            "./a.qubc" => Some(("./a.qubc".to_string(), a.to_string())),
            "./entry.qubc" => Some(("entry".to_string(), String::new())),
            _ => None,
        };
        // CompileOutput은 Debug가 없어 expect_err에 못 쓴다 - 성공분은 버린다.
        let err = compile_src("entry", entry, &loader)
            .map(|_| ())
            .expect_err("실패해야 한다");
        assert!(matches!(
            err,
            CompileError::Flatten(FlattenError::Use(ref e))
                if matches!(e.err.kind, UseErrorKind::Cycle(_))
        ));
        // 순환은 이 use 자체가 원인이라 줄 전체를 짚는다 - 경로만이 아니라. 탓하는 곳은
        // 고리를 닫은 use(a.qubc가 entry를 도로 부르는 자리)지 엔트리의 use가 아니다.
        assert_eq!(use_error_span(&err), r#"use Entry from "./entry.qubc""#);
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
    /// parts에 Used/Unused 둘 다 있지만 Used만 use -> 산출물에 Used만.
    #[test]
    fn use_excludes_unlisted_components() {
        let entry = r#"
            use Used from "./parts.qubc"
            component Card { template { Used( /) } }
        "#;
        let parts = r#"
            component Used { template { span( /) } }
            component Unused { template { div( /) } }
        "#;
        let bytes = compile_map(entry, &[("./parts.qubc", parts)]).unwrap();
        let names = component_names(&bytes);
        assert_eq!(names, vec!["Card", "Used"], "Unused는 제외돼야 함");
    }

    /// 같은 파일을 두 곳에서 서로 다른 이름으로 use(다이아몬드) -> 둘 다 들어간다(합집합).
    #[test]
    fn use_diamond_unions_wanted_names() {
        let entry = r#"
            use Left from "./left.qubc"
            use Right from "./right.qubc"
            component Card { template { Left( /) Right( /) } }
        "#;
        // Left/Right는 같은 parts에서 각각 X/Y를 use한다.
        let left = r#"
            use X from "./parts.qubc"
            component Left { template { X( /) } }
        "#;
        let right = r#"
            use Y from "./parts.qubc"
            component Right { template { Y( /) } }
        "#;
        let parts = r#"
            component X { template { span( /) } }
            component Y { template { div( /) } }
            component Z { template { p( /) } }
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
        assert!(
            !names.contains(&"Z".to_string()),
            "아무도 use 안 한 Z는 제외"
        );
    }

    /// 합성은 RENDER 직전에 PUSH_PATH_SEGMENT를 낸다 - operand는 자식 type-name 상수풀 인덱스.
    /// 이벤트 fullname의 path 축(누가 쐈나)을 누적할 세그먼트다(alias 도입 전엔 type-name 그대로).
    #[test]
    fn composition_emits_push_path_segment_of_child_type_name() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Inner( /) } } }
            component Inner { template { span( /) } }
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
    /// alias 없는 동일 type-name은 같은 fullname을 의도적으로 공유한다(#1.3).
    #[test]
    fn duplicate_composition_repeats_same_segment() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Inner( /) Inner( /) } } }
            component Inner { template { span( /) } }
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

        assert_eq!(seg_indices.len(), 2, "Inner 두 번 합성 -> 세그먼트 둘");
        assert_eq!(
            seg_indices[0], seg_indices[1],
            "같은 type-name은 같은 상수풀 인덱스"
        );
        assert_eq!(str_at(&module, seg_indices[0]).unwrap(), "Inner");
    }

    /// `Alias: Comp(...)` - alias가 있으면 세그먼트는 type-name이 아니라 alias다.
    #[test]
    fn alias_replaces_type_name_in_path_segment() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Done: Inner( /) } } }
            component Inner { template { span( /) } }
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

    /// 같은 type-name이라도 alias가 다르면 세그먼트가 갈린다 - alias 부여는 분리의 명시적 행위(#1.3).
    #[test]
    fn distinct_aliases_split_shared_type_name() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Save: Inner( /) Cancel: Inner( /) } } }
            component Inner { template { span( /) } }
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

        assert_eq!(seg_indices.len(), 2, "Inner 두 번 합성 -> 세그먼트 둘");
        assert_ne!(seg_indices[0], seg_indices[1], "다른 alias는 다른 세그먼트");
        assert_eq!(str_at(&module, seg_indices[0]).unwrap(), "Save");
        assert_eq!(str_at(&module, seg_indices[1]).unwrap(), "Cancel");
    }

    /// 요소 속성은 공백 구분 - 속성 사이 콤마는 우리 문법이 아니라 ParseError로 거부한다.
    #[test]
    fn element_attrs_reject_comma_separator() {
        let src = r#"component A { template { div(class="x", id="y" /) } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
    }

    /// 타입 필드 구분자 콤마는 필수 - 누락하면 ParseError. (지금은 완전 optional이었다.)
    #[test]
    fn type_field_missing_comma_rejected() {
        // props에서 콤마 누락.
        let src = r#"component A { props { a: string b: number } template { div( /) } }"#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
        // 중첩 object 타입에서 콤마 누락.
        let nested = r#"component B { props { o: { a: string b: number } } template { div( /) } }"#;
        assert!(matches!(
            compile(nested),
            Err(CompileError::Flatten(FlattenError::Parse(_)))
        ));
    }

    /// 마지막 필드 뒤 콤마는 생략 가능하고 trailing 콤마도 허용(TS 규칙). 둘 다 컴파일 성공.
    #[test]
    fn type_field_last_comma_optional() {
        // 마지막 생략.
        let omitted = r#"component A { props { a: string, b: number } template { div( /) } }"#;
        assert!(compile(omitted).is_ok());
        // trailing 콤마.
        let trailing = r#"component B { props { a: string, b: number, } template { div( /) } }"#;
        assert!(compile(trailing).is_ok());
        // 중첩 object에서도 동일.
        let nested =
            r#"component C { props { o: { a: string, b: number, } } template { div( /) } }"#;
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
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::Scope(scope::ScopeErrorKind::NotLeaf(_)),
                    ..
                },
                ..
            }))
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
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::Scope(
                        scope::ScopeErrorKind::UnknownField { .. }
                    ),
                    ..
                },
                ..
            }))
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
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::Scope(
                        scope::ScopeErrorKind::UnknownField { .. }
                    ),
                    ..
                },
                ..
            }))
        ));
    }

    /// def 하나의 코드 구간(테스트용). 슬롯은 사용쪽(부모)/정의쪽(자식) 코드가 갈려 둘 다 봐야 한다.
    fn def_code(module: &bytecode::Module, id: u16) -> &[u8] {
        let def = module.def(id).unwrap();
        &module.code[def.code_off as usize..(def.code_off + def.code_len) as usize]
    }

    /// 코드 구간에서 opcode 하나가 나온 위치들(테스트용).
    fn op_positions(code: &[u8], op: bytecode::Op) -> Vec<usize> {
        code.iter()
            .enumerate()
            .filter(|(_, &b)| b == op as u8)
            .map(|(i, _)| i)
            .collect()
    }

    /// `@slot()` 정의쪽은 FILL_SLOT_PLACEHOLDER, 사용쪽은 PUSH_SLOT_PLACEHOLDER_CONTENT..END로
    /// 갈린다. 콘텐츠 코드는 자식 def가 아니라 부모 def 안에 남는다(BYTECODE.md 슬롯 메모).
    #[test]
    fn anonymous_slot_placeholder_splits_def_and_fill() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Inner() { span( /) } } } }
            component Inner { template { section() { @slot() } } }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        // 사용쪽(Outer): 콘텐츠 구간이 열리고 그 안에 span이 있고 닫힌 뒤 RENDER.
        let outer = def_code(&module, 0);
        let push = op_positions(outer, Op::PushSlotPlaceholderContent);
        assert_eq!(push.len(), 1, "슬롯 하나를 채웠으니 콘텐츠 구간 하나");
        assert_eq!(
            u16::from_le_bytes([outer[push[0] + 1], outer[push[0] + 2]]),
            0,
            "무기명 슬롯은 인덱스 0"
        );
        let end = op_positions(outer, Op::SlotPlaceholderContentEnd);
        assert_eq!(end.len(), 1);
        assert!(push[0] < end[0], "구간은 열고 닫는다");
        assert!(
            outer[push[0]..end[0]].contains(&(Op::ElemOpen as u8)),
            "콘텐츠(span)는 부모 코드 안 구간에 있다"
        );
        assert_eq!(outer[end[0] + 1], Op::Render as u8, "구간 뒤 RENDER가 소비");

        // 정의쪽(Inner): 자리표시자만. 콘텐츠 코드는 여기 없다.
        let inner = def_code(&module, 1);
        let fill = op_positions(inner, Op::FillSlotPlaceholder);
        assert_eq!(fill.len(), 1);
        assert_eq!(
            u16::from_le_bytes([inner[fill[0] + 1], inner[fill[0] + 2]]),
            0
        );
        assert!(op_positions(inner, Op::PushSlotPlaceholderContent).is_empty());
    }

    /// 기명 슬롯은 선언 순서가 인덱스다. 채우는 순서가 달라도 사용쪽은 자식 선언 순서로 정규화된다.
    #[test]
    fn named_slot_placeholder_fills_normalize_to_declaration_order() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer {
              template {
                div() {
                  Inner() {
                    Footer << p( /)
                    Header << h1( /)
                  }
                }
              }
            }
            component Inner {
              template { section() { @slot(Header) @slot(Footer) } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        // 사용쪽은 Footer를 먼저 썼지만 방출은 선언 순서(Header=0, Footer=1).
        let outer = def_code(&module, 0);
        let indices: Vec<u16> = op_positions(outer, Op::PushSlotPlaceholderContent)
            .iter()
            .map(|&i| u16::from_le_bytes([outer[i + 1], outer[i + 2]]))
            .collect();
        assert_eq!(
            indices,
            vec![0, 1],
            "작성 순서와 무관하게 선언 순서로 정규화"
        );

        // 정의쪽도 같은 순서 - 두 축이 같은 인덱스 공간을 쓴다.
        let inner = def_code(&module, 1);
        let fills: Vec<u16> = op_positions(inner, Op::FillSlotPlaceholder)
            .iter()
            .map(|&i| u16::from_le_bytes([inner[i + 1], inner[i + 2]]))
            .collect();
        assert_eq!(fills, vec![0, 1]);
    }

    /// 슬롯 인덱스는 컴포넌트-로컬이다 - 다른 컴포넌트의 슬롯 수와 무관하게 각자 0부터.
    #[test]
    fn slot_placeholder_index_is_component_local() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer {
              template { div() { A() { span( /) } B() { em( /) } } }
            }
            component A { template { section() { @slot() } } }
            component B { template { article() { @slot() } } }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        for id in [1u16, 2] {
            let code = def_code(&module, id);
            let fill = op_positions(code, Op::FillSlotPlaceholder);
            assert_eq!(fill.len(), 1);
            assert_eq!(
                u16::from_le_bytes([code[fill[0] + 1], code[fill[0] + 2]]),
                0,
                "def {id}의 슬롯도 자기 안에서 0"
            );
        }
    }

    /// 안 채운 슬롯은 사용쪽이 콘텐츠 구간을 아예 안 낸다 - 정의쪽 자리표시자는 그대로 남는다.
    #[test]
    fn unfilled_slot_placeholder_emits_no_content() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer { template { div() { Inner() { Header << h1( /) } } } }
            component Inner {
              template { section() { @slot(Header) @slot(Footer) } }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        let outer = def_code(&module, 0);
        let indices: Vec<u16> = op_positions(outer, Op::PushSlotPlaceholderContent)
            .iter()
            .map(|&i| u16::from_le_bytes([outer[i + 1], outer[i + 2]]))
            .collect();
        assert_eq!(indices, vec![0], "Header만 채웠으니 구간 하나(인덱스 0)");

        // Footer 자리표시자는 정의쪽에 남는다 - 런타임이 미채움으로 건너뛴다.
        let inner = def_code(&module, 1);
        assert_eq!(op_positions(inner, Op::FillSlotPlaceholder).len(), 2);
    }

    /// 콘텐츠는 부모 scope로 해석된다 - 부모 prop 보간이 부모 slot index로 나온다.
    #[test]
    fn slot_placeholder_content_reads_parent_scope() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer {
              props { title: string }
              template { div() { Inner() { {title} } } }
            }
            component Inner { template { section() { @slot() } } }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        let outer = def_code(&module, 0);
        let push = op_positions(outer, Op::PushSlotPlaceholderContent)[0];
        let end = op_positions(outer, Op::SlotPlaceholderContentEnd)[0];
        let text_var = op_positions(&outer[push..end], Op::TextVar);
        assert_eq!(text_var.len(), 1, "콘텐츠 구간 안에 {{title}} 보간");
        // operand = Outer의 scope index 0 (Inner의 것이 아니다).
        assert_eq!(outer[push + text_var[0] + 1], 0);
    }

    /// `@slot`은 요소/`@if`/`@for` 안에 있어도 등장 순서대로 인덱스를 받는다.
    #[test]
    fn nested_slot_placeholder_defs_keep_source_order() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer {
              props { on: bool }
              template {
                div() { Inner(on={on}) { Header << h1( /) Footer << p( /) } }
              }
            }
            component Inner {
              props { on: bool }
              template {
                section() {
                  @if (on) { @slot(Header) }
                  div() { @slot(Footer) }
                }
              }
            }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        let inner = def_code(&module, 1);
        let fills: Vec<u16> = op_positions(inner, Op::FillSlotPlaceholder)
            .iter()
            .map(|&i| u16::from_le_bytes([inner[i + 1], inner[i + 2]]))
            .collect();
        assert_eq!(fills, vec![0, 1], "@if 안이든 요소 안이든 등장 순서");
    }

    /// 정의에 없는 슬롯을 채우면 컴파일 에러 - 오타가 조용히 사라지지 않게.
    #[test]
    fn unknown_slot_placeholder_fill_errors() {
        let src = r#"
            component Outer { template { div() { Inner() { Sidebar << p( /) } } } }
            component Inner { template { section() { @slot(Header) } } }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::UnknownSlotPlaceholder { .. },
                    ..
                },
                ..
            }))
        ));
    }

    /// 무기명 슬롯만 있는 자식에 기명으로 채우면 UnknownSlotPlaceholder(무기명은 이름 None).
    #[test]
    fn named_fill_into_anonymous_slot_placeholder_errors() {
        let src = r#"
            component Outer { template { div() { Inner() { Header << p( /) } } } }
            component Inner { template { section() { @slot() } } }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::UnknownSlotPlaceholder { .. },
                    ..
                },
                ..
            }))
        ));
    }

    /// 한 사용처에서 기명/무기명을 섞으면 파싱 단계에서 막는다(SYNTAX #3.3).
    #[test]
    fn mixing_named_and_anonymous_fill_errors() {
        let src = r#"
            component Outer { template { div() { Inner() { Header << h1( /) p( /) } } } }
            component Inner { template { section() { @slot(Header) } } }
        "#;
        assert!(compile(src).is_err());
    }

    /// 같은 슬롯을 두 번 채우면 에러 - 어느 쪽이 이기는지 정하지 않는다.
    #[test]
    fn duplicate_slot_placeholder_fill_errors() {
        let src = r#"
            component Outer {
              template { div() { Inner() { Header << h1( /) Header << p( /) } } }
            }
            component Inner { template { section() { @slot(Header) } } }
        "#;
        assert!(compile(src).is_err());
    }

    /// `<<` 오른쪽은 블록도 된다 - 노드 여럿을 한 슬롯에 넣는다.
    #[test]
    fn slot_placeholder_fill_accepts_block() {
        use bytecode::{decode, Op};

        let src = r#"
            component Outer {
              template { div() { Inner() { Header << { h1( /) p( /) } } } }
            }
            component Inner { template { section() { @slot(Header) } } }
        "#;
        let bytes = compile(src).unwrap();
        let module = decode(&bytes).unwrap();

        let outer = def_code(&module, 0);
        let push = op_positions(outer, Op::PushSlotPlaceholderContent)[0];
        let end = op_positions(outer, Op::SlotPlaceholderContentEnd)[0];
        assert_eq!(
            op_positions(&outer[push..end], Op::ElemOpen).len(),
            2,
            "블록 안 노드 둘 다 한 구간에"
        );
    }

    /// 무기명 `@slot()`을 두 자리에 두면 에러 - 자식 블록 한 덩이가 어디로 갈지 정할 수 없다.
    #[test]
    fn duplicate_anonymous_slot_placeholder_def_errors() {
        let src = r#"
            component Outer { template { div() { Inner() { p( /) } } } }
            component Inner { template { section() { @slot() @slot() } } }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::DuplicateSlotPlaceholderDef {
                        slot_placeholder: None,
                        ..
                    },
                    ..
                },
                ..
            }))
        ));
    }

    /// 같은 이름 `@slot(Header)`을 두 자리에 두는 것도 같은 이유로 에러.
    #[test]
    fn duplicate_named_slot_placeholder_def_errors() {
        let src = r#"
            component Outer { template { div() { Inner() { Header << p( /) } } } }
            component Inner {
              template { section() { @slot(Header) div() { @slot(Header) } } }
            }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::DuplicateSlotPlaceholderDef { .. },
                    ..
                },
                ..
            }))
        ));
    }

    /// 슬롯을 안 채우는 컴포넌트여도 중복 선언은 막는다 - 검사는 선언 자체에 붙는다.
    #[test]
    fn duplicate_slot_placeholder_def_errors_even_when_unfilled() {
        let src = r#"
            component Inner { template { section() { @slot() @slot() } } }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::DuplicateSlotPlaceholderDef { .. },
                    ..
                },
                ..
            }))
        ));
    }

    /// `@slot` 없는 자식에 콘텐츠를 넣으면 에러 - 갈 곳 없는 콘텐츠를 조용히 버리지 않는다.
    #[test]
    fn fill_into_component_without_slot_placeholder_errors() {
        let src = r#"
            component Outer { template { div() { Inner() { p( /) } } } }
            component Inner { template { section( /) } }
        "#;
        assert!(matches!(
            compile(src),
            Err(CompileError::Codegen(flatten::Sourced {
                err: codegen::CodegenError {
                    kind: codegen::CodegenErrorKind::UnknownSlotPlaceholder { .. },
                    ..
                },
                ..
            }))
        ));
    }

    // -- 에러 위치(SrcRange) --------------------------------------------
    //
    // 오프셋 숫자를 그대로 적으면 읽는 쪽이 검산을 못 하므로, 소스에서 그 구간을 잘라내
    // "무엇을 가리키는지"를 문자열로 본다. 위치가 밀리면 잘린 문자열이 달라져 잡힌다.

    /// 컴파일이 실패했다고 보고 그 에러가 가리키는 소스 조각을 돌려준다(테스트용).
    fn error_snippet(src: &str) -> String {
        let range = match compile(src) {
            Err(CompileError::Flatten(FlattenError::Lex(e))) => e.err.range,
            Err(CompileError::Flatten(FlattenError::Parse(e))) => e.err.range,
            other => panic!("lex/parse 에러를 기대했다: {:?}", other.map(|_| ())),
        };
        src[range.start as usize..range.end as usize].to_string()
    }

    /// codegen 에러가 가리키는 소스 조각. codegen 에러는 전부 자리를 안다.
    fn codegen_error_snippet(src: &str) -> String {
        match compile(src) {
            Err(CompileError::Codegen(e)) => {
                src[e.err.range.start as usize..e.err.range.end as usize].to_string()
            }
            other => panic!("codegen 에러를 기대했다: {:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn lex_error_points_at_bad_char() {
        // `#`은 어느 토큰도 시작하지 못한다 - 그 한 글자를 가리켜야 한다.
        assert_eq!(error_snippet("component C { # }"), "#");
    }

    #[test]
    fn lex_error_points_at_unknown_directive() {
        // `@`부터 키워드 끝까지 통째로 - `@`만 가리키면 무엇이 안 알려진 건지 안 보인다.
        assert_eq!(error_snippet("component C { template { @nope } }"), "@nope");
    }

    #[test]
    fn lex_error_points_at_unterminated_string() {
        // 닫는 따옴표가 없으면 여는 따옴표부터 소스 끝까지가 문자열로 먹힌다.
        let src = r#"component C { template { div(class="x /) } }"#;
        assert_eq!(error_snippet(src), r#""x /) } }"#);
    }

    #[test]
    fn string_literal_stops_at_newline() {
        // 문자열은 한 줄에서 닫혀야 한다. 개행을 넘기면 따옴표 하나를 빠뜨렸을 때 그 뒤 소스
        // 전부가 문자열로 먹혀, 에러가 파일 끝을 가리킨다(편집기 밑줄도 거기까지 뻗는다).
        let src = "component C {\n  template { div(class=\"x /) }\n}\n";
        assert_eq!(error_snippet(src), "\"x /) }", "그 줄에서 멎는다");
    }

    #[test]
    fn type_key_stops_at_newline() {
        // 타입 키(작은따옴표)도 같은 규칙이다 - 줄을 넘을 이유가 없다.
        let src = "component C {\n  props { rows: Omit<Card, 'id>[] }\n  template { hr( /) }\n}\n";
        assert_eq!(error_snippet(src), "'id>[] }");
    }

    #[test]
    fn string_literal_error_does_not_eat_next_lines() {
        // 여러 줄이 남아 있어도 구간은 첫 줄 안이다 - 뒤 줄들은 멀쩡하다고 봐야 한다.
        let src = "component C {\n  template { p() { \"열림 } }\n  // 뒤에 더 있다\n}\n";
        let snippet = error_snippet(src);

        assert!(!snippet.contains('\n'), "개행을 먹었다: {snippet:?}");
        assert_eq!(snippet, "\"열림 } }");
    }

    #[test]
    fn lex_error_points_at_unterminated_comment() {
        // 닫는 `*/`가 없으면 여는 `/*`부터 소스 끝까지다(문자열과 같은 규칙).
        let src = "component C { /* 설명 template { div( /) } }";
        assert_eq!(error_snippet(src), "/* 설명 template { div( /) } }");
    }

    /// 주석은 토큰을 안 낸다 - 어디에 끼든 없는 것처럼 컴파일된다. 줄 주석은 개행까지,
    /// 블록 주석은 짝 `*/`까지. 비ASCII도 주석 안에서는 통과해야 한다(전에는 렉서가 터졌다).
    #[test]
    fn comments_are_ignored() {
        let src = r#"
            // 이 컴포넌트는 카드를 그린다
            component C {
              /* props는
                 여러 줄로 설명한다 */
              props { title: string, tags: string[] }
              template {
                div(class="card") { // 제목만
                  {title}
                }
              }
            }
        "#;
        assert!(compile(src).is_ok(), "주석이 컴파일을 막으면 안 된다");
    }

    /// 주석은 앞 공백 여부에 투명하다 - `/` 앞 공백 강제(SYNTAX #3.1.1)가 주석 때문에 느슨해지지도,
    /// 엄해지지도 않아야 한다. 공백을 세우면 `img(class="x"/**//)`가 통과해 검증이 뚫린다.
    #[test]
    fn comment_is_transparent_to_self_close_space() {
        // 주석은 앞 공백 여부를 그대로 통과시킨다 - 공백을 만들지도, 지우지도 않는다.
        // 공백이 있으면 주석이 끼어도 self-close가 서고,
        assert!(
            compile(r#"component C { template { img(class="x" /* 설명 *//) } }"#).is_ok(),
            "공백 뒤 주석은 self-close를 막지 않아야 한다"
        );
        // 공백이 없으면 주석이 그 자리를 대신하지 못한다(대신하면 SYNTAX #3.1.1이 뚫린다).
        assert!(
            compile(r#"component C { template { img(class="x"/* 설명 *//) } }"#).is_err(),
            "공백 없이 붙은 주석이 앞 공백을 대신하면 안 된다"
        );
    }

    /// self-close `/`는 그대로 살아 있어야 한다 - 주석 분기가 `/` 하나짜리까지 먹으면 안 된다.
    #[test]
    fn self_close_still_works_after_comment_support() {
        assert!(compile(r#"component C { template { img(class="x" /) } }"#).is_ok());
    }

    /// next()로 읽은 뒤 그 토큰을 탓하는 자리 - just_read()가 한 칸 밀리지 않는지.
    #[test]
    fn parse_error_points_at_unexpected_token() {
        // `template` 자리에 `oops`가 왔다.
        assert_eq!(error_snippet("component C { oops { } }"), "oops");
    }

    /// peek만 하고 튕겨내는 자리 - here()가 아직 안 읽은 그 토큰을 가리키는지.
    #[test]
    fn parse_error_points_at_unexpected_node() {
        // 자식 자리에 노드가 될 수 없는 `=`가 왔다.
        assert_eq!(
            error_snippet("component C { template { div() { = } } }"),
            "="
        );
    }

    /// 토큰이 다 떨어져 난 에러는 소스 끝(빈 구간)을 가리킨다 - 패닉 없이 위치가 나와야 한다.
    #[test]
    fn parse_error_at_eof_points_past_end() {
        let src = "component C { template {";
        assert_eq!(error_snippet(src), "");
        // 빈 구간이라도 자리는 소스 끝이어야 한다(0이 아니라).
        match compile(src) {
            Err(CompileError::Flatten(FlattenError::Parse(e))) => {
                assert_eq!(e.err.range.start as usize, src.len());
            }
            other => panic!("parse 에러를 기대했다: {:?}", other.map(|_| ())),
        }
    }

    /// 검사 시점이 태그에서 멀어도(여는 태그를 다 읽은 뒤) 탓할 대상인 태그를 가리켜야 한다.
    #[test]
    fn parse_error_points_at_void_tag_not_current_pos() {
        assert_eq!(
            error_snippet("component C { template { input() { } } }"),
            "input"
        );
    }

    /// 슬롯 중복도 마찬가지 - 콘텐츠까지 읽은 뒤 검사하지만 두 번째 슬롯 이름을 가리킨다.
    #[test]
    fn parse_error_points_at_duplicate_slot_name() {
        let src = r#"
            component Outer { template { Inner() { H << p( /) H << span( /) } } }
            component Inner { template { div() { @slot(H) } } }
        "#;
        assert_eq!(error_snippet(src), "H");
        // 두 번째 H여야 한다 - 첫 H를 가리키면 어느 쪽이 중복인지 안 보인다.
        let range = match compile(src) {
            Err(CompileError::Flatten(FlattenError::Parse(e))) => e.err.range,
            other => panic!("parse 에러를 기대했다: {:?}", other.map(|_| ())),
        };
        assert_eq!(range.start as usize, src.rfind("H <<").unwrap());
    }

    /// 한글이 앞에 있어도 바이트 오프셋이 정확해야 한다(문자 수로 세면 밀린다).
    #[test]
    fn error_range_is_byte_offset_past_hangul() {
        let src = r#"component C { template { div(class="가나다") { = } } }"#;
        assert_eq!(error_snippet(src), "=");
    }

    // -- codegen 에러 위치 ----------------------------------------------
    //
    // prop 참조(VarRef)가 구간을 들어, 그 참조를 탓하는 에러는 자리를 가리킨다.
    // 아직 구간이 없는 자리(태그명/컴포넌트명 등)는 None으로 남는다.

    #[test]
    fn codegen_error_points_at_unknown_prop() {
        // props에 없는 `nope`를 보간했다 - 그 참조를 가리켜야 한다.
        let src = r#"component C { props { title: string } template { div() { {nope} } } }"#;
        assert_eq!(codegen_error_snippet(src), "nope");
    }

    /// 경로 참조는 root부터 끝까지 통째로 - `user`만 가리키면 어느 필드가 문제인지 안 보인다.
    #[test]
    fn codegen_error_points_at_whole_path() {
        let src = r#"
            component C {
              props { user: { name: string } }
              template { div() { {user.nope} } }
            }
        "#;
        assert_eq!(codegen_error_snippet(src), "user.nope");
    }

    /// 값 자리에 객체가 오면(NotLeaf) 그 참조를 가리킨다.
    #[test]
    fn codegen_error_points_at_non_leaf_ref() {
        let src = r#"
            component C {
              props { user: { name: string } }
              template { div() { {user} } }
            }
        "#;
        assert_eq!(codegen_error_snippet(src), "user");
    }

    /// 단축형 payload(`{ title }`)도 그 이름이 곧 참조라 자리를 가리킨다.
    #[test]
    fn codegen_error_points_at_shorthand_payload_field() {
        let src = r#"
            component C {
              events { PICK({ nope }) }
              template { div(@click:PICK /) }
            }
        "#;
        assert_eq!(codegen_error_snippet(src), "nope");
    }

    /// 무기명 슬롯도 자리를 안다 - 탓할 이름이 없으면 `@slot()` 노드 전체를 짚는다.
    #[test]
    fn duplicate_anonymous_slot_placeholder_points_at_the_node() {
        let src = r#"
            component C { template { @slot() @slot() } }
            component D { template { C( /) } }
        "#;
        assert_eq!(codegen_error_snippet(src), "@slot()");
    }

    /// 자식에 없는 슬롯을 무기명으로 채우면 합성 호출을 짚는다 - "이 컴포넌트는 자식 블록을
    /// 받지 않는다"가 곧 그 에러다.
    #[test]
    fn unknown_anonymous_slot_placeholder_points_at_the_composition() {
        let src = r#"
            component C { template { p() { "x" } } }
            component D { template { C() { span() { "y" } } } }
        "#;
        assert_eq!(codegen_error_snippet(src), "C");
    }

    // -- 진단 텍스트(format_error) --------------------------------------
    //
    // 위치 계산은 diagnostic 모듈이 자기 테스트로 덮는다. 여기서는 에러 종류마다 올바른
    // 파일/구간/메시지가 진단에 흘러 들어가는지를 본다.

    /// 컴파일 실패의 진단 텍스트(테스트용). 엔트리 경로는 compile()이 쓰는 이름과 같아야
    /// 한다 - 위치를 아는 에러는 자기가 든 파일을 쓰므로, 다른 이름을 넘기면 그 이름은
    /// 위치 없는 에러에만 나타나 무엇을 보는 테스트인지 흐려진다.
    fn diagnostic_of(src: &str) -> String {
        let err = compile(src).expect_err("컴파일이 실패해야 한다");
        format_error(None, "entry", src, &err)
    }

    /// codegen 에러는 참조 자리를 가리키고, 메시지에 variant 이름이 안 새어 나온다.
    #[test]
    fn diagnostic_shows_location_and_message() {
        let src = "component C {\n  props { user: { name: string } }\n  template { div() { {user.nope} } }\n}";
        assert_eq!(
            diagnostic_of(src),
            [
                "entry:3:23: error: no field `nope` on prop `user`",
                " 3 |   template { div() { {user.nope} } }",
                "   |                       ^^^^^^^^^",
            ]
            .join("\n")
        );
    }

    /// lex/parse 에러는 자기가 든 파일(Sourced.path)을 가리킨다 - 인자로 준 엔트리 이름이 아니라.
    #[test]
    fn diagnostic_uses_file_the_error_carries() {
        let out = diagnostic_of("component C { oops { } }");
        assert!(out.starts_with("entry:1:15: error: "), "{out}");
    }

    /// diagnose는 텍스트로 합치기 전의 것을 그대로 낸다 - range는 바이트 오프셋이고,
    /// 소스에서 잘라내면 밑줄 칠 구간이 나온다.
    #[test]
    fn diagnose_gives_byte_range_into_the_source() {
        let src = "component C {\n  props { user: { name: string } }\n  template { div() { {user.nope} } }\n}";
        let err = compile(src).expect_err("컴파일이 실패해야 한다");
        let d = diagnose("entry", src, &err);

        assert_eq!(d.path, "entry");
        assert_eq!(d.message, "no field `nope` on prop `user`");
        let range = d.range.expect("자리를 알아야 한다");
        assert_eq!(
            &d.src[range.start as usize..range.end as usize],
            "user.nope"
        );
    }

    /// use한 파일의 에러는 그 파일의 경로/소스를 낸다 - 환산할 원본이 엔트리가 아니어야
    /// 에디터가 맞는 파일에 밑줄을 긋는다.
    #[test]
    fn diagnose_carries_the_used_file_source() {
        let entry = "use Column from \"./column.qubc\"\ncomponent Board {\n  props { t: { label: string } }\n  template { Lane: Column(name={t} /) }\n}";
        let used = "component Column {\n  props { name: { label: string } }\n  template { p() { {name.nope} } }\n}";

        let err = compile_map(entry, &[("./column.qubc", used)]).expect_err("실패해야 한다");
        let d = diagnose("entry", entry, &err);

        assert_eq!(d.path, "./column.qubc");
        assert_eq!(d.src, used);
        // range는 그 파일 기준이라 엔트리가 아니라 used에서 잘라야 맞는다.
        let range = d.range.expect("자리를 알아야 한다");
        assert_eq!(&used[range.start as usize..range.end as usize], "name.nope");
    }

    /// 위치를 아는 에러는 종류를 가리지 않고 diagnose가 range를 실어야 한다.
    ///
    /// 회귀: blame이 `CompileError::Flatten(_)` 와일드카드로 받고 있어, 컴파일러가 위치를
    /// 붙인 뒤에도 타입 에러만 조용히 첫 줄로 떨어졌다(단위 테스트는 FlattenError를 직접 봐서
    /// 안 걸렸다). 종류마다 밑줄 칠 텍스트를 확인한다.
    #[test]
    fn diagnose_carries_range_for_every_located_error() {
        let cases: &[(&str, &str)] = &[
            // lex/parse
            ("component C { oops { } }", "oops"),
            // use 줄
            (
                "use Nope from \"./x.qubc\"\ncomponent C { template { div( /) } }",
                "\"./x.qubc\"",
            ),
            // prop 타입 표기
            (
                "component C {\n  props { x: Nope }\n  template { div( /) }\n}",
                "Nope",
            ),
            (
                "component C {\n  props { s: Omit<string, 'a'> }\n  template { div( /) }\n}",
                "Omit<string, 'a'>",
            ),
            // codegen
            (
                "component C {\n  props { user: { name: string } }\n  template { div() { {user.nope} } }\n}",
                "user.nope",
            ),
        ];

        for (src, want) in cases {
            let err = compile_map(src, &[]).expect_err("실패해야 한다");
            let d = diagnose("entry", src, &err);
            let range = d
                .range
                .unwrap_or_else(|| panic!("자리를 알아야 한다: {}", d.message));
            assert_eq!(
                &d.src[range.start as usize..range.end as usize],
                *want,
                "{}",
                d.message
            );
        }
    }

    /// 진단의 range를 에디터 기준으로 환산하면 그 자리가 나온다 - 0-based/UTF-16.
    /// 한글이 앞선 줄이라 바이트로 셌다면 컬럼이 튄다.
    #[test]
    fn diagnose_range_converts_to_editor_position() {
        let src = "component C {\n  props { user: { name: string } }\n  template { div() { \"가나다\" {user.nope} } }\n}";
        let err = compile(src).expect_err("컴파일이 실패해야 한다");
        let d = diagnose("entry", src, &err);
        let range = d.range.expect("자리를 알아야 한다");

        let start = locate_utf16(d.src, range.start);
        // 3번째 줄(0-based로 2). 한글 3자는 UTF-16으로 3칸이라 바이트(9칸)와 다르다.
        assert_eq!(start.line, 2);
        let line = d.src.lines().nth(2).unwrap();
        let expected: u32 = line[..line.find("user.nope").unwrap()]
            .chars()
            .map(|c| c.len_utf16() as u32)
            .sum();
        assert_eq!(start.column, expected);
    }

    /// use한 파일에서 난 codegen 에러는 엔트리가 아니라 그 파일을 가리킨다.
    ///
    /// 회귀: 예전엔 codegen 에러가 자기 출처를 몰라, 진단이 엔트리 소스에 대고 줄/칸을 셌다.
    /// range는 에러가 난 파일의 바이트 오프셋이므로 엔트리에 대고 세면 파일명도 줄도 밑줄도
    /// 전부 엉뚱한 곳을 짚었다(board.qubc를 컴파일하면 column.qubc의 에러가 board.qubc에
    /// 있는 것처럼 나왔다).
    #[test]
    fn diagnostic_points_at_the_used_file_not_the_entry() {
        let entry = "use Column from \"./column.qubc\"\ncomponent Board {\n  props { t: { label: string } }\n  template { Lane: Column(name={t} /) }\n}";
        let used = "component Column {\n  props { name: { label: string } }\n  template { p() { {name.nope} } }\n}";

        let err = compile_map(entry, &[("./column.qubc", used)]).expect_err("실패해야 한다");
        let out = format_error(None, "entry", entry, &err);

        assert_eq!(
            out,
            [
                "./column.qubc:3:21: error: no field `nope` on prop `name`",
                " 3 |   template { p() { {name.nope} } }",
                "   |                     ^^^^^^^^^",
            ]
            .join("\n")
        );
    }

    /// 엔트리보다 긴 파일에서 난 에러도 안전하다 - 그 오프셋을 엔트리 소스에 대고 세면
    /// 범위를 넘어 잘린 줄이나 엉뚱한 캐럿이 나온다.
    #[test]
    fn diagnostic_handles_offset_past_entry_length() {
        let entry = "use C from \"./c.qubc\"\ncomponent E {\n  props { v: { k: string } }\n  template { X: C(a={v} /) }\n}";
        let used = format!(
            "component C {{\n{}  props {{ a: {{ k: string }} }}\n  template {{ p() {{ {{a.nope}} }} }}\n}}",
            "  \n".repeat(40),
        );

        let err = compile_map(entry, &[("./c.qubc", &used)]).expect_err("실패해야 한다");
        let out = format_error(None, "entry", entry, &err);

        assert!(out.starts_with("./c.qubc:43:"), "{out}");
    }

    /// 자식이 선언 안 한 prop을 넘기면 그 이름을 가리킨다. 넘긴 것 검사가 빠진 것보다
    /// 먼저다 - 오타를 냈으면 "title이 빠졌다"보다 그 오타를 짚는 게 낫다.
    #[test]
    fn diagnostic_points_at_the_unknown_arg_name() {
        let src = "component Card { props { title: string } template { p() { {title} } } }\ncomponent D { props { x: string } template { Card(nope={x} /) } }";
        assert_eq!(
            diagnostic_of(src),
            [
                "entry:2:51: error: `Card` has no prop `nope`",
                " 2 | component D { props { x: string } template { Card(nope={x} /) } }",
                "   |                                                   ^^^^",
            ]
            .join("\n")
        );
    }

    /// 안 넘긴 prop은 빠진 것이라 소스에 자리가 없다 - 대신 그 합성 호출을 가리킨다.
    #[test]
    fn diagnostic_points_at_the_composition_missing_a_prop() {
        let out = diagnostic_of(
            "component C { props { a: string } template { div() { \"x\" } } }\ncomponent D { template { C( /) } }",
        );
        assert_eq!(
            out,
            [
                "entry:2:26: error: `C` requires prop `a`",
                " 2 | component D { template { C( /) } }",
                "   |                          ^",
            ]
            .join("\n")
        );
    }

    /// prop을 가리는 @for 회차변수는 그 변수 이름을 가리킨다.
    #[test]
    fn diagnostic_points_at_duplicate_for_binding() {
        let src = "component C {\n  props { row: string }\n  template { @for (row of 3) { p() { \"x\" } } }\n}";
        assert_eq!(
            diagnostic_of(src),
            [
                "entry:3:20: error: @for binding `row` shadows a prop or an outer binding: use another name",
                " 3 |   template { @for (row of 3) { p() { \"x\" } } }",
                "   |                    ^^^",
            ]
            .join("\n")
        );
    }

    /// item과 index가 같은 이름이면 먼저 온 item을 가리킨다(같은 이름 두 슬롯).
    #[test]
    fn diagnostic_points_at_for_item_index_same_name() {
        let src = "component C {\n  template { @for (i, i of 3) { p() { \"x\" } } }\n}";
        assert_eq!(
            diagnostic_of(src),
            [
                "entry:2:20: error: @for binding `i` shadows a prop or an outer binding: use another name",
                " 2 |   template { @for (i, i of 3) { p() { \"x\" } } }",
                "   |                    ^",
            ]
            .join("\n")
        );
    }

    /// events에 없는 이벤트명은 `@click:` 뒤 그 이름을 가리킨다(`@click`은 렉서가 이미 걸렀다).
    #[test]
    fn diagnostic_points_at_unknown_event() {
        let src = "component C {\n  events { PICK({}) }\n  template { div(@click:NOPE /) }\n}";
        assert_eq!(
            diagnostic_of(src),
            [
                "entry:3:25: error: `NOPE` is not declared in events",
                " 3 |   template { div(@click:NOPE /) }",
                "   |                         ^^^^",
            ]
            .join("\n")
        );
    }

    /// 같은 슬롯을 두 번 선언하면 뒤에 온 선언을 가리킨다(먼저 온 것이 자리를 차지했다).
    #[test]
    fn diagnostic_points_at_duplicate_slot_placeholder_def() {
        let src = "component C {\n  template { div() { @slot(H) @slot(H) } }\n}";
        assert_eq!(
            diagnostic_of(src),
            [
                "entry:2:37: error: `C` declares slot `H` twice: the content has no single place to go",
                " 2 |   template { div() { @slot(H) @slot(H) } }",
                "   |                                     ^",
            ]
            .join("\n")
        );
    }

    /// 정의가 없는 컴포넌트는 호출한 그 이름을 가리킨다.
    #[test]
    fn diagnostic_points_at_unknown_component() {
        assert_eq!(
            diagnostic_of("component C {\n  template { Nope( /) }\n}"),
            [
                "entry:2:14: error: cannot find component `Nope`",
                " 2 |   template { Nope( /) }",
                "   |              ^^^^",
            ]
            .join("\n")
        );
    }

    /// 자식이 선언하지 않은 슬롯을 채우면 그 슬롯 이름을 가리킨다(`<<` 왼쪽).
    #[test]
    fn diagnostic_points_at_unknown_slot_placeholder_fill() {
        let src = "component Outer {\n  template { Inner() { Sidebar << p( /) } }\n}\ncomponent Inner { template { section() { @slot(Header) } } }";
        assert_eq!(
            diagnostic_of(src),
            [
                "entry:2:24: error: `Inner` only takes named slots: `Header`",
                " 2 |   template { Inner() { Sidebar << p( /) } }",
                "   |                        ^^^^^^^",
            ]
            .join("\n")
        );
    }

    /// 슬롯 에러 메시지는 없는 것이 아니라 **쓸 수 있는 것**을 말한다 - 고칠 방법이 문장
    /// 안에 있어야 한다. 자식이 무엇을 선언했느냐로 셋이 갈린다.
    #[test]
    fn unknown_slot_placeholder_message_says_what_is_taken() {
        let message = |src: &str| {
            diagnostic_of(src)
                .lines()
                .next()
                .unwrap()
                .split_once("error: ")
                .unwrap()
                .1
                .to_string()
        };

        // 슬롯이 아예 없다 - 대안이 없으니 할 일을 알려준다.
        assert_eq!(
            message(
                "component O { template { I() { p( /) } } }\ncomponent I { template { span( /) } }"
            ),
            "`I` has no slot: use self-close (`I( /)`)"
        );
        // 선언한 게 무기명뿐인데 기명으로 채웠다.
        assert_eq!(
            message("component O { template { I() { H << p( /) } } }\ncomponent I { template { @slot() } }"),
            "`I` only takes unnamed slot content"
        );
        // 기명이 있는데 무기명으로 채웠다 - 이름을 보여줘야 그걸로 고친다.
        assert_eq!(
            message("component O { template { I() { p( /) } } }\ncomponent I { template { @slot(H) @slot(F) } }"),
            "`I` only takes named slots: `H`, `F`"
        );
    }

    /// 선언하지 않은 컨텍스트는 `@with` 뒤 이름을 가리킨다.
    #[test]
    fn diagnostic_points_at_unknown_context() {
        let src = "component C {\n  template { @with Nope { p() { \"x\" } } }\n}";
        assert_eq!(
            diagnostic_of(src),
            [
                "entry:2:20: error: `Nope` is not declared in contexts",
                " 2 |   template { @with Nope { p() { \"x\" } } }",
                "   |                    ^^^^",
            ]
            .join("\n")
        );
    }

    /// 모르는 태그는 그 태그 이름을 가리킨다.
    #[test]
    fn diagnostic_points_at_unknown_tag() {
        assert_eq!(
            diagnostic_of("component C {\n  template { svg( /) }\n}"),
            [
                "entry:2:14: error: unknown builtin tag `svg`",
                " 2 |   template { svg( /) }",
                "   |              ^^^",
            ]
            .join("\n")
        );
    }

    // -- 토큰 표기 ------------------------------------------------------
    //
    // Expected 에러가 무엇이 왔는지 보일 때 파서 내부 이름(LBrace)이 아니라 소스에 적힌
    // 모양(`{`)으로 나와야 한다. 진단 첫 줄의 메시지만 떼어 본다.

    /// 진단 첫 줄의 `error: ` 뒤 메시지(테스트용).
    fn error_message(src: &str) -> String {
        let out = diagnostic_of(src);
        let first = out.lines().next().unwrap().to_string();
        match first.split_once("error: ") {
            Some((_, msg)) => msg.to_string(),
            None => panic!("진단 첫 줄에 'error: '가 없다: {first}"),
        }
    }

    /// 기호 토큰은 그 글자로 - `LBrace`가 아니라 `` `{` ``.
    #[test]
    fn message_shows_symbol_token_as_written() {
        let msg = error_message(r#"component C { template { div(class="x" { p() { "h" } } } }"#);
        assert_eq!(msg, "expected attribute name, @event, or ), found `{`");
    }

    /// 식별자는 그 이름을 담아 보인다 - 어느 이름이 틀렸는지 보이게.
    #[test]
    fn message_shows_identifier_with_its_name() {
        assert_eq!(
            error_message("oops { }"),
            "expected use or component, found `oops`"
        );
    }

    /// 디렉티브는 `@` 붙은 키워드로 - `At(If)`가 아니라 `@if`.
    #[test]
    fn message_shows_directive_with_at_keyword() {
        // 속성 자리에 DOM 이벤트(`@click`)는 오지만 구조 디렉티브(`@if`)는 못 온다.
        let msg = error_message(r#"component C { template { div(@if /) } }"#);
        assert_eq!(
            msg,
            "expected DOM event directive (e.g. @click), found `@if`"
        );
    }

    /// peek 자리에서 토큰이 떨어지면 `None`이 아니라 사람이 읽는 말로(shown).
    /// next()로 읽다 떨어지는 건 다른 에러(UnexpectedEnd)라 여긴 peek 자리를 골라야 한다.
    #[test]
    fn message_shows_end_of_source_not_none() {
        assert_eq!(
            error_message("component C { template { div(class="),
            "expected attribute value (string or {var}), found end of source"
        );
    }

    /// 리터럴은 종류가 보이게 - 문자열은 따옴표째, 숫자는 값 그대로.
    #[test]
    fn message_shows_literal_kind() {
        // 노드 자리에 숫자는 올 수 없다.
        assert_eq!(
            error_message("component C { template { div() { 42 } } }"),
            "expected node (element, string, or {var}), found `42`"
        );
    }

    /// expect()/keyword()/ident()가 내는 에러도 같은 표기를 쓴다 - 이 셋은 peek 계열과
    /// 다른 경로라 따로 덮는다(한 곳만 고치고 나머지를 빠뜨리기 쉽다).
    #[test]
    fn message_from_expect_paths_uses_same_notation() {
        // keyword(): props 블록 뒤에 template이 와야 한다.
        assert_eq!(
            error_message("component C { oops { } }"),
            "expected `template`, found `oops`"
        );
        // ident(): 컴포넌트 이름 자리에 기호가 왔다.
        assert_eq!(
            error_message("component { }"),
            "expected identifier, found `{`"
        );
        // expect(): 이름 뒤에 `{`가 와야 한다.
        assert_eq!(error_message("component C ]"), "expected `{`, found `]`");
    }

    /// base_dir 아래 경로는 상대경로로 줄여 낸다. 아래가 아니면 원본 그대로.
    #[test]
    fn diagnostic_shortens_path_under_base_dir() {
        assert_eq!(relative_to("/a/b", "/a/b/c.qubc"), Some("c.qubc"));
        // 끝 슬래시가 있어도 같게 동작해야 한다.
        assert_eq!(relative_to("/a/b/", "/a/b/c.qubc"), Some("c.qubc"));
        // 접두어가 겹쳐 보이지만 다른 디렉터리다(/a/bb) - 줄이면 안 된다.
        assert_eq!(relative_to("/a/b", "/a/bb/c.qubc"), None);
        assert_eq!(relative_to("/a/b", "/x/c.qubc"), None);
    }
}
