// .qubc 컴포넌트의 핸들러 타입을 짝 `.qubc.d.ts`(Handlers)로 생성한다. handlers.ts가
// `import type { Handlers } from './x.qubc'`로 받아 fullname/payload/props/context를 타입으로 강제한다.
// 생성 시점(둘 다): handlers.ts를 열 때 + .qubc를 저장할 때(소스 변경 반영).
//
// 타입은 wasm 컴파일러가 낸다 - 바이너리를 띄우지 않아 레포 위치에 매이지 않고, 확장에 .wasm을
// 동봉하면 어느 프로젝트에서든 돈다. 바이너리는 경로를 받아 디스크에서 use를 풀었지만 wasm은
// 소스를 받으므로, use 그래프를 여기서 읽어 넘긴다.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadCompiler, type TSourceFiles } from "quble-wasm-compiler/node.ts";
import * as vscode from "vscode";

// 번들이 CJS라 import.meta.url이 비어 패키지 기본값(wasmPath())을 못 쓴다 - 빌드가 dist/에
// 복사해 둔 것을 __dirname으로 짚는다.
const WASM = join(__dirname, "compiler_wasm.wasm");

// 진단용 출력 채널 - "출력" 패널에서 Quble 선택. 실패 원인을 여기에 찍는다.
const log = vscode.window.createOutputChannel("Quble");

// wasm은 한 번만 인스턴스화해 들고 쓴다. 처음 필요할 때 받고 그 뒤로는 같은 promise를 준다.
let ready: ReturnType<typeof loadCompiler> | null = null;
const getCompiler = () => {
  ready ??= loadCompiler(WASM);
  return ready;
};

// `use "./x.css"` / `use Name from "./x.qubc"` - 둘 다 등록해야 한다(css도 loader를 탄다).
const USE = /^\s*use\s+(?:\w+\s+from\s+)?"([^"]+)"/gm;

/**
 * 엔트리와 그 use 그래프를 읽어 (경로 -> 소스) 맵으로 만든다. 키는 엔트리 기준 상대경로 -
 * wasm loader가 `./` 접두만 떼고 이름으로 맞추므로 소스에 적힌 그대로여야 한다.
 *
 * 읽기 실패한 파일은 건너뛴다 - 컴파일러가 그 자리에서 진단을 내는 게 낫다.
 */
const collectSources = (entryPath: string): TSourceFiles => {
  const files: TSourceFiles = {};
  const entryName = "entry.qubc";

  const visit = (absolute: string, name: string) => {
    if (files[name] !== undefined) {
      return;
    }
    let source: string;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      return;
    }
    files[name] = source;
    for (const [, target] of source.matchAll(USE)) {
      const child = target.replace(/^\.\//, "");
      visit(resolve(dirname(absolute), target), child);
    }
  };

  visit(entryPath, entryName);
  return files;
};

/** 짝 .qubc -> `x.qubc.d.ts`를 생성/갱신한다. 실패는 로그로 남긴다(소스가 미완성일 수 있음). */
const writeDts = async (qubcPath: string) => {
  try {
    const compiler = await getCompiler();
    const result = compiler.handlersDts(collectSources(qubcPath), "entry.qubc");
    if (!result.ok) {
      log.appendLine(`${qubcPath}: ${result.diagnostic}`);
      return;
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.file(`${qubcPath}.d.ts`), new TextEncoder().encode(result.dts));
  } catch (e) {
    log.appendLine(`${qubcPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

export const activate = (context: vscode.ExtensionContext) => {
  const onDocument = (document: vscode.TextDocument) => {
    const file = document.fileName;
    if (file.endsWith(".qubc.handlers.ts")) {
      // 핸들러 파일을 열면 짝 .qubc로 d.ts를 준비한다.
      void writeDts(file.replace(/\.handlers\.ts$/, ""));
    } else if (file.endsWith(".qubc")) {
      // 소스를 저장하면 짝 d.ts를 갱신한다.
      void writeDts(file);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(onDocument),
    vscode.workspace.onDidSaveTextDocument(onDocument),
  );
  // 활성화 시 이미 열려 있는 핸들러 파일도 한 번 처리한다.
  vscode.workspace.textDocuments.forEach(onDocument);
};
