// .qubc 컴포넌트의 핸들러 타입을 짝 `.qubc.d.ts`(Handlers)로 생성한다. handlers.ts가
// `import type { Handlers } from './x.qubc'`로 받아 fullname·payload·props·context를 타입으로 강제한다.
// 생성 시점(둘 다): handlers.ts를 열 때 + .qubc를 저장할 때(소스 변경 반영).
// 짝 .qubc를 quble-dts가 AST에서 걸어 .d.ts 텍스트로 낸다(props 이름은 바이트코드에 없어 소스에서 뽑는다).

const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

// 레포 내 고정 위치 - 워크스페이스 루트 기준 상대경로(PoC. 나중에 설정으로 뺀다).
const DTS_BIN_REL = "core/target/debug/quble-dts";

// 진단용 출력 채널 - "출력" 패널에서 Quble 선택. 실패 원인을 여기에 찍는다.
const log = vscode.window.createOutputChannel("Quble");

/** 짝 .qubc -> `x.qubc.d.ts`를 생성/갱신한다. 컴파일 실패는 로그로 남긴다(소스가 미완성일 수 있음). */
const writeDts = (qubcPath) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    log.appendLine("workspaceFolders 없음 - 워크스페이스로 폴더를 열었는지 확인");
    return;
  }
  try {
    const dts = execFileSync(path.join(root, DTS_BIN_REL), [qubcPath]);
    fs.writeFileSync(qubcPath + ".d.ts", dts);
  } catch (e) {
    log.appendLine(`${qubcPath}: ${e && e.message ? e.message : e}`);
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
