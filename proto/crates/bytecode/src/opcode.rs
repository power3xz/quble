//! Opcode 정의. 값은 BYTECODE.md §5와 일치해야 한다.

/// 1바이트 opcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Op {
    Halt = 0x00,
    ElemOpen = 0x01,
    /// 전역 속성명 테이블 ID + 컴포넌트 상수풀 값 인덱스.
    AttrG = 0x02,
    ElemCloseOpen = 0x03,
    Text = 0x04,
    ElemEnd = 0x05,
    Render = 0x06,
    /// 컴포넌트 상수풀 속성명 인덱스 + 값 인덱스 (전역 테이블에 없는 속성명).
    AttrL = 0x07,
    /// 텍스트 자리에 scope[index] 값을 출력 (런타임 주입 값, HTML 이스케이프).
    TextVar = 0x08,
    /// 전역 속성명 테이블 ID + scope index. 속성값이 변수(`class={x}`). value는 TextVar와 같은 scope index 공간.
    AttrGVar = 0x09,
    /// 컴포넌트 상수풀 속성명 인덱스 + scope index. 속성값이 변수(`data-id={x}`).
    AttrLVar = 0x0a,
    /// 부모 scope[scope_index] 슬롯 `(kind, index)`을 편집 없이 그대로 자식 인자 버퍼에 push.
    /// 경로 없는 참조(`Comp(x={a})`)의 인코딩. 뒤따르는 RENDER가 소비. 순서 = 자식 scope index 0,1,2….
    PushThrough = 0x0b,
    /// 분기 시작. scope index 하나(불리언)로 then/else를 가른다. then 가지 코드가 이어진다.
    If = 0x0c,
    /// then 가지 끝, else 가지 시작. (else 있을 때만)
    Else = 0x0d,
    /// if 블록 끝.
    IfEnd = 0x0e,
    /// 외부 리소스(CSS 등) 로드. operand는 모듈 전역 resId. resId->URL은 런타임이 주입.
    LoadRes = 0x0f,
    /// 지금 여는 요소에 리스너를 묶는다. operand: event_type(전역 DOM 이벤트), event_index(컴포넌트 이벤트).
    /// event_type DOM 이벤트가 일어나면 컴포넌트 이벤트 event_index를 발생시킨다.
    BindEvent = 0x10,
    /// 리터럴 인자를 자식 인자 버퍼에 push. operand: 상수풀 값 인덱스. 뒤따르는 RENDER가 소비.
    /// PushArg와 달리 부모 슬롯을 공유하지 않고, 런타임이 자식 인스턴스에 고유 leaf로 심는다
    /// (use-site 리터럴 `Comp(prop="lit")`의 인코딩 - 원본과 분리된 독립 값).
    PushArgLit = 0x11,
    /// 합성 경로(fullname)에 세그먼트 하나를 민다. operand: 상수풀 세그먼트 인덱스(자식 type-name).
    /// 뒤따르는 RENDER가 소비. 이벤트 fullname의 path 축을 누적한다(context 축 `@with`와 무관).
    PushPathSegment = 0x12,
    /// `@with Context` 블록 진입. operand: context_index(이 def의 CompDef.contexts 인덱스).
    /// 런타임이 ContextDef.fields를 읽어 컨텍스트를 활성 스택에 push. 이후 코드가 그 범위.
    EnterContext = 0x13,
    /// `@with` 블록 끝. operand 없는 마커(IfEnd와 동형). 활성 컨텍스트 스택 pop.
    ExitContext = 0x14,
    /// `@for (x of N)` 반복. operand: 반복 횟수 u16(슬롯 안 거치고 직접 인라인). FOR_END까지가 몸체.
    ForRaw = 0x15,
    /// `@for (x of n)` 반복 - count가 숫자 slot. operand: count의 scope index u16. 런타임이 그
    /// 슬롯 값을 횟수로. count가 배열이면 ForArrayVar로 갈린다(컴파일타임 타입으로 구별).
    ForCountVar = 0x16,
    /// `@for` 몸체 끝 마커(operand 없음, IfEnd 동형).
    ForEnd = 0x17,
    /// 합성 경로에 @for 인덱스 세그먼트를 민다. operand: @for 깊이 u16(loopIndexStack에서 읽을
    /// 위치). 런타임이 그 회차 인덱스를 직전 이름 세그먼트에 접미(VideoItem[3])하거나, 직전
    /// 이름이 없으면 익명 세그먼트([3])로. PushPathSegment와 짝지어(둘 다 뒤 RENDER/발화가 소비).
    PushPathIndexSegment = 0x18,
    /// 부모 scope[scope_index]에서 필드로 내려가 `(kind, base+offset)`을 자식에 push.
    /// 경로 참조(`Comp(x={user.name})`)의 인코딩. kind(출처)는 부모 슬롯 그대로 전파, 위치만
    /// 넘긴다 - 결과 타입은 자식이 자기 선언으로 안다. 뒤따르는 RENDER가 소비.
    PushField = 0x19,
    /// `@for (item of arr)` 반복 - count가 배열 slot. operand: 배열의 scope index u8, offset u8
    /// (배열이 필드면 base로부터의 거리). 런타임이 그 칸의 arrayInfoIndex로 요소 수·위치를 얻어
    /// 요소 수만큼 반복하며, 회차마다 회차변수(item) slot을 그 요소 leaf에 바인딩한다. item slot은
    /// operand에 없다 - 런타임이 codegen과 같은 규칙(props 슬롯 수 + 현재 @for 깊이)으로 구한다.
    /// count가 숫자면 ForCountVar.
    ForArrayVar = 0x1a,
}

impl Op {
    /// 바이트에서 opcode로. 알 수 없는 값이면 None.
    pub fn from_u8(b: u8) -> Option<Op> {
        Some(match b {
            0x00 => Op::Halt,
            0x01 => Op::ElemOpen,
            0x02 => Op::AttrG,
            0x03 => Op::ElemCloseOpen,
            0x04 => Op::Text,
            0x05 => Op::ElemEnd,
            0x06 => Op::Render,
            0x07 => Op::AttrL,
            0x08 => Op::TextVar,
            0x09 => Op::AttrGVar,
            0x0a => Op::AttrLVar,
            0x0b => Op::PushThrough,
            0x0c => Op::If,
            0x0d => Op::Else,
            0x0e => Op::IfEnd,
            0x0f => Op::LoadRes,
            0x10 => Op::BindEvent,
            0x11 => Op::PushArgLit,
            0x12 => Op::PushPathSegment,
            0x13 => Op::EnterContext,
            0x14 => Op::ExitContext,
            0x15 => Op::ForRaw,
            0x16 => Op::ForCountVar,
            0x17 => Op::ForEnd,
            0x18 => Op::PushPathIndexSegment,
            0x19 => Op::PushField,
            0x1a => Op::ForArrayVar,
            _ => return None,
        })
    }
}
