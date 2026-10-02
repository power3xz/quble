// 부모가 같은 칸을 두 인덱스 prop으로 넘기는 경우 - 자식의 `${rows[i].score + rows[j].score}`에 i, j가
// 모두 부모의 cursor 칸을 가리킨다. 식의 두 변수가 한 칸을 읽고, 둘 다 READ_LEAF가 읽을 leafIndex를
// 정한다. cursor가 바뀌면 두 READ_LEAF의 구독을 모두 새 요소로 옮겨야 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_index_alias");
});

// props 선언 순서가 곧 고정부 leafIndex. 배열은 칸 하나(arrayInfoIndex).
//   0=rows 1=cursor
// rows 요소는 {score} 1칸이라 요소 i의 score = 2 + i.
const CURSOR = 1;
const scoreLeaf = (i: number) => 2 + i;

const instantiate = () => {
  const inst = compile(qubb)(0)({ rows: [{ score: 10 }, { score: 20 }], cursor: 0 }, {});
  const host = mount(inst);
  return {
    textOf: (cls: string) => (host.querySelector(`.${cls}`) as HTMLElement).textContent,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
  };
};

test("두 인덱스 변수가 같은 칸을 가리켜도 그 칸이 바뀌면 두 요소의 구독을 모두 옮긴다", () => {
  const { textOf, set } = instantiate();
  assert.equal(textOf("index-pair"), "20", "rows[0].score + rows[0].score");
  set(CURSOR, 1);
  assert.equal(textOf("index-pair"), "40", "rows[1].score + rows[1].score");
  set(scoreLeaf(1), 25);
  assert.equal(textOf("index-pair"), "50", "새로 읽는 rows[1].score의 변경이 닿는다");
  set(scoreLeaf(0), 99);
  assert.equal(textOf("index-pair"), "50", "더 이상 안 읽는 rows[0].score가 바뀌어도 그대로다");
});
