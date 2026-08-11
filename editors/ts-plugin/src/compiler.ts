// 짝 .qubc에서 d.ts 텍스트를 얻는다. tsserver가 getScriptSnapshot을 동기로 부르므로
// wasm 인스턴스화도 동기여야 한다 - readFileSync + new WebAssembly.Instance.
// (node.ts의 loadCompiler는 async라 여기서 못 쓴다. ABI 래핑은 makeCompiler를 그대로 쓴다.)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadCompilerSync } from "quble-wasm-compiler/node-sync.ts";
import type { TSourceFiles } from "quble-wasm-compiler/wasm-compiler.ts";

// `use "./x.css"` / `use Name from "./x.qubc"` - 둘 다 등록해야 한다(css도 loader를 탄다).
const USE = /^\s*use\s+(?:\w+\s+from\s+)?"([^"]+)"/gm;

// wasm은 한 번만 인스턴스화해 들고 쓴다.
let compiler: ReturnType<typeof loadCompilerSync> | null = null;

const getCompiler = (wasmPath: string) => {
  compiler ??= loadCompilerSync(wasmPath);
  return compiler;
};

/**
 * 엔트리와 그 use 그래프를 읽어 (경로 -> 소스) 맵으로 만든다. 키는 엔트리 기준 상대경로 -
 * wasm loader가 `./` 접두만 떼고 이름으로 맞추므로 소스에 적힌 그대로여야 한다.
 *
 * 읽기 실패한 파일은 건너뛴다 - 컴파일러가 그 자리에서 진단을 내는 게 낫다.
 */
const collectSources = (entryPath: string): TSourceFiles => {
  const files: TSourceFiles = {};

  const visit = (absolute: string, name: string) => {
    if (files[name] !== undefined) {
      return;
    }
    let source: string;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      return;
    }
    files[name] = source;
    for (const [, target] of source.matchAll(USE)) {
      visit(resolve(dirname(absolute), target), target.replace(/^\.\//, ""));
    }
  };

  visit(entryPath, "entry.qubc");
  return files;
};

/** 컴파일이 실패했을 때 얹을 d.ts. 어떤 키도 통과하지 않게 빈 인터페이스를 낸다. */
export const emptyDts = (reason: string) => `// quble: ${reason}\nexport interface Handlers {}\n`;

/**
 * 짝 .qubc를 컴파일해 d.ts 텍스트를 낸다. 실패하면 빈 Handlers를 내 어떤 키도 통과하지
 * 않게 한다 - 타입을 아예 안 얹으면 any가 되어 반대로 다 통과한다.
 *
 * @param qubcPath  짝 .qubc의 절대경로
 * @param wasmPath  compiler_wasm.wasm의 절대경로
 */
export const dtsFor = (qubcPath: string, wasmPath: string) => {
  try {
    const result = getCompiler(wasmPath).handlersDts(collectSources(qubcPath), "entry.qubc");
    return result.ok ? result.dts : emptyDts(result.diagnostic);
  } catch (e) {
    return emptyDts(e instanceof Error ? e.message : String(e));
  }
};
