//! 컴파일 산출물 전체. 상수풀 + 컴포넌트 테이블 + 코드(BYTECODE.md §4).

use crate::pool::ConstPool;

/// 컴포넌트 테이블의 한 항목. ID = 이 항목의 배열 인덱스.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompDef {
    /// 상수풀에 든 컴포넌트명의 인덱스.
    pub name_idx: u16,
    /// 코드 영역 내 시작 오프셋.
    pub code_off: u32,
    /// 코드 길이.
    pub code_len: u32,
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
