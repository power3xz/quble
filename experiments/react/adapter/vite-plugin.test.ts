// compileToModule과 quble() 플러그인이 .qubc를 TQubleBytecode 모듈로 바꾸는지. 낸 모듈 소스를 실제로 import해 본다.

import "../runtime/test-helpers/dom.ts";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const SOURCE = "component C { props { n: number } template { p() { ${n} } } }";

type TWatcherHandler = (event: string, file: string) => Promise<void> | void;

// configureServer가 받는 server의 필요한 부분만 흉내 낸다. 파일 변화는 emit으로 직접 낸다.
const fakeServer = (root: string) => {
  let onChange: TWatcherHandler | undefined;
  const warnings: string[] = [];
  const server = {
    watcher: {
      on: (_name: string, handler: TWatcherHandler) => {
        onChange = handler;
      },
    },
    config: { root, logger: { warn: (message: string) => warnings.push(message) } },
  };
  return { server, warnings, emit: (event: string, file: string) => onChange?.(event, file) };
};

const startDevServer = async (root: string, typesDir?: string) => {
  const plugin = quble(typesDir === undefined ? {} : { typesDir });
  const fake = fakeServer(root);
  await (plugin.configureServer as unknown as (server: unknown) => Promise<void>)(fake.server);
  return fake;
};

test("dev 서버를 시작하면 프로젝트의 .qubc 선언을 모두 쓴다", async () => {
  const root = mkdtempSync(join(TMP, "dev-"));
  writeFileSync(join(root, "c.qubc"), SOURCE);
  await startDevServer(root);
  assert.ok(existsSync(join(root, "c.qubc.d.ts")), "요청 없이도 서버 시작 때 만든다");
});

test("실패한 .qubc는 서버를 막지 않고 경고로 남긴다", async () => {
  const root = mkdtempSync(join(TMP, "dev-"));
  writeFileSync(join(root, "bad.qubc"), "component Bad {");
  const { warnings } = await startDevServer(root);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad\.qubc/);
});

test(".qubc가 추가되거나 바뀌면 선언을 다시 쓰고 지워지면 선언도 지운다", async () => {
  const root = mkdtempSync(join(TMP, "dev-"));
  const { emit } = await startDevServer(root);

  const added = join(root, "n.qubc");
  writeFileSync(added, SOURCE);
  await emit("add", added);
  assert.ok(existsSync(`${added}.d.ts`), "추가");

  writeFileSync(added, SOURCE.replace("n: number", "n: number, m: string"));
  await emit("change", added);
  assert.match(readFileSync(`${added}.d.ts`, "utf8"), /m: TLeafIndex<string>/, "변경");

  rmSync(added);
  await emit("unlink", added);
  assert.equal(existsSync(`${added}.d.ts`), false, "삭제");
});

test(".qubc가 아닌 파일의 변화에는 선언을 쓰지 않는다", async () => {
  const root = mkdtempSync(join(TMP, "dev-"));
  const { emit } = await startDevServer(root);
  writeFileSync(join(root, "n.qubc"), SOURCE);
  await emit("change", join(root, "other.css"));
  assert.equal(existsSync(join(root, "n.qubc.d.ts")), false);
});

test("typesDir 옵션을 주면 그곳에 쓴다", async () => {
  const root = mkdtempSync(join(TMP, "dev-"));
  writeFileSync(join(root, "c.qubc"), SOURCE);
  await startDevServer(root, ".quble/types");
  assert.ok(existsSync(join(root, ".quble", "types", "c.qubc.d.ts")));
  assert.equal(existsSync(join(root, "c.qubc.d.ts")), false);
});

test("load 훅과 빌드 시작은 선언을 쓰지 않는다", async () => {
  const root = mkdtempSync(join(TMP, "build-"));
  const entry = join(root, "c.qubc");
  writeFileSync(entry, SOURCE);
  const plugin = quble();
  const context = { addWatchFile: () => {} };
  const load = plugin.load as unknown as (this: typeof context, id: string) => Promise<string | null>;
  await load.call(context, entry);
  assert.equal(existsSync(`${entry}.d.ts`), false);
  assert.equal(plugin.buildStart, undefined, "빌드 시작에 거는 생성 훅이 없다");
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
