// 자동완성 자리 판정 - 큰따옴표를 쳤을 때 그 자리가 핸들러 맵의 키인지.
//
// 틀리면 두 방향으로 나쁘다: 아닌 자리에서 열리면 후보가 방해가 되고, 키 자리에서 안 열리면
// 기능이 없는 것과 같다. 그래서 양쪽을 다 덮는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { entryOf, handlerBody, isKeySlot, usedKeys } from "../../components/completion.ts";

// `|`가 방금 친 따옴표 자리. 그 자리를 따옴표로 바꿔 실제 입력 직후 상태를 만든다.
const at = (marked: string) => {
  const pos = marked.indexOf("|");
  return isKeySlot(marked.replace("|", '"'), pos);
};

test("여는 중괄호 뒤 - 첫 키", () => {
  assert.equal(at("export default {\n  |"), true);
});

test("쉼표 뒤 - 다음 키", () => {
  assert.equal(at('export default {\n  "A": f,\n  |'), true);
});

test("콜론 뒤 값 자리 - 감싼 괄호는 맞지만 키를 여는 게 아니다", () => {
  assert.equal(at('export default {\n  "A": |'), false);
});

test("중첩 객체를 닫은 뒤는 다시 키 자리 - 닫힌 쌍은 상쇄된다", () => {
  assert.equal(at('export default {\n  "A": { x: 1, y: 2 },\n  |'), true);
});

test("중첩 객체 안은 키 자리가 아니다 - 감싼 괄호가 default의 것이 아니다", () => {
  assert.equal(at("export default {\n  a: { |"), false);
});

test("두 겹 안도 아니다", () => {
  assert.equal(at("export default {\n  a: { b: { |"), false);
});

test("함수 몸통 안은 키 자리가 아니다", () => {
  assert.equal(at('export default {\n  "A": (d) => { go(|'), false);
});

test("함수 인자 안은 키 자리가 아니다", () => {
  assert.equal(at('export default {\n  "A": (d) => go(|'), false);
});

test("배열 안은 키 자리가 아니다", () => {
  assert.equal(at('export default {\n  "A": [|'), false);
});

test("여는 중괄호가 없으면 키 자리가 아니다", () => {
  assert.equal(at("|"), false);
});

test("default가 아닌 객체는 키 자리가 아니다", () => {
  assert.equal(at("const map = {\n  |"), false);
});

test("앞선 문자열 리터럴에 흔들리지 않는다", () => {
  assert.equal(at('import x from "./y.ts";\nexport default {\n  |'), true);
});

// `|`가 지금 쓰는 중인 자리(여는 따옴표 다음 칸).
const used = (marked: string) => usedKeys(marked.replace("|", ""), marked.indexOf("|"));

test("따옴표를 두른 키를 모은다", () => {
  const keys = used('export default {\n  "A": f,\n  "B.C": g,\n|');
  assert.deepEqual([...keys].sort(), ["A", "B.C"]);
});

test("따옴표 없는 키도 모은다 - 식별자로 유효한 이름은 그냥 쓸 수 있다", () => {
  const keys = used('export default {\n  CLICK_CARD: f,\n  "Flag.CLICK_BADGE": g,\n|');
  assert.deepEqual([...keys].sort(), ["CLICK_CARD", "Flag.CLICK_BADGE"]);
});

test("값 자리 문자열은 키가 아니다", () => {
  const keys = used('export default {\n  A: () => log("CLICK_CARD"),\n|');
  assert.deepEqual([...keys].sort(), ["A"]);
});

test("지금 쓰는 중인 자리는 세지 않는다 - 자기 자신 때문에 후보가 사라지면 안 된다", () => {
  // 캐럿이 "CLI 뒤에 있다. 그 미완성 문자열은 이미 쓴 키가 아니다.
  const keys = used('export default {\n  "A": f,\n  "|CLI":\n}');
  assert.deepEqual([...keys].sort(), ["A"]);
});

test("따옴표 없이 쓰는 중인 자리도 세지 않는다", () => {
  const keys = used("export default {\n  A: f,\n  |CLI:\n}");
  assert.deepEqual([...keys].sort(), ["A"]);
});

test("@for 밖이면 두 번째 인자가 없다", () => {
  const { text } = handlerBody("CLICK_CARD", "  ");
  assert.equal(text, ": (data) => {\n    \n  },");
});

test("@for 안이면 회차 인덱스를 낸다", () => {
  const { text } = handlerBody("Lane[$0].CLICK_ADD_CARD", "  ");
  assert.equal(text, ": (data, { $0 }) => {\n    \n  },");
});

test("중첩 @for는 개수만큼", () => {
  const { text } = handlerBody("Lane[$0].Ticket[$1].CLICK_CARD", "  ");
  assert.equal(text, ": (data, { $0, $1 }) => {\n    \n  },");
});

test("커서는 몸통 안, 한 단 더 들여쓴 자리에 선다", () => {
  const { text, caret } = handlerBody("CLICK_CARD", "  ");
  assert.equal(text.slice(0, caret), ": (data) => {\n    ");
  assert.equal(text.slice(caret), "\n  },");
});

test("들여쓰기를 그대로 물려받는다", () => {
  const { text } = handlerBody("A", "\t\t");
  assert.equal(text, ": (data) => {\n\t\t  \n\t\t},");
});

test("핸들러 파일에서 짝이 되는 엔트리를 얻는다", () => {
  assert.equal(entryOf("card.qubc.handlers.js"), "card.qubc");
});

test("핸들러 파일이 아니면 엔트리가 없다", () => {
  assert.equal(entryOf("card.qubc"), null);
  assert.equal(entryOf("board.css"), null);
  assert.equal(entryOf(null), null);
});
