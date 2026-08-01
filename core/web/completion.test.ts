// 자동완성 자리 판정 - 큰따옴표를 쳤을 때 그 자리가 핸들러 맵의 키인지.
//
// 틀리면 두 방향으로 나쁘다: 아닌 자리에서 열리면 후보가 방해가 되고, 키 자리에서 안 열리면
// 기능이 없는 것과 같다. 그래서 양쪽을 다 덮는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { entryOf, isKeySlot } from "../../components/completion.ts";

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

test("핸들러 파일에서 짝이 되는 엔트리를 얻는다", () => {
  assert.equal(entryOf("card.qubc.handlers.js"), "card.qubc");
});

test("핸들러 파일이 아니면 엔트리가 없다", () => {
  assert.equal(entryOf("card.qubc"), null);
  assert.equal(entryOf("board.css"), null);
  assert.equal(entryOf(null), null);
});
