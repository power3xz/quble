import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompiler } from "../../../core/wasm-compiler/node.ts";
import { collectSources } from "./collect-sources.ts";

// wasm 인스턴스는 한 번만 만들어 모든 컴파일이 나눠 쓴다. 컴파일은 동기라 호출끼리 섞이지 않는다.
let compiler: ReturnType<typeof loadCompiler> | undefined;
export const compilerOf = () => {
  compiler ??= loadCompiler();
  return compiler;
};

const DECODE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "core", "web", "decode");

// 소스가 아닌 디렉터리 - 의존, 산출물, 점으로 시작하는 디렉터리(.git, .quble 등).
const SKIPPED = new Set(["node_modules", "dist", "target"]);

/**
 * 엔트리 .qubc의 타입 선언 텍스트. 기본 export가 TQubleBytecode<THandlers>다.
 * @param entryPath  엔트리 .qubc의 파일 경로
 * @param outPath    선언을 놓을 파일 경로 - TQubleBytecode를 가져오는 상대 경로가 여기 기준이다
 */
export const declarationOf = async (entryPath: string, outPath: string): Promise<string> => {
  const { files, entry } = await collectSources(entryPath);
  const handlers = (await compilerOf()).handlersDts(files, entry);
  if (!handlers.ok) {
    throw new Error(handlers.diagnostic);
  }
  const decode = relative(dirname(outPath), DECODE).split("\\").join("/");
  const from = decode.startsWith(".") ? decode : `./${decode}`;
  return `import type { TQubleBytecode } from "${from}";\n${handlers.dts}\ndeclare const bytecode: TQubleBytecode<THandlers>;\nexport default bytecode;\n`;
};

// root 아래의 .qubc 경로를 모두 모은다.
const qubcFilesIn = async (dir: string, skipped: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name) && !entry.name.startsWith(".") && path !== skipped) {
        found.push(...(await qubcFilesIn(path, skipped)));
      }
    } else if (entry.name.endsWith(".qubc")) {
      found.push(path);
    }
  }
  return found;
};

/** .qubc 하나의 선언 파일 경로 - typesDir가 없으면 옆, 있으면 root 기준 같은 상대 경로로 그 아래다. */
export const declarationPath = (root: string, entryPath: string, typesDir?: string): string => {
  if (typesDir === undefined) {
    return `${entryPath}.d.ts`;
  }
  const base = isAbsolute(typesDir) ? typesDir : join(root, typesDir);
  return join(base, `${relative(root, entryPath)}.d.ts`);
};

// 내용이 같으면 쓰지 않는다 - 파일 감시가 쓰기에 다시 반응해 도는 것을 막는다. 썼으면 true.
const writeIfChanged = (path: string, text: string): boolean => {
  if (existsSync(path) && readFileSync(path, "utf8") === text) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
};

/**
 * root 아래의 .qubc 전부에 타입 선언을 쓴다. 컴파일되지 않는 파일은 건너뛰고 failed에 담는다.
 * @param root      소스를 찾을 디렉터리
 * @param typesDir  선언을 모아 둘 디렉터리(root 기준 상대 경로 또는 절대 경로). 없으면 .qubc 옆에 쓴다.
 *                  모아 두면 소비자가 tsconfig의 rootDirs에 이 디렉터리를 더해야 import가 해석된다.
 * @returns         written 새로 쓰거나 바뀌어 쓴 선언 파일, failed 컴파일에 실패한 .qubc와 진단
 */
export const writeDeclarations = async (
  root: string,
  typesDir?: string,
): Promise<{ written: string[]; failed: { path: string; diagnostic: string }[] }> => {
  const skipped = typesDir === undefined ? "" : isAbsolute(typesDir) ? typesDir : join(root, typesDir);
  const written: string[] = [];
  const failed: { path: string; diagnostic: string }[] = [];
  for (const entryPath of await qubcFilesIn(root, skipped)) {
    const outPath = declarationPath(root, entryPath, typesDir);
    try {
      if (writeIfChanged(outPath, await declarationOf(entryPath, outPath))) {
        written.push(outPath);
      }
    } catch (error) {
      failed.push({ path: entryPath, diagnostic: error instanceof Error ? error.message : String(error) });
    }
  }
  return { written, failed };
};
