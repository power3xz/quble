//! SrcRange를 사람이 읽는 진단 텍스트로 만든다. 컴파일러가 내는 위치는 바이트 오프셋뿐이라
//! (src_range.rs 참고) 라인/컬럼과 밑줄은 여기서 소스를 세어 만든다.
//!
//! 폭 기준이 셋이고 서로 다르다 - 헷갈리면 캐럿이 밀린다.
//!
//! ```text
//! range 저장      바이트    SrcRange { start, end }
//! 컬럼 보고       문자      편집기가 세는 것과 같은 기준
//! 캐럿 정렬       표시 폭   한글은 터미널에서 2칸
//! ```

use crate::src_range::SrcRange;

/// 소스 안 한 지점의 사람이 읽는 위치. 라인/컬럼 모두 1부터 센다.
/// 컬럼은 **문자** 기준이다 - 바이트로 세면 한글 뒤 컬럼이 편집기와 안 맞는다.
#[derive(Debug, PartialEq, Eq)]
pub struct SrcLocation {
    pub line: u32,
    pub column: u32,
}

/// 진단 하나를 CLI에 그대로 찍을 여러 줄 텍스트로 만든다(끝에 개행 없음).
///
/// ```text
/// card.qubc:6:14: error: prop 'user'에 필드 'nope'가 없다
///   6 |       p() { {user.nope} }
///     |              ^^^^^^^^^
/// ```
///
/// range가 None이면(탓할 자리를 모르는 codegen 에러) 첫 줄만 낸다 - 파일명과 메시지.
pub fn format(path: &str, src: &str, range: Option<SrcRange>, message: &str) -> String {
    let range = match range {
        Some(r) => r,
        None => return std::format!("{path}: error: {message}"),
    };

    let at = locate(src, range.start);
    let (line_start, line_text) = line_at(src, range.start);

    // 밑줄 시작은 줄머리부터 range.start까지의 표시 폭. 끝은 range가 이 줄을 넘으면 줄 끝까지
    // 자른다(여러 줄에 걸친 range - 닫히지 않은 문자열이 그렇다). 시작 줄만 보여준다.
    let before = &line_text[..(range.start as usize - line_start)];
    let in_line_end = (range.end as usize - line_start).min(line_text.len());
    let underlined = &line_text[(range.start as usize - line_start)..in_line_end];

    // 빈 구간(소스 끝에서 난 에러)도 가리킬 자리는 보여야 해 최소 한 칸.
    let caret_width = display_width(underlined).max(1);

    // 줄번호 폭에 맞춰 두 줄의 `|`를 세로로 맞춘다.
    let num = at.line.to_string();
    let pad = " ".repeat(num.len());
    std::format!(
        "{path}:{}:{}: error: {message}\n {num} | {line_text}\n {pad} | {}{}",
        at.line,
        at.column,
        " ".repeat(display_width(before)),
        "^".repeat(caret_width),
    )
}

/// 바이트 오프셋을 라인/컬럼(1-based, 컬럼은 문자 수)으로 환산한다.
/// offset이 소스 길이면(EOF) 마지막 줄의 끝을 가리킨다.
fn locate(src: &str, offset: u32) -> SrcLocation {
    let offset = offset as usize;
    let mut line = 1;
    let mut column = 1;
    for (i, c) in src.char_indices() {
        if i >= offset {
            break;
        }
        match c {
            '\n' => {
                line += 1;
                column = 1;
            }
            _ => column += 1,
        }
    }
    SrcLocation { line, column }
}

/// offset이 놓인 줄의 (줄 시작 바이트 오프셋, 줄 텍스트). 개행은 안 포함한다.
fn line_at(src: &str, offset: u32) -> (usize, &str) {
    let offset = (offset as usize).min(src.len());
    let start = src[..offset].rfind('\n').map_or(0, |i| i + 1);
    let end = src[start..].find('\n').map_or(src.len(), |i| start + i);
    (start, &src[start..end])
}

/// 터미널 표시 폭. 캐럿 정렬에 문자 수를 쓰면 한글 뒤에서 밀린다 - 한글/한자/가나/전각은
/// 2칸을 차지한다. 완전한 East Asian Width 표는 아니고 `.qubc`에 실제로 나오는 범위만 덮는다.
fn display_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

