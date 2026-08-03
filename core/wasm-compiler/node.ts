// Node에서 .wasm을 읽어 컴파일러 핸들을 만든다. 읽는 방법만 여기 있고 ABI 래핑은
// wasm-compiler.ts가 한다.
//
// 브라우저와 달리 프리페치(lazyCompiler)가 없다 - 첫 페인트를 다툴 화면이 없고, 부르는 쪽이
// 필요할 때 한 번 만들어 들고 있으면 된다.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCompiler } from "./wasm-compiler.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/wasm-compiler

/**
 * .wasm의 자리 - 패키지 바로 옆이다. cargo 산출물 경로(core/target/..)를 짚으면 레포 안에서만
 * 맞고 확장에 포장했을 때 깨지므로, build:wasm이 여기로 복사해 두 환경을 같게 만든다.
 * 산출물이라 레포에는 없다 - `npm run build:wasm -w quble-wasm-compiler`로 만든다.
 */
export const WASM_PATH = join(HERE, "compiler_wasm.wasm");

/**
 * .wasm을 읽어 인스턴스화한다.
 * @param wasmPath  compiler_wasm.wasm 파일 경로. 기본은 패키지 옆(WASM_PATH).
 */
export const loadCompiler = async (wasmPath: string = WASM_PATH) => {
  const bytes = await readFile(wasmPath).catch(() => {
    throw new Error(`wasm 컴파일러 없음(${wasmPath}). 'npm run build:wasm -w quble-wasm-compiler'를 먼저 실행하세요.`);
  });
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return makeCompiler(instance);
};
