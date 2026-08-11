// loadCompiler의 동기 버전. node.ts에서 갈라 둔 이유는 모듈 형식이다 - 이쪽 소비자는
// CJS(TS Language Service plugin: tsserver가 require로 싣고 getScriptSnapshot을 동기로 부른다)라
// node.ts의 import.meta(wasmPath 기본값)에 걸린다. 여기는 경로를 반드시 받아 그것을 안 쓴다.

import { readFileSync } from "node:fs";
import { makeCompiler } from "./wasm-compiler.ts";

/**
 * .wasm을 읽어 동기로 인스턴스화한다.
 * @param path  compiler_wasm.wasm 파일 경로(필수 - 이 진입점은 기본 경로를 계산하지 않는다).
 */
export const loadCompilerSync = (path: string) => {
  // Buffer의 .buffer는 SharedArrayBuffer일 수 있어 WebAssembly.Module이 안 받는다 -
  // 내용을 새 ArrayBuffer로 옮긴다.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const read = readFileSync(path);
    bytes = new Uint8Array(read.byteLength);
    bytes.set(read);
  } catch {
    throw new Error(`wasm 컴파일러 없음(${path}). 'npm run build:wasm -w quble-wasm-compiler'를 먼저 실행하세요.`);
  }
  return makeCompiler(new WebAssembly.Instance(new WebAssembly.Module(bytes), {}));
};