fn char_width(c: char) -> usize {
    match c {
        // 탭은 터미널마다 다르지만 대개 소스에서 4칸으로 보인다.
        '\t' => 4,
        // 한자(CJK 통합), 히라가나/가타카나, 한글 자모/음절, 전각 기호.
        '\u{1100}'..='\u{115f}'   // 한글 자모 초성
        | '\u{2e80}'..='\u{303e}' // CJK 부호, 가나 부호
        | '\u{3041}'..='\u{33ff}' // 가나, 한글 호환 자모, CJK 기호
        | '\u{3400}'..='\u{4dbf}' // CJK 확장 A
        | '\u{4e00}'..='\u{9fff}' // CJK 통합 한자
        | '\u{a000}'..='\u{a4cf}' // 이족 문자
        | '\u{ac00}'..='\u{d7a3}' // 한글 음절
        | '\u{f900}'..='\u{faff}' // CJK 호환 한자
        | '\u{fe30}'..='\u{fe6f}' // CJK 호환 형태
        | '\u{ff00}'..='\u{ff60}' // 전각 ASCII
        | '\u{ffe0}'..='\u{ffe6}' // 전각 기호
        => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 위치 환산의 기본 - 라인은 개행 수, 컬럼은 줄머리부터의 문자 수.
    #[test]
    fn locates_line_and_column() {
        let src = "ab\ncdef\ng";
        assert_eq!(locate(src, 0), SrcLocation { line: 1, column: 1 });
        assert_eq!(locate(src, 3), SrcLocation { line: 2, column: 1 });
        assert_eq!(locate(src, 5), SrcLocation { line: 2, column: 3 });
        assert_eq!(locate(src, 8), SrcLocation { line: 3, column: 1 });
    }

    /// 컬럼은 문자 기준 - 한글 뒤에서 바이트로 세면 3배로 튄다.
    #[test]
    fn column_counts_chars_not_bytes() {
        let src = r#"a "가나" b"#;
        // `b`는 바이트로 12번째지만 문자로는 8번째다.
        let b = src.find('b').unwrap();
        assert_eq!(b, 11);
        assert_eq!(locate(src, b as u32), SrcLocation { line: 1, column: 8 });
    }

    /// 소스 끝(EOF)에서 난 에러도 위치가 나와야 한다 - 마지막 줄 끝.
    #[test]
    fn locates_end_of_source() {
        let src = "ab\ncd";
        assert_eq!(
            locate(src, src.len() as u32),
            SrcLocation { line: 2, column: 3 }
        );
    }

    /// 캐럿은 표시 폭으로 정렬한다 - 한글 앞선 만큼 2칸씩 밀어야 소스와 세로로 맞는다.
    #[test]
    fn caret_aligns_by_display_width() {
        let src = r#"div(class="가나") { x }"#;
        let at = src.find('x').unwrap();
        let out = format(
            "a.qubc",
            src,
            Some(SrcRange::new(at, at + 1)),
            "무엇이 틀렸다",
        );
        let lines: Vec<&str> = out.lines().collect();
        // 소스 줄과 캐럿 줄에서 `|` 뒤 부분만 떼어 폭을 비교한다.
        let body = lines[1].split_once("| ").unwrap().1;
        let caret = lines[2].split_once("| ").unwrap().1;
        assert_eq!(caret, format!("{}^", " ".repeat(display_width(&body[..at]))));
        // 문자 수로 셌다면 한글 두 자만큼(2칸) 왼쪽으로 밀렸을 것이다.
        assert_eq!(display_width(&body[..at]) - body[..at].chars().count(), 2);
    }

    /// 여러 줄에 걸친 range(닫히지 않은 문자열)는 시작 줄에서 줄 끝까지만 밑줄 친다.
    #[test]
    fn multiline_range_underlines_to_line_end() {
        let src = "a\nb \"unterminated\nc\n";
        let start = src.find('"').unwrap();
        let out = format("a.qubc", src, Some(SrcRange::new(start, src.len())), "안 닫혔다");
        let lines: Vec<&str> = out.lines().collect();
        // 진단은 세 줄(헤더/소스/캐럿)뿐 - 나머지 줄로 안 새어 나간다.
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1], " 2 | b \"unterminated");
        // `"unterminated` 13자 - 줄을 넘는 나머지는 잘린다.
        assert_eq!(lines[2], r#"   |   ^^^^^^^^^^^^^"#);
    }

    /// 빈 구간(EOF)도 가리킬 자리는 보여야 한다 - 캐럿 한 칸.
    #[test]
    fn empty_range_still_shows_one_caret() {
        let src = "component C {";
        let out = format("a.qubc", src, Some(SrcRange::eof(src.len())), "끝났다");
        // 캐럿은 소스 끝 자리에 한 칸. 빈 구간이라 폭이 0이 될 수 있는데 최소 1로 올린다.
        assert!(out.ends_with('^') && !out.ends_with("^^"), "{out}");
        assert_eq!(out.lines().next().unwrap(), "a.qubc:1:14: error: 끝났다");
    }

    /// 위치를 모르는 에러(codegen range None)는 파일명과 메시지만.
    #[test]
    fn no_range_prints_header_only() {
        let out = format("a.qubc", "whatever", None, "태그를 모른다");
        assert_eq!(out, "a.qubc: error: 태그를 모른다");
    }
}
