// 픽스처 .qubc를 실제 컴파일러로 빌드해 .qubb 바이트를 돌려준다.
// dist/는 gitignore라 산출물을 커밋하지 않는다 - 테스트가 빌드를 트리거해 재현성을 보장한다.
// (compile_file은 dist/<name>.qubb로 쓰므로, 컴파일 후 그 파일을 읽는다.)
//
// `cargo run`이 아니라 미리 빌드된 바이너리(target/debug/quble)를 직접 실행한다.
// `node --test web/*.test.js`는 파일마다 별도 프로세스라, 여럿이 동시에 `cargo run`을 치면
// 빌드 최신성 검사가 target/ 락을 다투어 간헐 실패했다(매번 다른 파일). 바이너리 직접 실행은
// 락을 잡지 않는다. 바이너리 보장은 호출자 몫 - 없으면 안내와 함께 실패한다(테스트 전 `cargo build`).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // proto/web/fixtures
const PROTO = join(HERE, "..", ".."); // proto
const QUBLE_BIN = join(PROTO, "target", "debug", "quble");

// fixtures/<name>.qubc를 컴파일하고 dist/<name>.qubb 바이트(Uint8Array)를 돌려준다.
export const buildFixture = (name) => {
  if (!existsSync(QUBLE_BIN)) {
    throw new Error(`quble 바이너리 없음(${QUBLE_BIN}). 테스트 전에 'cargo build'를 실행하세요.`);
  }
  execFileSync(QUBLE_BIN, [`web/fixtures/${name}.qubc`], {
    cwd: PROTO,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return new Uint8Array(readFileSync(join(PROTO, "dist", `${name}.qubb`)));
};

// 위와 같이 빌드하되 { qubb, resmap }를 돌려준다. resmap은 manifest의 resources 배열
// (dist/<name>.manifest.json). manifest는 항상 생성되고, 리소스 없으면 resources는 빈 배열.
export const buildFixtureWithResmap = (name) => {
  const qubb = buildFixture(name);
  const manifestPath = join(PROTO, "dist", `${name}.manifest.json`);
  const resmap = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")).resources
    : [];
  return { qubb, resmap };
};
