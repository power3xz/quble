//! 컴파일 산출물 전체. 상수풀 + 컴포넌트 테이블 + 코드(BYTECODE.md §4).

use crate::pool::ConstPool;

/// field 값 하나의 출처. field.ref.
/// - Scope: 부모 슬롯 위치(scope_index, offset). 슬롯의 실제 kind(store/const)는 런타임이 정한다
///   - 부모가 그 슬롯을 어디서 받았느냐에 달려 컴파일이 못 박는다. object/array면 base+offset.
/// - Const: 컴포넌트 상수풀 인덱스. 리터럴 값(payload에 직접 박힘).
/// - Raw: @for 등이 런타임에 만든 원시값. 지금은 number only(@for 인덱스). 실사용은 @for 착수 때.
/// 직렬화는 태그 1바이트 + payload(serialize.rs). variant가 곧 태그라 enum엔 태그 필드가 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldValue {
    Scope(/* scope_index */ u8, /* offset */ u8),
    Const(/* const_index */ u16),
    Raw(/* value */ u16),
}

/// payload/context가 담는 객체 타입의 구조. 모듈 전역 테이블(Module.types)에 dedup 저장.
/// 조립 명세다 - 값도 인덱스도 없이 구조(필드명/중첩)만 담고, 런타임이 field.refs를
/// 받아 이 구조로 객체를 조립한다. object 필드는 자식을 type_ref(테이블 인덱스)로 가리켜
/// 중첩/공유를 표현한다.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TypeEntry {
    Scalar,
    /// (name_const_index, type_ref) 목록. 선언 순서 = 조립 시 값 소비 순서.
    Object(Vec<(u16, u16)>),
    /// 원소 타입을 type_ref로 가리킨다. `string[][]`은 Array(Array(Scalar)) 세 엔트리로 편다.
    /// 하위(말단 Scalar 방향) 참조만 - 자기/조상 참조(재귀 타입)는 컴파일러가 내지 않는다.
    Array(u16),
}

/// 필드 하나 = 필드명 + 조립 구조(type_ref) + 채울 값 출처 하나. 이벤트 payload와 컨텍스트가
/// 공유하는 명세. 슬롯을 안 펼치므로 객체 field도 ref 하나가 그 슬롯을 가리킨다(런타임이 조립).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// 필드명("title")의 컴포넌트 상수풀 인덱스.
    pub name_const_index: u16,
    /// 모듈 전역 타입 테이블 인덱스. 이 ref를 어떤 구조로 조립할지.
    pub type_ref: u16,
    /// 조립에 채울 값 출처 하나.
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
    /// 이 컴포넌트 props를 하나의 Object로 묶은 타입(types 인덱스). 필드 순서 = scope 슬롯 순서.
    /// defs[0].props_type_ref가 진입점의 rootValue 풀필 구조. 핸들러 props 접근이 이 타입 워크 +
    /// argumentSourcePairs(런타임 슬롯 출처)로 해소된다.
    pub props_type_ref: u16,
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
    pub fn new(
        pool: ConstPool,
        types: Vec<TypeEntry>,
        defs: Vec<CompDef>,
        code: Vec<u8>,
    ) -> Self {
        Self { pool, types, defs, code }
    }

    /// 컴포넌트 ID로 정의를 직접 인덱싱.
    pub fn def(&self, comp_id: u16) -> Option<&CompDef> {
        self.defs.get(comp_id as usize)
    }
}

