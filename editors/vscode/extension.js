// .qubc 컴포넌트의 핸들러 타입을 짝 `.qubc.d.ts`(Handlers)로 생성한다. handlers.ts가
// `import type { Handlers } from './x.qubc'`로 받아 키·payload·context를 타입으로 강제한다.
// 생성 시점(둘 다): handlers.ts를 열 때 + .qubc를 저장할 때(소스 변경 반영).
// 짝 .qubc를 컴파일러(quble-bytecode)로 qubb로 만들고 disasm.js로 .d.ts 텍스트를 낸다.

const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

// 레포 내 고정 위치 - 워크스페이스 루트 기준 상대경로(PoC. 나중에 설정으로 뺀다).
const COMPILER_REL = "proto/target/debug/quble-bytecode";
const DISASM_REL = "proto/web/disasm.js";

/** 짝 .qubc -> `x.qubc.d.ts`를 생성/갱신한다. 컴파일/디코드 실패는 무시(소스가 미완성일 수 있음). */
const writeDts = async (qubcPath) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return;
  }
  try {
    const qubb = execFileSync(path.join(root, COMPILER_REL), [qubcPath]);
    const { inspect, handlersDts } = await import(path.join(root, DISASM_REL));
    const { module } = inspect(qubb);
    fs.writeFileSync(qubcPath + ".d.ts", handlersDts(module, 0));
  } catch {
    // 미완성 소스 등 - 조용히 넘긴다(다음 저장 때 다시 시도).
  }
};

const activate = (context) => {
  const onDocument = (document) => {
    const file = document.fileName;
    if (file.endsWith(".qubc.handlers.ts")) {
      // 핸들러 파일을 열면 짝 .qubc로 d.ts를 준비한다.
      writeDts(file.replace(/\.handlers\.ts$/, ""));
    } else if (file.endsWith(".qubc")) {
      // 소스를 저장하면 짝 d.ts를 갱신한다.
      writeDts(file);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(onDocument),
    vscode.workspace.onDidSaveTextDocument(onDocument)
  );
  // 활성화 시 이미 열려 있는 핸들러 파일도 한 번 처리한다.
  vscode.workspace.textDocuments.forEach(onDocument);
};

module.exports = { activate };
