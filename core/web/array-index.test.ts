// 배열 인덱스 접근 - `props.items[2].title`처럼 요소로 내려간다.
//
// 요소 주소는 컴파일타임 offset이 아니라 arrayInfo.elemStartLeafIndices가 들고 있고(alloc/free로
// 자리가 오간다) push/removeAt으로 목록이 계속 바뀐다. 그래서 배열 노드는 인덱싱하는 그 순간에
// 요소 노드를 만든다 - 확인할 것은 그 해소가 늘 현재 목록을 보는가다. 미리 펴 두었다면 push/
// removeAt 뒤에 낡은 자리를 가리킨다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("set_object");
});

type TCtx = {
  props: { user: { tags: TNode; posts: TNode } };
  get: (k: unknown) => unknown;
  set: (k: unknown, v: unknown) => void;
  setObject: (k: unknown, v: unknown) => void;
  push: (k: unknown, v: unknown) => void;
  removeAt: (k: unknown, i: number) => void;
};
type TNode = Record<number, Record<string, unknown>> & { length: number };

const USER = {
  name: "kim",
  age: 30,
  tags: ["a", "b"],
  posts: [
    { title: "p1", marks: ["m1", "m2"] },
    { title: "p2", marks: ["m3"] },
  ],
  contact: { email: "kim@x.com" },
};

const tagsOf = (host: ParentNode) => [...host.querySelectorAll(".tag")].map((n) => n.textContent);
const titlesOf = (host: ParentNode) => [...host.querySelectorAll(".ptitle")].map((n) => n.textContent);
const marksOf = (host: ParentNode) =>
  [...host.querySelectorAll(".post")].map((p) => [...p.querySelectorAll(".mark")].map((m) => m.textContent));

// SWAP 한 번에 act 하나를 실행한다 - 핸들러 안에서만 노드를 만질 수 있어서다.
const run = (act: (ctx: TCtx) => void) => {
  const handlers: THandlers = {
    SWAP: (_d, c) => act(c as unknown as TCtx),
  };
  const inst = compile(qubb)(0)({ title: "t", user: USER }, handlers);
  const host = mount(inst);
  return { host, fire: () => (host.querySelector("h1") as HTMLElement).click() };
};

test("스칼라 배열 요소는 leaf라 get/set이 짚는다", () => {
  const seen: unknown[] = [];
  const { host, fire } = run((ctx) => {
    seen.push(ctx.get(ctx.props.user.tags[1]));
    ctx.set(ctx.props.user.tags[0], "A");
  });
  fire();
  assert.deepEqual(seen, ["b"], "인덱스로 읽은 값");
  assert.deepEqual(tagsOf(host), ["A", "b"], "인덱스로 쓴 값이 화면까지");
});

test("객체 배열 요소는 노드라 필드로 내려간다", () => {
  const seen: unknown[] = [];
  const { host, fire } = run((ctx) => {
    seen.push(ctx.get(ctx.props.user.posts[1].title));
    ctx.set(ctx.props.user.posts[0].title, "P1");
  });
  fire();
  assert.deepEqual(seen, ["p2"]);
  assert.deepEqual(titlesOf(host), ["P1", "p2"]);
});

test("요소 노드는 setObject 대상이다", () => {
  const { host, fire } = run((ctx) => {
    ctx.setObject(ctx.props.user.posts[0], { title: "X" });
  });
  fire();
  assert.deepEqual(titlesOf(host), ["X", "p2"]);
  assert.deepEqual(marksOf(host), [[], ["m3"]], "안 준 marks는 비워진다(교체)");
});

// 배열 -> 객체 -> 배열. 안쪽 배열도 노드라 인덱싱과 push가 그대로 된다.
test("요소가 품은 배열도 인덱싱된다", () => {
  const seen: unknown[] = [];
  const { host, fire } = run((ctx) => {
    const marks = ctx.props.user.posts[0].marks as TNode;
    seen.push(ctx.get(marks[1]));
    ctx.set(marks[0], "M1");
    ctx.push(marks, "m9");
  });
  fire();
  assert.deepEqual(seen, ["m2"]);
  assert.deepEqual(marksOf(host), [["M1", "m2", "m9"], ["m3"]]);
});

test("length가 지금 개수를 준다", () => {
  const seen: number[] = [];
  const { fire } = run((ctx) => {
    seen.push(ctx.props.user.tags.length);
    ctx.push(ctx.props.user.tags, "c");
    seen.push(ctx.props.user.tags.length);
    ctx.removeAt(ctx.props.user.tags, 0);
    seen.push(ctx.props.user.tags.length);
  });
  fire();
  assert.deepEqual(seen, [2, 3, 2], "push/removeAt이 곧바로 반영돼야");
});

// 노드를 미리 펴 두었다면 여기서 낡는다 - push로 목록이 바뀐 뒤 같은 인덱스가 새 요소를 봐야 한다.
test("목록이 바뀌어도 인덱싱이 현재 요소를 본다", () => {
  const seen: unknown[] = [];
  const { fire } = run((ctx) => {
    ctx.removeAt(ctx.props.user.tags, 0); // ["b"]
    seen.push(ctx.get(ctx.props.user.tags[0])); // 당겨진 "b"
    ctx.push(ctx.props.user.tags, "z"); // ["b","z"]
    seen.push(ctx.get(ctx.props.user.tags[1]));
  });
  fire();
  assert.deepEqual(seen, ["b", "z"]);
});

// 범위 밖은 조용히 undefined로 새지 않고 잡는다 - 핸들러는 우리 통제 밖의 자유 코드라(d.ts는
// 힌트일 뿐) props 오타를 propsGuard가 잡는 것과 같은 이유다.
test("범위 밖 인덱스는 throw한다", () => {
  const errors: string[] = [];
  const { fire } = run((ctx) => {
    for (const i of [2, -1]) {
      try {
        void ctx.props.user.tags[i];
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  });
  fire();
  assert.equal(errors.length, 2, `둘 다 잡혀야: ${JSON.stringify(errors)}`);
  assert.match(errors[0], /배열 인덱스 '2' 없음 - 길이 2/);
});
