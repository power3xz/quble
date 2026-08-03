// Node에서 .wasm을 읽어 컴파일러 핸들을 만든다. 읽는 방법만 여기 있고 ABI 래핑은
// wasm-compiler.ts가 한다.
//
// 브라우저와 달리 프리페치(lazyCompiler)가 없다 - 첫 페인트를 다툴 화면이 없고, 부르는 쪽이
// 필요할 때 한 번 만들어 들고 있으면 된다.

import { readFile } from "node:fs/promises";
import { makeCompiler } from "./wasm-compiler.ts";

/**
 * .wasm을 읽어 인스턴스화한다.
 * @param wasmPath  compiler_wasm.wasm 파일 경로
 */
export const loadCompiler = async (wasmPath: string) => {
  const bytes = await readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return makeCompiler(instance);
};
