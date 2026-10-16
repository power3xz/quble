import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { loadCompiler } from "../../../core/wasm-compiler/node.ts";
import { collectSources } from "./collect-sources.ts";

// wasm 인스턴스는 한 번만 만들어 모든 .qubc 컴파일이 나눠 쓴다. 컴파일은 동기라 호출끼리 섞이지 않는다.
let compiler: ReturnType<typeof loadCompiler> | undefined;

/**
 * 엔트리 .qubc를 컴파일해 JS 모듈 소스를 만든다. 기본 export가 TQubleBytecode이고, `use`한 CSS는 import로 건다.
 * @param entryPath  엔트리 .qubc의 파일 경로
 * @returns          code 모듈 소스, dependencies 컴파일에 읽은 파일들의 절대 경로(.qubc와 CSS)
 */
export const compileToModule = async (entryPath: string): Promise<{ code: string; dependencies: string[] }> => {
  const { files, entry } = await collectSources(entryPath);
  compiler ??= loadCompiler();
  const result = (await compiler).compile(files, entry);
  if (!result.ok) {
    throw new Error(result.diagnostic);
  }
  const dir = dirname(entryPath);
  const cssImports = result.resources.map((resource) => `import ${JSON.stringify(join(dir, resource))};\n`);
  const base64 = Buffer.from(result.bytecode).toString("base64");
  const code = `${cssImports.join("")}export default Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0));\n`;
  return { code, dependencies: Object.keys(files).map((name) => join(dir, name)) };
};

/** `import X from "./x.qubc"`를 TQubleBytecode로 바꾸는 Vite 플러그인. */
export const quble = (): Plugin => ({
  name: "quble",
  async load(id) {
    if (!id.endsWith(".qubc")) {
      return null;
    }
    const { code, dependencies } = await compileToModule(id);
    for (const dependency of dependencies) {
      this.addWatchFile(dependency);
    }
    return code;
  },
});
