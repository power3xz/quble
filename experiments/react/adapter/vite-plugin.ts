import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { loadCompiler } from "../../../core/wasm-compiler/node.ts";
import { collectSources } from "./collect-sources.ts";

// wasm 인스턴스는 한 번만 만들어 모든 .qubc 컴파일이 나눠 쓴다. 컴파일은 동기라 호출끼리 섞이지 않는다.
let compiler: ReturnType<typeof loadCompiler> | undefined;

const DECODE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "core", "web", "decode");

/**
 * 엔트리 .qubc를 컴파일해 JS 모듈 소스를 만든다. 기본 export가 TQubleBytecode이고, `use`한 CSS는 import로 건다.
 * @param entryPath  엔트리 .qubc의 파일 경로
 * @returns          code 모듈 소스, dts 그 모듈의 타입 선언(x.qubc.d.ts에 쓴다), dependencies 컴파일에 읽은 파일들의 절대 경로(.qubc와 CSS)
 */
export const compileToModule = async (
  entryPath: string,
): Promise<{ code: string; dts: string; dependencies: string[] }> => {
  const { files, entry } = await collectSources(entryPath);
  compiler ??= loadCompiler();
  const loaded = await compiler;
  const result = loaded.compile(files, entry);
  if (!result.ok) {
    throw new Error(result.diagnostic);
  }
  const handlers = loaded.handlersDts(files, entry);
  if (!handlers.ok) {
    throw new Error(handlers.diagnostic);
  }
  const dir = dirname(entryPath);
  const decode = relative(dir, DECODE).split("\\").join("/");
  const dts = `import type { TQubleBytecode } from "${decode.startsWith(".") ? decode : `./${decode}`}";\n${handlers.dts}\ndeclare const bytecode: TQubleBytecode<THandlers>;\nexport default bytecode;\n`;
  const cssImports = result.resources.map((resource) => `import ${JSON.stringify(join(dir, resource))};\n`);
  const base64 = Buffer.from(result.bytecode).toString("base64");
  const code = `${cssImports.join("")}export default Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0));\n`;
  return { code, dts, dependencies: Object.keys(files).map((name) => join(dir, name)) };
};

// 내용이 같으면 쓰지 않는다 - 파일 감시가 쓰기에 다시 반응해 도는 것을 막는다.
const writeIfChanged = (path: string, text: string): void => {
  if (existsSync(path) && readFileSync(path, "utf8") === text) {
    return;
  }
  writeFileSync(path, text);
};

/** `import X from "./x.qubc"`를 TQubleBytecode로 바꾸는 Vite 플러그인. */
export const quble = (): Plugin => ({
  name: "quble",
  async load(id) {
    if (!id.endsWith(".qubc")) {
      return null;
    }
    const { code, dts, dependencies } = await compileToModule(id);
    writeIfChanged(`${id}.d.ts`, dts);
    for (const dependency of dependencies) {
      this.addWatchFile(dependency);
    }
    return code;
  },
});
