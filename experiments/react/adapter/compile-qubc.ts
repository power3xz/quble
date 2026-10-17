// .qubc 하나를 컴파일해 compileToModule의 결과를 JSON으로 stdout에 낸다. Vite 밖의 번들러 로더가 자식 프로세스로 부른다.
// 사용: node --experimental-strip-types compile-qubc.ts <엔트리.qubc>

import { compileToModule } from "./vite-plugin.ts";

try {
  process.stdout.write(JSON.stringify(await compileToModule(process.argv[2])));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
