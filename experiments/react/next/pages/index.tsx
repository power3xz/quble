// playground 셸을 서버에서 그린다. 초기 data는 core/playground/index.html이 만드는 것과 같고, 데모 소스는
// 요청마다 파일에서 읽는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GetServerSideProps } from "next";
import { QubleRoot, type THandlers } from "quble-react";
import { useEffect } from "react";
import { lineCountOf, tokenize } from "../../../../core/playground/tokenize.ts";
import { Playground } from "../../dist/playground/playground.tsx";

type TData = Parameters<typeof Playground>[0];

// 셸 핸들러는 브라우저에서만 싣는다. 그 모듈은 실리자마자 wasm 컴파일러를 받으러 가고 console을 가로챈다.
// QubleRoot는 발화할 때 이 표를 읽으므로, 실린 뒤 채워 넣으면 그때부터 핸들러가 돈다.
const handlers: THandlers = {};

export default function Page({ data }: { data: TData }) {
  useEffect(() => {
    import("../../../../core/playground/playground.qubc.handlers.ts").then((m) => {
      // 핸들러 표의 타입은 qubb 기준(leafIndex)이다. 쓰는 법은 같다.
      Object.assign(handlers, m.handlers as unknown as THandlers);
    });
  }, []);
  return <QubleRoot<TData> component={Playground} initial={data} handlers={handlers} />;
}

export const getServerSideProps: GetServerSideProps<{ data: TData }> = async () => {
  const dir = process.env.QUBLE_PLAYGROUND ?? "";
  // sources.json은 이름만 담고 내용은 demo/에 있다. 목록 순서가 곧 파일 트리 순서다.
  const names: string[] = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8"));
  const sources = names.map((name) => ({ name, source: readFileSync(join(dir, "demo", name), "utf8") }));
  const data: TData = {
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
    // 셸의 줄 모양은 밑줄을 hasUnderline/underlineStyle로 받는다(핸들러의 forScreen). 첫 화면은 컴파일 전이라
    // 밑줄이 없다.
    lines: tokenize(sources[0].source, sources[0].name).map(({ underline: _, ...line }) => ({
      ...line,
      hasUnderline: false,
      underlineStyle: "",
    })),
    lineCount: lineCountOf(sources[0].source),
    caretLine: "transform: translateY(1rem)",
    preview: 0,
    previewSelected: false,
    completion: { isOpen: false, style: "", isAbove: false, items: [] },
    logs: [],
    diagnostic: "",
    hasError: false,
  };
  return { props: { data } };
};
