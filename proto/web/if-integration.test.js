// @if 통합 테스트 - 실제 컴파일러(.qubc → .qubb)와 실제 runtime.js를 jsdom 위에서 돌린다.
// 가짜 interpret 복제본이 아니라 진짜 경로를 검증한다: 바이트코드 해석 → region 트리 → lazy
// build → swap → 재귀 구독. 검증은 사용자가 보는 결과(HTML)와 region 상태로 한다.
//
// 구독 0(안 보이는 가지)은 "비활성 가지 leaf를 set해도 화면이 안 바뀐다"로 행동 검증한다 -
// createLeafStoreSubject는 subscribers를 노출하지 않으므로(최소 노출), 부작용으로 간접 확인한다.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./fixtures/dom.js"; // jsdom 전역 document 주입(첫 import)
import { buildFixture } from "./fixtures/build.js";

// dom.js가 document를 깐 뒤에 runtime.js를 불러야 한다(top-level await import).
const { compile, createLeafStoreSubject } = await import("./runtime.js");

// 픽스처를 한 번 컴파일해 캐시(cargo run은 비싸다).
const qubb = {};
before(() => {
  for (const name of ["single_if", "nested_if", "no_else_if", "sibling_if", "triple_if", "composed_triple", "if_with_context", "lit_bool_if"]) {
    qubb[name] = buildFixture(name);
  }
});

// 한 인스턴스를 만들어 { store, inst, host, set } 묶음으로 - set은 path로 바로 쓰게.
const instantiate = (name, paths, values) => {
  const store = createLeafStoreSubject(values);
  const inst = compile(qubb[name])(0)(store, paths);
  const host = mount(inst);
  const set = (path, value) => store.setPath(path, value);
  return { store, inst, host, set };
};

// region 트리 탐색. branchOf: region의 슬롯(THEN/ELSE)을 전역 branches에서 Branch 객체로 푼다.
const THEN = 0;
const ELSE = 1;
const branchOf = (inst, region, slot) =>
  inst.branches[region.branchIndices[slot]];
const childRegion = (inst, regionIndex, slot, nth = 0) =>
  inst.regions[branchOf(inst, inst.regions[regionIndex], slot).childRegionIndices[nth]];

// 텍스트만 추출(주석 anchor·태그 제외) - swap 가시화 확인용.
const texts = (host) => [...host.querySelectorAll("p")].map((p) => p.textContent);

