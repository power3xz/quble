// resume - SSR이 그린 DOM을 노드를 새로 만들지 않고 이어받는다.
//
// blueprint에 { resumeFrom: host }를 주면 런타임이 노드를 만들던 자리에서 host 아래 SSR 노드를
// 앞순회로 꺼내 쓴다(resume-cursor.ts). store, region, 구독, 이벤트 바인딩은 처음 그릴 때와 같이 짓는다.
//
// 확인은 둘로 나뉜다.
//   - 모든 SSR 일치 시드로: SSR 노드를 그대로 쓰는지(새로 만드는 것은 빈 텍스트 자리뿐), 이어받은
//     DOM이 CSR DOM과 같은지
//   - 픽스처 몇 개로: 이어받은 뒤의 set, 클릭, lazy build, push가 CSR처럼 동작하는지

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resume as resumeFrom } from "./resume.ts";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixtureWithResmap } from "./test-helpers/build.ts";
import "./test-helpers/dom.ts";
import { isTextMark, renderSsr } from "./test-helpers/ssr.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web
const seeds: Record<string, unknown[]> = JSON.parse(readFileSync(join(HERE, "ssr-match.seeds.json"), "utf8"));

// SSR HTML을 담은 host. 클릭이 위임 리스너에 닿도록 문서에 붙인다(이전 테스트의 host는 비운다).
const ssrHost = (name: string, resmap: string[], data: unknown): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = renderSsr(name, resmap, data).html;
  document.body.replaceChildren(host);
  return host;
};

// root 아래 노드 전부(앞순회).
const allNodes = (root: Node): Node[] => [...root.childNodes].flatMap((n) => [n, ...allNodes(n)]);

const resume = (qubb: Uint8Array, resmap: string[], host: HTMLElement, data: unknown, handlers: THandlers = {}) => {
  const inst = resumeFrom(qubb, resmap)(0)(data, handlers, { resumeFrom: host });
  host.replaceChildren(...inst.nodes);
  return inst;
};

// 같은 data로 처음부터 그린(CSR) DOM의 HTML.
const csrHtml = (qubb: Uint8Array, resmap: string[], data: unknown): string => {
  const inst = compile(qubb, resmap)(0)(data, {});
  const host = document.createElement("div");
  host.append(...inst.nodes);
  const html = host.innerHTML;
  inst.destroy();
  return html;
};

for (const [name, list] of Object.entries(seeds)) {
  list.forEach((data, i) => {
    test(`${name} 시드 ${i} - SSR 노드를 그대로 이어받는다`, () => {
      const { qubb, resmap } = buildFixtureWithResmap(name);
      const host = ssrHost(name, resmap, data);
      const before = allNodes(host);
      const kept = new Set(before.filter((n) => !isTextMark(n)));
      const emptyMarks = before.filter((n) => isTextMark(n) && (n as Comment).data === "qb:empty").length;

      const inst = resume(qubb, resmap, host, data);
      const after = allNodes(host);
      const afterSet = new Set(after);
      const html = host.innerHTML;
      inst.destroy();

      // 노드가 많은 픽스처(perfbig)가 있어 노드 목록 대신 개수를 비교한다 - 실패 출력이 노드를 다 찍는다.
      assert.equal([...kept].filter((n) => !afterSet.has(n)).length, 0, "SSR 노드가 빠졌다");
      const created = after.filter((n) => !kept.has(n));
      assert.equal(created.length, emptyMarks, "새로 만든 노드는 빈 텍스트 자리뿐이다");
      assert.ok(created.every((n) => n.nodeType === n.TEXT_NODE && n.textContent === ""));
      assert.equal(html, csrHtml(qubb, resmap, data));
    });
  });
}

test("SSR이 head에 <style data-qb-href>로 인라인한 리소스는 <link>로 다시 넣지 않는다", () => {
  for (const link of [...document.head.querySelectorAll("link")]) {
    link.remove();
  }
  const { qubb, resmap } = buildFixtureWithResmap("styled_res");
  const host = ssrHost("styled_res", resmap, {});
  const inlined = document.createElement("style");
  inlined.setAttribute("data-qb-href", resmap[0]);
  inlined.textContent = ".box { color: red }";
  document.head.append(inlined);
  const inst = resume(qubb, resmap, host, {});
  assert.equal(document.head.querySelectorAll("link").length, 0, "인라인한 리소스를 <link>로 또 넣었다");
  inst.destroy();
  inlined.remove();
});

