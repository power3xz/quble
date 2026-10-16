// 플레이그라운드 런타임 번들의 진입점 - 핸들러가 runtime.ts에서 가져오는 compile(미리보기 CSR)과
// 셸이 쓰는 resume, loadHandlers(SSR 이어받기)가 한 번들에서 모두 나가야 한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as entry from "./runtime-entry.ts";

test("compile, resume, loadHandlers를 모두 내보낸다", () => {
  assert.equal(typeof entry.compile, "function");
  assert.equal(typeof entry.resume, "function");
  assert.equal(typeof entry.loadHandlers, "function");
});