// ── 단일 if ──────────────────────────────────────────────────────────
test("단일 if: 초기 then 렌더, anchor 유지", () => {
  const { host, inst } = instantiate("single_if", ["cond", "a", "b"], { cond: true, a: "A", b: "B" });
  assert.deepEqual(texts(host), ["A"], "then(a) 보임");
  assert.match(host.innerHTML, /<!--qb:region#\d+-->/, "anchor 주석 존재");
  const r = childRegion(inst, 0, THEN);
  assert.equal(r.shownIndex, THEN);
  assert.equal(branchOf(inst, r, ELSE).built, false, "else 미build(lazy)");
});

test("단일 if: swap이 보이는 가지를 바꾼다(A→B→A)", () => {
  const { host, set } = instantiate("single_if", ["cond", "a", "b"], { cond: true, a: "A", b: "B" });
  set("cond", false);
  assert.deepEqual(texts(host), ["B"], "else(b)로 swap");
  set("cond", true);
  assert.deepEqual(texts(host), ["A"], "then(a)로 복귀");
});

test("단일 if: 비활성 가지 set은 화면을 안 바꾼다(구독 0)", () => {
  const { host, set } = instantiate("single_if", ["cond", "a", "b"], { cond: true, a: "A", b: "B" });
  set("b", "B2"); // else 비활성 - 구독 0이라 무반응
  assert.deepEqual(texts(host), ["A"], "여전히 A");
  set("cond", false); // else 활성화 → 최신값 B2 따라잡기
  assert.deepEqual(texts(host), ["B2"], "재활성 시 놓친 값 반영");
});

test("단일 if: 활성 가지 set은 즉시 반영", () => {
  const { host, set } = instantiate("single_if", ["cond", "a", "b"], { cond: true, a: "A", b: "B" });
  set("a", "A2");
  assert.deepEqual(texts(host), ["A2"], "활성 then 갱신");
});

// ── 중첩 if ──────────────────────────────────────────────────────────
test("중첩 if: 바깥 then 활성 시 안쪽 if도 build·자식 등록", () => {
  const { inst, host } = instantiate(
    "nested_if",
    ["outer", "inner", "a", "b", "c"],
    { outer: true, inner: true, a: "A", b: "B", c: "C" },
  );
  assert.deepEqual(texts(host), ["A", "B"], "바깥 then의 a + 안쪽 then의 b");
  const outer = childRegion(inst, 0, THEN);
  assert.equal(branchOf(inst, outer, THEN).childRegionIndices.length, 1, "안쪽 if 1개 등록");
  const inner = childRegion(inst, inst.regions.indexOf(outer), THEN);
  assert.equal(inner.shownIndex, THEN);
});

test("중첩 if: 안쪽 swap은 바깥과 독립", () => {
  const { host, set } = instantiate(
    "nested_if",
    ["outer", "inner", "a", "b", "c"],
    { outer: true, inner: true, a: "A", b: "B", c: "C" },
  );
  set("inner", false);
  assert.deepEqual(texts(host), ["A", "C"], "a 유지 + 안쪽 else의 c");
});

test("중첩 if: 바깥 swap이 안쪽(자식)까지 detach", () => {
  const { host, set } = instantiate(
    "nested_if",
    ["outer", "inner", "a", "b", "c"],
    { outer: true, inner: true, a: "A", b: "B", c: "C" },
  );
  set("outer", false);
  assert.deepEqual(texts(host), ["A"], "바깥 else의 a만(안쪽 트리 통째 사라짐)");
  // 바깥 비활성 동안 안쪽 leaf를 바꿔도 무반응(재귀로 구독 해제됨)
  set("b", "B2");
  set("outer", true);
  set("inner", true);
  assert.deepEqual(texts(host), ["A", "B2"], "재활성 시 안쪽도 최신값 따라잡기");
});

// ── else 없는 if ─────────────────────────────────────────────────────
test("else 없는 if: true면 렌더, false면 빈 자리(anchor만)", () => {
  const t = instantiate("no_else_if", ["cond", "a"], { cond: true, a: "A" });
  assert.deepEqual(texts(t.host), ["A"], "then 보임");

  const f = instantiate("no_else_if", ["cond", "a"], { cond: false, a: "A" });
  assert.deepEqual(texts(f.host), [], "빈 가지 - p 없음");
  assert.match(f.host.innerHTML, /<!--qb:region#\d+-->/, "anchor는 남음");

  f.set("cond", true); // 빈 else → then 첫 build
  assert.deepEqual(texts(f.host), ["A"], "swap으로 then 등장");
});

// ── 형제 if ──────────────────────────────────────────────────────────
test("형제 if: 같은 가지의 if 둘이 독립 swap", () => {
  const { inst, host, set } = instantiate(
    "sibling_if",
    ["c1", "c2", "a", "b", "c", "d"],
    { c1: true, c2: false, a: "A", b: "B", c: "C", d: "D" },
  );
  assert.deepEqual(texts(host), ["A", "D"], "첫 if then(A) + 둘째 if else(D)");
  assert.equal(branchOf(inst, inst.regions[0], THEN).childRegionIndices.length, 2, "루트 가지에 if 2개");

  set("c1", false); // 첫 if만 swap
  assert.deepEqual(texts(host), ["B", "D"], "첫 if만 B로, 둘째 D 유지");
  set("c2", true); // 둘째만 swap
  assert.deepEqual(texts(host), ["B", "C"], "둘째 C로, 첫 B 유지");
});

// ── 3단 중첩 ─────────────────────────────────────────────────────────
test("3단 중첩: 최하단까지 렌더, 최상단 swap이 전부 detach", () => {
  const { host, set } = instantiate(
    "triple_if",
    ["c1", "c2", "c3", "a", "b", "c", "d"],
    { c1: true, c2: true, c3: true, a: "A", b: "B", c: "C", d: "D" },
  );
  assert.deepEqual(texts(host), ["A"], "3단 then까지 내려가 a");
  set("c3", false);
  assert.deepEqual(texts(host), ["B"], "최하단만 else(b)");
  set("c1", false);
  assert.deepEqual(texts(host), ["D"], "최상단 else(d) - 2·3단 통째 사라짐");
  set("c1", true);
  assert.deepEqual(texts(host), ["B"], "복귀 시 안쪽 상태(c3=false) 유지 → b");
});

// ── @if 가지 안의 @with ──────────────────────────────────────────────
// 회귀: runtime.js operandLen에 ENTER/EXIT_CONTEXT가 빠져, @with를 품은 가지를 lazy build하며
// 스캔할 때 "bad opcode 0x13"으로 죽었다. then(@with) 가지가 build·swap될 때 터지지 않아야 한다.
test("@if 가지 안 @with: lazy build 시 context opcode를 건너뛴다", () => {
  // 초기 else 활성 - then(@with 가지)은 미build 상태로 둔다.
  const { host, set } = instantiate("if_with_context", ["cond", "a", "b"], { cond: false, a: "A", b: "B" });
  assert.deepEqual(texts(host), ["B"], "초기 else(b)");
  // then 활성화 → @with 가지 첫 build. 여기서 operandLen이 ENTER/EXIT_CONTEXT를 넘겨야 한다.
  set("cond", true);
  assert.deepEqual(texts(host), ["A"], "@with 품은 then 가지가 bad opcode 없이 렌더");
  set("cond", false);
  assert.deepEqual(texts(host), ["B"], "다시 else로 swap");
});

// ── 리터럴 bool을 @if 조건으로 ────────────────────────────────────────
// 부모가 자식에 리터럴 `cond=false`를 넘기고 자식이 @if(cond)로 분기. 상수풀 타입 태그가
// 없던 시절엔 리터럴이 문자열 "false"라 truthy -> THEN(A)로 오판했다. 이제 실제 boolean
// false라 ELSE(B)로 가야 한다(리터럴 타입화의 핵심 시나리오).
test("리터럴 bool @if: cond=false가 실제 boolean이라 else로 간다", () => {
  const { host } = instantiate("lit_bool_if", [], {});
  assert.deepEqual(texts(host), ["B"], "리터럴 false -> else(b). 문자열이면 truthy로 A가 됐을 것");
});

// ── 컴포넌트 합성 ─────────────────────────────────────────────────────
// triple_if를 부모(바깥 c1) + 자식 InnerPair(c2/c3)로 쪼개 RENDER로 합성. 같은 store·path를 쓰므로
// triple_if와 동일한 set/texts 시퀀스가 그대로 통과해야 한다(합성이 단일 컴포넌트와 동등).
test("합성 3단: triple_if를 부모+자식으로 쪼개도 동일 동작", () => {
  const { host, set } = instantiate(
    "composed_triple",
    ["c1", "c2", "c3", "a", "b", "c", "d"],
    { c1: true, c2: true, c3: true, a: "A", b: "B", c: "C", d: "D" },
  );
  assert.deepEqual(texts(host), ["A"], "3단 then까지 내려가 a");
  set("c3", false);
  assert.deepEqual(texts(host), ["B"], "최하단만 else(b)");
  set("c1", false);
  assert.deepEqual(texts(host), ["D"], "최상단 else(d) - 자식(2·3단) 통째 사라짐");
  set("c1", true);
  assert.deepEqual(texts(host), ["B"], "복귀 시 자식 안쪽 상태(c3=false) 유지 → b");
});
