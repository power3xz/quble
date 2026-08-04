// wasm 컴파일러(compiler-wasm 크레이트)의 JS 래퍼. extern "C" ABI를 감싸 문자열/바이트를 오간다.
// 여기는 환경 중립 - .wasm을 얻는 방법만 갈리므로 그쪽은 browser.ts / node.ts가 맡는다.
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
  qb_handler_names: (entryPtr: number, entryLen: number) => number;
  qb_handlers_dts: (entryPtr: number, entryLen: number) => number;
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

/** 성공이면 d.ts 텍스트, 실패면 진단 텍스트. */
export type TDtsResult = { ok: true; dts: string } | { ok: false; diagnostic: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 인스턴스화된 wasm을 컴파일러 핸들로 감싼다.
 *
 * .wasm 바이트를 어디서 얻느냐만 환경마다 다르므로(브라우저는 fetch, Node는 readFile)
 * 인스턴스를 받아 그 갈래를 밖에 둔다 - browser.ts / node.ts.
 *
 * @param instance  compiler_wasm.wasm 인스턴스
 * @returns         compile/handlerNames를 가진 핸들
 */
export const makeCompiler = (instance: WebAssembly.Instance) => {
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

  // 파일을 등록하고 entry를 받는 wasm 함수(qb_compile/qb_handler_names)를 태운다. 둘 다 결과를
  // out 슬롯에 놓으므로 상태와 함께 읽어 돌려준다 - 슬롯은 다음 호출이 덮어쓴다.
  const run = (
    fn: (entryPtr: number, entryLen: number) => number,
    files: TSourceFiles,
    entry: string,
  ): { status: number; out: Uint8Array } => {
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
      status = fn(entryPtr, entryLen);
    } finally {
      wasm.qb_free(entryPtr, entryLen);
    }
    return { status, out: readSlot(wasm.qb_out_ptr, wasm.qb_out_len) };
  };

  /**
   * 파일을 등록하고 entry를 엔트리로 컴파일한다. `use`는 등록된 이름으로 해소된다.
   * @param files  경로 -> 소스 (.qubc/.css)
   * @param entry  엔트리 경로(files의 키)
   */
  const compile = (files: TSourceFiles, entry: string): TCompileResult => {
    const { status, out } = run(wasm.qb_compile, files, entry);
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

  /**
   * entry를 마운트 진입점으로 봤을 때 핸들러가 가질 수 있는 fullname 목록(트리 순서).
   * 컴파일(codegen)까지 가지 않고 합성 트리만 걸으므로 편집 중에 반복해 불러도 된다.
   * 소스가 깨져 이름을 못 내면 빈 배열 - 진단은 컴파일 쪽이 낸다.
   * @param files  경로 -> 소스 (.qubc/.css)
   * @param entry  엔트리 경로(files의 키). 핸들러 파일의 짝이 되는 `.qubc`다.
   */
  const handlerNames = (files: TSourceFiles, entry: string): string[] => {
    const { status, out } = run(wasm.qb_handler_names, files, entry);
    if (status !== 0 || out.length === 0) {
      return [];
    }
    return decoder.decode(out).split("\n");
  };

  /**
   * entry의 핸들러 타입(.d.ts 텍스트). 짝 핸들러 파일에 타입을 붙이는 쪽이 쓴다.
   *
   * handlerNames와 달리 실패를 뭉개지 않는다 - 이름 후보는 없으면 자동완성이 안 뜨고 말지만,
   * 타입은 왜 안 붙었는지를 소비자가 알려줘야 한다.
   *
   * @param files  경로 -> 소스 (.qubc/.css)
   * @param entry  엔트리 경로(files의 키). 핸들러 파일의 짝이 되는 `.qubc`다.
   */
  const handlersDts = (files: TSourceFiles, entry: string): TDtsResult => {
    const { status, out } = run(wasm.qb_handlers_dts, files, entry);
    const text = decoder.decode(out);
    return status === 0 ? { ok: true, dts: text } : { ok: false, diagnostic: text };
  };

  return { compile, handlerNames, handlersDts };
};

/** 컴파일러 핸들 - 환경별 로더가 돌려주는 것. */
export type TCompiler = ReturnType<typeof makeCompiler>;
