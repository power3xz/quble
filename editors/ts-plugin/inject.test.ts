// 주입 로직 테스트. 실제 tsserver 없이 텍스트 변환만 본다 - 파서는 진짜 typescript를 쓴다.

import assert from "node:assert/strict";
import { test } from "node:test";
import tsModule from "typescript";
import { injectionFor, isInjected, toInjected, toOriginal } from "./src/inject.ts";

const DTS = 'export interface Handlers {\n  "A": Handler<{}, {}, {}, {}>;\n}\n';

// biome-ignore lint/suspicious/noExplicitAny: tsserverlibrary 타입으로 받지만 런타임은 같은 모듈이다.
const ts = tsModule as any;

const inject = (source: string) => injectionFor(ts, source, DTS);

test("export const handlers에 타입 표기를 심는다", () => {
  const result = inject("export const handlers = {\n  A: () => {},\n};\n");

  assert.notEqual(result, null);
  assert.match(result?.text ?? "", /export const handlers: Partial<__qubleHandlers> = \{/);
});

test("d.ts 본문을 앞에 붙인다 - 가상 파일도 import도 없다", () => {
  const result = inject("export const handlers = {};\n");

  assert.match(result?.text ?? "", /interface __qubleHandlers \{/);
  assert.doesNotMatch(result?.text ?? "", /import\(/);
});

test("붙인 d.ts의 export를 떼 지역 선언으로 만든다", () => {
  // export가 남으면 handlers.ts의 모듈 형태를 건드린다.
  const lead = (inject("export const handlers = {};\n")?.text ?? "").slice(0, -"export const handlers: Partial<__qubleHandlers> = {};\n".length);

  assert.doesNotMatch(lead, /\bexport\b/);
});

test("앞에 붙인 d.ts는 한 줄이다 - 원본 줄 번호가 밀리면 안 된다", () => {
  const result = inject("export const handlers = {};\n");
  const lead = (result?.text ?? "").slice(0, result?.lead ?? 0);

  assert.doesNotMatch(lead, /\n/);
});

test("handlers 선언이 없으면 건드리지 않는다", () => {
  assert.equal(inject("export const other = {};\n"), null);
  assert.equal(inject("export function seed() {}\n"), null);
});

test("export가 아닌 handlers는 대상이 아니다", () => {
  assert.equal(inject("const handlers = {};\n"), null);
});

test("이미 타입이 적혀 있으면 덮지 않는다", () => {
  assert.equal(inject("export const handlers: Partial<Handlers> = {};\n"), null);
});

test("주석이나 문자열 안의 handlers에 속지 않는다", () => {
  assert.equal(inject('// export const handlers = {}\nconst s = "export const handlers = {";\n'), null);
});

test("원본 줄 번호가 밀리지 않는다 - d.ts가 첫 줄에 함께 얹힌다", () => {
  const source = "export const handlers = {\n  A: () => {},\n};\n";
  const result = inject(source);

  // 원본 2번째 줄부터가 주입본에서도 같은 줄에 있어야 진단 줄 번호가 맞는다.
  const lines = (result?.text ?? "").split("\n");
  assert.equal(lines[1], "  A: () => {},");
  assert.equal(lines[2], "};");
});

test("리터럴이 안 닫혀도 뒤가 삼켜지지 않는다", () => {
  // 타이핑 중이 이 상태다 - d.ts가 뒤에 있으면 미완성 문자열 안으로 빨려 들어간다.
  const result = inject('export const handlers = {\n  "CLI');

  assert.match(result?.text ?? "", /interface __qubleHandlers \{[^]*\}.*export const handlers/);
});

test("삽입 지점 앞의 위치는 그대로다", () => {
  const result = inject("export const handlers = {};\n");
  assert.notEqual(result, null);
  if (result === null) {
    return;
  }

  // 원본 0은 주입본에서 lead 뒤다.
  assert.equal(toOriginal(result, result.lead), 0);
  assert.equal(toOriginal(result, result.lead + result.at), result.at);
});

test("삽입 지점 뒤의 위치는 삽입 길이만큼 되돌린다", () => {
  const result = inject("export const handlers = {};\n");
  assert.notEqual(result, null);
  if (result === null) {
    return;
  }

  assert.equal(toOriginal(result, result.lead + result.at + result.width + 5), result.at + 5);
  assert.equal(toInjected(result, result.at + 5), result.lead + result.at + result.width + 5);
});

test("보정은 왕복해도 제자리다", () => {
  const source = "export const handlers = {\n  A: () => {},\n};\n";
  const result = inject(source);
  assert.notEqual(result, null);
  if (result === null) {
    return;
  }

  for (let position = 0; position < source.length; position++) {
    assert.equal(toOriginal(result, toInjected(result, position)), position);
  }
});

test("주입한 텍스트에서 원본 위치의 글자가 맞는다", () => {
  const source = 'export const handlers = {\n  "A": () => {},\n};\n';
  const result = inject(source);
  assert.notEqual(result, null);
  if (result === null) {
    return;
  }

  // 원본의 "A"가 주입본에서도 같은 글자를 가리켜야 편집기 밑줄이 제자리에 그어진다.
  const quoteAt = source.indexOf('"A"');
  assert.equal(result.text[toInjected(result, quoteAt)], '"');
});

test("우리가 넣은 텍스트 안의 위치를 가려낸다", () => {
  const result = inject("export const handlers = {};\n");
  assert.notEqual(result, null);
  if (result === null) {
    return;
  }

  // 앞에 얹은 d.ts - 원본에 없는 자리다.
  assert.equal(isInjected(result, 0), true);
  assert.equal(isInjected(result, result.lead - 1), true);
  // 타입 표기(`: Partial<...>`) 안 - 역시 원본에 없다.
  assert.equal(isInjected(result, result.lead + result.at + 1), true);

  // 원본에서 온 자리는 아니다.
  assert.equal(isInjected(result, result.lead), false);
  assert.equal(isInjected(result, result.lead + result.at), false);
  assert.equal(isInjected(result, result.lead + result.at + result.width), false);
});
