//! 재귀하강 파서: 토큰 → AST. MVP 문법.
//!
//! component IDENT { [PROPS] template { NODE* } }
//! PROPS   = props { IDENT (, IDENT)* }       (선택)
//! NODE    = ELEMENT | STRING | VAR
//! VAR     = { IDENT }                         (props 보간)
//! ELEMENT = IDENT ( ATTR* ) { NODE* }
//! ATTR    = IDENT = STRING   (콤마 구분 허용)

use crate::ast::{Component, Node};
use crate::lexer::Token;

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    UnexpectedEnd,
    Expected { want: String, got: String },
}

pub fn parse(tokens: &[Token]) -> Result<Component, ParseError> {
    let mut p = Parser { tokens, pos: 0 };
    let c = p.component()?;
    p.expect_end()?;
    Ok(c)
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

    fn expect_end(&self) -> Result<(), ParseError> {
        match self.peek() {
            None => Ok(()),
            Some(t) => Err(ParseError::Expected {
                want: "end of input".into(),
                got: format!("{t:?}"),
            }),
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

        self.keyword("template")?;
        self.expect(&Token::LBrace)?;
        let template = self.nodes()?;
        self.expect(&Token::RBrace)?; // template
        self.expect(&Token::RBrace)?; // component
        Ok(Component { name, props, template })
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

    // { IDENT }
    fn var(&mut self) -> Result<Node, ParseError> {
        self.expect(&Token::LBrace)?;
        let name = self.ident()?;
        self.expect(&Token::RBrace)?;
        Ok(Node::Var(name))
    }

    // IDENT ( ATTR* ) { NODE* }
    fn element(&mut self) -> Result<Node, ParseError> {
        let tag = self.ident()?;
        self.expect(&Token::LParen)?;
        let attrs = self.attrs()?;
        self.expect(&Token::RParen)?;
        self.expect(&Token::LBrace)?;
        let children = self.nodes()?;
        self.expect(&Token::RBrace)?;
        Ok(Node::Element { tag, attrs, children })
    }

    // RParen 전까지 ATTR을 모은다. 콤마는 선택적 구분자.
    fn attrs(&mut self) -> Result<Vec<(String, String)>, ParseError> {
        let mut attrs = Vec::new();
        loop {
            match self.peek() {
                Some(Token::RParen) | None => break,
                Some(Token::Comma) => {
                    self.next()?;
                }
                Some(Token::Ident(_)) => {
                    let name = self.ident()?;
                    self.expect(&Token::Eq)?;
                    let value = match self.next()? {
                        Token::Str(s) => s.clone(),
                        got => {
                            return Err(ParseError::Expected {
                                want: "string attribute value".into(),
                                got: format!("{got:?}"),
                            })
                        }
                    };
                    attrs.push((name, value));
                }
                Some(t) => {
                    return Err(ParseError::Expected {
                        want: "attribute name or )".into(),
                        got: format!("{t:?}"),
                    })
                }
            }
        }
        Ok(attrs)
    }
}
