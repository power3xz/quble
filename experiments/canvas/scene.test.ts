// 장면 트리가 런타임에게 DOM과 같게 보이는지 비교한다. 같은 컴포넌트를 jsdom과 장면 트리에서 각각 짓고
// 같은 조작을 한 뒤, 단계마다 두 트리의 직렬화(innerHTML 형식)를 견준다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { JSDOM } from "jsdom";
import { compile, type THandlers } from "../../core/web/runtime.ts";
import { buildFixture } from "../../core/web/test-helpers/build.ts";
import { SDocument, type SElement, type SNode, toHTML } from "./scene.ts";

// 런타임이 보는 전역 document를 단계마다 바꿔 끼운다.
type TEnv = {
  mount: (nodes: unknown[]) => unknown;
  html: (host: unknown) => string;
  // host 안에서 class가 cls인 n번째 요소를 클릭한다.
  click: (host: unknown, cls: string, n?: number) => void;
};

const jsdomEnv = (): TEnv => {
  const dom = new JSDOM("<!DOCTYPE html><body></body>");
  globalThis.document = dom.window.document;
  return {
    mount: (nodes) => {
      const host = document.createElement("div");
      host.append(...(nodes as Node[]));
      document.body.replaceChildren(host);
      return host;
    },
    html: (host) => (host as HTMLElement).innerHTML,
    click: (host, cls, n = 0) =>
      (((host as HTMLElement).querySelectorAll(`.${cls}`)[n] as HTMLElement) ?? null).click(),
  };
};

const byClass = (node: SNode, cls: string, out: SElement[] = []): SElement[] => {
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    const el = c as SElement;
    if (el.attributes?.get("class")?.split(" ").includes(cls)) {
      out.push(el);
    }
    byClass(c, cls, out);
  }
  return out;
};

const sceneEnv = (): TEnv => {
  const doc = new SDocument();
  globalThis.document = doc as unknown as Document;
  return {
    mount: (nodes) => {
      const host = doc.createElement("div");
      host.append(...(nodes as SNode[]));
      doc.body.replaceChildren(host);
      return host;
    },
    html: (host) => toHTML(host as SNode),
    click: (host, cls, n = 0) => doc.dispatch("click", byClass(host as SNode, cls)[n]),
  };
};

// 시나리오는 env 위에서 조작하며 단계마다 직렬화를 모아 돌려준다.
const sameOnBoth = (scenario: (env: TEnv) => string[]) => {
  const expected = scenario(jsdomEnv());
  const actual = scenario(sceneEnv());
  assert.deepEqual(actual, expected);
};

const qubb: Record<string, Uint8Array> = {};
before(() => {
  for (const name of ["nested_if", "for_array_index_del", "for_array_push_obj", "expr_array_index"]) {
    qubb[name] = buildFixture(name);
  }
});

test("@if 가지 바꾸기 - anchor 뒤에 가지를 붙이고 뗀다", () => {
  sameOnBoth((env) => {
    const inst = compile(qubb.nested_if)(0)({ outer: true, inner: true, a: "A", b: "B", c: "C" });
    const host = env.mount(inst.nodes);
    const out = [env.html(host)];
    for (const [leaf, v] of [
      [1, false],
      [0, false],
      [0, true],
      [2, "Z"],
      [1, true],
    ] as const) {
      inst.store.set(leaf, v);
      out.push(env.html(host));
    }
    return out;
  });
});

test("배열 @for - 중간 제거와 꼬리 추가, 인덱스 갱신", () => {
  sameOnBoth((env) => {
    let next = 0;
    const handlers: THandlers = {
      ADD: (_d, ctx) =>
        (ctx.push as (a: unknown, v: unknown) => void)((ctx.props as Record<string, unknown>).tags, `n${next++}`),
      "[$0].DEL": (_d, ctx) =>
        (ctx.removeAt as (a: unknown, i: number) => void)(
          (ctx.props as Record<string, unknown>).tags,
          ctx.$0 as number,
        ),
    };
    const inst = compile(qubb.for_array_index_del)(0)({ tags: ["a", "b", "c", "d"] }, handlers);
    const host = env.mount(inst.nodes);
    const out = [env.html(host)];
    env.click(host, "del", 1);
    out.push(env.html(host));
    env.click(host, "add");
    env.click(host, "add");
    out.push(env.html(host));
    env.click(host, "del", 0);
    out.push(env.html(host));
    return out;
  });
});

test("객체 배열 @for - 요소 추가", () => {
  sameOnBoth((env) => {
    const handlers: THandlers = {
      ADD: (_d, ctx) =>
        (ctx.push as (a: unknown, v: unknown) => void)((ctx.props as Record<string, unknown>).stats, {
          label: "x",
          value: "1",
        }),
    };
    const inst = compile(qubb.for_array_push_obj)(0)({ stats: [{ label: "a", value: "0" }] }, handlers);
    const host = env.mount(inst.nodes);
    const out = [env.html(host)];
    env.click(host, "add");
    out.push(env.html(host));
    return out;
  });
});

test("식과 인덱스 접근 - 다시 걸기", () => {
  sameOnBoth((env) => {
    const inst = compile(qubb.expr_array_index)(0)({
      rows: [
        { title: "A", score: 10 },
        { title: "B", score: 20 },
        { title: "C", score: 30 },
      ],
      scalars: [5, 6],
      cursor: 0,
      show: true,
    });
    const host = env.mount(inst.nodes);
    const out = [env.html(host)];
    // props 선언 순서가 leafIndex - 0=rows 1=scalars 2=cursor 3=show
    inst.store.set(2, 1);
    out.push(env.html(host));
    inst.store.set(3, false);
    out.push(env.html(host));
    return out;
  });
});
