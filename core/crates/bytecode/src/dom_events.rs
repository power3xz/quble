//! 전역 DOM 이벤트 테이블. 파일에 직렬화되지 않고 코드에 고정된다(BYTECODE.md §2).
//! `BIND_EVENT`의 event_type이 이 ID로 어떤 DOM 이벤트인지 가리킨다. DOM 이벤트는 닫힌
//! 집합이라 통째로 전역에 둔다. 예약 ID는 안정적이어야 하므로 **추가만, 재배치 금지**.

/// 인덱스 = 예약 DOM 이벤트 ID. DOM 이벤트 종류는 닫힌 집합이지만 그중 쓰는 것부터 넣었다.
const DOM_EVENTS: &[&str] = &[
    "click",      // 0
    "input",      // 1
    "change",     // 2
    "submit",     // 3
    "focus",      // 4
    "blur",       // 5
    "keydown",    // 6
    "keyup",      // 7
    "mousedown",  // 8
    "mouseup",    // 9
    "mouseenter", // 10
    "mouseleave", // 11
    "scroll",     // 12
];

/// DOM 이벤트 ID -> 이름. 범위를 벗어나면 None.
pub fn dom_event_name(id: u16) -> Option<&'static str> {
    DOM_EVENTS.get(id as usize).copied()
}

/// DOM 이벤트명 -> ID. 전역 집합에 없으면 None.
pub fn dom_event_id(name: &str) -> Option<u16> {
    DOM_EVENTS.iter().position(|&e| e == name).map(|i| i as u16)
}
