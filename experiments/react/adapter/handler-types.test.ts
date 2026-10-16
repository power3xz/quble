// 플러그인이 낸 x.qubc.d.ts로 createComponent의 props와 handlers 키, 핸들러 컨텍스트(update 포함)에 타입이 붙는지
// 실제 tsc로 확인한다. 통과 케이스만 두면 무엇이든 받는 타입도 통과하므로 막혀야 하는 것이 막히는지를 에러 코드로 함께 본다.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarationOf } from "./declarations.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // experiments/react/adapter
const COUNTER = join(HERE, "fixtures", "counter.qubc");
const TSC = join(HERE, "..", "..", "..", "node_modules", ".bin", "tsc");
const TMP = join(HERE, "..", "dist", "adapter-test");
mkdirSync(TMP, { recursive: true });

let work: string;
before(async () => {
  // 플러그인의 load가 하는 것과 같다 - 엔트리 옆에 x.qubc.d.ts를 둔다.
  writeFileSync(`${COUNTER}.d.ts`, await declarationOf(COUNTER, `${COUNTER}.d.ts`));
  work = mkdtempSync(join(TMP, "types-"));
  writeFileSync(
    join(work, "tsconfig.json"),
    JSON.stringify({ extends: join(HERE, "..", "tsconfig.json"), include: [join(work, "*.ts"), join(HERE, "*.d.ts")] }),
  );
});

// 본문을 넣어 tsc를 돌린다. 통과면 null, 아니면 진단 텍스트.
const typecheck = (body: string): string | null => {
  const counter = relative(work, COUNTER);
  writeFileSync(
    join(work, "probe.ts"),
    `import { createComponent } from "quble/react";
import { createElement } from "react";
import Counter from "${counter}";
const C = createComponent(Counter);
${body}
`,
  );
  try {
    execFileSync(TSC, ["--noEmit", "-p", join(work, "tsconfig.json")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
};

test("props와 handlers 키와 update가 타입을 갖는다", () => {
  const out = typecheck(`
createElement(C, {
  label: "Go",
  count: 1,
  handlers: {
    CLICK: (data, { update, get }) => {
      data.label.toUpperCase();
      update({ count: 2 });
      update({ label: "x", count: 3 }, "replace");
      void get;
    },
  },
});`);
  assert.equal(out, null, out ?? "");
});

test("props 이름이 틀리면 막는다", () => {
  const out = typecheck(`createElement(C, { label: "Go", count: 1, nope: 1 });`);
  assert.match(out ?? "", /TS2769|TS2353|nope/);
});

test("props 값 타입이 틀리면 막는다", () => {
  const out = typecheck(`createElement(C, { label: "Go", count: "x" });`);
  assert.match(out ?? "", /TS2769|TS2322/);
});

test("없는 핸들러 이름이면 막는다", () => {
  const out = typecheck(`createElement(C, { label: "Go", count: 1, handlers: { TYPO: () => {} } });`);
  assert.match(out ?? "", /TS2769|TS2353|TYPO/);
});

test("update에 없는 prop 이름을 주면 막는다", () => {
  const out = typecheck(`
createElement(C, { label: "Go", count: 1, handlers: { CLICK: (_d, { update }) => update({ nope: 1 }) } });`);
  assert.match(out ?? "", /TS2769|TS2353|nope/);
});

test("update에 값 타입이 틀린 값을 주면 막는다", () => {
  const out = typecheck(`
createElement(C, { label: "Go", count: 1, handlers: { CLICK: (_d, { update }) => update({ count: "x" }) } });`);
  assert.match(out ?? "", /TS2322|TS2769/);
});
