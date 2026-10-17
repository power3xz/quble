// Turbopack 로더 - `import X from "./x.qubc"`를 TQubleBytecode 모듈로 바꾼다(next.config.mjs).
// 컴파일 코드가 TS라서 --experimental-strip-types를 켠 자식 프로세스로 compile-qubc.ts를 돌린다.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const COMPILE = join(__dirname, "..", "compile-qubc.ts");

module.exports = function qubcLoader() {
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", COMPILE, this.resourcePath],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const { code, dependencies } = JSON.parse(output);
  for (const dependency of dependencies) {
    this.addDependency(dependency);
  }
  return code;
};
