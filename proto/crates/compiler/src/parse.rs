//! 재귀하강 파서: 토큰 → AST. MVP 문법.
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
    ArgValue, AttrValue, Component, Context, Event, ForCount, LitValue, Node, Prop, SourceFile,
    Type, Use, VarRef,
};
use crate::lexer::{Directive, Token};

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    UnexpectedEnd,
    Expected { want: String, got: String },
}

/// `use` 문 한 줄의 두 형태. 컴포넌트 import(`use A from "..."`)와 리소스(`use "..."`)는
/// 같은 키워드로 시작하지만 다른 곳에 모인다(전자는 use 그래프, 후자는 SourceFile.resources).
enum UseDecl {
    Component(Use),
    Resource(String),
}

/// 한 소스를 파싱. 최상위 use 문(있으면 component 앞)과 컴포넌트 정의들을 모은다.
/// 컴포넌트 정의 순서는 codegen에서 의미를 갖지 않는다(CompLookup이 forward 참조 허용).
pub fn parse(tokens: &[Token]) -> Result<SourceFile, ParseError> {
    let mut p = Parser { tokens, pos: 0 };
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
                return Err(ParseError::Expected {
                    want: "use or component".into(),
                    got: other.to_string(),
                })
            }
        }
    }
    // 토큰이 남았는데 Ident가 아니면 최상위에 올 수 없는 토큰.
    if let Some(t) = p.peek() {
        return Err(ParseError::Expected {
            want: "use or component".into(),
            got: format!("{t:?}"),
        });
    }
    Ok(SourceFile {
        uses,
        resources,
        comps,
    })
}

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Result<&Token, ParseError> {
        let t = self.tokens.get(self.pos).ok_or(ParseError::UnexpectedEnd)?;
        self.pos += 1;
        Ok(t)
    }

    fn expect(&mut self, want: &Token) -> Result<(), ParseError> {
        let got = self.next()?;
        if got == want {
            Ok(())
        } else {
            Err(ParseError::Expected {
                want: format!("{want:?}"),
                got: format!("{got:?}"),
            })
        }
    }

    fn ident(&mut self) -> Result<String, ParseError> {
        match self.next()? {
            Token::Ident(s) => Ok(s.clone()),
            got => Err(ParseError::Expected {
                want: "identifier".into(),
                got: format!("{got:?}"),
            }),
        }
    }

    // prop 참조 하나: `root` 또는 `root.field.field…`. root는 prop 이름, 뒤는 객체 필드 경로.
    // leaf 여부(경로 끝이 원시냐)는 여기서 안 본다 - 타입을 모르는 파서의 몫이 아니라 codegen이
    // props 타입과 대조해 판단한다.
    fn var_ref(&mut self) -> Result<VarRef, ParseError> {
        let root = self.ident()?;
        let mut path = Vec::new();
        while matches!(self.peek(), Some(Token::Dot)) {
            self.next()?;
            path.push(self.ident()?);
        }
        Ok(VarRef { root, path })
    }

    /// 값 자리(payload/context/합성 인자)의 값 하나: Ident면 prop 참조(Var), 그 외 리터럴 토큰
    /// (Str/Num/Bool)이면 타입대로 Literal.
    fn field_value(&mut self) -> Result<ArgValue, ParseError> {
        match self.peek() {
            Some(Token::Ident(_)) => Ok(ArgValue::Var(self.var_ref()?)),
            Some(Token::Str(_) | Token::Num(_) | Token::Bool(_)) => {
                Ok(ArgValue::Literal(self.lit_value()?))
            }
            got => Err(ParseError::Expected {
                want: "value (prop, \"str\", 42, true)".into(),
                got: format!("{got:?}"),
            }),
        }
    }

    /// 리터럴 토큰 하나를 LitValue로 소비. 숫자는 f64로 파싱한다(원문이 렉서를 통과해도
    /// 형태가 어긋나면 여기서 잡힌다). 호출부가 리터럴 토큰임을 확인한 뒤 부른다.
    fn lit_value(&mut self) -> Result<LitValue, ParseError> {
        match self.next()? {
            Token::Str(s) => Ok(LitValue::Str(s.clone())),
            Token::Bool(b) => Ok(LitValue::Bool(*b)),
            Token::Num(n) => {
                n.parse::<f64>()
                    .map(LitValue::Number)
                    .map_err(|_| ParseError::Expected {
                        want: "number literal".into(),
                        got: n.clone(),
                    })
            }
            got => Err(ParseError::Expected {
                want: "literal (\"str\", 42, true)".into(),
                got: format!("{got:?}"),
            }),
        }
    }

    /// 특정 키워드 식별자를 기대.
    fn keyword(&mut self, kw: &str) -> Result<(), ParseError> {
        let s = self.ident()?;
        if s == kw {
            Ok(())
        } else {
            Err(ParseError::Expected {
                want: kw.into(),
                got: s,
            })
        }
    }

    // 컴포넌트 import:  use IDENT (, IDENT)* from STRING
    // 리소스:           use STRING
    fn use_decl(&mut self) -> Result<UseDecl, ParseError> {
        self.keyword("use")?;
        // `use` 다음이 문자열이면 리소스(컴포넌트명·from 없음).
        if let Some(Token::Str(path)) = self.peek() {
            let path = path.clone();
            self.next()?;
            return Ok(UseDecl::Resource(path));
        }
        let mut names = Vec::new();
        names.push(self.ident()?);
        while matches!(self.peek(), Some(Token::Comma)) {
            self.next()?;
            names.push(self.ident()?);
        }
        self.keyword("from")?;
        let path = match self.next()? {
            Token::Str(s) => s.clone(),
            got => {
                return Err(ParseError::Expected {
                    want: "string path".into(),
                    got: format!("{got:?}"),
                })
            }
        };
        Ok(UseDecl::Component(Use { names, path }))
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

        // contexts 블록도 선택적이며 props 다음, events 앞에 온다(SYNTAX.md §1).
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
                let util = self.ident()?;
                self.expect(&Token::Lt)?;
                let inner = Box::new(self.type_expr()?);
                self.expect(&Token::Comma)?;
                let keys = self.type_keys()?;
                self.expect(&Token::Gt)?;
                if util == "Omit" {
                    Type::Omit(inner, keys)
                } else {
                    Type::Pick(inner, keys)
                }
            }
            // 대문자로 시작하는 식별자 = 다른 컴포넌트를 타입으로 참조(`general: Section`).
            Some(Token::Ident(n)) if n.starts_with(char::is_uppercase) => {
                let name = self.ident()?;
                Type::Ref(name)
            }
            other => {
                return Err(ParseError::Expected {
                    want: "bool, number, string, {, or 컴포넌트명".into(),
                    got: format!("{other:?}"),
                })
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
    fn type_keys(&mut self) -> Result<Vec<String>, ParseError> {
        let mut keys = vec![self.type_key()?];
        while matches!(self.peek(), Some(Token::Pipe)) {
            self.next()?;
            keys.push(self.type_key()?);
        }
        Ok(keys)
    }

    // 타입 키(작은따옴표) 하나를 소비해 그 값을 돌려준다.
    fn type_key(&mut self) -> Result<String, ParseError> {
        match self.next()? {
            Token::TypeKey(s) => Ok(s.clone()),
            other => Err(ParseError::Expected {
                want: "타입 키('...')".into(),
                got: format!("{other:?}"),
            }),
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
                        ArgValue::Var(VarRef {
                            root: field.clone(),
                            path: Vec::new(),
                        })
                    };
                    payload.push((field, value));
                }
                Some(t) => {
                    return Err(ParseError::Expected {
                        want: "payload field or }".into(),
                        got: format!("{t:?}"),
                    })
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
                        ArgValue::Var(VarRef {
                            root: key.clone(),
                            path: Vec::new(),
                        })
                    };
                    fields.push((key, value));
                }
                Some(t) => {
                    return Err(ParseError::Expected {
                        want: "context field or }".into(),
                        got: format!("{t:?}"),
                    })
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
                Some(Token::Str(_)) => {
                    if let Token::Str(s) = self.next()? {
                        nodes.push(Node::Text(s.clone()));
                    }
                }
                // `{ IDENT }` 보간. (자식 자리의 `{`는 블록이 아니라 보간만 온다.)
                Some(Token::LBrace) => nodes.push(self.var()?),
                // @if 분기.
                Some(Token::At(Directive::If)) => nodes.push(self.if_node()?),
                // @for 반복.
                Some(Token::At(Directive::For)) => nodes.push(self.for_node()?),
                // @with 컨텍스트.
                Some(Token::At(Directive::With)) => nodes.push(self.with_node()?),
                // 대문자 시작 = 컴포넌트 호출(합성), 소문자 = HTML 태그.
                Some(Token::Ident(s)) if starts_upper(s) => nodes.push(self.component_call()?),
                Some(Token::Ident(_)) => nodes.push(self.element()?),
                Some(t) => {
                    return Err(ParseError::Expected {
                        want: "node (element, string, or {var})".into(),
                        got: format!("{t:?}"),
                    })
                }
            }
        }
        Ok(nodes)
    }

    // @if ( IDENT ) { NODE* } [ @else { NODE* } ]
    // cond는 불리언 prop 참조(경로 허용, `gen.open`). 표현식은 이후 단계.
    fn if_node(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::At(Directive::If))?;
        self.expect(&Token::LParen)?;
        let cond = self.var_ref()?;
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

    // @for ( IDENT of ( NUM | VAR_REF ) ) { NODE* }
    // count는 정수 리터럴(of 3) 또는 숫자 prop 참조(of count). of는 문맥 키워드(Ident("of")).
    fn for_node(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::At(Directive::For))?;
        self.expect(&Token::LParen)?;
        let item = self.ident()?;
        match self.next()? {
            Token::Ident(s) if s == "of" => {}
            got => {
                return Err(ParseError::Expected {
                    want: "of".into(),
                    got: format!("{got:?}"),
                })
            }
        }
        let count = match self.peek() {
            Some(Token::Num(n)) => {
                let count = n.parse::<u16>().map_err(|_| ParseError::Expected {
                    want: "0..=65535 정수 반복 횟수".into(),
                    got: n.clone(),
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
        Ok(Node::For { item, count, body })
    }

    // @with CONTEXT { NODE* }   - context는 이 컴포넌트 contexts에 선언된 이름.
    fn with_node(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::At(Directive::With))?;
        let context = self.ident()?;
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

    // [ALIAS :] COMP ( ARG* ) { }   - 대문자 컴포넌트 호출. ARG = prop = { var }.
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
        let name = self.ident()?;
        self.expect(&Token::LParen)?;
        let args = self.component_args()?;
        self.expect(&Token::RParen)?;
        self.expect(&Token::LBrace)?;
        let children = self.nodes()?;
        if !children.is_empty() {
            return Err(ParseError::Expected {
                want: "empty component body (슬롯 미지원)".into(),
                got: format!("{} child node(s)", children.len()),
            });
        }
        self.expect(&Token::RBrace)?;
        Ok(Node::Component { alias, name, args })
    }

    // RParen 전까지 `prop = {var}`(부모 변수) 또는 `prop = "lit"`(리터럴) 인자를 모은다.
    // 공백 구분(콤마 없음).
    fn component_args(&mut self) -> Result<Vec<(String, ArgValue)>, ParseError> {
        let mut args = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RParen) | None => break,
                Some(Token::Ident(_)) => {
                    let prop = self.ident()?;
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
                            return Err(ParseError::Expected {
                                want: "component arg value ({var}, \"str\", 42, true)".into(),
                                got: format!("{got:?}"),
                            })
                        }
                    };
                    args.push((prop, value));
                }
                Some(t) => {
                    return Err(ParseError::Expected {
                        want: "component arg (prop={var} or prop=\"lit\") or )".into(),
                        got: format!("{t:?}"),
                    })
                }
            }
        }
        Ok(args)
    }

    // IDENT ( (ATTR | @click:EVENT)* ) { NODE* }
    fn element(&mut self) -> Result<Node, ParseError> {
        let tag = self.ident()?;
        self.expect(&Token::LParen)?;
        let (attrs, event_bindings) = self.attrs()?;
        self.expect(&Token::RParen)?;
        self.expect(&Token::LBrace)?;
        let children = self.nodes()?;
        self.expect(&Token::RBrace)?;
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
    fn attrs(&mut self) -> Result<(Vec<(String, AttrValue)>, Vec<(String, String)>), ParseError> {
        let mut attrs = Vec::new();
        let mut event_bindings = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RParen) | None => break,
                // `@click:EVENT` - DOM 이벤트 바인딩. 디렉티브는 닫힌 집합(Directive).
                Some(Token::At(_)) => {
                    let dom_event = match self.next()? {
                        Token::At(directive) => match directive.dom_event_name() {
                            Some(name) => name.to_string(),
                            None => {
                                return Err(ParseError::Expected {
                                    want: "DOM event directive (e.g. @click)".into(),
                                    got: format!("{directive:?}"),
                                })
                            }
                        },
                        got => {
                            return Err(ParseError::Expected {
                                want: "DOM event directive (e.g. @click)".into(),
                                got: format!("{got:?}"),
                            })
                        }
                    };
                    self.expect(&Token::Colon)?;
                    let event_name = self.ident()?;
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
                            return Err(ParseError::Expected {
                                want: "attribute value (string or {var})".into(),
                                got: format!("{got:?}"),
                            })
                        }
                    };
                    attrs.push((name, value));
                }
                Some(t) => {
                    return Err(ParseError::Expected {
                        want: "attribute name, @event, or )".into(),
                        got: format!("{t:?}"),
                    })
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
