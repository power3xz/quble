//! 컴파일 산출물 전체. 상수풀 + 컴포넌트 테이블 + 코드(BYTECODE.md §4).

use crate::pool::ConstPool;

/// leaf 값 하나의 출처. field.leaves의 각 원소 - scope(런타임 paths[index]) 또는 const(리터럴).
/// 바이트코드 u16과의 변환은 encode/decode에 가둔다 - 비트연산(0x8000)이 한 곳에만 존재.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leaf {
    /// scope index. 런타임이 paths[index]로 읽는다.
    Scope(u16),
    /// 컴포넌트 상수풀 인덱스. 리터럴 값($lit).
    Const(u16),
}

impl Leaf {
    /// MSB = const 여부, 하위 15비트 = 인덱스. const=1, scope=0(디폴트).
    /// 인덱스 상한은 0x7fff - 초과는 인덱스 발급 지점(intern/prop 인덱싱)이 막아야 한다(미구현).
    const CONST_BIT: u16 = 0x8000;

    /// 바이트코드 u16으로. Scope는 인덱스 그대로, Const는 MSB를 세운다.
    pub fn encode(self) -> u16 {
        match self {
            Leaf::Scope(index) => index,
            Leaf::Const(index) => index | Self::CONST_BIT,
        }
    }

    /// 바이트코드 u16에서. MSB가 서 있으면 Const, 아니면 Scope.
    pub fn decode(raw: u16) -> Leaf {
        if raw & Self::CONST_BIT != 0 {
            Leaf::Const(raw & !Self::CONST_BIT)
        } else {
            Leaf::Scope(raw)
        }
    }
}

/// payload/context가 담는 객체 타입의 구조. 모듈 전역 테이블(Module.types)에 dedup 저장.
/// 조립 명세다 - 값도 leaf 인덱스도 없이 구조(필드명·중첩)만 담고, 런타임이 field.leaves를
/// 받아 이 구조로 객체를 조립한다. object 필드는 자식을 type_ref(테이블 인덱스)로 가리켜
/// 중첩·공유를 표현한다. (Array는 @for 미해결이라 아직 없음 - PAYLOAD-OBJECTS.md.)
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TypeEntry {
    Scalar,
    /// (name_const_index, type_ref) 목록. 선언 순서 = 조립 시 leaf 소비 순서.
    Object(Vec<(u16, u16)>),
}

/// 필드 하나 = 필드명 + 조립 구조(type_ref) + 채울 leaf 목록. 이벤트 payload와 컨텍스트가
/// 공유하는 명세. 스칼라 field는 type_ref가 Scalar 엔트리 + leaves 하나(지금 동작의 상위집합).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// 필드명("title")의 컴포넌트 상수풀 인덱스.
    pub name_const_index: u16,
    /// 모듈 전역 타입 테이블 인덱스. 이 leaves를 어떤 구조로 조립할지.
    pub type_ref: u16,
    /// 조립에 채울 leaf 목록(깊이우선 순서). 스칼라는 하나, 객체는 leaf 수만큼.
    pub leaves: Vec<Leaf>,
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
#[derive(Debug, Clone, PartialEq)]
pub struct Module {
    pub pool: ConstPool,
    /// 모듈 전역 타입 테이블(dedup). field.type_ref가 이걸 인덱싱한다.
    pub types: Vec<TypeEntry>,
    pub(crate) defs: Vec<CompDef>,
    pub code: Vec<u8>,
}

impl Module {
    pub fn new(pool: ConstPool, types: Vec<TypeEntry>, defs: Vec<CompDef>, code: Vec<u8>) -> Self {
        Self { pool, types, defs, code }
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
    fn leaf_roundtrips() {
        for lf in [Leaf::Scope(0), Leaf::Scope(42), Leaf::Const(0), Leaf::Const(5)] {
            assert_eq!(Leaf::decode(lf.encode()), lf);
        }
    }

    /// MSB가 const 표지다. Scope는 MSB가 꺼져 있고, Const는 켜진다.
    #[test]
    fn leaf_const_bit() {
        assert_eq!(Leaf::Scope(3).encode(), 0x0003);
        assert_eq!(Leaf::Const(3).encode(), 0x8003);
    }

    /// 하위 15비트 상한(0x7fff)까지 인덱스가 보존된다.
    #[test]
    fn leaf_max_index() {
        let max = 0x7fff;
        assert_eq!(Leaf::decode(Leaf::Scope(max).encode()), Leaf::Scope(max));
        assert_eq!(Leaf::decode(Leaf::Const(max).encode()), Leaf::Const(max));
    }
}
