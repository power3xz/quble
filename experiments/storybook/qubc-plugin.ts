// .qubc를 싣는 vite 플러그인. import 모양에 따라 두 가지를 낸다.
//
// `x.qubc?qubb` - quble 바이너리로 qubb를 내고, 그 바이트와 스타일 리소스 URL로 런타임 compile을 부른 결과를
// default export한다. `?qubb`는 .qubc 옆에 생성된 .qubc.d.ts(핸들러 타입)가 이 import의 타입을 가리지 않게 붙인다.
//
//   import TodoList from "../../../components/todo_list.qubc?qubb";
//   TodoList(0)(data, handlers)  // { nodes, destroy, ... }
//
// `x.qubc` - story 모듈(CSF). Storybook indexer(.storybook/main.ts)가 디렉터리의 .qubc를 story로 실을 때 쓴다.
// 루트는 그 파일의 첫 컴포넌트이고, 짝 `x.data.json`을 args로, 짝 `x.qubc.handlers.ts`를 핸들러로 싣는다.
// 짝이 둘 다 있는 .qubc만 story가 된다.
//
// 산출물은 dist/qubc/<경로 해시>/에 둔다. 스타일은 `?url`로 실어 vite가 서빙한다.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const QUBLE = join(REPO, "core", "target", "debug", "quble");
const RUNTIME = join(REPO, "core", "web", "runtime.ts");
const OUT = join(HERE, "dist", "qubc");
const MOUNT = join(HERE, "stories", "mount.ts");

// x.qubc의 짝 파일. data는 x.data.json, 핸들러는 x.qubc.handlers.ts 또는 .js. 둘 다 있어야 story가 된다.
export const pairsOf = (id: string): { data: string; handlers: string } | null => {
  const data = id.replace(/\.qubc$/, ".data.json");
  const handlers = [".qubc.handlers.ts", ".qubc.handlers.js"]
    .map((suffix) => id.replace(/\.qubc$/, suffix))
    .find((path) => existsSync(path));
  return existsSync(data) && handlers ? { data, handlers } : null;
};

// x.qubc의 story 모듈. indexer가 짝 파일이 둘 다 있는 것만 싣는다.
const storyModule = (id: string) => {
  const pairs = pairsOf(id);
  if (!pairs) {
    throw new Error(`${id}: 짝 data(.data.json)와 핸들러(.qubc.handlers.ts)가 둘 다 있어야 story가 된다`);
  }
  return [
    `import component from ${JSON.stringify(`${id}?qubb`)};`,
    `import { mount } from ${JSON.stringify(MOUNT)};`,
    `import data from ${JSON.stringify(pairs.data)};`,
    `import { handlers } from ${JSON.stringify(pairs.handlers)};`,
    "export default { render: (args) => mount(component, args, handlers), args: data };",
    "export const Default = {};",
  ].join("\n");
};

// `use "./x.css"`, `use X from "./x.qubc"`의 경로. 고치면 이 .qubc를 다시 컴파일하도록 감시에 건다.
const usedPaths = (source: string) => [...source.matchAll(/^\s*use\s+(?:\w+\s+from\s+)?"([^"]+)"/gm)].map((m) => m[1]);

export const qubc = (): Plugin => ({
  name: "quble-qubc",
  enforce: "pre",
  load(request) {
    const [id, query] = request.split("?");
    if (!id.endsWith(".qubc")) {
      return null;
    }
    if (query === undefined) {
      return storyModule(id);
    }
    if (query !== "qubb") {
      return null;
    }
    const out = join(OUT, createHash("sha1").update(id).digest("hex").slice(0, 12));
    try {
      execFileSync(QUBLE, [id, "--out-dir", out], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      const { stderr, message } = e as { stderr?: Buffer; message: string };
      throw new Error(`quble: ${id}\n${stderr?.toString() ?? message}`);
    }
    for (const path of usedPaths(readFileSync(id, "utf8"))) {
      this.addWatchFile(resolve(dirname(id), path));
    }
    const stem = basename(id, ".qubc");
    const bytes = readFileSync(join(out, `${stem}.qubb`)).toString("base64");
    const { resources }: { resources: string[] } = JSON.parse(readFileSync(join(out, `${stem}.manifest.json`), "utf8"));
    // resId 순서가 곧 compile에 넘길 URL 배열 순서다.
    const imports = resources.map((path, i) => `import r${i} from ${JSON.stringify(`${join(out, path)}?url`)};`);
    return [
      `import { compile } from ${JSON.stringify(RUNTIME)};`,
      ...imports,
      `const bytes = Uint8Array.from(atob(${JSON.stringify(bytes)}), (c) => c.charCodeAt(0));`,
      `export default compile(bytes, [${resources.map((_, i) => `r${i}`).join(", ")}]);`,
    ].join("\n");
  },
});
