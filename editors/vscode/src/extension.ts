// 확장이 하는 일은 둘이다.
//
// 1. ts-plugin 등록(package.json의 typescriptServerPlugins)과 wasm 경로 전달. .qubc 컴포넌트의
//    핸들러 타입은 plugin이 편집 중인 handlers.ts에 얹는다(editors/ts-plugin).
// 2. `.qubc` 컴파일 진단을 인라인으로 표시. LSP 서버를 세우지 않고 여기서 직접 컴파일한다 -
//    지금 필요한 게 밑줄뿐이라(정의로 이동/자동완성이 붙으면 그때 서버로 옮긴다).
//
// plugin은 tsserver 안에서 돌아 자기가 어디 설치됐는지 모른다. 그래서 확장이 .wasm 경로를
// 넘겨야 한다 - 확장에 동봉하므로 레포 위치에 매이지 않는다.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCompilerSync } from "quble-wasm-compiler/node-sync.ts";
import * as vscode from "vscode";
import { collectSources } from "./sources.ts";

// 번들이 CJS라 import.meta.url이 비어 패키지 기본값(wasmPath())을 못 쓴다 - 빌드가 dist/에
// 복사해 둔 것을 __dirname으로 짚는다.
const WASM = join(__dirname, "compiler_wasm.wasm");

// 편집 중에 매 키 입력마다 컴파일하지 않도록 미루는 시간.
const DEBOUNCE_MS = 300;

// 진단용 출력 채널 - "출력" 패널에서 Quble 선택. 실패 원인을 여기에 찍는다.
const log = vscode.window.createOutputChannel("Quble");

/**
 * ts-plugin에 wasm 경로를 넘긴다. 내장 TS 확장이 이 API를 통해 설정을 전달한다.
 *
 * 이 설정은 tsserver가 파일을 연 뒤에 도착할 수 있다(확장 activate가 그보다 늦다) - plugin이
 * 그 경우를 처리한다.
 */
const configureTsPlugin = async () => {
  const ts = vscode.extensions.getExtension("vscode.typescript-language-features");
  if (ts === undefined) {
    log.appendLine("TS 확장을 찾지 못해 핸들러 타입 주입이 꺼집니다.");
    return;
  }
  await ts.activate();
  const api = ts.exports?.getAPI?.(0);
  if (api?.configurePlugin === undefined) {
    log.appendLine(`TS 확장 API를 쓸 수 없습니다(exports=${typeof ts.exports}, api=${typeof api}).`);
    return;
  }
  // package.json의 typescriptServerPlugins에 적은 이름과 같아야 한다.
  api.configurePlugin("quble-ts-plugin", { wasmPath: WASM });
  log.appendLine(`ts-plugin에 wasm 경로를 넘겼습니다: ${WASM}`);
};

// wasm은 한 번만 인스턴스화해 들고 쓴다. 첫 .qubc를 열 때까지 미룬다 - .qubc를 안 여는
// 세션에서는 로드하지 않는다.
let compiler: ReturnType<typeof loadCompilerSync> | null = null;

const getCompiler = () => {
  compiler ??= loadCompilerSync(WASM);
  return compiler;
};

/**
 * 절대경로의 소스를 읽는다. 열려 있는 문서면 저장 안 된 편집 내용을 쓴다 - 디스크만 보면
 * 방금 고친 줄이 아니라 저장된 줄에 밑줄이 걸린다.
 */
const readSource = (absolutePath: string) => {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === absolutePath);
  if (open !== undefined) {
    return open.getText();
  }
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
};

/**
 * 진단이 가리키는 파일의 Uri. path는 엔트리면 절대경로, use 대상이면 소스에 적힌 이름이다
 * (collectSources가 그렇게 키를 붙인다) - 후자는 엔트리 기준으로 푼다.
 */
const uriFor = (entry: vscode.Uri, path: string) =>
  path === entry.fsPath ? entry : vscode.Uri.joinPath(entry, "..", path);

/** 열린 .qubc 문서를 컴파일해 진단을 갱신한다. 성공이면 비운다. */
const refreshDiagnostics = (doc: vscode.TextDocument, collection: vscode.DiagnosticCollection) => {
  if (doc.languageId !== "quble") {
    return;
  }
  collection.clear();

  let found: ReturnType<ReturnType<typeof loadCompilerSync>["diagnose"]>;
  try {
    const files = collectSources(doc.uri.fsPath, readSource);
    found = getCompiler().diagnose(files, doc.uri.fsPath);
  } catch (e) {
    log.appendLine(`진단 실패(${doc.uri.fsPath}): ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (found === null) {
    return;
  }

  const range = new vscode.Range(
    found.start.line,
    found.start.column,
    found.end.line,
    found.end.column,
  );
  const diagnostic = new vscode.Diagnostic(range, found.message, vscode.DiagnosticSeverity.Error);
  diagnostic.source = "quble";
  collection.set(uriFor(doc.uri, found.path), [diagnostic]);
};

/** 마지막 호출만 ms 뒤에 실행한다. 앞선 예약은 취소된다. */
const debounce = <T>(fn: (arg: T) => void, ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  return (arg: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(arg), ms);
  };
};

export const activate = (context: vscode.ExtensionContext) => {
  void configureTsPlugin();

  const collection = vscode.languages.createDiagnosticCollection("quble");
  const refresh = (doc: vscode.TextDocument) => refreshDiagnostics(doc, collection);
  const refreshSoon = debounce(refresh, DEBOUNCE_MS);

  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refreshSoon(e.document)),
    // 닫힌 문서의 밑줄은 남으면 안 된다 - 진단은 엔트리 하나분이라 통째로 지운다.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === "quble") {
        collection.clear();
      }
    }),
  );

  // 확장이 켜지기 전에 열려 있던 문서는 onDidOpen을 안 탄다.
  for (const doc of vscode.workspace.textDocuments) {
    refresh(doc);
  }
};
