//! 렉서: `.qubc` 소스를 토큰으로. MVP 문법만 - 식별자, 괄호/중괄호, `=`, `,`, 문자열.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    Ident(String),
    Str(String),          // 큰따옴표 값 리터럴
    TypeKey(String),      // 작은따옴표 타입 키(유틸 타입 `Omit<T, 'a'>`)
    Num(String),  // 숫자 리터럴 원문. 값 파싱(f64)은 parse 단계.
    Bool(bool),   // true / false 값 리터럴.
    KwBool,       // 타입 키워드 bool
    KwNumber,     // 타입 키워드 number
    KwString,     // 타입 키워드 string
    LBrace,   // {
    RBrace,   // }
    LParen,   // (
    RParen,   // )
    LBracket, // [
    RBracket, // ]
    Eq,     // =
    Comma,  // ,
    Colon,  // :
    Dot,    // . (객체 필드 접근 `assignee.name`)
    Lt,     // < (제네릭 타입 `Omit<Section, 'a'>`)
    Gt,     // >
    Pipe,   // | (유니온 키 리스트 `'a' | 'b'`)
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
            '[' => {
                chars.next();
                toks.push(Token::LBracket);
            }
            ']' => {
                chars.next();
                toks.push(Token::RBracket);
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
            '.' => {
                chars.next();
                toks.push(Token::Dot);
            }
            '<' => {
                chars.next();
                toks.push(Token::Lt);
            }
            '>' => {
                chars.next();
                toks.push(Token::Gt);
            }
            '|' => {
                chars.next();
                toks.push(Token::Pipe);
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
            // 큰따옴표 = 값 리터럴(속성값 `class="x"`, payload 리터럴).
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
            // 작은따옴표 = 타입 키(TS 유틸 타입 `Omit<T, 'title'>`). 값 리터럴과 자리가 달라 구분한다.
            '\'' => {
                chars.next(); // 여는 따옴표
                let mut s = String::new();
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(ch) => s.push(ch),
                        None => return Err(LexError::UnterminatedString),
                    }
                }
                toks.push(Token::TypeKey(s));
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
                // 예약어는 Ident와 분리해 토큰화한다 - prop명/참조로 못 쓰게(뒤늦게 막으면
                // 하위호환이 깨지므로 지금 전부 잠근다). 값(true/false)과 타입(bool/number/string) 모두.
                toks.push(match s.as_str() {
                    "true" => Token::Bool(true),
                    "false" => Token::Bool(false),
                    "bool" => Token::KwBool,
                    "number" => Token::KwNumber,
                    "string" => Token::KwString,
                    _ => Token::Ident(s),
                });
            }
            // 숫자 리터럴. 원문을 그대로 담고 값 파싱은 이후 단계(parse). 정수·소수만, 음수·지수는
            // 표현식 영역이라 지금은 다루지 않는다(SYNTAX.md 미결).
            c if c.is_ascii_digit() => {
                let mut s = String::new();
                while let Some(&ch) = chars.peek() {
                    if ch.is_ascii_digit() || ch == '.' {
                        s.push(ch);
                        chars.next();
                    } else {
                        break;
                    }
                }
                toks.push(Token::Num(s));
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
