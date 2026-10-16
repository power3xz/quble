// compileToModule과 quble() 플러그인이 .qubc를 TQubleBytecode 모듈로 바꾸는지. 낸 모듈 소스를 실제로 import해 본다.

import "../runtime/test-helpers/dom.ts";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compile } from "../../../core/web/runtime.ts";
import { evaluate } from "./test-helpers/bytecode.ts";
import { compileToModule, quble } from "./vite-plugin.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // experiments/react/adapter
const GREETING = join(HERE, "fixtures", "greeting.qubc");
const TMP = join(HERE, "..", "dist", "adapter-test");
mkdirSync(TMP, { recursive: true });

test("바이트코드를 기본 export로 내고 mount할 수 있다", async () => {
  const { code } = await compileToModule(GREETING);
  const bytecode = await evaluate(code);
  assert.ok(bytecode instanceof Uint8Array);
  const inst = compile(bytecode)(0)({ name: "Ann" }, {});
  const host = document.createElement("div");
  host.append(...inst.nodes);
  assert.equal(host.querySelector("p span")?.textContent, "Ann");
});

test("use한 CSS를 절대 경로 import로 건다", async () => {
  const { code } = await compileToModule(GREETING);
  assert.ok(code.includes(`import ${JSON.stringify(join(HERE, "fixtures", "greeting.css"))};`));
});

test("dependencies에 읽은 .qubc와 CSS의 절대 경로를 담는다", async () => {
  const { dependencies } = await compileToModule(GREETING);
  const fixtures = join(HERE, "fixtures");
  assert.deepEqual(dependencies.sort(), [
    join(fixtures, "greeting.css"),
    join(fixtures, "greeting.qubc"),
    join(fixtures, "label.qubc"),
  ]);
});

test("컴파일 오류는 진단 텍스트를 담은 예외가 된다", async () => {
  const dir = mkdtempSync(join(TMP, "plugin-"));
  const bad = join(dir, "bad.qubc");
  writeFileSync(bad, "component Bad {");
  await assert.rejects(compileToModule(bad), /bad\.qubc/);
});

test("플러그인 load 훅은 .qubc만 바꾸고 읽은 파일을 감시에 등록한다", async () => {
  const plugin = quble();
  const watched: string[] = [];
  const context = { addWatchFile: (file: string) => watched.push(file) };
  const load = plugin.load as unknown as (this: typeof context, id: string) => Promise<string | null>;

  assert.equal(await load.call(context, join(HERE, "fixtures", "greeting.css")), null);
  assert.equal(watched.length, 0);

  const code = await load.call(context, GREETING);
  assert.equal(typeof code, "string");
  assert.equal(watched.length, 3);
  assert.ok(watched.includes(GREETING));
});
