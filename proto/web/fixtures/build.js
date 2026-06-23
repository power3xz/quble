// 픽스처 .qubc를 실제 컴파일러(cargo run)로 빌드해 .qubb 바이트를 돌려준다.
// dist/는 gitignore라 산출물을 커밋하지 않는다 — 테스트가 빌드를 트리거해 재현성을 보장한다.
// (compile_file은 dist/<name>.qubb로 쓰므로, 컴파일 후 그 파일을 읽는다.)

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // proto/web/fixtures
const PROTO = join(HERE, "..", ".."); // proto

// fixtures/<name>.qubc를 컴파일하고 dist/<name>.qubb 바이트(Uint8Array)를 돌려준다.
export const buildFixture = (name) => {
  execFileSync("cargo", ["run", "-q", "--", `web/fixtures/${name}.qubc`], {
    cwd: PROTO,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return new Uint8Array(readFileSync(join(PROTO, "dist", `${name}.qubb`)));
};

// 위와 같이 빌드하되 { qubb, resmap }를 돌려준다. resmap은 dist/<name>.resmap.json
// (use한 리소스가 있을 때만 생성됨 — 없으면 빈 배열).
export const buildFixtureWithResmap = (name) => {
  const qubb = buildFixture(name);
  const resmapPath = join(PROTO, "dist", `${name}.resmap.json`);
  const resmap = existsSync(resmapPath) ? JSON.parse(readFileSync(resmapPath, "utf8")) : [];
  return { qubb, resmap };
};
