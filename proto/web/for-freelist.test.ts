// @for 회차 증감 시 branch/region 칸이 freelist로 반납·재사용되는지 검증한다. 화면 결과가 아니라
// pool 길이와 freelist 상태를 직접 본다 - 재사용이 깨져 늘 append해도 화면·이벤트는 같아
// for-integration.test.js가 못 잡기 때문.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./fixtures/build.js";
import { mount } from "./fixtures/dom.js";

const { compile, createLeafStoreSubject } = await import("./runtime.ts");

const qubb: Record<string, Uint8Array> = {};
before(() => {
  for (const name of ["for_count", "for_if_count"]) {
    qubb[name] = buildFixture(name);
  }
});

const instantiate = (name: string, paths: string[], values: Record<string, unknown>) => {
  const store = createLeafStoreSubject(values);
  const inst = compile(qubb[name])(0)(store, paths, {});
  mount(inst);
  return { store, inst };
};

test("count 줄이면 떼어낸 회차의 branch 칸이 freeBranches에 반납된다", () => {
  const { store, inst } = instantiate("for_count", ["n"], { n: 5 });
  assert.equal(inst.freeBranches.length, 0, "초기엔 빈 칸 없음");
  store.setPath("n", 2);
  assert.equal(inst.freeBranches.length, 3, "회차 3개 제거 -> branch 칸 3개 반납");
});

test("count 재증가 시 반납된 칸을 재사용해 branchPool이 안 커진다", () => {
  const { store, inst } = instantiate("for_count", ["n"], { n: 5 });
  const lenAt5 = inst.branchPool.length;
  store.setPath("n", 2); // 3칸 반납
  store.setPath("n", 5); // 3칸 재사용해야 함
  assert.equal(inst.freeBranches.length, 0, "반납된 칸을 전부 재사용 -> freelist 비움");
  assert.equal(inst.branchPool.length, lenAt5, "재사용했으니 pool 길이 그대로(append 아님)");
});

test("@if 품은 회차를 줄이면 자식 region 칸도 freeRegions에 반납된다", () => {
  const { store, inst } = instantiate("for_if_count", ["n", "flag"], { n: 3, flag: true });
  assert.equal(inst.freeRegions.length, 0, "초기엔 빈 칸 없음");
  store.setPath("n", 1); // 회차 2개 제거 -> 각 회차의 자식 @if region도 반납되어야
  assert.equal(inst.freeRegions.length, 2, "회차 2개의 자식 region 2개 반납");
});

test("@if 품은 회차 재증가 시 region 칸도 재사용돼 regionPool이 안 커진다", () => {
  const { store, inst } = instantiate("for_if_count", ["n", "flag"], { n: 3, flag: true });
  const lenAt3 = inst.regionPool.length;
  store.setPath("n", 1);
  store.setPath("n", 3);
  assert.equal(inst.freeRegions.length, 0, "반납된 region 칸 전부 재사용");
  assert.equal(inst.regionPool.length, lenAt3, "재사용했으니 regionPool 길이 그대로");
});
