//! 전역 속성명 테이블. 내장 태그 테이블과 대칭으로, 파일에 직렬화되지 않고
//! 코드에 고정된다(BYTECODE.md §2). 흔한 속성명만 전역으로 두고, 여기 없는
//! 속성명(`data-*` 등)은 컴포넌트 상수풀(AttrL)로 빠진다.
//! 프로토타입이라 ID 호환성은 신경 쓰지 않는다(필요하면 재배치 가능).

/// 인덱스 = 전역 속성명 ID.
const ATTRS: &[&str] = &[
    "class",       // 0
    "id",          // 1
    "src",         // 2
    "alt",         // 3
    "href",        // 4
    "type",        // 5
    "name",        // 6
    "value",       // 7
    "title",       // 8
    "style",       // 9
    "placeholder", // 10
];

/// 전역 속성명 ID → 이름. 범위를 벗어나면 None.
pub fn attr_name(id: u16) -> Option<&'static str> {
    ATTRS.get(id as usize).copied()
}

/// 속성명 → 전역 ID. 전역 테이블에 없으면 None(컴포넌트 상수풀로 빠짐).
pub fn attr_id(name: &str) -> Option<u16> {
    ATTRS.iter().position(|&a| a == name).map(|i| i as u16)
}
