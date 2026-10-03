// `.qubc?qubb`를 import하면 quble 바이너리로 qubb를 내고, 그 바이트와 스타일 리소스 URL로 런타임 compile을
// 부른 결과를 default export하는 vite 플러그인. `?qubb`는 .qubc 옆에 생성된 .qubc.d.ts(핸들러 타입)가
// 이 import의 타입을 가리지 않게 붙인다.
//
//   import TodoList from "../../../components/todo_list.qubc?qubb";
//   TodoList(0)(data, handlers)  // { nodes, destroy, ... }
//
// 산출물은 dist/qubc/<경로 해시>/에 둔다. 스타일은 `?url`로 실어 vite가 서빙한다.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const QUBLE = join(REPO, "core", "target", "debug", "quble");
const RUNTIME = join(REPO, "core", "web", "runtime.ts");
const OUT = join(HERE, "dist", "qubc");

// `use "./x.css"`, `use X from "./x.qubc"`의 경로. 고치면 이 .qubc를 다시 컴파일하도록 감시에 건다.
const usedPaths = (source: string) => [...source.matchAll(/^\s*use\s+(?:\w+\s+from\s+)?"([^"]+)"/gm)].map((m) => m[1]);

export const qubc = (): Plugin => ({
  name: "quble-qubc",
  enforce: "pre",
  load(request) {
    const [id, query] = request.split("?");
    if (!id.endsWith(".qubc") || query !== "qubb") {
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
