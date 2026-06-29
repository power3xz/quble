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
    /// 텍스트 자리에 scope[idx] 값을 출력 (런타임 주입 값, HTML 이스케이프).
    TextVar = 0x08,
    /// 전역 속성명 테이블 ID + scope offset. 속성값이 변수(`class={x}`). value는 TextVar와 같은 offset 공간.
    AttrGVar = 0x09,
    /// 컴포넌트 상수풀 속성명 인덱스 + scope offset. 속성값이 변수(`data-id={x}`).
    AttrLVar = 0x0a,
    /// 부모 offset 하나를 자식 인자 버퍼에 push. 뒤따르는 RENDER가 소비.
    /// 부모의 paths/scope[offset]을 자식에게 그대로 넘긴다(한 단계 풀기). 순서 = 자식 offset 0,1,2….
    /// use-site 바인딩(`Comp(name={b})` - b는 부모 offset)의 인코딩.
    PushArg = 0x0b,
    /// 분기 시작. scope offset 하나(불리언)로 then/else를 가른다. then 가지 코드가 이어진다.
    If = 0x0c,
    /// then 가지 끝, else 가지 시작. (else 있을 때만)
    Else = 0x0d,
    /// if 블록 끝.
    IfEnd = 0x0e,
    /// 외부 리소스(CSS 등) 로드. operand는 모듈 전역 resId. resId->URL은 런타임이 주입.
    LoadRes = 0x0f,
    /// 지금 여는 요소에 리스너를 묶는다. operand: event_type(전역 DOM 이벤트), event_idx(컴포넌트 이벤트).
    /// event_type DOM 이벤트가 일어나면 컴포넌트 이벤트 event_idx를 발생시킨다.
    BindEvent = 0x10,
    /// 리터럴 인자를 자식 인자 버퍼에 push. operand: 상수풀 값 인덱스. 뒤따르는 RENDER가 소비.
    /// PushArg와 달리 부모 슬롯을 공유하지 않고, 런타임이 자식 인스턴스에 고유 leaf로 심는다
    /// (use-site 리터럴 `Comp(prop="lit")`의 인코딩 - 원본과 분리된 독립 값).
    PushArgLit = 0x11,
    /// 합성 경로(fullname)에 세그먼트 하나를 민다. operand: 상수풀 세그먼트 인덱스(자식 type-name).
    /// 뒤따르는 RENDER가 소비. 이벤트 fullname의 path 축을 누적한다(context 축 `@with`와 무관).
    PushPathSegment = 0x12,
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
            0x0b => Op::PushArg,
            0x0c => Op::If,
            0x0d => Op::Else,
            0x0e => Op::IfEnd,
            0x0f => Op::LoadRes,
            0x10 => Op::BindEvent,
            0x11 => Op::PushArgLit,
            0x12 => Op::PushPathSegment,
            _ => return None,
        })
    }
}
