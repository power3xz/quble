// 첫 화면에 실을 파일. core/playground/demo를 그대로 받아 온다(vite publicDir).
// 목록은 core/playground/sources.json과 같은 순서 - board가 진입 파일이다.
const NAMES = [
  "board.qubc",
  "board.qubc.handlers.js",
  "board.css",
  "board.data.json",
  "column.qubc",
  "column.qubc.handlers.js",
  "column.css",
  "column.data.json",
  "card.qubc",
  "card.qubc.handlers.js",
  "card.css",
  "card.data.json",
  "badge.qubc",
  "badge.qubc.handlers.js",
  "badge.css",
  "badge.data.json",
];

const ENTRY = "board.qubc";

/** demo 파일을 모두 받아 편집 대상 목록으로 만든다. */
export const loadFiles = async () => {
  const sources = await Promise.all(
    NAMES.map(async (name) => {
      const res = await fetch(`./${name}`);
      return res.ok ? await res.text() : `// 못 읽음: ${name}`;
    }),
  );
  return NAMES.map((name, i) => ({
    name,
    source: sources[i],
    isEntry: name === ENTRY,
  }));
};
