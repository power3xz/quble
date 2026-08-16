//! Opcode 정의. 값은 BYTECODE.md #5와 일치해야 한다.

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
    /// 경로 없는 참조(`Comp(x={a})`)의 인코딩. 뒤따르는 RENDER가 소비. 순서 = 자식 scope index 0,1,2....
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
    /// `@for (x of n)` 반복 - count가 숫자 slot. operand: scope index u8, offset u8 (count가
    /// 필드면 base로부터의 거리). 런타임이 그 슬롯 값을 횟수로. count가 배열이면 ForArrayVar로
    /// 갈린다(컴파일타임 타입으로 구별).
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
    /// (배열이 필드면 base로부터의 거리). 런타임이 그 칸의 arrayInfoIndex로 요소 수/위치를 얻어
    /// 요소 수만큼 반복하며, 회차마다 회차변수(item) slot을 그 요소 leaf에 바인딩한다. item slot은
    /// operand에 없다 - 런타임이 codegen과 같은 규칙(props 슬롯 수 + 현재 @for 깊이)으로 구한다.
    /// count가 숫자면 ForCountVar.
    ForArrayVar = 0x1a,
    /// 슬롯 콘텐츠 구간 시작(사용쪽). operand: slot_placeholder_index u16(자식 def의 선언 순서).
    /// SLOT_PLACEHOLDER_CONTENT_END까지가 콘텐츠 코드이고, 뒤따르는 RENDER가 소비한다.
    /// 콘텐츠는 부모 def 안에 그대로 남아 부모 scope/path로 해석된다(SYNTAX #3.3).
    PushSlotPlaceholderContent = 0x1b,
    /// 슬롯 콘텐츠 구간 끝 마커(operand 없음, IF_END 동형).
    SlotPlaceholderContentEnd = 0x1c,
    /// `@slot(name)` 자리(정의쪽). operand: slot_placeholder_index u16.
    /// 런타임이 그 인덱스의 콘텐츠 구간을 부모 컨텍스트로 해석해 이 자리에 끼운다.
    /// 안 채운 슬롯이면 아무것도 안 넣는다(미채움 허용).
    FillSlotPlaceholder = 0x1d,
    /// 연산자가 붙은 조건으로 분기 시작(`@if (count > 0)`). operand: expr_index u8(이 def의
    /// CompDef.exprs 인덱스). 잎 하나짜리 조건은 If로 간다. 이후 코드는 If와 같다 - then 가지가
    /// 이어지고 Else/IfEnd도 그대로. 런타임이 파생 칸을 잡고 식이 읽는 칸들을 구독해 그 칸에
    /// 결과를 넣는다(BYTECODE.md #5.2).
    IfExpr = 0x1e,
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
            0x1b => Op::PushSlotPlaceholderContent,
            0x1c => Op::SlotPlaceholderContentEnd,
            0x1d => Op::FillSlotPlaceholder,
            0x1e => Op::IfExpr,
            _ => return None,
        })
    }
}

/// 표현식 바이트 하나의 태그. `Op`와 다른 이름공간이다 - 표현식 테이블 안에서만 쓴다.
/// 값은 BYTECODE.md #4의 `<EXPR>`와 일치해야 한다.
///
/// 식은 후위 표기라 앞에서 뒤로 한 번 훑으면 끝난다. 스택에는 값만 올라간다 - 칸 번호는
/// 안 올라간다. 타입은 컴파일타임에 검사가 끝나 런타임은 타입을 안 본다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ExprOp {
    /// 그 칸의 값을 올린다. operand: scope_index u8, offset u8.
    LoadVar = 0x00,
    /// 컴포넌트 상수풀 값을 올린다. operand: const_index u16.
    LoadConst = 0x01,
    /// 배열 길이를 올린다. operand: scope_index u8, offset u8.
    /// 문자열과 태그를 나눈 건 구독 대상이 달라서다 - 배열은 길이를 담은 칸을 구독한다.
    LoadArrayLength = 0x02,
    /// 문자열 길이를 올린다. operand: scope_index u8, offset u8.
    /// 값 칸을 구독해 바뀔 때마다 길이를 다시 잰다.
    LoadStringLength = 0x03,
    /// 0~255 정수를 올린다. operand: value u8. 음수는 Neg가 붙고, 256 이상이나 소수는 LoadConst로.
    LoadSmallInt = 0x04,
    LoadTrue = 0x05,
    LoadFalse = 0x06,
    Add = 0x10,
    Sub = 0x11,
    Mul = 0x12,
    Div = 0x13,
    Rem = 0x14,
    Eq = 0x15,
    Ne = 0x16,
    Lt = 0x17,
    Le = 0x18,
    Gt = 0x19,
    Ge = 0x1a,
    And = 0x1b,
    Or = 0x1c,
    Not = 0x1d,
    Neg = 0x1e,
}

impl ExprOp {
    /// 바이트에서 표현식 태그로. 알 수 없는 값이면 None.
    pub fn from_u8(b: u8) -> Option<ExprOp> {
        Some(match b {
            0x00 => ExprOp::LoadVar,
            0x01 => ExprOp::LoadConst,
            0x02 => ExprOp::LoadArrayLength,
            0x03 => ExprOp::LoadStringLength,
            0x04 => ExprOp::LoadSmallInt,
            0x05 => ExprOp::LoadTrue,
            0x06 => ExprOp::LoadFalse,
            0x10 => ExprOp::Add,
            0x11 => ExprOp::Sub,
            0x12 => ExprOp::Mul,
            0x13 => ExprOp::Div,
            0x14 => ExprOp::Rem,
            0x15 => ExprOp::Eq,
            0x16 => ExprOp::Ne,
            0x17 => ExprOp::Lt,
            0x18 => ExprOp::Le,
            0x19 => ExprOp::Gt,
            0x1a => ExprOp::Ge,
            0x1b => ExprOp::And,
            0x1c => ExprOp::Or,
            0x1d => ExprOp::Not,
            0x1e => ExprOp::Neg,
            _ => return None,
        })
    }
}
