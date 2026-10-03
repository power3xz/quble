// playground 셸을 React로 띄운다. 초기 data는 core/playground/index.html이 만드는 것과 같다.
// 핸들러는 qubb 셸과 같은 core/playground/playground.qubc.handlers.ts다.
import { QubleRoot, type THandlers } from "quble-react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { handlers, lineCountOf, tokenize } from "../../core/playground/playground.qubc.handlers.ts";
import { Playground } from "../gen/playground.tsx";

// sources.json은 이름만 담고 내용은 demo/에 있다. 목록 순서가 곧 파일 트리 순서다.
const names: string[] = await fetch("./sources.json").then((r) => r.json());
const sources = await Promise.all(
  names.map(async (name) => ({ name, source: await fetch(`./demo/${name}`).then((r) => r.text()) })),
);

const data = {
  files: sources.map((f) => ({
    name: f.name,
    source: f.source,
    isEntry: f.name.endsWith(".qubc"),
    isEditing: f.name === sources[0].name,
    isPreviewing: false,
    hasError: false,
  })),
  editing: 0,
  source: sources[0].source,
  lines: tokenize(sources[0].source, sources[0].name),
  lineCount: lineCountOf(sources[0].source),
  caretLine: "transform: translateY(1rem)",
  preview: 0,
  previewSelected: false,
  completion: { isOpen: false, style: "", isAbove: false, items: [] },
  logs: [],
  diagnostic: "",
  hasError: false,
};

const editor = document.getElementById("editor");
if (!editor) {
  throw new Error("#editor가 없다");
}
createRoot(editor).render(
  createElement(QubleRoot, {
    component: Playground,
    initial: data,
    // 핸들러 표의 타입은 qubb 기준(leafIndex)이다. 쓰는 법은 같아 그대로 넘긴다.
    handlers: handlers as unknown as THandlers,
  }),
);
