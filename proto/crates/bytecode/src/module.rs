//! 컴파일 산출물 전체. 상수풀 + 컴포넌트 테이블 + 코드(BYTECODE.md §4).

use crate::pool::ConstPool;

/// field 값 하나의 출처. field.refs의 각 원소.
/// - Scope: 런타임 슬롯을 거쳐 읽는 값(반응/상수/원시 - 슬롯 kind가 최종 결정).
/// - Const: 컴포넌트 상수풀 인덱스. 리터럴 값(payload에 직접 박힘).
/// - Raw: @for 등이 런타임에 만든 원시값. 지금은 number only(@for 인덱스). 스택이 아니라
///   슬롯 인라인 값이다(회차 프레임 유지 시 메모리 폭발 회피). 실사용은 @for 착수 때.
/// 바이트코드 u16과의 변환은 encode/decode에 가둔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldValue {
    Scope(u16),
    Const(u16),
    Raw(u16),
}

impl FieldValue {
    /// u16 한 칸을 비대칭으로 나눈다 - 상한 리스크가 큰 Const에 15비트를 온전히 주고
    /// (상수풀은 문자열 전반을 공유해 큰 컴포넌트에서 빨리 찬다), 여유 있는 Scope/Raw는
    /// 최상위 2비트를 태그로 쓰고 14비트 인덱스:
    ///   0 xxxxxxxxxxxxxxx  Const  (15비트, 0x7fff)
    ///   1 0 xxxxxxxxxxxxxx  Scope  (14비트, 0x3fff)
    ///   1 1 xxxxxxxxxxxxxx  Raw    (14비트, 0x3fff)
    const TAG_HI: u16 = 0x8000; // 최상위: 0=Const, 1=Scope/Raw
    const TAG_LO: u16 = 0x4000; // 최상위가 1일 때 둘째: 0=Scope, 1=Raw
    /// 축별 인덱스 상한(encode가 넘으면 패닉). Const 15비트, Scope/Raw는 태그 2비트를 빼 14비트.
    pub const CONST_MAX: u16 = 0x7fff;
    pub const SCOPE_MAX: u16 = 0x3fff;
    pub const RAW_MAX: u16 = 0x3fff;
    /// decode에서 태그 2비트를 벗겨 인덱스만 꺼내는 마스크(Scope/Raw 공용, 하위 14비트).
    const INDEX_MASK: u16 = 0x3fff;

    /// 바이트코드 u16으로. 상한 초과면 패닉 - codegen 가드가 앞서 걸러야 한다(ISSUES).
    pub fn encode(self) -> u16 {
        match self {
            FieldValue::Const(index) => {
                assert!(index <= Self::CONST_MAX, "Const 인덱스 상한 초과: {index}");
                index
            }
            FieldValue::Scope(index) => {
                assert!(index <= Self::SCOPE_MAX, "Scope 인덱스 상한 초과: {index}");
                Self::TAG_HI | index
            }
            FieldValue::Raw(index) => {
                assert!(index <= Self::RAW_MAX, "Raw 인덱스 상한 초과: {index}");
                Self::TAG_HI | Self::TAG_LO | index
            }
        }
    }

    /// 바이트코드 u16에서. 최상위 0이면 Const(태그 없음, raw 그대로), 1이면 둘째 비트로
    /// Scope/Raw를 가르고 INDEX_MASK로 태그를 벗긴다. 모든 u16이 유효(무효 조합 없음).
    pub fn decode(raw: u16) -> FieldValue {
        if raw & Self::TAG_HI == 0 {
            FieldValue::Const(raw)
        } else if raw & Self::TAG_LO == 0 {
            FieldValue::Scope(raw & Self::INDEX_MASK)
        } else {
            FieldValue::Raw(raw & Self::INDEX_MASK)
        }
    }
}

/// payload/context가 담는 객체 타입의 구조. 모듈 전역 테이블(Module.types)에 dedup 저장.
/// 조립 명세다 - 값도 인덱스도 없이 구조(필드명·중첩)만 담고, 런타임이 field.refs를
/// 받아 이 구조로 객체를 조립한다. object 필드는 자식을 type_ref(테이블 인덱스)로 가리켜
/// 중첩·공유를 표현한다. (Array는 @for 미해결이라 아직 없음 - PAYLOAD-OBJECTS.md.)
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TypeEntry {
    Scalar,
    /// (name_const_index, type_ref) 목록. 선언 순서 = 조립 시 값 소비 순서.
    Object(Vec<(u16, u16)>),
}

/// 필드 하나 = 필드명 + 조립 구조(type_ref) + 채울 값 출처 목록. 이벤트 payload와 컨텍스트가
/// 공유하는 명세. 스칼라 field는 type_ref가 Scalar 엔트리 + refs 하나(지금 동작의 상위집합).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// 필드명("title")의 컴포넌트 상수풀 인덱스.
    pub name_const_index: u16,
    /// 모듈 전역 타입 테이블 인덱스. 이 refs를 어떤 구조로 조립할지.
    pub type_ref: u16,
    /// 조립에 채울 값 출처 목록(깊이우선 순서). 스칼라는 하나, 객체는 값 수만큼.
    pub refs: Vec<FieldValue>,
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

    /// 세 variant가 u16 인코딩을 라운드트립한다. 최상위 2비트가 축을 가른다.
    #[test]
    fn field_value_roundtrips() {
        for v in [
            FieldValue::Const(0),
            FieldValue::Const(5),
            FieldValue::Scope(0),
            FieldValue::Scope(42),
            FieldValue::Raw(0),
            FieldValue::Raw(7),
        ] {
            assert_eq!(FieldValue::decode(v.encode()), v);
        }
    }

    /// 태그 비트 배치. Const는 최상위 0, Scope는 10, Raw는 11.
    #[test]
    fn field_value_tag_bits() {
        assert_eq!(FieldValue::Const(3).encode(), 0x0003);
        assert_eq!(FieldValue::Scope(3).encode(), 0x8003);
        assert_eq!(FieldValue::Raw(3).encode(), 0xc003);
    }

    /// 축별 상한값까지 인덱스가 보존된다(Const 15비트, Scope/Raw 14비트).
    #[test]
    fn field_value_max_index() {
        for v in [
            FieldValue::Const(FieldValue::CONST_MAX),
            FieldValue::Scope(FieldValue::SCOPE_MAX),
            FieldValue::Raw(FieldValue::RAW_MAX),
        ] {
            assert_eq!(FieldValue::decode(v.encode()), v);
        }
    }

    /// 상한 초과는 encode에서 패닉한다(codegen 가드가 앞서 걸러야 하나, 최후 방어).
    #[test]
    #[should_panic(expected = "Scope 인덱스 상한 초과")]
    fn field_value_scope_over_max_panics() {
        FieldValue::Scope(FieldValue::SCOPE_MAX + 1).encode();
    }

    #[test]
    #[should_panic(expected = "Const 인덱스 상한 초과")]
    fn field_value_const_over_max_panics() {
        FieldValue::Const(FieldValue::CONST_MAX + 1).encode();
    }
}
