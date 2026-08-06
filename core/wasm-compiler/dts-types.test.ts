// 핸들러 d.ts가 낸 타입이 실제로 제약을 거는지 tsc로 확인한다. dts.rs 쪽 테스트는 문자열이
// 그대로 나오는지만 보므로(타입으로서 맞는지는 Rust가 알 수 없다) 여기서 진짜 컴파일을 시킨다.
//
// 통과 케이스만 두면 "무엇이든 받는 타입"도 통과한다 - 막혀야 하는 것이 막히는지를 에러 코드로
// 함께 본다.
//
// d.ts는 wasm(handlersDts)이 낸다 - 에디터가 탈 경로와 같은 것을 검증한다.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCompiler } from "./node.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/wasm-compiler
const ROOT = join(HERE, "..", ".."); // repo root
const TSC = join(ROOT, "node_modules", ".bin", "tsc");

// 세 축을 다 두는 컴포넌트 - 원시(leaf 하나), 배열(칸 하나가 leaf), 객체(필드마다 leaf).
const ENTRY = "a.qubc";
const SOURCE = `component HandlerTypes {
  props {
    title: string,
    count: number,
    tags: string[],
    cards: { title: string, done: bool }[],
    ghost: { style: string, marks: string[], inner: { label: string } }
  }
  events {
    EDIT({ title })
  }
  template {
    button(class="ht" @click:EDIT) { {title} }
  }
}`;

let work: string;

