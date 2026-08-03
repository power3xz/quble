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
    ghost: { style: string, inner: { label: string } }
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
  const source = `import type { Handlers } from "./handlers";
export default {
  EDIT: (_data, { props, get, set, push, removeAt, replace }) => {
${body}
  },
} satisfies Partial<Handlers>;
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
    replace(props.tags, ["a", "b"]);
    removeAt(props.cards, 0);
  `),
    null,
  );
});

test("배열 아닌 leaf는 push/replace가 막는다", () => {
  const out = typecheck(`push(props.title, "x");`);
  assert.match(out ?? "", /TS2345/);
  assert.match(out ?? "", /LeafIndex<string\[\]>/);
});

test("배열 요소 모양이 다르면 막는다", () => {
  const out = typecheck(`push(props.cards, { title: "t", wrong: 1 });`);
  assert.match(out ?? "", /TS2353|TS2345/);
  assert.match(out ?? "", /wrong/);
});

// 요소 타입은 넘긴 leaf에서 추론된다 - string[] 자리에 number[]를 주면 그 leaf 기준으로 걸린다.
// 배열 리터럴은 요소마다 걸려(TS2322) 인자 단위 불일치(TS2345)와 코드가 다르다.
test("replace는 그 배열의 요소 타입을 요구한다", () => {
  const out = typecheck(`replace(props.tags, [1, 2]);`);
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
