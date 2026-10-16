import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TSourceFiles } from "../../../core/wasm-compiler/wasm-compiler.ts";

// 문자열은 남기고 주석만 지운다. 주석 안의 use를 따라가지 않으려는 것이다.
const stripComments = (source: string): string =>
  source.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (token) => (token.startsWith('"') ? token : ""));

// `use Name from "경로"`(이름 여럿 가능)와 `use "경로"`(에셋)의 경로를 줄 시작에 있는 것만 모은다.
const USE_PATH = /^[ \t]*use\s+(?:[^"]*?\bfrom\s+)?"([^"]+)"/gm;

const pathsOfUse = (source: string): string[] =>
  Array.from(stripComments(source).matchAll(USE_PATH), (match) => match[1]);

// wasm 컴파일러의 로더는 이름 공간이 평탄해 `./`만 벗겨 등록된 이름을 찾는다. 하위 디렉터리와 상위로 가는
// 경로는 같은 이름으로 맞출 수 없어 오류로 막는다.
const flatName = (target: string, from: string): string => {
  const name = target.replace(/^\.\//, "");
  if (name.includes("/")) {
    throw new Error(`같은 디렉터리의 파일만 use할 수 있다: "${target}" (${from})`);
  }
  return name;
};

/**
 * 엔트리 .qubc에서 `use "..."`를 재귀로 따라가 wasm 컴파일러의 files 맵을 모은다.
 * @param entryPath  엔트리 .qubc의 파일 경로
 * @returns          files 경로(`./`를 벗긴 이름) -> 소스, entry 엔트리의 files 키
 */
export const collectSources = async (entryPath: string): Promise<{ files: TSourceFiles; entry: string }> => {
  const dir = dirname(entryPath);
  const entry = basename(entryPath);
  const files: TSourceFiles = {};
  const pending = [entry];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (name in files) {
      continue;
    }
    files[name] = await readFile(join(dir, name), "utf8").catch(() => {
      throw new Error(`use한 파일을 읽지 못했다: ${name} (엔트리 ${entryPath})`);
    });
    for (const target of pathsOfUse(files[name])) {
      pending.push(flatName(target, name));
    }
  }
  return { files, entry };
};
