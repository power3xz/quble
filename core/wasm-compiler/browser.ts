// 브라우저에서 .wasm을 받아 컴파일러 핸들을 만든다. 받는 방법만 여기 있고 ABI 래핑은
// wasm-compiler.ts가 한다.

import { makeCompiler } from "./wasm-compiler.ts";

/**
 * .wasm을 받아 인스턴스화한다.
 * @param wasmUrl  compiler_wasm.wasm URL
 */
export const loadCompiler = async (wasmUrl: string) => {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
  return makeCompiler(instance);
};

/**
 * loadCompiler를 처음 부를 때까지 미루되, 화면이 뜨고 한가해지면 미리 받아 둔다.
 * .wasm은 수백 KB라 첫 페인트와 대역폭을 다투면 안 되고, 그렇다고 처음 컴파일할 때
 * 받기 시작하면 그만큼 기다린다. 한 번 시작한 로딩은 promise째 캐시해 다시 받지 않는다.
 * @param wasmUrl  compiler_wasm.wasm URL
 * @returns        부를 때마다 같은 핸들 promise를 주는 함수
 */
export const lazyCompiler = (wasmUrl: string) => {
  let ready: ReturnType<typeof loadCompiler> | null = null;
  const get = () => {
    ready ??= loadCompiler(wasmUrl);
    return ready;
  };

  // 프레임에 여유가 생겼을 때 받는다 - 첫 페인트가 밀려 있으면 그 전에 돌지 않는다.
  // requestIdleCallback이 없는 브라우저(Safari)는 매크로태스크로 떨어뜨린다.
  const idle = globalThis.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 0));
  idle(() => get());

  return get;
};
