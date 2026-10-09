// quble-ssr(crates/renderer)를 실행해 픽스처의 SSR HTML을 얻는다. 픽스처는 buildFixture로 먼저 빌드돼 있어야 한다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureQubbPath } from "./build.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web/test-helpers
const SSR_BIN = join(HERE, "..", "..", "target", "debug", "quble-ssr");

// HTML(stdout)과 LOAD_RES가 만난 리소스 URL(stderr의 `link: <url>` 줄)을 돌려준다.
export const renderSsr = (name: string, resmap: string[], data: unknown) => {
  const run = spawnSync(SSR_BIN, [fixtureQubbPath(name), "-", ...resmap], {
    input: JSON.stringify(data),
    encoding: "utf8",
    // 기본 1MB를 넘는 픽스처가 있다(perfbig 약 3MB). 넘치면 status가 null로 끝난다.
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const links = run.stderr
    .split("\n")
    .filter((l) => l.startsWith("link: "))
    .map((l) => l.slice("link: ".length));
  return { html: run.stdout, links };
};

// quble-ssr --snapshot이 낸 leaf store 스냅샷(JSON)을 객체로 돌려준다. 픽스처는 buildFixture로 먼저 빌드돼 있어야 한다.
export const snapshotSsr = (name: string, data: unknown) => {
  const run = spawnSync(SSR_BIN, ["--snapshot", fixtureQubbPath(name), "-"], {
    input: JSON.stringify(data),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

// SSR이 resume용으로 남긴 텍스트 경계 표시 주석인가(`<!---->`, `<!--qb:empty-->`).
export const isTextMark = (node: Node): boolean =>
  node.nodeType === node.COMMENT_NODE && ["", "qb:empty"].includes((node as Comment).data);

// node 아래의 텍스트 경계 표시 주석을 모두 지운다.
export const removeTextMarks = (node: Node) => {
  for (const child of [...node.childNodes]) {
    if (isTextMark(child)) {
      child.remove();
    } else {
      removeTextMarks(child);
    }
  }
};