test("data-qb-href가 상대 경로여도 문서 주소 기준으로 같은 리소스면 <link>로 다시 넣지 않는다", () => {
  for (const link of [...document.head.querySelectorAll("link")]) {
    link.remove();
  }
  const base = document.createElement("base");
  base.href = "https://example.com/app/";
  document.head.append(base);
  const { qubb, resmap } = buildFixtureWithResmap("styled_res");
  const host = ssrHost("styled_res", resmap, {});
  const inlined = document.createElement("style");
  inlined.setAttribute("data-qb-href", "res/a.css"); // SSR이 적은 상대 경로
  inlined.textContent = ".box { color: red }";
  document.head.append(inlined);
  // 페이지 스크립트가 넘기는 값은 qubb 주소 기준으로 푼 절대 URL이다.
  const inst = resume(qubb, ["https://example.com/app/res/a.css"], host, {});
  assert.equal(document.head.querySelectorAll("link").length, 0, "인라인한 리소스를 <link>로 또 넣었다");
  inst.destroy();
  inlined.remove();
  base.remove();
});

test("이어받은 뒤 클릭과 set이 CSR처럼 동작한다 - payload 식", () => {
  const data = { n: 1, open: true, cursor: 0, rows: [{ title: "A", tags: ["a1"] }] };
  const { qubb, resmap } = buildFixtureWithResmap("payload_expr");
  const host = ssrHost("payload_expr", resmap, data);
  const ssrSend = host.querySelector(".send");
  const sent: unknown[] = [];
  const inst = resume(qubb, resmap, host, data, { SEND: (d) => sent.push(d.next) });
  const send = host.querySelector(".send") as HTMLButtonElement;
  assert.equal(send, ssrSend, "SSR이 그린 버튼에 이벤트가 걸린다");
  send.click();
  inst.store.set(0, 10); // n
  send.click();
  assert.deepEqual(sent, [2, 11]);
  inst.destroy();
});

test("이어받은 뒤 인덱스가 바뀌면 텍스트가 갱신된다", () => {
  const data = {
    rows: [
      { title: "A", score: 10 },
      { title: "B", score: 20 },
      { title: "C", score: 30 },
    ],
    scalars: [7, 8, 9],
    cursor: 0,
    show: false,
  };
  const { qubb, resmap } = buildFixtureWithResmap("expr_array_index");
  const host = ssrHost("expr_array_index", resmap, data);
  const field = host.querySelector(".field") as HTMLElement;
  const inst = resume(qubb, resmap, host, data);
  assert.equal(host.querySelector(".field"), field, "SSR이 그린 노드를 그대로 쓴다");
  assert.equal(field.textContent, "A");
  inst.store.set(2, 1); // cursor
  assert.equal(field.textContent, "B");
  inst.destroy();
});

test("이어받은 뒤 @if가 바뀌면 SSR이 안 그린 가지를 새로 짓는다", () => {
  const data = { tags: ["a", "b"], flag: true };
  const { qubb, resmap } = buildFixtureWithResmap("for_if_lazy_slot");
  const host = ssrHost("for_if_lazy_slot", resmap, data);
  const ssrSpans = [...host.querySelectorAll("span")];
  const inst = resume(qubb, resmap, host, data);
  const spans = () => [...host.querySelectorAll("span")].map((s) => `${s.className}:${s.textContent}`);
  assert.deepEqual(spans(), ["on:a", "on:b"]);
  inst.store.set(1, false); // flag
  assert.deepEqual(spans(), ["off:off", "off:off"]);
  inst.store.set(1, true);
  assert.deepEqual(spans(), ["on:a", "on:b"]);
  // 다시 켠 then 가지는 새로 짓지 않고 SSR이 그린 노드를 다시 붙인다.
  const now = [...host.querySelectorAll("span")];
  assert.ok(now.length === ssrSpans.length && now.every((s, i) => s === ssrSpans[i]), "SSR이 그린 span이어야 한다");
  inst.destroy();
});

test("이어받은 뒤 push한 요소가 꼬리에 그려진다", () => {
  const data = { tags: ["a"] };
  const { qubb, resmap } = buildFixtureWithResmap("for_array_push");
  const host = ssrHost("for_array_push", resmap, data);
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (arrayLeafIndex: number, elem: unknown) => void;
      push((ctx.props as Record<string, number>).tags, "b");
    },
  };
  const ssrTag = host.querySelector(".tag");
  const inst = resume(qubb, resmap, host, data, handlers);
  (host.querySelector(".add") as HTMLButtonElement).click();
  assert.deepEqual(
    [...host.querySelectorAll(".tag")].map((t) => t.textContent),
    ["a", "b"],
  );
  assert.equal(host.querySelector(".tag"), ssrTag, "SSR이 그린 요소는 그대로 남고 새 요소만 붙는다");
  inst.destroy();
});
