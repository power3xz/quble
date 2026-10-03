// 같은 fixture를 qubb 런타임과 React 산출로 각각 그리는 테스트 헬퍼.
import "./dom.ts";

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QubleRoot, type THandlerCtx, type THandlers } from "quble-react";
import { act, createElement, type FC } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { compile, type THandlers as TQubbHandlers } from "../../../../core/web/runtime.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // experiments/react/runtime/test-helpers
const EXPERIMENT = join(HERE, "..", "..");
const REPO = join(EXPERIMENT, "..", "..");
const QUBLE_BIN = join(REPO, "core", "target", "debug", "quble");
const QUBLE_REACT_BIN = join(EXPERIMENT, "cli", "target", "debug", "quble-react");
// 생성물은 이 실험의 dist/ 아래에 둔다. 거기서 위로 올라가며 react와 quble-react(이 패키지 자신)를 찾는다.
const OUT_DIR = join(EXPERIMENT, "dist", "fixtures");

// 이 실험의 fixture가 먼저, 없으면 레포의 components/<이름>.fixture.qubc.
const fixturePath = (fixture: string): string => {
  const own = join(EXPERIMENT, "fixtures", `${fixture}.qubc`);
  return existsSync(own) ? own : join(REPO, "components", `${fixture}.fixture.qubc`);
};

const buildQubb = (fixture: string): Uint8Array => {
  const out = join(OUT_DIR, "qubb");
  execFileSync(QUBLE_BIN, [fixturePath(fixture), "--out-dir", out], { stdio: ["ignore", "ignore", "inherit"] });
  const stem = fixturePath(fixture)
    .split("/")
    .at(-1)
    ?.replace(/\.qubc$/, "");
  return new Uint8Array(readFileSync(join(out, `${stem}.qubb`)));
};

// 핸들러 표. 두 런타임에 같은 표를 넘긴다 - ctx의 이름(get/set/props/context)이 같다.
export type TAnyHandlers = THandlers;

type TValues = Record<string, unknown>;

const appendHost = (): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  return host;
};

export const renderQubb = (fixture: string, values: unknown, handlers: TAnyHandlers): HTMLElement => {
  const inst = compile(buildQubb(fixture))(0)(values, handlers as unknown as TQubbHandlers);
  const host = appendHost();
  host.append(...inst.nodes);
  return host;
};

// quble-react로 OUT_DIR/<fixture>.tsx를 내고 그 내용을 돌려준다. 리소스 import가 그 위치 기준이다.
const reactTsx = (fixture: string): string => {
  const file = join(OUT_DIR, `${fixture}.tsx`);
  execFileSync(QUBLE_REACT_BIN, [fixturePath(fixture), "--out", file], { stdio: ["ignore", "ignore", "inherit"] });
  return readFileSync(file, "utf8");
};

// 산출 TSX를 strict로 타입 검사해 오류 메시지를 돌려준다.
export const typeErrors = (fixtures: readonly string[]): string[] => {
  const files = fixtures.map((fixture) => {
    reactTsx(fixture);
    return join(OUT_DIR, `${fixture}.tsx`);
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
