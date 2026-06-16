//! 사용자 상수풀. 텍스트·속성명·속성값·컴포넌트명 등 컴포넌트마다 다른 문자열을
//! 중복 제거해 담는다. 코드에서는 u16 인덱스로 참조한다(BYTECODE.md §2).

/// 문자열 상수풀. 중복은 자동으로 제거되어 같은 인덱스를 돌려준다.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ConstPool {
    entries: Vec<String>,
}

impl ConstPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// 문자열을 풀에 넣고 인덱스를 반환. 이미 있으면 기존 인덱스.
    pub fn intern(&mut self, s: &str) -> u16 {
        if let Some(i) = self.entries.iter().position(|e| e == s) {
            return i as u16;
        }
        let i = self.entries.len();
        self.entries.push(s.to_string());
        i as u16
    }

    /// 인덱스 → 문자열. 범위를 벗어나면 None.
    pub fn get(&self, idx: u16) -> Option<&str> {
        self.entries.get(idx as usize).map(|s| s.as_str())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 직렬화/역직렬화용 원시 접근.
    pub fn entries(&self) -> &[String] {
        &self.entries
    }

    /// 역직렬화 시 그대로 채우기 위한 생성자.
    pub fn from_entries(entries: Vec<String>) -> Self {
        Self { entries }
    }
}
