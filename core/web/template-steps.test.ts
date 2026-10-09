// 값 자리 사이 걸음 계산 테스트 - 걸음이 가리키는 노드가 앞순회 번호의 노드와 같은지를 jsdom 노드 위에서 본다.
// 기대 걸음(spec)은 손으로 적고, 따라간 결과는 복제본에서 앞순회로 센 노드와 대조한다(구현이 하는 일을 베끼지 않는다).

import assert from "node:assert/strict";
import { test } from "node:test";
import { STEP_FIRST_CHILD, STEP_NEXT_SIBLING, STEP_PARENT, stepsToEachHole } from "./template-steps.ts";
import "./test-helpers/dom.ts"; // jsdom 전역 document 주입

const el = (tag: string, ...children: Node[]): HTMLElement => {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
};
const text = (value: string): Text => document.createTextNode(value);
const fragmentOf = (...children: Node[]): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  fragment.append(...children);
  return fragment;
};

// root 아래를 앞순회한 순서대로 모은다 - 노드 번호의 정의다.
const preorder = (root: Node): Node[] => {
  const nodes: Node[] = [];
  const visit = (parent: Node) => {
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      nodes.push(child);
      visit(child);
    }
  };
  visit(root);
  return nodes;
};

const follow = (from: Node, steps: number[]): Node => {
  let cursor: Node = from;
  for (const step of steps) {
    cursor =
      step === STEP_FIRST_CHILD
        ? (cursor.firstChild as Node)
        : step === STEP_NEXT_SIBLING
          ? (cursor.nextSibling as Node)
          : (cursor.parentNode as Node);
  }
  return cursor;
};

// 뼈대에서 구한 걸음을 복제본에 따라가 각 값 자리가 복제본의 앞순회 번호 노드에 닿는지 확인한다.
const assertReachesHoles = (template: DocumentFragment, holeNodeNumbers: number[]) => {
  const steps = stepsToEachHole(template, holeNodeNumbers);
  assert.equal(steps.length, holeNodeNumbers.length);
  const clone = template.cloneNode(true);
  const nodes = preorder(clone);
  let cursor: Node = clone;
  holeNodeNumbers.forEach((number, i) => {
    cursor = follow(cursor, steps[i]);
    if (number >= 0) {
      assert.equal(cursor, nodes[number], `값 자리 ${i}(노드 ${number})`);
    }
  });
  return steps;
};

// 벤치 행 모양: div.row > span*6 > 값 텍스트, span(속성 값 자리) > "!", a(속성 값 자리) > "link", button(이벤트 값 자리) > "+1"
const rowTemplate = () =>
  fragmentOf(
    el(
      "div",
      el("span", text("")),
      el("span", text("")),
      el("span", text("")),
      el("span", text("")),
      el("span", text("")),
      el("span", text("")),
      el("span", text("!")),
      el("a", text("link")),
      el("button", text("+1")),
    ),
  );
//  0 div  1 span 2 텍스트  3 span 4 텍스트  5 span 6 텍스트  7 span 8 텍스트  9 span 10 텍스트  11 span 12 텍스트
//  13 span("!" 14)  15 a("link" 16)  17 button("+1" 18)
const ROW_HOLES = [2, 4, 6, 8, 10, 12, 13, 15, 17];

test("행 모양 뼈대는 앞 값 자리에서 다음 값 자리로 가는 걸음을 낸다", () => {
  const steps = assertReachesHoles(rowTemplate(), ROW_HOLES);
  // 첫 값 자리는 root에서 세 번 내려가고, 이어지는 텍스트 값 자리 다섯은 위로 나가 다음 형제의 첫 자식으로 간다.
  // 이어서 span(속성), a, button은 형제로 건너간다.
  const leaveAndEnterNextSibling = [STEP_PARENT, STEP_NEXT_SIBLING, STEP_FIRST_CHILD];
  assert.deepEqual(steps, [
    [STEP_FIRST_CHILD, STEP_FIRST_CHILD, STEP_FIRST_CHILD],
    leaveAndEnterNextSibling,
    leaveAndEnterNextSibling,
    leaveAndEnterNextSibling,
    leaveAndEnterNextSibling,
    leaveAndEnterNextSibling,
    [STEP_PARENT, STEP_NEXT_SIBLING],
    [STEP_NEXT_SIBLING],
    [STEP_NEXT_SIBLING],
  ]);
});

test("같은 요소의 값 자리가 둘이면 두 번째는 걸음이 비어 있다", () => {
  const template = fragmentOf(el("a", text("link")));
  const steps = assertReachesHoles(template, [0, 0]);
  assert.deepEqual(steps, [[STEP_FIRST_CHILD], []]);
});

test("값 자리 앞의 정적 형제는 nextSibling으로 건너뛴다", () => {
  const template = fragmentOf(el("div", el("span"), el("span"), el("span", text(""))));
  // 0 div  1 span  2 span  3 span  4 텍스트
  const steps = assertReachesHoles(template, [4]);
  assert.deepEqual(steps, [
    [STEP_FIRST_CHILD, STEP_FIRST_CHILD, STEP_NEXT_SIBLING, STEP_NEXT_SIBLING, STEP_FIRST_CHILD],
  ]);
});

test("깊은 곳에서 위로 두 단계 나가 다음 형제로 간다", () => {
  const template = fragmentOf(el("div", el("section", el("p", text(""))), el("aside")));
  // 0 div  1 section  2 p  3 텍스트  4 aside
  const steps = assertReachesHoles(template, [3, 4]);
  assert.deepEqual(steps, [
    [STEP_FIRST_CHILD, STEP_FIRST_CHILD, STEP_FIRST_CHILD, STEP_FIRST_CHILD],
    [STEP_PARENT, STEP_PARENT, STEP_NEXT_SIBLING],
  ]);
});

test("노드가 없는 값 자리(-1)는 걸음이 비고 커서를 움직이지 않는다", () => {
  const template = fragmentOf(el("div", el("span", text("")), el("span", text(""))));
  // 0 div  1 span  2 텍스트  3 span  4 텍스트
  const steps = assertReachesHoles(template, [2, -1, 4]);
  assert.deepEqual(steps, [
    [STEP_FIRST_CHILD, STEP_FIRST_CHILD, STEP_FIRST_CHILD],
    [],
    [STEP_PARENT, STEP_NEXT_SIBLING, STEP_FIRST_CHILD],
  ]);
});

test("첫 노드(번호 0)는 root에서 firstChild 한 걸음이다", () => {
  const steps = assertReachesHoles(fragmentOf(el("div")), [0]);
  assert.deepEqual(steps, [[STEP_FIRST_CHILD]]);
});

test("값 자리가 없으면 걸음도 없다", () => {
  assert.deepEqual(stepsToEachHole(rowTemplate(), []), []);
});
