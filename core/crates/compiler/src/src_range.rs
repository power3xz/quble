//! 소스 안의 구간 표기. lexer가 토큰마다 만들고, parse/codegen 에러가 "어디가 틀렸나"를
//! 가리키는 데 쓴다.

/// 소스 안의 한 구간. start/end는 **바이트** 오프셋이고 end는 배타(std Range와 같다).
///
/// ```text
/// component Card {
/// ^^^^^^^^^                     SrcRange { start: 0, end: 9 }
/// ```
///
/// 라인/컬럼을 담지 않는 건 의도다 - 원본 소스만 있으면 언제든 세어지는 파생값이고,
/// 컬럼의 기준(바이트/문자/UTF-16)이 소비처마다 달라 여기서 하나로 정하면 나머지는 틀린다.
/// `.qubc`는 한글 문자열이 흔해 실제로 값이 갈린다 - `"안녕"` 뒤의 컬럼은 바이트로 6, 문자로 2다.
/// 환산은 소비처(CLI 출력, 에디터, wasm 경계)가 자기 기준으로 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SrcRange {
    pub start: u32,
    pub end: u32,
}

impl SrcRange {
    pub fn new(start: usize, end: usize) -> Self {
        SrcRange {
            start: start as u32,
            end: end as u32,
        }
    }

    /// 소스 끝을 가리키는 빈 구간. 토큰이 더 없어서 난 에러(UnexpectedEnd)가 쓴다.
    pub fn eof(src_len: usize) -> Self {
        SrcRange::new(src_len, src_len)
    }
}
