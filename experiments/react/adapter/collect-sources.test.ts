// collectSources가 `use`를 재귀로 따라가 wasm 컴파일러의 files 맵을 모으는지. 임시 파일은 dist/ 아래에 둔다.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectSources } from "./collect-sources.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // experiments/react/adapter
const TMP = join(HERE, "..", "dist", "adapter-test");
mkdirSync(TMP, { recursive: true });

// 이름 -> 소스로 임시 디렉터리에 파일을 만들고 그 디렉터리를 돌려준다.
const dirWith = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(TMP, "case-"));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source);
  }
  return dir;
};

test("use한 컴포넌트와 CSS를 따라가 files에 모은다", async () => {
  const entryPath = join(HERE, "fixtures", "greeting.qubc");
  const { files, entry } = await collectSources(entryPath);
  assert.equal(entry, "greeting.qubc");
  assert.deepEqual(Object.keys(files).sort(), ["greeting.css", "greeting.qubc", "label.qubc"]);
  assert.equal(files["greeting.qubc"], readFileSync(entryPath, "utf8"));
  assert.equal(files["greeting.css"], readFileSync(join(HERE, "fixtures", "greeting.css"), "utf8"));
});

test("두 갈래가 같은 파일을 use해도 한 번만 모은다", async () => {
  const dir = dirWith({
    "a.qubc": 'use B from "./b.qubc"\nuse C from "./c.qubc"\ncomponent A {}',
    "b.qubc": 'use D from "./d.qubc"\ncomponent B {}',
    "c.qubc": 'use D from "./d.qubc"\ncomponent C {}',
    "d.qubc": "component D {}",
  });
  const { files } = await collectSources(join(dir, "a.qubc"));
  assert.deepEqual(Object.keys(files).sort(), ["a.qubc", "b.qubc", "c.qubc", "d.qubc"]);
});

test("서로를 use하는 순환에서 끝난다", async () => {
  const dir = dirWith({
    "a.qubc": 'use B from "./b.qubc"\ncomponent A {}',
    "b.qubc": 'use A from "./a.qubc"\ncomponent B {}',
  });
  const { files } = await collectSources(join(dir, "a.qubc"));
  assert.deepEqual(Object.keys(files).sort(), ["a.qubc", "b.qubc"]);
});

test("주석 안의 use는 따라가지 않는다", async () => {
  const dir = dirWith({
    "a.qubc": '// use X from "./none.qubc"\n/* use "./none.css"\nuse Y from "./none2.qubc" */\ncomponent A {}',
  });
  const { files } = await collectSources(join(dir, "a.qubc"));
  assert.deepEqual(Object.keys(files), ["a.qubc"]);
});

test("여러 이름을 한 번에 가져오는 use도 따라간다", async () => {
  const dir = dirWith({
    "a.qubc": 'use B, C from "./bc.qubc"\ncomponent A {}',
    "bc.qubc": "component B {}\ncomponent C {}",
  });
  const { files } = await collectSources(join(dir, "a.qubc"));
  assert.deepEqual(Object.keys(files).sort(), ["a.qubc", "bc.qubc"]);
});

test("하위 디렉터리나 상위로 가는 use는 오류다", async () => {
  const up = dirWith({ "a.qubc": 'use B from "../b.qubc"\ncomponent A {}' });
  await assert.rejects(collectSources(join(up, "a.qubc")), /\.\.\/b\.qubc/);
  const down = dirWith({ "a.qubc": 'use B from "./sub/b.qubc"\ncomponent A {}' });
  await assert.rejects(collectSources(join(down, "a.qubc")), /sub\/b\.qubc/);
});

test("없는 파일을 use하면 그 이름이 든 오류다", async () => {
  const dir = dirWith({ "a.qubc": 'use B from "./missing.qubc"\ncomponent A {}' });
  await assert.rejects(collectSources(join(dir, "a.qubc")), /missing\.qubc/);
});
