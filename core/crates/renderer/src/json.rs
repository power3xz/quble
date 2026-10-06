//! 루트 props 데이터를 읽는 최소 JSON 파서(프로토타입). 외부 의존 없이 렌더에 필요한 만큼만 읽는다.

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// 키 순서를 그대로 둔다. 조회는 선형 - props 객체는 작다.
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// 객체의 키 값. 객체가 아니거나 키가 없으면 None.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

pub fn parse(src: &str) -> Result<Json, String> {
    let mut p = Parser {
        bytes: src.as_bytes(),
        pos: 0,
    };
    let value = p.value()?;
    p.skip_ws();
    match p.pos == p.bytes.len() {
        true => Ok(value),
        false => Err(format!("trailing input at {}", p.pos)),
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect(&mut self, b: u8) -> Result<(), String> {
        match self.peek() {
            Some(got) if got == b => {
                self.pos += 1;
                Ok(())
            }
            _ => Err(format!("expected `{}` at {}", b as char, self.pos)),
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, String> {
        match self.bytes[self.pos..].starts_with(word.as_bytes()) {
            true => {
                self.pos += word.len();
                Ok(value)
            }
            false => Err(format!("bad literal at {}", self.pos)),
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.literal("true", Json::Bool(true)),
            Some(b'f') => self.literal("false", Json::Bool(false)),
            Some(b'n') => self.literal("null", Json::Null),
            Some(_) => self.number(),
            None => Err("unexpected end".into()),
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.expect(b'{')?;
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            self.expect(b':')?;
            entries.push((key, self.value()?));
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Json::Obj(entries));
                }
                _ => return Err(format!("expected `,` or `}}` at {}", self.pos)),
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(format!("expected `,` or `]` at {}", self.pos)),
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let start = self.pos;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' {
                    break;
                }
                self.pos += 1;
            }
            out.push_str(
                std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|e| e.to_string())?,
            );
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let esc = self.peek().ok_or("unexpected end")?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => out.push(self.unicode_escape()?),
                        _ => return Err(format!("bad escape at {}", self.pos)),
                    }
                }
                _ => return Err("unterminated string".into()),
            }
        }
    }

    // `\uXXXX`(서로게이트 쌍이면 이어지는 `\uXXXX`까지). 깨진 쌍은 U+FFFD.
    fn unicode_escape(&mut self) -> Result<char, String> {
        let hi = self.hex4()?;
        if (0xd800..0xdc00).contains(&hi) && self.bytes[self.pos..].starts_with(b"\\u") {
            self.pos += 2;
            let lo = self.hex4()?;
            let code = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
            return Ok(char::from_u32(code).unwrap_or('\u{fffd}'));
        }
        Ok(char::from_u32(hi).unwrap_or('\u{fffd}'))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self
            .bytes
            .get(self.pos..self.pos + 4)
            .ok_or("unexpected end")?;
        self.pos += 4;
        u32::from_str_radix(std::str::from_utf8(digits).map_err(|e| e.to_string())?, 16)
            .map_err(|e| e.to_string())
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if b.is_ascii_digit() || matches!(b, b'-' | b'+' | b'.' | b'e' | b'E') {
                self.pos += 1;
            } else {
                break;
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|e| e.to_string())?;
        text.parse::<f64>()
            .map(Json::Num)
            .map_err(|_| format!("bad number `{text}` at {start}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_values_in_key_order() {
        let v = parse(r#" { "a": [1, -2.5e3, true, null], "b": { "c": "x" }, "d": false } "#).unwrap();
        assert_eq!(
            v,
            Json::Obj(vec![
                (
                    "a".into(),
                    Json::Arr(vec![Json::Num(1.0), Json::Num(-2500.0), Json::Bool(true), Json::Null])
                ),
                ("b".into(), Json::Obj(vec![("c".into(), Json::Str("x".into()))])),
                ("d".into(), Json::Bool(false)),
            ])
        );
    }

    #[test]
    fn decodes_string_escapes() {
        let v = parse(r#""a\"b\\c\ndé😀""#).unwrap();
        assert_eq!(v, Json::Str("a\"b\\c\nd\u{e9}\u{1f600}".into()));
    }

    #[test]
    fn rejects_broken_input() {
        assert!(parse("{").is_err());
        assert!(parse(r#"{"a" 1}"#).is_err());
        assert!(parse("[1,]").is_err());
        assert!(parse("1 2").is_err());
    }
}
