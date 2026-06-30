// PoC: *.qubc.handlers.ts 에서 문자열 자동완성 시 fullname 이벤트명을 띄운다.
// 짝 .qubc를 컴파일러(quble-bytecode)로 qubb 바이트로 만들고, disasm.js로 fullname을 산출한다.

const vscode = require("vscode");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// 레포 내 고정 위치 - 워크스페이스 루트 기준 상대경로(PoC. 나중에 설정으로 뺀다).
const COMPILER_REL = "proto/target/debug/quble-bytecode";
const DISASM_REL = "proto/web/disasm.js";

/** handlers.ts 문서 -> 짝 .qubc 절대경로. `foo.qubc.handlers.ts` -> `foo.qubc`. */
const pairedQubc = (document) => document.fileName.replace(/\.handlers\.ts$/, "");

/** 짝 .qubc를 컴파일+디코드해 fullname 목록을 낸다. 실패 시 빈 배열. */
const fullnamesFor = async (document) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return [];
  }
  const qubcPath = pairedQubc(document);
  const qubb = execFileSync(path.join(root, COMPILER_REL), [qubcPath]);
  const { inspect, collectEventFullnames } = await import(path.join(root, DISASM_REL));
  const { module } = inspect(qubb);
  return collectEventFullnames(module, 0).map((e) => e.fullname);
};

const provider = {
  async provideCompletionItems(document) {
    if (!document.fileName.endsWith(".qubc.handlers.ts")) {
      return undefined;
    }
    const fullnames = await fullnamesFor(document);
    return fullnames.map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Event);
      // 따옴표 안에서 트리거되므로 이름만 삽입한다.
      item.insertText = name;
      // "0_" 접두사로 TS 기본 제안보다 위로 끌어온다(우리끼린 fullname 순서 유지).
      item.sortText = "0_" + name;
      return item;
    });
  },
};

const activate = (context) => {
  context.subscriptions.push(
    // 따옴표(' ")를 치면 트리거 - 문자열 키 자리에서 후보가 뜬다.
    vscode.languages.registerCompletionItemProvider("typescript", provider, "'", "\"")
  );
};

module.exports = { activate };
