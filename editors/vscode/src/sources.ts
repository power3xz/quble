// `.qubc` 하나를 컴파일하려면 그 파일이 `use`로 끌어오는 것까지 다 등록해야 한다 - wasm은
// 파일시스템을 모르고 미리 넘긴 것만 본다. 여기는 vscode API에 안 닿는다(테스트를 위해).

import { dirname, resolve } from "node:path";
import type { TSourceFiles } from "quble-wasm-compiler/wasm-compiler.ts";

// `use "./x.css"` / `use Name from "./x.qubc"` - 둘 다 등록해야 한다(css도 loader를 탄다).
const USE = /^\s*use\s+(?:\w+\s+from\s+)?"([^"]+)"/gm;

/** 절대경로의 소스를 읽는다. 없거나 못 읽으면 null. */
export type TReadSource = (absolutePath: string) => string | null;

/**
 * 엔트리와 그 use 그래프를 (경로 -> 소스)로 모은다. 키는 **소스에 적힌 이름 그대로**다 -
 * wasm loader가 `./` 접두만 떼고 이름으로 맞추므로(compiler-wasm 머리주석) 절대경로를 주면
 * 안 맞는다.
 *
 * 엔트리만 예외로 그 파일의 절대경로를 키로 쓴다. 진단이 돌려주는 path가 이 키라, 확장이
 * 그걸로 어느 파일에 밑줄을 그을지 되찾는다.
 *
 * 읽기 실패한 파일은 건너뛴다 - 컴파일러가 그 자리에서 진단을 내는 게 낫다.
 */
export const collectSources = (entryPath: string, read: TReadSource): TSourceFiles => {
  const files: TSourceFiles = {};

  const visit = (absolute: string, name: string) => {
    if (files[name] !== undefined) {
      return;
    }
    const source = read(absolute);
    if (source === null) {
      return;
    }
    files[name] = source;
    for (const [, target] of source.matchAll(USE)) {
      visit(resolve(dirname(absolute), target), target.replace(/^\.\//, ""));
    }
  };

  visit(entryPath, entryPath);
  return files;
};
