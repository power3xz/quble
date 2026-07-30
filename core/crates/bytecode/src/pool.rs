//! 사용자 상수풀. 텍스트/속성명/속성값/컴포넌트명 등 컴포넌트마다 다른 상수를
//! 중복 제거해 담는다. 코드에서는 u16 인덱스로 참조한다(BYTECODE.md #2).
//!
//! quble이 타입을 소유하므로 엔트리는 문자열만이 아니라 값의 종류(Str/Num/Bool)를 갖는다.
//! 런타임이 인덱스로 꺼내면 이미 올바른 JS 값(string/number/boolean)이라, @if 등 소비 지점은
//! 타입을 다시 해석하지 않는다.

/// 상수풀 엔트리. 이름/텍스트 등은 Str, 리터럴은 소스의 타입대로 Num/Bool.
#[derive(Debug, Clone, PartialEq)]
pub enum Const {
    Str(String),
    Num(f64),
    Bool(bool),
}

/// 상수풀. 중복은 자동으로 제거되어 같은 인덱스를 돌려준다(타입까지 같아야 동일 엔트리).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ConstPool {
    entries: Vec<Const>,
}

impl ConstPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// 상수를 풀에 넣고 인덱스를 반환. 이미 있으면(값/타입 동일) 기존 인덱스.
    pub fn intern(&mut self, c: Const) -> u16 {
        if let Some(i) = self.entries.iter().position(|e| e == &c) {
            return i as u16;
        }
        let i = self.entries.len();
        self.entries.push(c);
        i as u16
    }

    /// 문자열 상수 편의 intern. 이름/텍스트/속성값 등 대부분의 호출부가 문자열이다.
    pub fn intern_str(&mut self, s: &str) -> u16 {
        self.intern(Const::Str(s.to_string()))
    }

    /// 인덱스 -> 상수. 범위를 벗어나면 None.
    pub fn get(&self, index: u16) -> Option<&Const> {
        self.entries.get(index as usize)
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    /// 직렬화/역직렬화용 원시 접근.
    pub(crate) fn entries(&self) -> &[Const] {
        &self.entries
    }

    /// 역직렬화 시 그대로 채우기 위한 생성자.
    pub(crate) fn from_entries(entries: Vec<Const>) -> Self {
        Self { entries }
    }
}
