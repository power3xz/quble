//! 컴파일 산출물 전체. 상수풀 + 컴포넌트 테이블 + 코드(BYTECODE.md §4).

use crate::pool::ConstPool;

/// 필드 값의 출처. 바이트코드는 값 자체가 아니라 "어디서 값을 읽을지"를 싣는다.
/// 바이트코드 u16과의 변환은 encode/decode에 가둔다 - 비트연산(0x8000)이 한 곳에만 존재.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldValue {
    /// scope index. 런타임이 paths[index]로 읽는다.
    Scope(u16),
    /// 컴포넌트 상수풀 인덱스. 리터럴 값($lit).
    Const(u16),
}

impl FieldValue {
    /// MSB = const 여부, 하위 15비트 = 인덱스. const=1, scope=0(디폴트).
    /// 인덱스 상한은 0x7fff - 초과는 인덱스 발급 지점(intern/prop 인덱싱)이 막아야 한다(미구현).
    const CONST_BIT: u16 = 0x8000;

    /// 바이트코드 u16으로. Scope는 인덱스 그대로, Const는 MSB를 세운다.
    pub fn encode(self) -> u16 {
        match self {
            FieldValue::Scope(index) => index,
            FieldValue::Const(index) => index | Self::CONST_BIT,
        }
    }

    /// 바이트코드 u16에서. MSB가 서 있으면 Const, 아니면 Scope.
    pub fn decode(raw: u16) -> FieldValue {
        if raw & Self::CONST_BIT != 0 {
            FieldValue::Const(raw & !Self::CONST_BIT)
        } else {
            FieldValue::Scope(raw)
        }
    }
}

/// 필드 하나 = 필드명 + 값 출처. 이벤트 payload와 컨텍스트가 공유하는 명세.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Field {
    /// 필드명("title")의 컴포넌트 상수풀 인덱스.
    pub name_const_index: u16,
    pub value: FieldValue,
}

/// 컴포넌트가 선언한 이벤트 하나. `event_index`는 이 항목이 CompDef.events에서 갖는 배열 인덱스
/// (BIND_EVENT가 참조). fields는 함께 싣는 필드 명세 - 런타임이 이걸 read해서 payload를 build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventDef {
    pub name_const_index: u16,
    pub fields: Vec<Field>,
}

/// `@with`로 주입하는 컨텍스트 하나. EnterContext가 context_index로 이 테이블을 참조
/// (BindEvent가 event_index로 EventDef를 참조하는 것과 동형). fields는 EventDef와 같은
/// 인코딩(Field) - 런타임이 read해서 컨텍스트 값을 build. 단 이벤트 payload와 의미 축이 달라
/// 별도 타입으로 둔다(이벤트는 핸들러 매칭, 컨텍스트는 활성 스택).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextDef {
    pub name_const_index: u16,
    pub fields: Vec<Field>,
}

/// 컴포넌트 테이블의 한 항목. ID = 이 항목의 배열 인덱스.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompDef {
    /// 상수풀에 든 컴포넌트명의 인덱스.
    pub name_const_index: u16,
    /// 코드 영역 내 시작 오프셋.
    pub code_off: u32,
    /// 코드 길이.
    pub code_len: u32,
    /// 이 컴포넌트가 선언한 이벤트들. 선언 순서 = event_index.
    pub events: Vec<EventDef>,
    /// 이 컴포넌트가 선언한 컨텍스트들. 선언 순서 = context_index.
    pub contexts: Vec<ContextDef>,
}

/// 바이트코드 모듈 하나(= 하나의 컴파일 산출물/파일).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Module {
    pub pool: ConstPool,
    pub(crate) defs: Vec<CompDef>,
    pub code: Vec<u8>,
}

impl Module {
    pub fn new(pool: ConstPool, defs: Vec<CompDef>, code: Vec<u8>) -> Self {
        Self { pool, defs, code }
    }

    /// 컴포넌트 ID로 정의를 직접 인덱싱.
    pub fn def(&self, comp_id: u16) -> Option<&CompDef> {
        self.defs.get(comp_id as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scope/Const 양쪽이 u16 인코딩을 라운드트립한다. MSB가 두 variant를 가른다.
    #[test]
    fn field_value_roundtrips() {
        for fv in [FieldValue::Scope(0), FieldValue::Scope(42), FieldValue::Const(0), FieldValue::Const(5)] {
            assert_eq!(FieldValue::decode(fv.encode()), fv);
        }
    }

    /// MSB가 const 표지다. Scope는 MSB가 꺼져 있고, Const는 켜진다.
    #[test]
    fn field_value_const_bit() {
        assert_eq!(FieldValue::Scope(3).encode(), 0x0003);
        assert_eq!(FieldValue::Const(3).encode(), 0x8003);
    }

    /// 하위 15비트 상한(0x7fff)까지 인덱스가 보존된다.
    #[test]
    fn field_value_max_index() {
        let max = 0x7fff;
        assert_eq!(FieldValue::decode(FieldValue::Scope(max).encode()), FieldValue::Scope(max));
        assert_eq!(FieldValue::decode(FieldValue::Const(max).encode()), FieldValue::Const(max));
    }
}
