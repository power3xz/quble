// 서버 없이 .qubc의 타입 선언(x.qubc.d.ts)을 만든다. tsc 단독 실행, CI, 새 클론에서 먼저 돌린다.
// 사용: node --experimental-strip-types gen-types.ts <루트> [typesDir]
import { resolve } from "node:path";
import { writeDeclarations } from "./declarations.ts";

const [root, typesDir] = process.argv.slice(2);
if (root === undefined) {
  console.error("사용법: node --experimental-strip-types gen-types.ts <루트> [typesDir]");
  process.exit(1);
}

const { written, failed } = await writeDeclarations(resolve(root), typesDir);
console.log(`타입 선언 ${written.length}개를 썼다`);
for (const { path, diagnostic } of failed) {
  console.error(`${path}: ${diagnostic}`);
}
process.exit(failed.length > 0 ? 1 : 0);
