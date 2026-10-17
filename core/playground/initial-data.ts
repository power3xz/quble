// 셸(playground.qubc)이 처음 그릴 때 받는 data. 브라우저(index.html)와 빌드 때 SSR(build-playground.mjs)이 같은
// 함수를 부른다 - 둘이 다르면 SSR 화면과 resume한 뒤 화면이 달라진다.

import { lineCountOf, tokenize } from "./tokenize.ts";

// sources의 순서가 곧 파일 트리 순서고, 첫 파일이 편집 중이다.
export const initialData = (sources: { name: string; source: string }[]) => ({
  files: sources.map((f) => ({
    name: f.name,
    source: f.source,
    isEntry: f.name.endsWith(".qubc"),
    isEditing: f.name === sources[0].name,
    isPreviewing: false,
    hasError: false,
  })),
  editing: 0, // 편집 중인 파일 - files의 인덱스
  source: sources[0].source,
  lines: tokenize(sources[0].source, sources[0].name),
  lineCount: lineCountOf(sources[0].source),
  caretLine: "transform: translateY(1rem)", // 첫 줄 - .pg__view의 padding-top과 같다
  // 줄의 hasError/error는 tokenize가 꺼진 채로 채운다 - 컴파일 에러가 나면 그때 얹힌다.
  // 미리보기 중인 파일 - files의 인덱스. @if (previewSelected) 안에서만 읽으므로 미리보기 전에는
  // 쓰이지 않는다.
  preview: 0,
  previewSelected: false,
  // 자동완성 팝업 - 핸들러 파일의 키 자리에서 큰따옴표를 치면 열린다.
  completion: { isOpen: false, style: "", isAbove: false, items: [] as unknown[] },
  logs: [] as unknown[],
  diagnostic: "",
  hasError: false,
});
