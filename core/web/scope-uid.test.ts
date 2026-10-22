// 스코프 번호 발급 - 0부터 1씩 늘고, 한도를 넘으면 경고를 한 번만 찍는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ScopeUidCounter } from "./scope-uid.ts";

const captureWarnings = (run: () => void): string[] => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
};

test("0부터 1씩 늘어난 번호를 준다", () => {
  const counter = new ScopeUidCounter();
  assert.deepEqual([counter.next(), counter.next(), counter.next()], [0, 1, 2]);
});

test("한도 안에서는 경고하지 않는다", () => {
  const warnings = captureWarnings(() => {
    const counter = new ScopeUidCounter(3);
    counter.next();
    counter.next();
    counter.next();
  });
  assert.deepEqual(warnings, []);
});

test("한도를 넘는 번호를 처음 줄 때 경고를 한 번만 찍고 번호는 계속 늘어난다", () => {
  const issued: number[] = [];
  const warnings = captureWarnings(() => {
    const counter = new ScopeUidCounter(3);
    for (let n = 0; n < 6; n++) {
      issued.push(counter.next());
    }
  });
  assert.deepEqual(issued, [0, 1, 2, 3, 4, 5]);
  assert.equal(warnings.length, 1);
});
