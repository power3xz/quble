import assert from "node:assert/strict";
import { test } from "node:test";
import { collectSources } from "./sources.ts";

/** 절대경로 -> 소스를 흉내내는 read. 없는 경로는 null이라 건너뛴다. */
const reader = (disk: Record<string, string>) => (path: string) => disk[path] ?? null;

test("엔트리는 절대경로를 키로 쓴다", () => {
  const files = collectSources("/w/a.qubc", reader({ "/w/a.qubc": "component A { }" }));
  assert.deepEqual(files, { "/w/a.qubc": "component A { }" });
});

// wasm loader가 `./`만 떼고 이름으로 맞추므로 use 대상은 소스에 적힌 이름이어야 한다.
test("use 대상은 소스에 적힌 이름을 키로 쓴다", () => {
  const disk = {
    "/w/a.qubc": `use Child from "./child.qubc"\ncomponent A { }`,
    "/w/child.qubc": "component Child { }",
  };
  const files = collectSources("/w/a.qubc", reader(disk));

  assert.deepEqual(Object.keys(files).sort(), ["/w/a.qubc", "child.qubc"]);
  assert.equal(files["child.qubc"], "component Child { }");
});

// use는 그 파일 기준 상대경로다 - 엔트리 기준으로 풀면 하위 디렉터리에서 어긋난다.
test("중첩된 use를 그 파일 기준으로 푼다", () => {
  const disk = {
    "/w/a.qubc": `use Mid from "./sub/mid.qubc"\ncomponent A { }`,
    "/w/sub/mid.qubc": `use Leaf from "./leaf.qubc"\ncomponent Mid { }`,
    "/w/sub/leaf.qubc": "component Leaf { }",
  };
  const files = collectSources("/w/a.qubc", reader(disk));

  assert.deepEqual(Object.keys(files).sort(), ["/w/a.qubc", "leaf.qubc", "sub/mid.qubc"]);
});

test("css도 등록한다", () => {
  const disk = {
    "/w/a.qubc": `use "./a.css"\ncomponent A { }`,
    "/w/a.css": ".x { color: red }",
  };
  const files = collectSources("/w/a.qubc", reader(disk));

  assert.equal(files["a.css"], ".x { color: red }");
});

// 서로 use하면 방문 표시가 없을 때 무한히 돈다.
test("순환 use에서 멈춘다", () => {
  const disk = {
    "/w/a.qubc": `use B from "./b.qubc"\ncomponent A { }`,
    "/w/b.qubc": `use A from "./a.qubc"\ncomponent B { }`,
  };
  const files = collectSources("/w/a.qubc", reader(disk));

  assert.deepEqual(Object.keys(files).sort(), ["/w/a.qubc", "a.qubc", "b.qubc"]);
});

// 없는 파일을 use해도 나머지는 모아야 한다 - 진단은 컴파일러가 낸다.
test("못 읽은 파일은 건너뛴다", () => {
  const disk = { "/w/a.qubc": `use Gone from "./gone.qubc"\ncomponent A { }` };
  const files = collectSources("/w/a.qubc", reader(disk));

  assert.deepEqual(Object.keys(files), ["/w/a.qubc"]);
});
