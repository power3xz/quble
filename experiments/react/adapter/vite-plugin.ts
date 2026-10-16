import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { collectSources } from "./collect-sources.ts";
import { compilerOf, declarationPath, writeDeclarations } from "./declarations.ts";

/**
 * 엔트리 .qubc를 컴파일해 JS 모듈 소스를 만든다. 기본 export가 TQubleBytecode이고, `use`한 CSS는 import로 건다.
 * @param entryPath  엔트리 .qubc의 파일 경로
 * @returns          code 모듈 소스, dependencies 컴파일에 읽은 파일들의 절대 경로(.qubc와 CSS)
 */
export const compileToModule = async (entryPath: string): Promise<{ code: string; dependencies: string[] }> => {
  const { files, entry } = await collectSources(entryPath);
  const result = (await compilerOf()).compile(files, entry);
  if (!result.ok) {
    throw new Error(result.diagnostic);
  }
  const dir = dirname(entryPath);
  const cssImports = result.resources.map((resource) => `import ${JSON.stringify(join(dir, resource))};\n`);
  const base64 = Buffer.from(result.bytecode).toString("base64");
  const code = `${cssImports.join("")}export default Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0));\n`;
  return { code, dependencies: Object.keys(files).map((name) => join(dir, name)) };
};

/**
 * `import X from "./x.qubc"`를 TQubleBytecode로 바꾸는 Vite 플러그인.
 * dev 서버를 시작할 때 프로젝트의 .qubc 타입 선언(x.qubc.d.ts)을 모두 쓰고, 서버가 도는 동안 .qubc의 추가, 변경,
 * 삭제를 따라 다시 쓴다. 빌드(vite build)는 선언을 쓰지 않는다 - 서버 없이 필요하면 gen-types.ts를 돌린다.
 * @param options.typesDir  선언을 모아 둘 디렉터리(프로젝트 루트 기준). 없으면 .qubc 옆에 쓴다.
 */
export const quble = (options: { typesDir?: string } = {}): Plugin => ({
  name: "quble",
  async configureServer(server) {
    const root = server.config.root;
    const generate = async (): Promise<void> => {
      const { failed } = await writeDeclarations(root, options.typesDir);
      for (const { path, diagnostic } of failed) {
        server.config.logger.warn(`[quble] ${path}의 타입 선언을 만들지 못했다: ${diagnostic}`);
      }
    };
    await generate();
    server.watcher.on("all", async (event, file) => {
      if (!file.endsWith(".qubc")) {
        return;
      }
      if (event === "unlink") {
        rmSync(declarationPath(root, file, options.typesDir), { force: true });
      } else if (event === "add" || event === "change") {
        await generate();
      }
    });
  },
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
