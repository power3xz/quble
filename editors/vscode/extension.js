// *.qubc.handlers.ts 에서 자동완성 시 짝 .qubc의 이벤트 fullname을 띄우고,
// 선택하면 핸들러 시그니처(payload/context 타입)까지 펼친다.
// 짝 .qubc를 컴파일러(quble-bytecode)로 qubb 바이트로 만들고, disasm.js로 산출한다.

const vscode = require("vscode");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// 레포 내 고정 위치 - 워크스페이스 루트 기준 상대경로(PoC. 나중에 설정으로 뺀다).
const COMPILER_REL = "proto/target/debug/quble-bytecode";
const DISASM_REL = "proto/web/disasm.js";

/** handlers.ts 문서 -> 짝 .qubc 절대경로. `foo.qubc.handlers.ts` -> `foo.qubc`. */
const pairedQubc = (document) => document.fileName.replace(/\.handlers\.ts$/, "");

/** 짝 .qubc를 컴파일+디코드해 이벤트 목록(fullname/payload/contexts)을 낸다. 실패 시 빈 배열. */
const eventsFor = async (document) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return [];
  }
  const qubcPath = pairedQubc(document);
  const qubb = execFileSync(path.join(root, COMPILER_REL), [qubcPath]);
  const { inspect, collectEventFullnames } = await import(path.join(root, DISASM_REL));
  const { module } = inspect(qubb);
  return collectEventFullnames(module, 0);
};

/** 필드 출처 -> TS 타입. 리터럴은 그 값으로 좁히고(literal type), 변수는 string. */
const fieldType = (source) => (source.kind === "lit" ? JSON.stringify(source.value) : "string");

/** {field, source} 목록 -> `a: T; b: U` 객체 본문. */
const fieldsType = (fields) => fields.map((f) => `${f.field}: ${fieldType(f.source)}`).join("; ");

/** 이벤트 -> 핸들러 시그니처 스니펫. 여는·닫는 따옴표를 스니펫이 통째로 책임진다(provider가
 *  기존 따옴표를 range로 덮어쓴다). payload·context 필드 타입은 같은 규칙(리터럴은 좁힘). */
const signatureSnippet = (event) => {
  const dataParam = `data: { ${fieldsType(event.payload)} }`;
  if (event.contexts.length === 0) {
    return `'${event.fullname}': (${dataParam}) => {\n\t$0\n}`;
  }
  const ctx = event.contexts.map((c) => `${c.name}: { ${fieldsType(c.fields)} }`).join("; ");
  return `'${event.fullname}': (${dataParam}, { context }: { context: { ${ctx} } }) => {\n\t$0\n}`;
};

const provider = {
  async provideCompletionItems(document, position) {
    if (!document.fileName.endsWith(".qubc.handlers.ts")) {
      return undefined;
    }
    // 스니펫이 따옴표를 통째로 넣으므로, 이미 입력된 따옴표(앞/뒤)는 교체 범위에 넣어 덮어쓴다.
    // 이러면 `'` 입력 후 선택과 Trigger Suggest(따옴표 없음)가 같은 결과를 낸다.
    const isQuote = (s) => s === "'" || s === '"';
    const before = position.character > 0
      ? document.getText(new vscode.Range(position.translate(0, -1), position))
      : "";
    const after = document.getText(new vscode.Range(position, position.translate(0, 1)));
    const start = isQuote(before) ? position.translate(0, -1) : position;
    const end = isQuote(after) ? position.translate(0, 1) : position;
    const replace = new vscode.Range(start, end);

    const events = await eventsFor(document);
    return events.map((event) => {
      const item = new vscode.CompletionItem(event.fullname, vscode.CompletionItemKind.Event);
      // 선택하면 핸들러 시그니처(따옴표 포함)까지 펼친다.
      item.insertText = new vscode.SnippetString(signatureSnippet(event));
      item.range = replace;
      // "0_" 접두사로 TS 기본 제안보다 위로 끌어온다(우리끼린 fullname 순서 유지).
      item.sortText = "0_" + event.fullname;
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
