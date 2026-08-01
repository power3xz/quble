// wasm 컴파일러(compiler-wasm 크레이트)의 JS 래퍼. extern "C" ABI를 감싸 문자열/바이트를 오간다.
//
// 메모리 주의: 힙이 자라면(memory.grow) 기존 ArrayBuffer가 detach되고 새것으로 바뀐다. 뷰를
// 캐싱하면 그 뒤로 빈 배열이 되므로 매번 새로 만든다. 특히 결과 읽기는 컴파일이 끝난 뒤에 떠야 한다.

// compiler-wasm이 export하는 것들(crates/compiler-wasm/src/lib.rs 머리주석의 ABI).
type TWasmExports = {
  memory: WebAssembly.Memory;
  qb_alloc: (len: number) => number;
  qb_free: (ptr: number, len: number) => void;
  qb_reset: () => void;
  qb_add_file: (pathPtr: number, pathLen: number, srcPtr: number, srcLen: number) => void;
  qb_compile: (entryPtr: number, entryLen: number) => number;
  qb_out_ptr: () => number;
  qb_out_len: () => number;
  qb_res_ptr: () => number;
  qb_res_len: () => number;
};

/** 경로 -> 소스. `.qubc`와 `.css` 모두 담는다(css도 loader를 타므로 등록돼 있어야 한다). */
export type TSourceFiles = Record<string, string>;

/** 성공이면 바이트코드와 리소스 경로(resId 순), 실패면 진단 텍스트. */
export type TCompileResult =
  | { ok: true; bytecode: Uint8Array; resources: string[] }
  | { ok: false; diagnostic: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * .wasm을 인스턴스화해 컴파일러 핸들을 만든다.
 * @param wasmUrl  compiler_wasm.wasm URL
 * @returns        compile(files, entry)를 가진 핸들
 */
export const loadCompiler = async (wasmUrl: string) => {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
  const wasm = instance.exports as unknown as TWasmExports;

  // 문자열을 wasm 메모리에 써넣고 [ptr, len]을 준다. 부른 쪽이 free할 책임을 진다.
  const put = (text: string): [number, number] => {
    const bytes = encoder.encode(text);
    const ptr = wasm.qb_alloc(bytes.length);
    new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
  };

  // 슬롯(ptr/len 게터 쌍)의 현재 내용을 복사한다 - 다음 컴파일이 슬롯을 덮어쓰므로 뷰로 들면 안 된다.
  const readSlot = (ptrFn: () => number, lenFn: () => number): Uint8Array =>
    new Uint8Array(wasm.memory.buffer, ptrFn(), lenFn()).slice();

  /**
   * 파일을 등록하고 entry를 엔트리로 컴파일한다. `use`는 등록된 이름으로 해소된다.
   * @param files  경로 -> 소스 (.qubc/.css)
   * @param entry  엔트리 경로(files의 키)
   */
  const compile = (files: TSourceFiles, entry: string): TCompileResult => {
    wasm.qb_reset();
    for (const [path, source] of Object.entries(files)) {
      const [pathPtr, pathLen] = put(path);
      const [srcPtr, srcLen] = put(source);
      wasm.qb_add_file(pathPtr, pathLen, srcPtr, srcLen);
      wasm.qb_free(pathPtr, pathLen);
      wasm.qb_free(srcPtr, srcLen);
    }

    const [entryPtr, entryLen] = put(entry);
    let status: number;
    try {
      status = wasm.qb_compile(entryPtr, entryLen);
    } finally {
      wasm.qb_free(entryPtr, entryLen);
    }

    const out = readSlot(wasm.qb_out_ptr, wasm.qb_out_len);
    if (status !== 0) {
      return { ok: false, diagnostic: decoder.decode(out) };
    }
    // 리소스 목록은 개행으로 이은 경로들(resId 순). 비면 리소스 없음.
    const resText = decoder.decode(readSlot(wasm.qb_res_ptr, wasm.qb_res_len));
    return {
      ok: true,
      bytecode: out,
      resources: resText === "" ? [] : resText.split("\n"),
    };
  };

  return { compile };
};
