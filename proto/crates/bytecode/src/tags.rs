//! 내장 HTML 태그 테이블. 파일에 직렬화되지 않고 코드에 고정된다(BYTECODE.md §2).
//! 예약 ID는 안정적이어야 하므로 **추가만, 재배치 금지**.

/// 프로토타입 시작 집합. 인덱스 = 예약 태그 ID.
const TAGS: &[&str] = &[
    "div",    // 0
    "span",   // 1
    "p",      // 2
    "h1",     // 3
    "h2",     // 4
    "h3",     // 5
    "a",      // 6
    "ul",     // 7
    "li",     // 8
    "button",  // 9
    "article", // 10
    "img",     // 11
    "section", // 12
    "header",  // 13
    "footer",  // 14
    "nav",     // 15
    "main",    // 16
    "aside",   // 17
    "label",   // 18
];

/// 태그 ID → 태그명. 범위를 벗어나면 None.
pub fn tag_name(id: u16) -> Option<&'static str> {
    TAGS.get(id as usize).copied()
}

/// 태그명 → 태그 ID. 내장 집합에 없으면 None.
pub fn tag_id(name: &str) -> Option<u16> {
    TAGS.iter().position(|&t| t == name).map(|i| i as u16)
}