before(async () => {
  const compiler = await loadCompiler();
  const result = compiler.handlersDts({ [ENTRY]: SOURCE }, ENTRY);
  if (!result.ok) {
    throw new Error(`d.ts 생성 실패: ${result.diagnostic}`);
  }
  work = mkdtempSync(join(tmpdir(), "quble-dts-"));
  writeFileSync(join(work, "handlers.d.ts"), result.dts);
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

// 핸들러 본문을 넣어 tsc를 돌린다. 통과면 null, 아니면 진단 텍스트.
// tsconfig가 잡히면 include에 걸려 다른 파일까지 끌고 오므로 끊는다(--ignoreConfig).
const typecheck = (body: string): string | null => {
  const source = `import type { THandlers } from "./handlers";
export default {
  EDIT: (_data, { props, store, get, set, setObject, push, removeAt, setArray }) => {
${body}
  },
} satisfies Partial<THandlers>;
`;
  const file = join(work, "probe.ts");
  writeFileSync(file, source);
  try {
    execFileSync(TSC, ["--noEmit", "--strict", "--skipLibCheck", "--ignoreConfig", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
};

test("배열 leaf에 요소 타입이 맞으면 통과한다", () => {
  assert.equal(
    typecheck(`
    push(props.tags, "new");
    push(props.cards, { title: "t", done: false });
    setArray(props.tags, ["a", "b"]);
    removeAt(props.cards, 0);
  `),
    null,
  );
});

test("배열 아닌 leaf는 push/setArray가 막는다", () => {
  const out = typecheck(`push(props.title, "x");`);
  assert.match(out ?? "", /TS2345/);
  assert.match(out ?? "", /TLeafIndex<string\[\]>/);
});

test("배열 요소 모양이 다르면 막는다", () => {
  const out = typecheck(`push(props.cards, { title: "t", wrong: 1 });`);
  assert.match(out ?? "", /TS2353|TS2345/);
  assert.match(out ?? "", /wrong/);
});

// 요소 타입은 넘긴 leaf에서 추론된다 - string[] 자리에 number[]를 주면 그 leaf 기준으로 걸린다.
// 배열 리터럴은 요소마다 걸려(TS2322) 인자 단위 불일치(TS2345)와 코드가 다르다.
test("setArray는 그 배열의 요소 타입을 요구한다", () => {
  const out = typecheck(`setArray(props.tags, [1, 2]);`);
  assert.match(out ?? "", /'number' is not assignable to type 'string'/);
});

// 객체 prop은 필드마다 leaf가 따로 서므로(runtime.ts leafTree) 통째로는 주소가 아니다.
test("객체 prop의 필드가 각각 leaf라 set으로 짚힌다", () => {
  assert.equal(
    typecheck(`
    set(props.ghost.style, "s");
    set(props.ghost.inner.label, "L");
    const label: string = get(props.ghost.inner.label);
    void label;
  `),
    null,
  );
});

test("객체 prop 자체는 leaf가 아니라 set에 못 넘긴다", () => {
  const out = typecheck(`set(props.ghost, { style: "s" });`);
  assert.match(out ?? "", /TS2345/);
});

test("leaf 값 타입이 다르면 set이 막는다", () => {
  const out = typecheck(`set(props.count, "not a number");`);
  assert.match(out ?? "", /TS2345/);
});

// store는 런타임이 루트(defs[0]) 기준 leafIndex 트리로 넘긴다. 여기서는 루트가 곧 이 컴포넌트라
// store와 props가 같은 트리다 - props와 같은 규칙으로 걸리는지를 store 쪽으로 다시 본다.
// `any`였을 때는 아래 셋이 모두 통과했다(검사가 아예 없었다).
test("store leaf가 props와 같은 규칙으로 짚힌다", () => {
  assert.equal(
    typecheck(`
    set(store.title, "s");
    push(store.tags, "new");
    const n: number = get(store.count);
    void n;
  `),
    null,
  );
});

test("없는 store 필드는 막는다", () => {
  const out = typecheck(`set(store.nope, 1);`);
  assert.match(out ?? "", /TS2339/);
  assert.match(out ?? "", /nope/);
});

test("store leaf 값 타입이 다르면 set이 막는다", () => {
  const out = typecheck(`set(store.count, "not a number");`);
  assert.match(out ?? "", /TS2345/);
});

// setObject는 객체 노드를 통째로 갈아끼운다. 값이 Partial이라 필드를 다 안 적어도 되지만,
// 그건 타입이 허용하는 범위일 뿐 의미는 교체다(안 준 필드는 undefined - 런타임 테스트가 못박는다).
//
// 컴파일러는 바깥 객체만 TLeafObject로 내고 안쪽은 값 타입 속 평범한 객체로 둔다 - 안쪽이 다시
// 노드가 되는 것은 TLeafObject의 매핑이 파생한 결과라, 중첩(ghost.inner)이 그 파생을 검증한다.
test("객체 노드를 setObject로 갈아끼운다", () => {
  assert.equal(
    typecheck(`
    setObject(props.ghost, { style: "s", inner: { label: "L" } });
    setObject(props.ghost, { style: "s" });
    setObject(props.ghost.inner, { label: "L" });
    setObject(store.ghost.inner, { label: "L" });
  `),
    null,
  );
});

test("없는 필드를 setObject에 주면 막는다", () => {
  const out = typecheck(`setObject(props.ghost, { nope: 1 });`);
  assert.match(out ?? "", /TS2353|TS2345/);
  assert.match(out ?? "", /nope/);
});

test("setObject 필드 값 타입이 다르면 막는다", () => {
  const out = typecheck(`setObject(props.ghost, { style: 123 });`);
  assert.match(out ?? "", /TS2322|TS2345/);
});

// leaf는 칸 하나라 노드가 아니다 - set이 받을 것을 setObject에 넘기면 걸려야 한다(반대도 마찬가지).
test("leaf는 setObject 대상이 아니다", () => {
  const out = typecheck(`setObject(props.title, { a: 1 });`);
  assert.match(out ?? "", /TS2345/);
});

// 객체 노드 안의 배열도 leaf 한 칸이어야 한다(push/removeAt 대상). 최상위 배열(props.tags)은
// 컴파일러가 직접 TLeafIndex로 내지만, 노드 안쪽은 TLeafObject의 매핑이 파생한다 - JS에서 배열도
// object라 매핑이 배열을 object보다 먼저 걸러야 성립한다. 순서가 뒤집히면 노드로 파생돼 여기서
// push가 막힌다(대상을 setObject에 주는 쪽은 값 검사에 먼저 걸려 순서 오류를 못 잡는다).
test("객체 노드 안 배열도 leaf 한 칸이다", () => {
  assert.equal(
    typecheck(`
    push(props.ghost.marks, "m");
    removeAt(props.ghost.marks, 0);
    setArray(props.ghost.marks, ["a"]);
  `),
    null,
  );
});
