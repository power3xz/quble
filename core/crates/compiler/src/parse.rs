//! 재귀하강 파서: 토큰 -> AST. MVP 문법.
//!
//! component IDENT { [PROPS] template { NODE* } }
//! PROPS   = props { IDENT : TYPE (, IDENT : TYPE)* }   (선택)
//! TYPE    = ("bool"|"number"|"string"|OBJECT) "[]"*     (재귀; []는 후위 반복)
//! OBJECT  = { (IDENT : TYPE (, IDENT : TYPE)*)? }
//! NODE    = ELEMENT | STRING | VAR
//! VAR     = { IDENT }                         (props 보간)
//! ELEMENT = IDENT ( ATTR* ) { NODE* }
//! ATTR    = IDENT = STRING   (콤마 구분 허용)

use crate::ast::{
    ArgValue, AttrValue, BinaryOp, Component, Context, Event, Expr, ForCount, Ident, LitValue,
    Node, Prop, SlotPlaceholderContent, SourceFile, Type, UnaryOp, Use, VarRef,
};
use crate::lexer::{Directive, Lexed, Token};
use crate::src_range::{NodeRange, SrcRange};

#[derive(Debug, PartialEq, Eq)]
pub enum ParseErrorKind {
    UnexpectedEnd,
    Expected {
        want: String,
        got: String,
    },
    /// 같은 슬롯을 두 번 채웠다(`Header << ... Header << ...`).
    DuplicateSlotPlaceholderFill {
        comp: String,
        slot: String,
    },
    /// 한 합성 블록에 기명 채움과 무기명 노드가 섞였다. 정의 쪽이 둘 중 하나라 어느 쪽도 성립 못 한다.
    MixedSlotPlaceholderFill {
        comp: String,
    },
    /// 빈 자식 블록(`Comp() { }`) - 슬롯을 안 채우면 self-close로 쓴다(DESIGN #4.5).
    EmptyBlock(String),
}

impl std::fmt::Display for ParseErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            ParseErrorKind::UnexpectedEnd => {
                write!(f, "unexpected end of source: a block is left unclosed")
            }
            // got은 Token의 Display라 소스에 적힌 모양대로 나온다(`` `{` ``). want는 문법
            // 자리를 가리키는 표기다("attribute name, @event, or )").
            ParseErrorKind::Expected { want, got } => {
                write!(f, "expected {want}, found {got}")
            }
            ParseErrorKind::DuplicateSlotPlaceholderFill { comp, slot } => write!(
                f,
                "slot `{slot}` of `{comp}` is filled twice: a slot takes one content block"
            ),
            ParseErrorKind::MixedSlotPlaceholderFill { comp } => write!(
                f,
                "`{comp}` mixes named fills with unnamed nodes: the definition declares one or the other"
            ),
            ParseErrorKind::EmptyBlock(tag) => write!(
                f,
                "empty child block on `{tag}`: use self-close (`{tag}( /)`) when filling no slot"
            ),
        }
    }
}

/// 파싱 실패 - 무엇이(kind) 어디서(range) 틀렸나.
#[derive(Debug, PartialEq, Eq)]
pub struct ParseError {
    pub kind: ParseErrorKind,
    pub range: SrcRange,
}

/// peek 결과를 에러 메시지에 쓸 표기로. None은 토큰이 다 떨어진 것이다 - `Option`의 Debug가
/// `None`을 그대로 내보내지 않게 사람이 읽는 말로 바꾼다.
fn shown(token: Option<&Token>) -> String {
    match token {
        Some(t) => t.to_string(),
        None => "end of source".to_string(),
    }
}

/// `use` 문 한 줄의 두 형태. 컴포넌트 import(`use A from "..."`)와 리소스(`use "..."`)는
/// 같은 키워드로 시작하지만 다른 곳에 모인다(전자는 use 그래프, 후자는 SourceFile.resources).
enum UseDecl {
    Component(Use),
    Resource(Ident),
}

/// 한 소스를 파싱. 최상위 use 문(있으면 component 앞)과 컴포넌트 정의들을 모은다.
/// 컴포넌트 정의 순서는 codegen에서 의미를 갖지 않는다(CompLookup이 forward 참조 허용).
/// src_len은 토큰이 다 떨어진 자리(소스 끝)를 가리키는 데만 쓴다.
pub fn parse(lexed: &Lexed, src_len: usize) -> Result<SourceFile, ParseError> {
    let mut p = Parser {
        tokens: &lexed.tokens,
        ranges: &lexed.ranges,
        src_len,
        pos: 0,
    };
    let mut uses = Vec::new();
    let mut resources = Vec::new();
    let mut comps = Vec::new();
    while let Some(Token::Ident(s)) = p.peek() {
        match s.as_str() {
            // `use` 다음이 문자열이면 리소스(`use './x.css'`), 식별자면 컴포넌트 import.
            "use" => match p.use_decl()? {
                UseDecl::Component(u) => uses.push(u),
                UseDecl::Resource(path) => resources.push(path),
            },
            "component" => comps.push(p.component()?),
            other => {
                let kind = ParseErrorKind::Expected {
                    want: "use or component".into(),
                    // 식별자 내용만 손에 있어 Token 표기를 못 쓴다 - Ident와 같은 모양으로 맞춘다.
                    got: format!("`{other}`"),
                };
                return Err(p.err_here(kind));
            }
        }
    }
    // 토큰이 남았는데 Ident가 아니면 최상위에 올 수 없는 토큰.
    if let Some(t) = p.peek() {
        let kind = ParseErrorKind::Expected {
            want: "use or component".into(),
            got: format!("{t}"),
        };
        return Err(p.err_here(kind));
    }
    Ok(SourceFile {
        uses,
        resources,
        comps,
    })
}

