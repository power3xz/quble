// gen-types.ts - 서버 없이 .qubc 타입 선언을 만드는 명령(tsc 단독 실행, CI, 새 클론).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // experiments/react/adapter
const TMP = join(HERE, "..", "dist", "adapter-test");
const CLI = join(HERE, "gen-types.ts");
mkdirSync(TMP, { recursive: true });

const SOURCE = "component C { props { n: number } template { p() { ${n} } } }";

const run = (...args: string[]) =>
  spawnSync("node", ["--experimental-strip-types", "--no-warnings", CLI, ...args], { encoding: "utf8" });

test("루트를 주면 .qubc 옆에 선언을 쓰고 개수를 알린다", () => {
  const root = mkdtempSync(join(TMP, "cli-"));
  writeFileSync(join(root, "c.qubc"), SOURCE);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, "c.qubc.d.ts")));
  assert.match(result.stdout, /1/);
});

test("두 번째 인자로 typesDir를 준다", () => {
  const root = mkdtempSync(join(TMP, "cli-"));
  writeFileSync(join(root, "c.qubc"), SOURCE);
  const result = run(root, ".quble/types");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, ".quble", "types", "c.qubc.d.ts")));
  assert.equal(existsSync(join(root, "c.qubc.d.ts")), false);
});

test("컴파일에 실패한 파일이 있으면 진단을 stderr에 내고 실패 코드로 끝난다", () => {
  const root = mkdtempSync(join(TMP, "cli-"));
  writeFileSync(join(root, "ok.qubc"), SOURCE);
  writeFileSync(join(root, "bad.qubc"), "component Bad {");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bad\.qubc/);
  assert.ok(existsSync(join(root, "ok.qubc.d.ts")), "성공한 파일의 선언은 그대로 쓴다");
});

test("루트를 안 주면 사용법을 내고 실패 코드로 끝난다", () => {
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /사용법/);
});
