//! 렉서: `.qubc` 소스를 토큰으로. MVP 문법만 — 식별자, 괄호/중괄호, `=`, `,`, 문자열.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    Ident(String),
    Str(String),
    LBrace, // {
    RBrace, // }
    LParen, // (
    RParen, // )
    Eq,     // =
    Comma,  // ,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LexError {
    UnterminatedString,
    UnexpectedChar(char),
}

pub fn lex(src: &str) -> Result<Vec<Token>, LexError> {
    let mut toks = Vec::new();
    let mut chars = src.chars().peekable();

    while let Some(&c) = chars.peek() {
        match c {
            c if c.is_whitespace() => {
                chars.next();
            }
            '{' => {
                chars.next();
                toks.push(Token::LBrace);
            }
            '}' => {
                chars.next();
                toks.push(Token::RBrace);
            }
            '(' => {
                chars.next();
                toks.push(Token::LParen);
            }
            ')' => {
                chars.next();
                toks.push(Token::RParen);
            }
            '=' => {
                chars.next();
                toks.push(Token::Eq);
            }
            ',' => {
                chars.next();
                toks.push(Token::Comma);
            }
            '"' => {
                chars.next(); // 여는 따옴표
                let mut s = String::new();
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some(ch) => s.push(ch),
                        None => return Err(LexError::UnterminatedString),
                    }
                }
                toks.push(Token::Str(s));
            }
            c if is_ident_start(c) => {
                let mut s = String::new();
                while let Some(&ch) = chars.peek() {
                    if is_ident_part(ch) {
                        s.push(ch);
                        chars.next();
                    } else {
                        break;
                    }
                }
                toks.push(Token::Ident(s));
            }
            other => return Err(LexError::UnexpectedChar(other)),
        }
    }
    Ok(toks)
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}
