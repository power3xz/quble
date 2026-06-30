//! 렉서: `.qubc` 소스를 토큰으로. MVP 문법만 - 식별자, 괄호/중괄호, `=`, `,`, 문자열.

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
    Colon,  // :
    /// `@` 뒤에 오는 디렉티브. `@if` -> `At(Directive::If)`.
    At(Directive),
}

/// `@` 디렉티브. 분기(`@if`/`@else`)와 DOM 이벤트(`@click`).
/// DOM 이벤트는 닫힌 집합이라 여기 박는다(필요할 때 추가).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Directive {
    If,
    Else,
    With,
    Click,
    Input,
    Change,
    Submit,
    Focus,
    Blur,
    KeyDown,
    KeyUp,
    MouseDown,
    MouseUp,
    MouseEnter,
    MouseLeave,
    Scroll,
}

impl Directive {
    /// DOM 이벤트 디렉티브면 그 이벤트명, 구조 디렉티브(`@if`/`@else`)면 None.
    pub fn dom_event_name(&self) -> Option<&'static str> {
        match self {
            Directive::If | Directive::Else | Directive::With => None,
            Directive::Click => Some("click"),
            Directive::Input => Some("input"),
            Directive::Change => Some("change"),
            Directive::Submit => Some("submit"),
            Directive::Focus => Some("focus"),
            Directive::Blur => Some("blur"),
            Directive::KeyDown => Some("keydown"),
            Directive::KeyUp => Some("keyup"),
            Directive::MouseDown => Some("mousedown"),
            Directive::MouseUp => Some("mouseup"),
            Directive::MouseEnter => Some("mouseenter"),
            Directive::MouseLeave => Some("mouseleave"),
            Directive::Scroll => Some("scroll"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum LexError {
    UnterminatedString,
    UnexpectedChar(char),
    /// `@` 뒤에 알 수 없는 디렉티브 키워드.
    UnknownDirective(String),
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
            ':' => {
                chars.next();
                toks.push(Token::Colon);
            }
            '@' => {
                chars.next(); // @
                let mut s = String::new();
                while let Some(&ch) = chars.peek() {
                    if is_ident_part(ch) {
                        s.push(ch);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let kw = match s.as_str() {
                    "if" => Directive::If,
                    "else" => Directive::Else,
                    "with" => Directive::With,
                    "click" => Directive::Click,
                    "input" => Directive::Input,
                    "change" => Directive::Change,
                    "submit" => Directive::Submit,
                    "focus" => Directive::Focus,
                    "blur" => Directive::Blur,
                    "keydown" => Directive::KeyDown,
                    "keyup" => Directive::KeyUp,
                    "mousedown" => Directive::MouseDown,
                    "mouseup" => Directive::MouseUp,
                    "mouseenter" => Directive::MouseEnter,
                    "mouseleave" => Directive::MouseLeave,
                    "scroll" => Directive::Scroll,
                    _ => return Err(LexError::UnknownDirective(s)),
                };
                toks.push(Token::At(kw));
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
