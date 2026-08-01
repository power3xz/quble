// 픽스처 .qubc를 실제 컴파일러로 빌드해 .qubb 바이트를 돌려준다.
// dist/는 gitignore라 산출물을 커밋하지 않는다 - 테스트가 빌드를 트리거해 재현성을 보장한다.
//
// `cargo run`이 아니라 미리 빌드된 바이너리(target/debug/quble)를 직접 실행한다.
// `node --test web/*.test.js`는 파일마다 별도 프로세스라, 여럿이 동시에 `cargo run`을 치면
// 빌드 최신성 검사가 target/ 락을 다투어 간헐 실패했다(매번 다른 파일). 바이너리 직접 실행은
// 락을 잡지 않는다. 바이너리 보장은 호출자 몫 - 없으면 안내와 함께 실패한다(테스트 전 `cargo build`).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web/test-helpers
const CORE = join(HERE, "..", ".."); // core
const QUBLE_BIN = join(CORE, "target", "debug", "quble");

// 픽스처는 루트 components/에 `<name>.fixture.qubc`로 산다(데모와 접미사로 구분). 호출부는 stem만
// 넘기고(`buildFixture("array_payload")`) 여기서 경로/접미사를 붙인다. 컴파일 산출물 stem은
// `<name>.fixture`라 <OUT_DIR>/<name>.fixture.qubb.
const COMPONENTS = join(CORE, "..", "components");

// 산출물은 용도별 하위 디렉토리에 낸다 - playground/preview 빌드와 섞이지 않게(그쪽은 시작할 때
// 자기 디렉토리를 비운다). cwd가 CORE라 quble에는 상대 경로로 넘긴다.
const OUT_NAME = join("dist", "fixtures");
const OUT_DIR = join(CORE, OUT_NAME);

// components/<name>.fixture.qubc를 컴파일하고 <OUT_DIR>/<name>.fixture.qubb 바이트를 돌려준다.
export const buildFixture = (name: string): Uint8Array => {
  if (!existsSync(QUBLE_BIN)) {
    throw new Error(`quble 바이너리 없음(${QUBLE_BIN}). 테스트 전에 'cargo build'를 실행하세요.`);
  }
  execFileSync(QUBLE_BIN, [join(COMPONENTS, `${name}.fixture.qubc`), "--out-dir", OUT_NAME], {
    cwd: CORE,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return new Uint8Array(readFileSync(join(OUT_DIR, `${name}.fixture.qubb`)));
};

// 위와 같이 빌드하되 { qubb, resmap }를 돌려준다. resmap은 manifest의 resources 배열
// (<OUT_DIR>/<name>.fixture.manifest.json). manifest는 항상 생성되고, 리소스 없으면 빈 배열.
export const buildFixtureWithResmap = (name: string) => {
  const qubb = buildFixture(name);
  const manifestPath = join(OUT_DIR, `${name}.fixture.manifest.json`);
  const resmap = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).resources : [];
  return { qubb, resmap };
};
