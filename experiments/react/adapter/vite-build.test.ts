// 실제 Vite 빌드를 거쳐도 .qubc import가 바이트코드가 되고 use한 CSS가 번들러 에셋으로 나오는지.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { quble } from "./vite-plugin.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const buildEntry = async () => {
  const result = await build({
    root: FIXTURES,
    logLevel: "silent",
    configFile: false,
    plugins: [quble()],
    build: { write: false, lib: { entry: join(FIXTURES, "entry.ts"), formats: ["es"], fileName: "entry" } },
  });
  return (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
};

test("빌드 결과 JS가 바이트코드를 싣고 CSS는 에셋으로 나온다", async () => {
  const { output } = await buildEntry();
  const js = output.find((file) => file.type === "chunk" && file.fileName.endsWith(".js")) as Rollup.OutputChunk;
  const css = output.find((file) => file.type === "asset" && file.fileName.endsWith(".css")) as Rollup.OutputAsset;
  assert.ok(js.code.includes("atob("), "바이트코드를 base64로 싣는다");
  assert.ok(!js.code.includes("greeting.css"), "CSS는 JS에 import로 남지 않고 번들러가 처리한다");
  assert.match(String(css.source), /color:\s*#345/);
});
