// 입력이 있는 계산 식의 부분 재평가 - 입력 식의 값을 올리는 명령(LOAD_INPUT)도 건너뛰기 표의 변수라, 입력이 바뀌면
// 그 입력을 품지 않은 부분식은 계산하지 않고 지난번 값을 사용한다(expr-skip-table.ts).
//
// `a * b + rows[pivot].price`는 감싼 식 `a * b + #R`(R은 값 읽기 식)로 컴파일된다. 인스턴스가 내놓는 store는 런타임이
// 사용하는 store와 같은 객체라, get을 감싸 식을 세며 어느 leaf를 읽었는지 기록해 본다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

// props 선언 순서가 곧 고정부 leafIndex. 0=a 1=b 2=pivot 3=rows. rows 요소는 {price} 1 leaf라 요소 i의 price = 4 + i.
const A = 0;
const B = 1;
const PIVOT = 2;
const priceLeaf = (i: number) => 4 + i;

const render = () => {
  const inst = compile(buildFixture("index_read_partial"))(0)(
    { a: 2, b: 3, pivot: 0, rows: [{ price: 10 }, { price: 20 }] },
    {},
  );
  const host = mount(inst);
  const { store } = inst;
  return {
    text: () => (host.querySelector(".v") as HTMLElement).textContent,
    set: (leafIndex: number, v: unknown) => store.set(leafIndex, v),
    // action 동안 런타임이 store에서 읽은 leaf들.
    readsDuring: (action: () => void) => {
      const original = store.get;
      const reads: number[] = [];
      store.get = (leafIndex: number) => {
        reads.push(leafIndex);
        return original(leafIndex);
      };
      try {
        action();
      } finally {
        store.get = original;
      }
      return reads;
    },
  };
};

test("입력과 leaf가 번갈아 바뀌어도 맞게 센다", () => {
  const { text, set } = render();
  assert.equal(text(), "16", "2 * 3 + rows[0].price");
  set(PIVOT, 1);
  assert.equal(text(), "26", "2 * 3 + rows[1].price");
  set(A, 4);
  assert.equal(text(), "32", "4 * 3 + rows[1].price");
  set(priceLeaf(1), 50);
  assert.equal(text(), "62", "4 * 3 + rows[1].price(50)");
});

test("pivot이 바뀌면 a * b를 건너뛰어 a, b를 읽지 않는다", () => {
  const { readsDuring, set } = render();
  const reads = readsDuring(() => set(PIVOT, 1));
  assert.ok(!reads.includes(A) && !reads.includes(B), `읽은 leaf ${reads}`);
});

test("pivot이 가리키는 요소의 값이 바뀌면 그 leaf만 읽는다", () => {
  const { readsDuring, set } = render();
  // 값 읽기 식은 주소를 다시 구하지 않고 요소 leaf만 읽고, 감싼 식은 a * b를 건너뛴다.
  assert.deepEqual(
    readsDuring(() => set(priceLeaf(0), 50)),
    [priceLeaf(0)],
  );
});

test("a가 바뀌면 입력 식은 다시 세지 않아 a, b만 읽는다", () => {
  const { readsDuring, set } = render();
  assert.deepEqual(
    readsDuring(() => set(A, 4)),
    [A, B],
  );
});
