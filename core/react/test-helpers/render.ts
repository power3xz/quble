// 같은 fixture를 qubb 런타임과 React 산출로 각각 그리는 테스트 헬퍼.
import "./dom.ts";

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QubleRoot, type THandlerCtx, type THandlers } from "quble-react";
import { act, createElement, type FC } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { compile, type THandlers as TQubbHandlers } from "../../web/runtime.ts";
import { buildFixture } from "../../web/test-helpers/build.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/react/test-helpers
const CORE = join(HERE, "..", "..");
const QUBLE_REACT_BIN = join(CORE, "target", "debug", "quble-react");
const COMPONENTS = join(CORE, "..", "components");
// 변환한 모듈은 core/ 아래에 둔다 - 거기서 위로 올라가며 react와 quble-react를 찾는다.
const OUT_DIR = join(CORE, "dist", "react-fixtures");

// 핸들러 표. 두 런타임에 같은 표를 넘긴다 - ctx의 이름(get/set/props/context)이 같다.
export type TAnyHandlers = THandlers;

type TValues = Record<string, unknown>;

const appendHost = (): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  return host;
};

export const renderQubb = (fixture: string, values: unknown, handlers: TAnyHandlers): HTMLElement => {
  const inst = compile(buildFixture(fixture))(0)(values, handlers as unknown as TQubbHandlers);
  const host = appendHost();
  host.append(...inst.nodes);
  return host;
};

export const reactTsx = (fixture: string): string =>
  execFileSync(QUBLE_REACT_BIN, [join(COMPONENTS, `${fixture}.fixture.qubc`)], { encoding: "utf8" });

// 산출 TSX를 strict로 타입 검사해 오류 메시지를 돌려준다. 파일은 OUT_DIR에 둔다 - 거기서
// quble-react와 react의 타입을 찾는다.
export const typeErrors = (fixtures: readonly string[]): string[] => {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = fixtures.map((fixture) => {
    const file = join(OUT_DIR, `${fixture}.tsx`);
    writeFileSync(file, reactTsx(fixture));
    return file;
  });
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    allowImportingTsExtensions: true,
    types: ["node"],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
};

// quble-react로 TSX를 내고 JS로 바꿔 싣는다. 루트는 모듈의 첫 컴포넌트다(qubb의 ID 0).
const loadReact = async (fixture: string): Promise<FC<TValues>> => {
  const tsx = reactTsx(fixture);
  const js = ts.transpileModule(tsx, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${fixture}.mjs`);
  writeFileSync(file, js);
  const root = /export const (\w+)/.exec(tsx)?.[1];
  if (!root) {
    throw new Error(`${fixture}: 컴포넌트가 없다`);
  }
  // 같은 fixture를 다시 실어도 새로 읽게 쿼리를 붙인다.
  const mod = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return mod[root];
};

export const renderReact = async (fixture: string, values: TValues, handlers: TAnyHandlers): Promise<HTMLElement> => {
  const component = await loadReact(fixture);
  const host = appendHost();
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(QubleRoot<TValues>, { component, initial: values, handlers }));
  });
  return host;
};

export const click = async (host: HTMLElement, selector: string, index = 0) => {
  const target = host.querySelectorAll(selector)[index];
  if (!target) {
    throw new Error(`${selector}[${index}] 없음`);
  }
  await act(async () => {
    target.dispatchEvent(new Event("click", { bubbles: true }));
  });
};

// qubb는 @if 자리에 주석 앵커를 둔다. 화면에 안 보이는 것이라 빼고 비교한다.
export const html = (host: HTMLElement): string => host.innerHTML.replace(/<!--.*?-->/g, "");

// 어떤 fullname이 오든 (fullname, data, context, 회차 번호 $N)를 적어 두는 핸들러 표.
// extra에 있는 fullname은 적은 뒤 그 핸들러도 부른다.
export const recorder = (extra: TAnyHandlers = {}) => {
  const calls: { fullname: string; data: unknown; context: unknown; loops: Record<string, unknown> }[] = [];
  const handlers = new Proxy(extra, {
    get: (target, key) => {
      if (typeof key !== "string") {
        return undefined;
      }
      return (data: TValues, ctx: THandlerCtx) => {
        const loops = Object.fromEntries(Object.entries(ctx).filter(([name]) => name.startsWith("$")));
        calls.push({ fullname: key, data: structuredClone(data), context: structuredClone(ctx.context), loops });
        target[key]?.(data, ctx);
      };
    },
  });
  return { calls, handlers };
};
