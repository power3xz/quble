// 배열이 자기 요소를 인덱스로 쓰는 경우 - `${nums[nums[0]]}`.
//
// nums[0]이 0이면 안쪽 READ_LEAF(nums[0])와 바깥 READ_LEAF(nums[nums[0]])가 같은 요소 leaf를 읽어, 그 leaf의
// 변수 목록에 둘이 함께 든다. 그 leaf가 바뀌면 안쪽 변수 몫으로 바깥 READ_LEAF의 구독을 옮기는데, 옮기며
// 바로 그 변수 목록에서 바깥 변수를 뺀다. 도는 중인 목록이 줄어도 나머지를 맞게 돌아야 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_self_index");
});

// props 선언 순서가 곧 고정부 leafIndex. 배열은 칸 하나(arrayInfoIndex).
//   0=nums
// 요소는 1칸이라 nums[i] = 1 + i.
const numLeaf = (i: number) => 1 + i;

const instantiate = () => {
  const inst = compile(qubb)(0)({ nums: [0, 7] }, {});
  const host = mount(inst);
  return {
    textOf: (cls: string) => (host.querySelector(`.${cls}`) as HTMLElement).textContent,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
  };
};

test("두 READ_LEAF가 함께 읽던 요소가 바뀌어 한쪽이 다른 요소로 옮겨 가도 맞게 따라간다", () => {
  const { textOf, set } = instantiate();
  assert.equal(textOf("self"), "0", "nums[nums[0]] = nums[0] = 0");
  set(numLeaf(0), 1);
  assert.equal(textOf("self"), "7", "nums[nums[0]] = nums[1] = 7");
  set(numLeaf(1), 9);
  assert.equal(textOf("self"), "9", "바깥 READ_LEAF가 새로 읽는 nums[1]의 변경이 닿는다");
  set(numLeaf(0), 0);
  assert.equal(textOf("self"), "0", "다시 nums[0]을 읽는다");
});
