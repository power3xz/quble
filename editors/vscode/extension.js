// PoC: *.handler.ts 에서 문자열 자동완성 시 fullname 이벤트명을 띄운다.
// 지금은 fullname 목록을 하드코딩 - 컴파일러가 합성 트리를 걸어 산출하는 단계는 이후.

const vscode = require("vscode");

// 하드코딩 fullname 후보 (litprofilecard 트리 기준 예시).
const FULLNAMES = [
  "MainThumb.HOVER",
  "MainThumb.LEAVE",
  "OPEN_PROFILE",
  "BIO_SCROLL",
  "Thumb.CLICK",
];

const provider = {
  provideCompletionItems(document) {
    if (!document.fileName.endsWith(".handler.ts")) {
      return undefined;
    }
    return FULLNAMES.map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Event);
      // 따옴표 안에서 트리거되므로 이름만 삽입한다.
      item.insertText = name;
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
