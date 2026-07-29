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
    "input",   // 19
    "em",      // 20
    "b",       // 21
    "strong",  // 22
    "i",       // 23
    "small",   // 24
    "code",    // 25
    "pre",     // 26
    "h4",      // 27
    "h5",      // 28
    "h6",      // 29
    "br",      // 30
    "hr",      // 31
    "ol",      // 32
    "dl",      // 33
    "dt",      // 34
    "dd",      // 35
    "table",   // 36
    "thead",   // 37
    "tbody",   // 38
    "tr",      // 39
    "th",      // 40
    "td",      // 41
    "form",    // 42
    "textarea", // 43
    "select",  // 44
    "option",  // 45
    "figure",  // 46
    "figcaption", // 47
    "time",    // 48
    "blockquote", // 49
    "video",   // 50
    "audio",   // 51
    "canvas",  // 52
];

/// 태그 ID -> 태그명. 범위를 벗어나면 None.
pub fn tag_name(id: u16) -> Option<&'static str> {
    TAGS.get(id as usize).copied()
}

/// 태그명 -> 태그 ID. 내장 집합에 없으면 None.
pub fn tag_id(name: &str) -> Option<u16> {
    TAGS.iter().position(|&t| t == name).map(|i| i as u16)
}
