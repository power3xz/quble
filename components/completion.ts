// 자동완성의 자리 판정. 셸 핸들러에서 떼어 둔다 - DOM에 묶이지 않아 그것만 테스트할 수 있다.

/**
 * 방금 친 큰따옴표가 핸들러 맵(`default {`)의 키를 여는 자리인가. fullname은 그 층에만 들어가므로
 * 중첩 객체나 함수 안에서는 뜨면 안 된다.
 *
 * 캐럿에서 뒤로 훑어 **나를 감싼** 여는 중괄호를 찾고(닫힌 쌍은 상쇄), 그 앞이 `default`면
 * 키 자리다. 감싼 괄호가 무엇인지만 보므로 절대 깊이를 셀 필요가 없다.
 *
 * 문자열/주석 안은 건너뛰지 않는다 - 여는 따옴표를 친 시점이라 그 앞은 코드이고, 앞선 문자열
 * 리터럴은 짝이 맞아 상쇄에 영향을 주지 않는다.
 *
 * @param source    편집 중인 파일 전체(캐럿 뒤는 보지 않는다)
 * @param quotePos  방금 친 따옴표의 오프셋
 */
export const isKeySlot = (source: string, quotePos: number) => {
  // 키를 여는 위치인가 - 바로 앞이 `{`(첫 키)나 `,`(다음 키)여야 한다. `:`면 값 자리,
  // `(`나 `[`면 인자/배열 자리다.
  const before = source.slice(0, quotePos).trimEnd();
  const prev = before[before.length - 1];
  if (prev !== "{" && prev !== ",") {
    return false;
  }
  return enclosingBraceIsDefault(source, quotePos);
};

// 캐럿을 감싼 여는 중괄호를 뒤로 훑어 찾고(닫힌 쌍은 상쇄), 그 앞이 `default`인지 본다.
// 감싼 괄호가 무엇인지만 보므로 절대 깊이를 셀 필요가 없다.
const enclosingBraceIsDefault = (source: string, from: number) => {
  let closed = 0;
  for (let i = from - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === "}") {
      closed++;
    } else if (ch === "{") {
      if (closed === 0) {
        return /\bdefault\s*$/.test(source.slice(0, i));
      }
      closed--;
    }
  }
  return false;
};

/**
 * 핸들러 파일이면 짝이 되는 엔트리 이름, 아니면 null.
 * `card.qubc.handlers.js` -> `card.qubc`.
 */
export const entryOf = (name: string | null) =>
  name?.endsWith(".qubc.handlers.js") ? name.slice(0, -".handlers.js".length) : null;
