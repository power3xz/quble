//! 재귀하강 파서: 토큰 → AST. MVP 문법.
//!
//! component IDENT { [PROPS] template { NODE* } }
//! PROPS   = props { IDENT (, IDENT)* }       (선택)
//! NODE    = ELEMENT | STRING | VAR
//! VAR     = { IDENT }                         (props 보간)
//! ELEMENT = IDENT ( ATTR* ) { NODE* }
//! ATTR    = IDENT = STRING   (콤마 구분 허용)

use crate::ast::{ArgValue, AttrValue, Component, Event, Node, SourceFile, Use};
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
    Ok(SourceFile { uses, resources, comps })
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

        // events 블록도 선택적이며 props 다음, template 앞에 온다.
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
        Ok(Component { name, props, events, template })
    }

    // props { IDENT (, IDENT)* }
    fn props(&mut self) -> Result<Vec<String>, ParseError> {
        self.keyword("props")?;
        self.expect(&Token::LBrace)?;
        let mut props = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RBrace) | None => break,
                Some(Token::Comma) => {
                    self.next()?;
                }
                Some(Token::Ident(_)) => props.push(self.ident()?),
                Some(t) => {
                    return Err(ParseError::Expected {
                        want: "prop name or }".into(),
                        got: format!("{t:?}"),
                    })
                }
            }
        }
        self.expect(&Token::RBrace)?;
        Ok(props)
    }

    // events { EVENT* }   — EVENT = NAME ( { PAYLOAD } )
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

    // NAME ( { PAYLOAD } )   — TOGGLE({ label: title, on })
    fn event_decl(&mut self) -> Result<Event, ParseError> {
        let name = self.ident()?;
        self.expect(&Token::LParen)?;
        self.expect(&Token::LBrace)?;
        let payload = self.payload()?;
        self.expect(&Token::RBrace)?;
        self.expect(&Token::RParen)?;
        Ok(Event { name, payload })
    }

    // RBrace 전까지 payload 필드를 모은다. 각 필드는 `field` 또는 `field: prop`.
    // 단축형 `field`는 (field, field)로 푼다(필드명 = prop명). 콤마는 선택적 구분자.
    fn payload(&mut self) -> Result<Vec<(String, String)>, ParseError> {
        let mut payload = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RBrace) | None => break,
                Some(Token::Comma) => {
                    self.next()?;
                }
                Some(Token::Ident(_)) => {
                    let field = self.ident()?;
                    // `: prop` 매핑이 있으면 prop명을, 없으면 단축형(field = prop).
                    let prop = if matches!(self.peek(), Some(Token::Colon)) {
                        self.next()?; // :
                        self.ident()?
                    } else {
                        field.clone()
                    };
                    payload.push((field, prop));
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
    // cond는 불리언 prop명 하나(표현식은 이후 단계).
    fn if_node(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::At(Directive::If))?;
        self.expect(&Token::LParen)?;
        let cond = self.ident()?;
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

    // { IDENT }
    fn var(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::LBrace)?;
        let name = self.ident()?;
        self.expect(&Token::RBrace)?;
        Ok(Node::Var(name))
    }

    // [ALIAS :] COMP ( ARG* ) { }   — 대문자 컴포넌트 호출. ARG = prop = { var }.
    // `Alias: Comp(...)`면 앞 Ident가 use-site 별칭(fullname 세그먼트). 없으면 type-name.
    // node 자리의 `대문자Ident :`는 alias뿐이라, 한 칸 앞 콜론으로 갈리고 모호하지 않다.
    // 슬롯(자식 노드)은 아직 미지원 — 블록은 비어야 한다.
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
                    // 값은 `{var}`(부모 변수, 슬롯 공유) 또는 `"lit"`(리터럴, 독립 값).
                    let value = match self.peek() {
                        Some(Token::LBrace) => {
                            self.next()?; // {
                            let var = self.ident()?;
                            self.expect(&Token::RBrace)?;
                            ArgValue::Var(var)
                        }
                        Some(Token::Str(_)) => match self.next()? {
                            Token::Str(s) => ArgValue::Literal(s.clone()),
                            _ => unreachable!(),
                        },
                        got => {
                            return Err(ParseError::Expected {
                                want: "component arg value ({var} or \"lit\")".into(),
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
        Ok(Node::Element { tag, attrs, event_bindings, children })
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
                // `@click:EVENT` — DOM 이벤트 바인딩. 디렉티브는 닫힌 집합(Directive).
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
                            let var = self.ident()?;
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

/// 식별자가 대문자로 시작하나 — 컴포넌트 호출(true) vs HTML 태그(false) 구분.
fn starts_upper(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_uppercase())
}
