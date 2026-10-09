// 정적 하위 트리가 값 자리 사이에 끼고 한 요소에 값 자리가 둘(속성 + 이벤트)인 @for 행이 복제 경로(템플릿 복제)로
// 올바른 노드에 바인딩되는지 본다. 값 자리를 잘못 찾으면 텍스트가 엉뚱한 요소에 들어가거나 다른 행이 갱신된다.
//
// leafIndex는 plant 규칙으로 손계산한다: 루트 {rows: T[]}는 배열칸 하나(leaf 0)만 심고, 요소는 그 뒤에 쌓는다.
// 요소 {id, note, url}은 3칸이라 요소 i의 base = 1 + 3*i, offset은 id=0/note=1/url=2.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_row_shape");
});

const idLeaf = (i: number) => 1 + 3 * i;
const noteLeaf = (i: number) => 2 + 3 * i;
const urlLeaf = (i: number) => 3 + 3 * i;

const seed = () => ({
  rows: [
    { id: "A", note: "n1", url: "/a" },
    { id: "B", note: "n2", url: "/b" },
    { id: "C", note: "n3", url: "/c" },
  ],
});

const instantiate = (handlers: THandlers = {}) => {
  const inst = compile(qubb)(0)(seed(), handlers);
  const host = mount(inst);
  return { store: inst.store, host };
};

// 행마다 값 자리가 닿는 곳만 모은다 - 정적 노드는 값 자리가 아니라 제외한다.
const rowsOf = (host: HTMLElement) =>
  [...host.querySelectorAll("li.row")].map((li) => ({
    id: li.querySelector(".id")?.textContent,
    note: li.querySelector(".note")?.textContent,
    href: li.querySelector("a.link")?.getAttribute("href"),
  }));

test("값 자리 사이에 정적 하위 트리가 끼어도 행마다 각 값이 제자리에 들어간다", () => {
  const { host } = instantiate();
  assert.deepEqual(rowsOf(host), [
    { id: "A", note: "n1", href: "/a" },
    { id: "B", note: "n2", href: "/b" },
    { id: "C", note: "n3", href: "/c" },
  ]);
  const firstRow = host.querySelector("li.row") as HTMLElement;
  assert.deepEqual(
    [...firstRow.children].map((child) => child.tagName),
    ["B", "SPAN", "P", "A", "SMALL"],
    "정적 노드가 그대로 남는다",
  );
  assert.equal(firstRow.querySelector("b")?.textContent, "static");
  assert.equal(firstRow.querySelector("em")?.textContent, "x");
  assert.equal(firstRow.querySelector("a")?.textContent, "go");
  assert.equal(firstRow.querySelector("small")?.textContent, "end");
});

test("값을 바꾸면 그 행의 그 자리만 갱신된다", () => {
  const { host, store } = instantiate();
  store.set(idLeaf(1), "B2");
  store.set(noteLeaf(2), "n3b");
  store.set(urlLeaf(0), "/a2");
  assert.deepEqual(rowsOf(host), [
    { id: "A", note: "n1", href: "/a2" },
    { id: "B2", note: "n2", href: "/b" },
    { id: "C", note: "n3b", href: "/c" },
  ]);
});

test("속성 값 자리와 같은 요소에 붙은 이벤트가 그 행의 요소에서 발화한다", () => {
  const picked: unknown[] = [];
  const { host } = instantiate({
    "[$0].PICK": (_data, { $0 }) => {
      picked.push($0);
    },
  });
  const links = [...host.querySelectorAll("a.link")] as HTMLElement[];
  links[2].click();
  links[0].click();
  assert.deepEqual(picked, [2, 0]);
});
