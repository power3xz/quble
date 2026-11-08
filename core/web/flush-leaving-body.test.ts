// 본문이 떨어지는 flush에서 떠나는 본문의 식은 평가하지 않는다(ISSUES.md "본문이 떨어지는 flush에서 떠나는 본문의
// 식을 한 번 센다").
//
// 가지가 식 인스턴스를 실을 때 vm이 그 가지를 고르는 식 인스턴스에서 간선을 건다. `@if`의 then 가지는 조건 식
// 인스턴스에서 label then, 개수 `@for`의 행 k는 행 수를 읽는 식 인스턴스에서 label k다. flush의 pull은 시작점의
// 새 값이 label과 맞지 않으면 끝점을 평가하지 않는다. 떠나는 본문의 식이 평가되면 `rows[3]`처럼 범위 밖을 읽어
// RangeError를 throw하므로, throw하지 않는 것으로 평가하지 않았음을 본다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { resume } from "./resume-entry.ts";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";
import { renderSsr } from "./test-helpers/ssr.ts";

const NAME = "flush_leaving_body";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture(NAME);
});

// 핸들러 안에서 난 에러. 핸들러가 끝날 때 모은 통지에서 난 에러는 click()까지 올라오지 않고 jsdom이 window의
// error 이벤트로 보고하므로 여기서 받아 담는다.
let handlerError: unknown = null;
document.defaultView?.addEventListener("error", (e) => {
  handlerError = e.error;
  e.preventDefault();
});

// SHRINK는 rows의 마지막 요소를 지우고 n을 2로 줄인다. 행 2는 이 flush에서 떠난다.
const handlers: THandlers = {
  SHRINK: (_d, ctx) => {
    const removeAt = ctx.removeAt as (array: unknown, index: number) => void;
    const set = ctx.set as (leafIndex: number, value: unknown) => void;
    const store = ctx.store as Record<string, number>;
    removeAt(store.rows, 2);
    set(store.n, 2);
  },
};

type TSeed = { i: number; n: number; ok: boolean; c: boolean; x: number; rows: number[] };

const BASE: TSeed = { i: 2, n: 3, ok: false, c: false, x: 1, rows: [10, 20, 30] };

const texts = (host: ParentNode, className: string) =>
  [...host.querySelectorAll(`.${className}`)].map((node) => node.textContent);

const instantiate = (seed: Partial<TSeed>) => {
  handlerError = null;
  const inst = compile(qubb)(0)({ ...BASE, ...seed }, handlers);
  const host = mount(inst);
  return {
    inst,
    host,
    shrink: () => (host.querySelector(".shrink") as HTMLButtonElement).click(),
    error: () => handlerError,
  };
};

test("`@if (i < n)` 조건이 false가 되는 flush에서 본문의 식을 평가하지 않는다", () => {
  const { inst, host } = instantiate({});
  assert.deepEqual(texts(host, "if-expr"), ["30"]);

  assert.doesNotThrow(() => inst.update({ i: 3 }));

  assert.deepEqual(texts(host, "if-expr"), [], "본문이 떨어진다");
});

test("`@if (i < n)` 안의 배열 `@for` 행의 식도 조건이 false가 되는 flush에서 평가하지 않는다", () => {
  const { inst, host } = instantiate({});
  assert.deepEqual(texts(host, "in-array"), ["40", "50", "60"]);

  assert.doesNotThrow(() => inst.update({ i: 3 }));

  assert.deepEqual(texts(host, "in-array"), []);
});

test("leaf 하나가 조건인 `@if (ok)`가 false가 되는 flush에서 본문의 식을 평가하지 않는다", () => {
  const { inst, host } = instantiate({ ok: true });
  assert.deepEqual(texts(host, "if-leaf"), ["30"]);

  assert.doesNotThrow(() => inst.update({ ok: false, i: 3 }));

  assert.deepEqual(texts(host, "if-leaf"), []);
});

test("개수 `@for`의 행 수가 줄어드는 flush에서 떠나는 행의 식을 평가하지 않는다", () => {
  const { host, shrink, error } = instantiate({ i: 0 });
  assert.deepEqual(texts(host, "row"), ["10", "20", "30"]);

  shrink();

  assert.equal(error(), null);
  assert.deepEqual(texts(host, "row"), ["10", "20"]);
});

test("root와 `@if (c)`가 함께 가진 식은 c가 false가 되는 flush에서도 평가한다", () => {
  const { inst, host } = instantiate({ c: true });
  assert.deepEqual(texts(host, "root-x"), ["2"]);
  assert.deepEqual(texts(host, "if-x"), ["2"]);

  inst.update({ c: false, x: 5 });

  assert.deepEqual(texts(host, "root-x"), ["6"]);
});

test("개수 `@for`의 행이 줄면 떠난 행의 식 인스턴스로 가는 간선이 지워진다", () => {
  const { inst, shrink } = instantiate({ i: 0 });
  // 행 k의 간선은 label이 k(0 이상)다. 행 셋이 식 인스턴스를 하나씩 가진다.
  const rowEdges = () => {
    const { exprGraph, exprInstances } = inst;
    let count = 0;
    for (let node = 0; node < exprInstances.entries.length; node++) {
      for (const edge of exprGraph.incomingEdgesOfNode(node) ?? []) {
        if (exprGraph.labelOfEdge(edge) >= 0) {
          count++;
        }
      }
    }
    return count;
  };
  assert.equal(rowEdges(), 3);

  shrink();

  assert.equal(rowEdges(), 2);
});

test("SSR에서 resume해도 `@if (i < n)` 조건이 false가 되는 flush에서 본문의 식을 평가하지 않는다", () => {
  const host = document.createElement("div");
  host.innerHTML = renderSsr(NAME, [], BASE).html;
  const inst = resume(qubb, host, { data: BASE, handlers });
  assert.deepEqual(texts(host, "if-expr"), ["30"]);

  assert.doesNotThrow(() => inst.update({ i: 3 }));

  assert.deepEqual(texts(host, "if-expr"), []);
  inst.destroy();
});