struct Parser<'a> {
    tokens: &'a [Token],
    /// tokens와 길이가 같은 병렬 배열 - i번 토큰의 소스 구간.
    ranges: &'a [SrcRange],
    /// 토큰이 다 떨어졌을 때 가리킬 자리(소스 끝).
    src_len: usize,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    // 에러가 가리킬 자리는 두 가지뿐이다 - 토큰을 소비했으면 그 토큰(just_read), 아직
    // peek만 했으면 앞에 놓인 토큰(here). 둘을 헷갈리면 밑줄이 한 칸 밀린다.
    //
    //     div(class="x" {         <- `)` 자리에 `{`가 왔다
    //                   ^ 여기를 가리켜야 한다

    /// pos가 가리키는(=아직 안 읽은) 토큰의 구간. peek으로만 보고 튕겨낼 때 쓴다.
    ///
    /// ```text
    /// match self.peek() {
    ///     got => Err(self.err_here(...)),   // got이 곧 pos 토큰
    /// }
    /// ```
    ///
    /// 토큰이 다 떨어졌으면 소스 끝(빈 구간)을 가리킨다.
    fn here(&self) -> SrcRange {
        self.ranges
            .get(self.pos)
            .copied()
            .unwrap_or_else(|| SrcRange::eof(self.src_len))
    }

    /// 직전에 소비한 토큰(pos - 1)의 구간. `next()`로 읽고 나서 그 토큰을 탓할 때 쓴다.
    ///
    /// ```text
    /// let got = self.next()?;              // pos가 이미 다음으로 넘어갔다
    /// Err(self.err_read(...))              // here()면 got의 *다음* 토큰을 가리킨다
    /// ```
    ///
    /// 아무것도 안 읽었으면(pos = 0) 가리킬 이전 토큰이 없어 here()로 떨어진다.
    fn just_read(&self) -> SrcRange {
        match self.pos {
            0 => self.here(),
            _ => self.ranges[self.pos - 1],
        }
    }

    /// 앞에 놓인 토큰을 가리키는 에러(peek 계열).
    fn err_here(&self, kind: ParseErrorKind) -> ParseError {
        ParseError {
            kind,
            range: self.here(),
        }
    }

    /// 방금 읽은 토큰을 가리키는 에러(next 계열).
    fn err_read(&self, kind: ParseErrorKind) -> ParseError {
        ParseError {
            kind,
            range: self.just_read(),
        }
    }

    fn next(&mut self) -> Result<&Token, ParseError> {
        // 토큰이 없어서 나는 에러라 here()가 소스 끝을 가리킨다. pos를 올리기 전에 만들어야
        // 하고(올린 뒤 just_read()를 쓰면 마지막 토큰을 엉뚱하게 탓한다), 성공하면 버려진다.
        let at_end = self.err_here(ParseErrorKind::UnexpectedEnd);
        let t = self.tokens.get(self.pos).ok_or(at_end)?;
        self.pos += 1;
        Ok(t)
    }

    fn expect(&mut self, want: &Token) -> Result<(), ParseError> {
        let got = self.next()?;
        if got == want {
            Ok(())
        } else {
            let kind = ParseErrorKind::Expected {
                want: format!("{want}"),
                got: format!("{got}"),
            };
            Err(self.err_read(kind))
        }
    }

    fn ident(&mut self) -> Result<String, ParseError> {
        match self.next()? {
            Token::Ident(s) => Ok(s.clone()),
            got => {
                let kind = ParseErrorKind::Expected {
                    want: "identifier".into(),
                    got: format!("{got}"),
                };
                Err(self.err_read(kind))
            }
        }
    }

    /// 이름과 그 이름이 적힌 자리를 함께. ident()가 토큰 하나를 소비하니 직후 just_read()가
    /// 곧 그 이름의 구간이다 - 미리 here()를 잡아둘 필요가 없다.
    fn ident_at(&mut self) -> Result<Ident, ParseError> {
        let name = self.ident()?;
        Ok(Ident {
            name,
            range: NodeRange(self.just_read()),
        })
    }

    // prop 참조 하나: `root` 또는 `root.field.field...`. root는 prop 이름, 뒤는 객체 필드 경로.
    // leaf 여부(경로 끝이 원시냐)는 여기서 안 본다 - 타입을 모르는 파서의 몫이 아니라 codegen이
    // props 타입과 대조해 판단한다.
    fn var_ref(&mut self) -> Result<VarRef, ParseError> {
        // `assignee.name` 전체를 걸치게 - root 앞에서 시작해 경로 끝에서 닫는다.
        let start = self.here();
        let root = self.ident()?;
        let mut path = Vec::new();
        while matches!(self.peek(), Some(Token::Dot)) {
            self.next()?;
            path.push(self.ident()?);
        }
        let range = NodeRange(SrcRange {
            start: start.start,
            end: self.just_read().end,
        });
        Ok(VarRef { root, path, range })
    }

    /// 값 자리의 식 하나. 1 = peek_binary_op 표의 최저 우선순위라 모든 연산자를 받는다.
    fn expr(&mut self) -> Result<Expr, ParseError> {
        self.expr_binary(1)
    }

    /// 이항 연산자를 우선순위대로 묶는다. `min`보다 낮은 연산자는 안 먹고 남겨 둔다 - 그걸
    /// 바깥 호출이 자기 왼쪽으로 받아 묶는다.
    ///
    /// `a + b * c`: `+`(5)를 먹고 오른쪽을 min=6으로 파싱해 `b * c`(6)가 먼저 묶인다.
    /// `a * b + c`: `*`(6)를 먹고 오른쪽을 min=7로 파싱하니 `+`(5)는 안 먹혀 `(a*b)`가 닫히고,
    /// 바깥 회차가 그걸 왼쪽 삼아 `+`로 묶는다.
    ///
    /// 오른쪽을 `prec + 1`로 부르는 것이 좌결합이다 - 같은 우선순위가 오른쪽에 안 붙고
    /// while이 왼쪽에 쌓는다(`a - b - c` -> `(a-b)-c`). `prec`으로 부르면 우결합이 된다.
    fn expr_binary(&mut self, min: u8) -> Result<Expr, ParseError> {
        // 피연산자 앞에서 시작해, 묶을 때마다 오른쪽 끝에서 닫는다.
        let start = self.here();
        // node는 지금까지 묶은 트리 전체다 - 첫 회차만 피연산자 하나이고, 이후 회차가 그걸
        // 통째로 왼쪽 자식에 밀어 넣는다. 왼쪽이 깊어지는 것이 곧 좌결합이다.
        let mut node = self.expr_operand()?;
        while let Some((op, prec)) = self.peek_binary_op() {
            if prec < min {
                break;
            }
            self.next()?;
            let right = self.expr_binary(prec + 1)?;
            let range = NodeRange(SrcRange {
                start: start.start,
                end: self.just_read().end,
            });
            node = Expr::Binary(op, Box::new(node), Box::new(right), range);
        }
        Ok(node)
    }

    /// 다음 토큰이 이항 연산자면 그 종류와 우선순위. 숫자가 클수록 먼저 묶인다(JS와 같은 순서).
    fn peek_binary_op(&self) -> Option<(BinaryOp, u8)> {
        Some(match self.peek()? {
            Token::PipePipe => (BinaryOp::Or, 1),
            Token::AmpAmp => (BinaryOp::And, 2),
            Token::EqEq => (BinaryOp::Eq, 3),
            Token::BangEq => (BinaryOp::Ne, 3),
            Token::Lt => (BinaryOp::Lt, 4),
            Token::Le => (BinaryOp::Le, 4),
            Token::Gt => (BinaryOp::Gt, 4),
            Token::Ge => (BinaryOp::Ge, 4),
            Token::Plus => (BinaryOp::Add, 5),
            Token::Minus => (BinaryOp::Sub, 5),
            Token::Star => (BinaryOp::Mul, 6),
            // 나눗셈과 self-close가 같은 토큰이다 - 값 자리로 내려온 `/`는 나눗셈이다.
            Token::Slash(_) => (BinaryOp::Div, 6),
            Token::Percent => (BinaryOp::Rem, 6),
            _ => return None,
        })
    }

    /// 다음 토큰이 단항 연산자면 그 종류. `-`는 이항에도 있어(peek_binary_op) 같은 토큰이
    /// 자리로 갈린다 - 피연산자 앞이면 부호, 뒤면 뺄셈이다.
    fn peek_unary_op(&self) -> Option<UnaryOp> {
        Some(match self.peek()? {
            Token::Bang => UnaryOp::Not,
            Token::Minus => UnaryOp::Neg,
            _ => return None,
        })
    }

    /// 피연산자 하나를 읽는다. expr_binary의 좌우도, 단항이 씌워지는 대상도 다 이것이다.
    ///
    /// 단항이 앞에 붙어 있으면 벗겨내고 안쪽을 자기를 다시 불러 읽는다 - 그래서 우결합이다
    /// (`!!a` -> `!(!a)`). 단항은 피연산자에 씌우는 것이라 이항보다 먼저 묶인다.
    ///
    /// 괄호도 피연산자다 - 안에 트리가 통째로 들어 있어도 바깥은 그걸 피연산자 하나로만
    /// 본다(`(a + b) * c`에서 `*`의 왼쪽이 `(a + b)` 통째다). 안쪽을 채울 때만 `expr`로
    /// 되올라가고, 그 순간 우선순위가 초기화된다.
    fn expr_operand(&mut self) -> Result<Expr, ParseError> {
        let start = self.here();
        if let Some(op) = self.peek_unary_op() {
            self.next()?;
            let operand = self.expr_operand()?;
            let range = NodeRange(SrcRange {
                start: start.start,
                end: self.just_read().end,
            });
            return Ok(Expr::Unary(op, Box::new(operand), range));
        }
        match self.peek() {
            Some(Token::LParen) => {
                self.next()?;
                let inner = self.expr()?;
                self.expect(&Token::RParen)?;
                Ok(inner)
            }
            Some(Token::Ident(_)) => {
                let var = self.var_ref()?;
                // 노드가 걸친 자리는 경로 전체(`tags.length`)다.
                let range = var.range;
                // 경로 끝이 `length`면 배열 길이다. 같은 이름의 객체 필드와 겹치므로 어느
                // 쪽인지는 codegen이 타입을 보고 가른다.
                match var.path.last().map(String::as_str) {
                    Some("length") => {
                        let mut base = var;
                        base.path.pop();
                        // 참조가 짚을 자리는 `tags`로 좁힌다 - 그 이름을 못 찾으면 거기에 밑줄이 간다.
                        base.range = NodeRange(SrcRange {
                            start: range.0.start,
                            end: range.0.start + base.root.len() as u32,
                        });
                        Ok(Expr::Length(base, range))
                    }
                    _ => Ok(Expr::Var(var, range)),
                }
            }
            Some(Token::Str(_) | Token::Num(_) | Token::Bool(_)) => {
                let lit = self.lit_value()?;
                Ok(Expr::Lit(lit, NodeRange(self.just_read())))
            }
            got => {
                let kind = ParseErrorKind::Expected {
                    want: "expression (prop, \"str\", 42, true, `(`)".into(),
                    got: shown(got),
                };
                Err(self.err_here(kind))
            }
        }
    }

    /// 값 자리(payload/context/합성 인자)의 값 하나: Ident면 prop 참조(Var), 그 외 리터럴 토큰
    /// (Str/Num/Bool)이면 타입대로 Literal.
    fn field_value(&mut self) -> Result<ArgValue, ParseError> {
        match self.peek() {
            Some(Token::Ident(_)) => Ok(ArgValue::Var(self.var_ref()?)),
            Some(Token::Str(_) | Token::Num(_) | Token::Bool(_)) => {
                Ok(ArgValue::Literal(self.lit_value()?))
            }
            got => {
                let kind = ParseErrorKind::Expected {
                    want: "value (prop, \"str\", 42, true)".into(),
                    got: shown(got),
                };
                Err(self.err_here(kind))
            }
        }
    }

    /// 리터럴 토큰 하나를 LitValue로 소비. 숫자는 f64로 파싱한다(원문이 렉서를 통과해도
    /// 형태가 어긋나면 여기서 잡힌다). 호출부가 리터럴 토큰임을 확인한 뒤 부른다.
    fn lit_value(&mut self) -> Result<LitValue, ParseError> {
        // next()가 빌려준 토큰을 아래 팔들이 쓰고 있어 그 안에서 just_read()를 못 부른다
        // (self 재빌림) - 소비 전에 이 리터럴 자리를 잡아둔다.
        let lit_range = self.here();
        match self.next()? {
            Token::Str(s) => Ok(LitValue::Str(s.clone())),
            Token::Bool(b) => Ok(LitValue::Bool(*b)),
            Token::Num(n) => n
                .parse::<f64>()
                .map(LitValue::Number)
                .map_err(|_| ParseError {
                    kind: ParseErrorKind::Expected {
                        want: "number literal".into(),
                        got: format!("`{n}`"),
                    },
                    range: lit_range,
                }),
            got => {
                let kind = ParseErrorKind::Expected {
                    want: "literal (\"str\", 42, true)".into(),
                    got: format!("{got}"),
                };
                Err(ParseError {
                    kind,
                    range: lit_range,
                })
            }
        }
    }

    /// 특정 키워드 식별자를 기대.
    fn keyword(&mut self, kw: &str) -> Result<(), ParseError> {
        let s = self.ident()?;
        if s == kw {
            Ok(())
        } else {
            // ident()가 Token을 String으로 풀어버려 Token 표기를 못 쓴다 - 직접 맞춘다.
            let kind = ParseErrorKind::Expected {
                want: format!("`{kw}`"),
                got: format!("`{s}`"),
            };
            Err(self.err_read(kind))
        }
    }

    // 컴포넌트 import:  use IDENT (, IDENT)* from STRING
    // 리소스:           use STRING
    fn use_decl(&mut self) -> Result<UseDecl, ParseError> {
        // `use`부터 경로 끝까지 걸치게 - 순환(Cycle)은 이 use 자체가 원인이라 줄 전체를 탓한다.
        let start = self.here();
        self.keyword("use")?;
        // `use` 다음이 문자열이면 리소스(컴포넌트명/from 없음).
        if matches!(self.peek(), Some(Token::Str(_))) {
            return Ok(UseDecl::Resource(self.str_at()?));
        }
        let mut names = Vec::new();
        names.push(self.ident_at()?);
        while matches!(self.peek(), Some(Token::Comma)) {
            self.next()?;
            names.push(self.ident_at()?);
        }
        self.keyword("from")?;
        let path = self.str_at()?;
        // 끝은 경로 토큰의 끝 - just_read()를 다시 부르면 그 사이에 무엇이 읽혔느냐에 매인다.
        let range = NodeRange(SrcRange {
            start: start.start,
            end: path.range.0.end,
        });
        Ok(UseDecl::Component(Use { names, path, range }))
    }

    /// 문자열 리터럴과 그 자리를 함께. 경로가 곧 탓할 대상이라(NotFound) 위치가 필요하다.
    fn str_at(&mut self) -> Result<Ident, ParseError> {
        match self.next()? {
            Token::Str(s) => {
                let name = s.clone();
                Ok(Ident {
                    name,
                    range: NodeRange(self.just_read()),
                })
            }
            got => {
                let kind = ParseErrorKind::Expected {
                    want: "string path".into(),
                    got: format!("{got}"),
                };
                Err(self.err_read(kind))
            }
        }
    }

    // component IDENT { [props { ... }] template { NODE* } }
    fn component(&mut self) -> Result<Component, ParseError> {
        self.keyword("component")?;
        let name = self.ident()?;
        self.expect(&Token::LBrace)?;

        // props 블록은 선택적이며 template 앞에 온다.
        let props = if matches!(self.peek(), Some(Token::Ident(s)) if s == "props") {
            self.props()?
        } else {
            Vec::new()
        };

        // contexts 블록도 선택적이며 props 다음, events 앞에 온다(SYNTAX.md #1).
        let contexts = if matches!(self.peek(), Some(Token::Ident(s)) if s == "contexts") {
            self.contexts()?
        } else {
            Vec::new()
        };

        // events 블록도 선택적이며 contexts 다음, template 앞에 온다.
        let events = if matches!(self.peek(), Some(Token::Ident(s)) if s == "events") {
            self.events()?
        } else {
            Vec::new()
        };

        self.keyword("template")?;
        self.expect(&Token::LBrace)?;
        let template = self.nodes()?;
        self.expect(&Token::RBrace)?; // template
        self.expect(&Token::RBrace)?; // component
        Ok(Component {
            name,
            props,
            events,
            contexts,
            template,
        })
    }

    // props { IDENT : TYPE (, IDENT : TYPE)* }
    fn props(&mut self) -> Result<Vec<Prop>, ParseError> {
        self.keyword("props")?;
        self.expect(&Token::LBrace)?;
        let mut props = Vec::new();
        // 구분자 콤마 필수, 마지막 prop 뒤만 생략 가능(object_type과 동일 규칙).
        while !matches!(self.peek(), Some(Token::RBrace) | None) {
            let name = self.ident()?;
            self.expect(&Token::Colon)?;
            let ty = self.type_expr()?;
            props.push(Prop { name, type_: ty });
            if matches!(self.peek(), Some(Token::RBrace)) {
                break;
            }
            self.expect(&Token::Comma)?;
        }
        self.expect(&Token::RBrace)?;
        Ok(props)
    }

    // TYPE = (PRIM | OBJECT) "[]"*  - base 타입 파싱 후 후위 []를 배열로 흡수(bool[][] 등).
    fn type_expr(&mut self) -> Result<Type, ParseError> {
        let mut ty = match self.peek() {
            Some(Token::LBrace) => self.object_type()?,
            Some(Token::KwBool) => {
                self.next()?;
                Type::Bool
            }
            Some(Token::KwNumber) => {
                self.next()?;
                Type::Number
            }
            Some(Token::KwString) => {
                self.next()?;
                Type::String
            }
            // 유틸 타입 `Omit<T, 'a' | 'b'>` / `Pick<T, ...>` - 안쪽 타입 필드를 가감.
            Some(Token::Ident(n)) if n == "Omit" || n == "Pick" => {
                // `Omit`부터 `>`까지 걸치게 - 안쪽이 객체가 아니면(NonObjectUtil) 표기 전체를
                // 탓한다. 안쪽 타입만 짚으려면 Type이 저마다 위치를 들어야 해 과하다.
                let start = self.here();
                let util = self.ident()?;
                self.expect(&Token::Lt)?;
                let inner = Box::new(self.type_expr()?);
                self.expect(&Token::Comma)?;
                let keys = self.type_keys()?;
                self.expect(&Token::Gt)?;
                let range = NodeRange(SrcRange {
                    start: start.start,
                    end: self.just_read().end,
                });
                if util == "Omit" {
                    Type::Omit(inner, keys, range)
                } else {
                    Type::Pick(inner, keys, range)
                }
            }
            // 대문자로 시작하는 식별자 = 다른 컴포넌트를 타입으로 참조(`general: Section`).
            Some(Token::Ident(n)) if n.starts_with(char::is_uppercase) => {
                Type::Ref(self.ident_at()?)
            }
            other => {
                let kind = ParseErrorKind::Expected {
                    want: "bool, number, string, {, or component name".into(),
                    got: shown(other),
                };
                return Err(self.err_here(kind));
            }
        };
        // 후위 [] 반복: string[] -> Array(String), number[][] -> Array(Array(Number)).
        while matches!(self.peek(), Some(Token::LBracket)) {
            self.next()?;
            self.expect(&Token::RBracket)?;
            ty = Type::Array(Box::new(ty));
        }
        Ok(ty)
    }

    // KEYS = TYPEKEY ("|" TYPEKEY)*  - 유틸 타입의 키 목록(`'a'` 또는 `'a' | 'b'`).
    // 키는 작은따옴표 타입 키(Token::TypeKey) - 큰따옴표 값 리터럴과 구분한다.
    fn type_keys(&mut self) -> Result<Vec<Ident>, ParseError> {
        let mut keys = vec![self.type_key()?];
        while matches!(self.peek(), Some(Token::Pipe)) {
            self.next()?;
            keys.push(self.type_key()?);
        }
        Ok(keys)
    }

    // 타입 키(작은따옴표) 하나를 소비해 그 값과 자리를 돌려준다. 안쪽에 없는 키면(UnknownKey)
    // 그 자리를 탓한다.
    fn type_key(&mut self) -> Result<Ident, ParseError> {
        match self.next()? {
            Token::TypeKey(s) => {
                let name = s.clone();
                Ok(Ident {
                    name,
                    range: NodeRange(self.just_read()),
                })
            }
            other => {
                let kind = ParseErrorKind::Expected {
                    want: "type key (`'...'`)".into(),
                    got: format!("{other}"),
                };
                Err(self.err_read(kind))
            }
        }
    }

    // OBJECT = { (IDENT : TYPE (, IDENT : TYPE)* ,?)? }  - 필드 선언 순서 보존.
    // 구분자 콤마 필수, 마지막 필드 뒤만 생략 가능(trailing 콤마 허용).
    fn object_type(&mut self) -> Result<Type, ParseError> {
        self.expect(&Token::LBrace)?;
        let mut fields = Vec::new();
        while !matches!(self.peek(), Some(Token::RBrace) | None) {
            let name = self.ident()?;
            self.expect(&Token::Colon)?;
            let ty = self.type_expr()?;
            fields.push((name, ty));
            // 필드 뒤가 }면 종료(마지막 생략), 아니면 콤마 필수(소비 후 계속).
            // trailing 콤마는 다음 루프에서 }를 만나 종료한다.
            if matches!(self.peek(), Some(Token::RBrace)) {
                break;
            }
            self.expect(&Token::Comma)?;
        }
        self.expect(&Token::RBrace)?;
        Ok(Type::Object(fields))
    }

    // events { EVENT* }   - EVENT = NAME ( { PAYLOAD } )
    fn events(&mut self) -> Result<Vec<Event>, ParseError> {
        self.keyword("events")?;
        self.expect(&Token::LBrace)?;
        let mut events = Vec::new();
        while matches!(self.peek(), Some(Token::Ident(_))) {
            events.push(self.event_decl()?);
        }
        self.expect(&Token::RBrace)?;
        Ok(events)
    }

    // NAME ( { PAYLOAD } )   - TOGGLE({ label: title, on })
    fn event_decl(&mut self) -> Result<Event, ParseError> {
        let name = self.ident()?;
        self.expect(&Token::LParen)?;
        self.expect(&Token::LBrace)?;
        let payload = self.payload()?;
        self.expect(&Token::RBrace)?;
        self.expect(&Token::RParen)?;
        Ok(Event { name, payload })
    }

    // RBrace 전까지 payload 필드를 모은다. 각 필드는 `field`, `field: prop`, 또는 `field: "lit"`.
    // 단축형 `field`는 (field, Var(field))로 푼다(필드명 = prop명). 콤마는 선택적 구분자.
    fn payload(&mut self) -> Result<Vec<(String, ArgValue)>, ParseError> {
        let mut payload = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RBrace) | None => break,
                Some(Token::Comma) => {
                    self.next()?;
                }
                Some(Token::Ident(_)) => {
                    let field = self.ident()?;
                    // `: 값` 매핑이 있으면 값은 prop명(Var) 또는 리터럴(Literal),
                    // 없으면 단축형(field = prop, Var).
                    let value = if matches!(self.peek(), Some(Token::Colon)) {
                        self.next()?; // :
                        self.field_value()?
                    } else {
                        // 단축형은 필드명이 곧 prop 참조라 그 이름 토큰이 구간이다.
                        ArgValue::Var(VarRef {
                            root: field.clone(),
                            path: Vec::new(),
                            range: NodeRange(self.just_read()),
                        })
                    };
                    payload.push((field, value));
                }
                Some(t) => {
                    let kind = ParseErrorKind::Expected {
                        want: "payload field or }".into(),
                        got: format!("{t}"),
                    };
                    return Err(self.err_here(kind));
                }
            }
        }
        Ok(payload)
    }

    // contexts { CONTEXT* }   - CONTEXT = NAME { FIELD* }
    fn contexts(&mut self) -> Result<Vec<Context>, ParseError> {
        self.keyword("contexts")?;
        self.expect(&Token::LBrace)?;
        let mut contexts = Vec::new();
        while matches!(self.peek(), Some(Token::Ident(_))) {
            contexts.push(self.context_decl()?);
        }
        self.expect(&Token::RBrace)?;
        Ok(contexts)
    }

    // NAME { key: 값, ... }   - ActionArea { section: "actions", userId: assignee }
    fn context_decl(&mut self) -> Result<Context, ParseError> {
        let name = self.ident()?;
        self.expect(&Token::LBrace)?;
        let fields = self.context_fields()?;
        self.expect(&Token::RBrace)?;
        Ok(Context { name, fields })
    }

    // RBrace 전까지 `key`, `key: prop`, 또는 `key: "lit"` 필드를 모은다. 값은 prop명(Var) 또는
    // 리터럴 문자열(Literal). 단축형 `key`는 (key, Var(key))로 푼다. 콤마는 선택적 구분자.
    fn context_fields(&mut self) -> Result<Vec<(String, ArgValue)>, ParseError> {
        let mut fields = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RBrace) | None => break,
                Some(Token::Comma) => {
                    self.next()?;
                }
                Some(Token::Ident(_)) => {
                    let key = self.ident()?;
                    // `: 값` 매핑이 있으면 값은 prop명(Var) 또는 리터럴(Literal),
                    // 없으면 단축형(key = prop, Var).
                    let value = if matches!(self.peek(), Some(Token::Colon)) {
                        self.next()?; // :
                        self.field_value()?
                    } else {
                        // 단축형은 키가 곧 prop 참조라 그 이름 토큰이 구간이다.
                        ArgValue::Var(VarRef {
                            root: key.clone(),
                            path: Vec::new(),
                            range: NodeRange(self.just_read()),
                        })
                    };
                    fields.push((key, value));
                }
                Some(t) => {
                    let kind = ParseErrorKind::Expected {
                        want: "context field or }".into(),
                        got: format!("{t}"),
                    };
                    return Err(self.err_here(kind));
                }
            }
        }
        Ok(fields)
    }

    // RBrace를 만날 때까지 노드를 모은다.
    fn nodes(&mut self) -> Result<Vec<Node>, ParseError> {
        let mut nodes = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RBrace) | None => break,
                _ => nodes.push(self.node()?),
            }
        }
        Ok(nodes)
    }

    // 노드 하나. 슬롯 채움(`Header << 노드`)도 오른쪽에 노드 하나를 받아 이걸 공유한다.
    fn node(&mut self) -> Result<Node, ParseError> {
        match self.peek() {
            Some(Token::Str(_)) => match self.next()? {
                Token::Str(s) => Ok(Node::Text(s.clone())),
                // 위 peek이 Str임을 확인했으므로 도달 불가.
                got => {
                    let kind = ParseErrorKind::Expected {
                        want: "string".into(),
                        got: format!("{got}"),
                    };
                    Err(self.err_read(kind))
                }
            },
            // `{ IDENT }` 보간. (자식 자리의 `{`는 블록이 아니라 보간만 온다.)
            Some(Token::LBrace) => self.var(),
            // @if 분기.
            Some(Token::At(Directive::If)) => self.if_node(),
            // @for 반복.
            Some(Token::At(Directive::For)) => self.for_node(),
            // @with 컨텍스트.
            Some(Token::At(Directive::With)) => self.with_node(),
            // @slot 정의 - 자식 콘텐츠가 들어갈 자리.
            Some(Token::At(Directive::Slot)) => self.slot_node(),
            // 대문자 시작 = 컴포넌트 호출(합성), 소문자 = HTML 태그.
            Some(Token::Ident(s)) if starts_upper(s) => self.component_call(),
            Some(Token::Ident(_)) => self.element(),
            got => {
                let kind = ParseErrorKind::Expected {
                    want: "node (element, string, or {var})".into(),
                    got: shown(got),
                };
                Err(self.err_here(kind))
            }
        }
    }

    // @slot( [IDENT] ) - 이름 생략(`@slot()`)이면 무기명.
    // 괄호는 필수다: 렉서가 줄바꿈을 안 넘겨 `@slot` 뒤 Ident가 슬롯명인지 다음 형제 노드인지
    // (`@slot` 다음 줄의 `p()`) 가릴 수 없다. 괄호가 그 경계를 준다(@if/@for와 같은 축).
    fn slot_node(&mut self) -> Result<Node, ParseError> {
        // `@slot`부터 `)`까지 - 무기명은 탓할 이름이 없어 이 자리를 쓴다.
        let start = self.here();
        self.expect(&Token::At(Directive::Slot))?;
        self.expect(&Token::LParen)?;
        let name = match self.peek() {
            Some(Token::Ident(_)) => Some(self.ident_at()?),
            _ => None,
        };
        self.expect(&Token::RParen)?;
        Ok(Node::SlotPlaceholderDef {
            name,
            range: NodeRange(SrcRange {
                start: start.start,
                end: self.just_read().end,
            }),
        })
    }

    // @if ( EXPR ) { NODE* } [ @else { NODE* } ]
    fn if_node(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::At(Directive::If))?;
        self.expect(&Token::LParen)?;
        let cond = self.expr()?;
        self.expect(&Token::RParen)?;
        self.expect(&Token::LBrace)?;
        let then = self.nodes()?;
        self.expect(&Token::RBrace)?;

        // @else는 선택적.
        let else_ = if matches!(self.peek(), Some(Token::At(Directive::Else))) {
            self.next()?; // @else
            self.expect(&Token::LBrace)?;
            let nodes = self.nodes()?;
            self.expect(&Token::RBrace)?;
            nodes
        } else {
            Vec::new()
        };

        Ok(Node::If { cond, then, else_ })
    }

    // @for ( IDENT [, IDENT] of ( NUM | VAR_REF ) ) { NODE* }
    // count는 정수 리터럴(of 3) 또는 숫자 prop 참조(of count). of는 문맥 키워드(Ident("of")).
    // 선택적 둘째 변수(, i)는 회차 인덱스변수 - 몸체 {i}/이벤트 $n이 읽는다(item과 별개 슬롯).
    fn for_node(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::At(Directive::For))?;
        self.expect(&Token::LParen)?;
        let item = self.ident_at()?;
        let index = if matches!(self.peek(), Some(Token::Comma)) {
            self.next()?; // ,
            Some(self.ident_at()?)
        } else {
            None
        };
        match self.next()? {
            Token::Ident(s) if s == "of" => {}
            got => {
                let kind = ParseErrorKind::Expected {
                    want: "of".into(),
                    got: format!("{got}"),
                };
                return Err(self.err_read(kind));
            }
        }
        let count = match self.peek() {
            Some(Token::Num(n)) => {
                let range = self.here(); // 아직 소비 전이라 이 숫자 토큰이 pos에 있다
                let count = n.parse::<u16>().map_err(|_| ParseError {
                    kind: ParseErrorKind::Expected {
                        want: "integer repeat count 0..=65535".into(),
                        got: format!("`{n}`"),
                    },
                    range,
                })?;
                self.next()?;
                ForCount::Literal(count)
            }
            _ => ForCount::Var(self.var_ref()?),
        };
        self.expect(&Token::RParen)?;
        self.expect(&Token::LBrace)?;
        let body = self.nodes()?;
        self.expect(&Token::RBrace)?;
        Ok(Node::For {
            item,
            index,
            count,
            body,
        })
    }

    // @with CONTEXT { NODE* }   - context는 이 컴포넌트 contexts에 선언된 이름.
    fn with_node(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::At(Directive::With))?;
        let context = self.ident_at()?;
        self.expect(&Token::LBrace)?;
        let children = self.nodes()?;
        self.expect(&Token::RBrace)?;
        Ok(Node::With { context, children })
    }

    // { IDENT(.IDENT)* }
    fn var(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::LBrace)?;
        let var = self.var_ref()?;
        self.expect(&Token::RBrace)?;
        Ok(Node::Var(var))
    }

    // [ALIAS :] COMP ( ARG*  /)   - 대문자 컴포넌트 호출. ARG = prop = { var }.
    // `Alias: Comp(...)`면 앞 Ident가 use-site 별칭(fullname 세그먼트). 없으면 type-name.
    // node 자리의 `대문자Ident :`는 alias뿐이라, 한 칸 앞 콜론으로 갈리고 모호하지 않다.
    // 슬롯(자식 노드)은 아직 미지원 - 블록은 비어야 한다.
    fn component_call(&mut self) -> Result<Node, ParseError> {
        let alias = if matches!(self.tokens.get(self.pos + 1), Some(Token::Colon)) {
            let alias = self.ident()?;
            self.expect(&Token::Colon)?;
            Some(alias)
        } else {
            None
        };
        let name = self.ident_at()?;
        self.expect(&Token::LParen)?;
        let args = self.component_args()?;
        // 슬롯을 안 채우면 self-close(`Comp( ... /)`), 채우면 `)` 뒤 자식 블록.
        // `/` 앞 공백 강제(SYNTAX #3.1.1, DESIGN #4.5).
        let contents = match self.peek() {
            Some(Token::Slash(spaced)) => {
                if !spaced {
                    let kind = ParseErrorKind::Expected {
                        want: "space before `/` (self-close)".into(),
                        got: "`/` without preceding space".into(),
                    };
                    // 아직 `/`를 소비하지 않았다 - 공백이 빠진 그 `/`를 가리킨다.
                    return Err(self.err_here(kind));
                }
                self.next()?; // /
                self.expect(&Token::RParen)?;
                Vec::new()
            }
            _ => {
                self.expect(&Token::RParen)?;
                self.slot_placeholder_contents(&name.name)?
            }
        };
        Ok(Node::Component {
            alias,
            name,
            args,
            contents,
        })
    }

    // 합성의 자식 블록 `{ ... }`을 슬롯 콘텐츠로 읽는다. 두 형태가 갈리고 섞을 수 없다(SYNTAX #3.3):
    // - 기명: `Header << 노드` 들만. `<<` 오른쪽은 노드 하나 또는 블록(`Header << { ... }`).
    // - 무기명: 그 외 노드들. 블록 전체가 무기명 슬롯 콘텐츠 하나가 된다.
    fn slot_placeholder_contents(
        &mut self,
        comp: &str,
    ) -> Result<Vec<SlotPlaceholderContent>, ParseError> {
        self.expect(&Token::LBrace)?;
        let mut named: Vec<SlotPlaceholderContent> = Vec::new();
        let mut anonymous: Vec<Node> = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RBrace) | None => break,
                // `Ident <<` = 기명 슬롯 채움. 한 칸 앞 `<<`로 갈려 일반 노드와 모호하지 않다.
                Some(Token::Ident(_))
                    if matches!(self.tokens.get(self.pos + 1), Some(Token::LtLt)) =>
                {
                    // 중복 검사는 콘텐츠까지 읽은 뒤라 그때 just_read()를 쓰면 콘텐츠 끝을
                    // 가리킨다 - slot이 든 구간이 탓할 대상인 이름 자리다.
                    let slot = self.ident_at()?;
                    self.expect(&Token::LtLt)?;
                    // 오른쪽은 블록(여러 노드) 또는 노드 하나.
                    let nodes = match self.peek() {
                        Some(Token::LBrace) => {
                            self.next()?; // {
                            let nodes = self.nodes()?;
                            self.expect(&Token::RBrace)?;
                            nodes
                        }
                        _ => vec![self.node()?],
                    };
                    if named
                        .iter()
                        .any(|c| c.name.as_ref().map(|n| n.name.as_str()) == Some(&slot.name))
                    {
                        return Err(ParseError {
                            kind: ParseErrorKind::DuplicateSlotPlaceholderFill {
                                comp: comp.to_string(),
                                slot: slot.name,
                            },
                            range: slot.range.0,
                        });
                    }
                    named.push(SlotPlaceholderContent {
                        name: Some(slot),
                        nodes,
                    });
                }
                _ => anonymous.push(self.node()?),
            }
        }
        self.expect(&Token::RBrace)?;
        // 아래 둘은 블록 전체가 문제라 방금 읽은 닫는 `}`를 가리킨다.
        // 무기명/기명은 정의 쪽에서 이미 갈리므로 사용 쪽에서 섞이면 어느 쪽도 성립하지 않는다.
        if !named.is_empty() && !anonymous.is_empty() {
            let kind = ParseErrorKind::MixedSlotPlaceholderFill {
                comp: comp.to_string(),
            };
            return Err(self.err_read(kind));
        }
        match named.is_empty() {
            // 빈 블록(`Comp() { }`)은 self-close로 쓴다 - 빈 블록 금지(DESIGN #4.5).
            true if anonymous.is_empty() => {
                Err(self.err_read(ParseErrorKind::EmptyBlock(comp.to_string())))
            }
            true => Ok(vec![SlotPlaceholderContent {
                name: None,
                nodes: anonymous,
            }]),
            false => Ok(named),
        }
    }

    // RParen 전까지 `prop = {var}`(부모 변수) 또는 `prop = "lit"`(리터럴) 인자를 모은다.
    // 공백 구분(콤마 없음).
    fn component_args(&mut self) -> Result<Vec<(Ident, ArgValue)>, ParseError> {
        let mut args = Vec::new();
        loop {
            match self.peek() {
                // Slash = self-close 마커(args 끝). 여기서 멈춰 component_call이 처리한다.
                Some(Token::RParen | Token::Slash(_)) | None => break,
                Some(Token::Ident(_)) => {
                    let prop = self.ident_at()?;
                    self.expect(&Token::Eq)?;
                    // 값은 `{var}`(부모 변수, 슬롯 공유) 또는 리터럴(`"str"`, `42`, `true` - 독립 값).
                    let value = match self.peek() {
                        Some(Token::LBrace) => {
                            self.next()?; // {
                            let var = self.var_ref()?;
                            self.expect(&Token::RBrace)?;
                            ArgValue::Var(var)
                        }
                        Some(Token::Str(_) | Token::Num(_) | Token::Bool(_)) => {
                            ArgValue::Literal(self.lit_value()?)
                        }
                        got => {
                            let kind = ParseErrorKind::Expected {
                                want: "component arg value ({var}, \"str\", 42, true)".into(),
                                got: shown(got),
                            };
                            return Err(self.err_here(kind));
                        }
                    };
                    args.push((prop, value));
                }
                Some(t) => {
                    let kind = ParseErrorKind::Expected {
                        want: "component arg (prop={var} or prop=\"lit\") or )".into(),
                        got: format!("{t}"),
                    };
                    return Err(self.err_here(kind));
                }
            }
        }
        Ok(args)
    }

    // IDENT ( (ATTR | @click:EVENT)* [/] ) [{ NODE* }]
    // self-close(`tag(attrs /)`)면 자식 블록을 안 읽는다. void 요소(input/img 등)는
    // self-close가 필수 - 아니면 에러(SYNTAX #3.1.1, DESIGN #4.5).
    fn element(&mut self) -> Result<Node, ParseError> {
        // 아래 void/빈블록 검사는 여는 태그를 다 읽은 뒤라 그때는 태그 이름이 pos에서 멀다 -
        // 두 에러는 tag가 든 구간을 쓴다(codegen의 UnknownTag도 같은 자리를 쓴다).
        let tag = self.ident_at()?;
        self.expect(&Token::LParen)?;
        let (attrs, event_bindings) = self.attrs()?;
        // attrs 뒤가 `/`면 self-close. 확정 문법상 `/` 앞 공백 필수.
        let self_close = match self.peek() {
            Some(Token::Slash(spaced)) => {
                if !spaced {
                    let kind = ParseErrorKind::Expected {
                        want: "space before `/` (self-close)".into(),
                        got: "`/` without preceding space".into(),
                    };
                    // 아직 `/`를 소비하지 않았다 - 공백이 빠진 그 `/`를 가리킨다.
                    return Err(self.err_here(kind));
                }
                self.next()?; // /
                true
            }
            _ => false,
        };
        self.expect(&Token::RParen)?;

        if is_void_tag(&tag.name) && !self_close {
            return Err(ParseError {
                kind: ParseErrorKind::Expected {
                    want: format!("self-close for void element ({}( ... /))", tag.name),
                    got: format!("void element `{}` with a child block", tag.name),
                },
                range: tag.range.0,
            });
        }

        let children = if self_close {
            Vec::new()
        } else {
            self.expect(&Token::LBrace)?;
            let children = self.nodes()?;
            self.expect(&Token::RBrace)?;
            // 자식 없으면 self-close 필수 - 빈 블록 금지(SYNTAX #3.1.1, DESIGN #4.5).
            if children.is_empty() {
                return Err(ParseError {
                    kind: ParseErrorKind::Expected {
                        want: format!("self-close for childless element ({}( ... /))", tag.name),
                        got: "an empty child block".into(),
                    },
                    range: tag.range.0,
                });
            }
            children
        };
        Ok(Node::Element {
            tag,
            attrs,
            event_bindings,
            children,
        })
    }

    // RParen 전까지 ATTR과 이벤트 바인딩(`@click:EVENT`)을 모은다. 콤마는 선택적 구분자.
    // 둘이 같은 괄호 안에 섞여 와 한 번에 모으고 (attrs, event_bindings)로 가른다.
    #[allow(clippy::type_complexity)]
    fn attrs(&mut self) -> Result<(Vec<(String, AttrValue)>, Vec<(String, Ident)>), ParseError> {
        let mut attrs = Vec::new();
        let mut event_bindings = Vec::new();
        loop {
            match self.peek() {
                // Slash = self-close 마커. attrs 끝(여는 태그 마지막 토큰)이므로 여기서 멈춘다.
                Some(Token::RParen | Token::Slash(_)) | None => break,
                // `@click:EVENT` - DOM 이벤트 바인딩. 디렉티브는 닫힌 집합(Directive).
                Some(Token::At(_)) => {
                    // next()가 빌려준 토큰을 아래 두 팔이 쓰고 있어 그 안에서 just_read()를
                    // 못 부른다(self 재빌림) - 소비 전에 이 `@...` 자리를 잡아 공유한다.
                    let directive_range = self.here();
                    let dom_event = match self.next()? {
                        Token::At(directive) => match directive.dom_event_name() {
                            Some(name) => name.to_string(),
                            None => {
                                let kind = ParseErrorKind::Expected {
                                    want: "DOM event directive (e.g. @click)".into(),
                                    got: format!("{directive}"),
                                };
                                return Err(ParseError {
                                    kind,
                                    range: directive_range,
                                });
                            }
                        },
                        got => {
                            let kind = ParseErrorKind::Expected {
                                want: "DOM event directive (e.g. @click)".into(),
                                got: format!("{got}"),
                            };
                            return Err(ParseError {
                                kind,
                                range: directive_range,
                            });
                        }
                    };
                    self.expect(&Token::Colon)?;
                    let event_name = self.ident_at()?;
                    event_bindings.push((dom_event, event_name));
                }
                Some(Token::Ident(_)) => {
                    let name = self.ident()?;
                    self.expect(&Token::Eq)?;
                    // 값은 정적 문자열(`="card"`) 또는 변수(`={x}`).
                    let value = match self.peek() {
                        Some(Token::Str(_)) => match self.next()? {
                            Token::Str(s) => AttrValue::Static(s.clone()),
                            _ => unreachable!(),
                        },
                        Some(Token::LBrace) => {
                            self.next()?; // {
                            let var = self.var_ref()?;
                            self.expect(&Token::RBrace)?;
                            AttrValue::Var(var)
                        }
                        got => {
                            let kind = ParseErrorKind::Expected {
                                want: "attribute value (string or {var})".into(),
                                got: shown(got),
                            };
                            return Err(self.err_here(kind));
                        }
                    };
                    attrs.push((name, value));
                }
                Some(t) => {
                    let kind = ParseErrorKind::Expected {
                        want: "attribute name, @event, or )".into(),
                        got: format!("{t}"),
                    };
                    return Err(self.err_here(kind));
                }
            }
        }
        Ok((attrs, event_bindings))
    }
}

/// 식별자가 대문자로 시작하나 - 컴포넌트 호출(true) vs HTML 태그(false) 구분.
fn starts_upper(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_uppercase())
}

/// HTML void 요소(자식을 못 갖는 태그). self-close가 필수다(SYNTAX #3.1.1).
fn is_void_tag(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "source"
            | "track"
            | "wbr"
    )
}
