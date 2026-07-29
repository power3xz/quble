//! 렉서: `.qubc` 소스를 토큰으로. MVP 문법만 - 식별자, 괄호/중괄호, `=`, `,`, 문자열.

use crate::src_range::SrcRange;

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
    LtLt,   // << (슬롯 채움 `Header << 노드`)
    Gt,     // >
    Pipe,   // | (유니온 키 리스트 `'a' | 'b'`)
    /// `/` - self-close 표기(`tag(attrs /)`). bool = 직전에 공백이 있었나. 확정 문법이
    /// `/` 앞 공백을 강제하므로(SYNTAX §3.1.1) 렉서가 공백 유무를 실어 파서가 검증한다.
    Slash(bool),
    /// `@` 뒤에 오는 디렉티브. `@if` -> `At(Directive::If)`.
    At(Directive),
}

/// `@` 디렉티브. 분기(`@if`/`@else`)와 DOM 이벤트(`@click`).
/// DOM 이벤트는 닫힌 집합이라 여기 박는다(필요할 때 추가).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Directive {
    If,
    Else,
    For,
    With,
    Slot,
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
            Directive::If | Directive::Else | Directive::For | Directive::With | Directive::Slot => None,
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
pub enum LexErrorKind {
    UnterminatedString,
    UnexpectedChar(char),
    /// `@` 뒤에 알 수 없는 디렉티브 키워드.
    UnknownDirective(String),
}

/// 렉스 실패 - 무엇이(kind) 어디서(range) 틀렸나. range는 문제가 시작된 문자/토큰 구간이다.
#[derive(Debug, PartialEq, Eq)]
pub struct LexError {
    pub kind: LexErrorKind,
    pub range: SrcRange,
}

/// 토큰과 그 소스 구간. 길이가 같은 병렬 배열로, i번 토큰의 구간이 ranges[i]다.
/// 파서는 이미 `pos`로 토큰을 인덱싱하므로 같은 인덱스로 구간을 집는다.
pub struct Lexed {
    pub tokens: Vec<Token>,
    pub ranges: Vec<SrcRange>,
}

pub fn lex(src: &str) -> Result<Lexed, LexError> {
    let mut toks = Vec::new();
    let mut ranges = Vec::new();
    let mut chars = src.char_indices().peekable();
    // 직전 문자가 공백이었나 - `/`(self-close)의 앞 공백 강제 검증용. 공백 분기에서 세우고
    // 그 외 토큰을 낼 때마다 리셋한다.
    let mut prev_ws = false;

    while let Some(&(start, c)) = chars.peek() {
        // `/`만 prev_ws를 읽는다. 아래에서 self-close 판단에 쓰고, 이 분기 밖 토큰은 모두 리셋.
        let ws_before = prev_ws;
        prev_ws = false;
        match c {
            c if c.is_whitespace() => {
                chars.next();
                prev_ws = true;
            }
            '/' => {
                chars.next();
                toks.push(Token::Slash(ws_before));
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
                // `<<`(슬롯 채움)와 `<`(제네릭 타입)를 가른다 - template과 타입으로 문맥이 갈려 충돌하지 않는다.
                match chars.peek().map(|&(_, ch)| ch) {
                    Some('<') => {
                        chars.next();
                        toks.push(Token::LtLt);
                    }
                    _ => toks.push(Token::Lt),
                }
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
                while let Some(&(_, ch)) = chars.peek() {
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
                    "for" => Directive::For,
                    "with" => Directive::With,
                    "slot" => Directive::Slot,
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
                    _ => {
                        // `@`부터 읽어들인 키워드 끝까지 - 통째로 가리켜야 무엇이 안 알려진 건지 보인다.
                        let end = start + 1 + s.len();
                        return Err(LexError {
                            kind: LexErrorKind::UnknownDirective(s),
                            range: SrcRange::new(start, end),
                        });
                    }
                };
                toks.push(Token::At(kw));
            }
            // 큰따옴표 = 값 리터럴(속성값 `class="x"`, payload 리터럴).
            '"' => {
                chars.next(); // 여는 따옴표
                let mut s = String::new();
                loop {
                    match chars.next() {
                        Some((_, '"')) => break,
                        Some((_, ch)) => s.push(ch),
                        // 여는 따옴표부터 소스 끝까지 - 닫는 짝이 없으니 그 뒤 전부가 문자열로 먹혔다.
                        None => {
                            return Err(LexError {
                                kind: LexErrorKind::UnterminatedString,
                                range: SrcRange::new(start, src.len()),
                            })
                        }
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
                        Some((_, '\'')) => break,
                        Some((_, ch)) => s.push(ch),
                        None => {
                            return Err(LexError {
                                kind: LexErrorKind::UnterminatedString,
                                range: SrcRange::new(start, src.len()),
                            })
                        }
                    }
                }
                toks.push(Token::TypeKey(s));
            }
            c if is_ident_start(c) => {
                let mut s = String::new();
                while let Some(&(_, ch)) = chars.peek() {
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
            // 숫자 리터럴. 원문을 그대로 담고 값 파싱은 이후 단계(parse). 정수/소수만, 음수/지수는
            // 표현식 영역이라 지금은 다루지 않는다(SYNTAX.md 미결).
            c if c.is_ascii_digit() => {
                let mut s = String::new();
                while let Some(&(_, ch)) = chars.peek() {
                    if ch.is_ascii_digit() || ch == '.' {
                        s.push(ch);
                        chars.next();
                    } else {
                        break;
                    }
                }
                toks.push(Token::Num(s));
            }
            other => {
                return Err(LexError {
                    kind: LexErrorKind::UnexpectedChar(other),
                    range: SrcRange::new(start, start + other.len_utf8()),
                })
            }
        }
        // 이 회차가 낸 토큰에 구간을 붙인다 - push 지점(20곳)마다 적지 않아 빠뜨릴 수 없다.
        // 끝은 다음 문자의 오프셋(없으면 소스 끝). 공백 회차는 토큰이 0개라 아무것도 안 붙고,
        // 토큰을 낸 회차는 resize가 그 하나를 이 구간으로 채운다.
        let end = chars.peek().map_or(src.len(), |&(i, _)| i);
        ranges.resize(toks.len(), SrcRange::new(start, end));
    }
    Ok(Lexed {
        tokens: toks,
        ranges,
    })
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}
