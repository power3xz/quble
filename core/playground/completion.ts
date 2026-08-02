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

/**
 * 소스에 이미 쓰인 키들. 한 번 쓴 fullname은 후보에서 빼려고 모은다 - 같은 키를 두 번 쓰면
 * 나중 것이 앞의 것을 덮으므로 후보로 내밀 이유가 없다.
 *
 * `:` 앞에 오는 것을 잡는다. 두 형태가 있다: `"Flag.CLICK_BADGE":`처럼 따옴표를 두른 것과
 * `CLICK_CARD:`처럼 맨 것 - 점/괄호가 든 fullname은 따옴표가 필수지만 식별자로 유효한 이름은
 * 그냥 쓸 수 있다.
 *
 * 지금 쓰는 중인 자리(skipAt, 여는 따옴표 안쪽 시작 오프셋)는 제외한다 - 그 자리의 미완성
 * 문자열까지 "이미 쓴 것"으로 세면 자기 자신 때문에 후보가 사라진다.
 *
 * @param source  편집 중인 파일 전체
 * @param skipAt  건너뛸 문자열의 시작 오프셋(여는 따옴표 다음 칸)
 */
export const usedKeys = (source: string, skipAt: number) => {
  const used = new Set<string>();
  const re = /(?:"([^"\n]*)"|([A-Za-z_$][\w$]*))\s*:/g;
  let m = re.exec(source);
  while (m) {
    // 따옴표 키면 여는 따옴표 다음 칸이 시작, 맨 키면 이름 자체가 시작이다.
    const start = m[1] === undefined ? m.index : m.index + 1;
    if (start !== skipAt) {
      used.add(m[1] ?? m[2]);
    }
    m = re.exec(source);
  }
  return used;
};

/**
 * 고른 키 뒤에 이어 넣을 함수 뼈대. `": (data) => {\n<들여쓰기>\n<들여쓰기>},"` 꼴이고,
 * 커서 자리는 `caret`(넣은 텍스트 안에서의 오프셋)이 가리킨다.
 *
 * 두 번째 인자는 회차 인덱스가 있을 때만 낸다 - `props`/`set`/`push`는 무엇을 쓸지 모르니
 * 비워 두고(안 쓰는 걸 넣으면 지우는 게 일이다), `$0`은 fullname의 `[$n]`이 있다는 것만으로
 * 확실하다. 중첩 @for면 `$0, $1`처럼 개수만큼 낸다.
 *
 * @param fullname  고른 핸들러 이름
 * @param indent    키가 놓인 줄의 들여쓰기(그 줄 앞 공백 그대로)
 */
export const handlerBody = (fullname: string, indent: string) => {
  const depth = (fullname.match(/\[\$\d+\]/g) ?? []).length;
  const loops = Array.from({ length: depth }, (_, i) => `$${i}`).join(", ");
  const params = depth ? `(data, { ${loops} })` : "(data)";
  const head = `: ${params} => {\n${indent}  `;
  return { text: `${head}\n${indent}},`, caret: head.length };
};
