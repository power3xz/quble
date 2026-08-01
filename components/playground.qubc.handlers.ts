// playground 셸의 핸들러. 파일을 고르면 편집기에 그 내용을 싣고, .qubc의 run 버튼을 누르면
// wasm으로 컴파일해 오른쪽(#preview)에 두 번째 quble 인스턴스를 마운트한다.
//
// fullname의 `Row[$0].`은 FileRow가 @for 안에서 별칭 Row로 합성되기 때문이다. $0가 몇 번째
// 파일인지 준다.
//
// 미리보기는 run을 눌러야 바뀐다 - 편집 중에는 오른쪽이 그대로다.
//
// 소스를 quble 상태가 아니라 여기 캐시(sources)에 두는 이유가 둘이다:
//   1. 컴파일은 모든 파일의 내용이 필요한데 핸들러가 받는 props는 자기 회차 요소뿐이고,
//      루트 store에서 배열 요소로 내려가는 경로가 없다(ISSUES).
//   2. 타이핑마다 set하면 TEXT_VAR 구독이 값 비교 없이 textContent를 덮어써 커서가 튄다.
// 그래서 편집 중에는 캐시만 갱신하고, 파일을 바꿀 때만 lines를 set한다(그때는 갱신이 맞다).

import { compile as decodeQubb, type THandlers } from "../core/web/runtime.ts";
import { lazyCompiler } from "../core/web/wasm-compiler.ts";
import { parseDiagnostic, type TDiagnostic } from "./diagnostic.ts";
import { markError, tokenize } from "./tokenize.ts";

export { tokenize };

type TStore = {
  files: number;
  lines: number;
  editingName: number;
  lineNumbers: number;
  lineCount: number;
  caretLine: number;
  previewName: number;
  previewSelected: number;
  logs: number;
  diagnostic: number;
  hasError: number;
};
type TCtx = {
  props: Record<string, number>;
  store: TStore;
  set: (leafIndex: number, value: unknown) => void;
  push: (arrayLeafIndex: number, element: unknown) => void;
  removeAt: (arrayLeafIndex: number, index: number) => void;
  replace: (arrayLeafIndex: number, elems: unknown[]) => void;
  event: Event;
  $0: number;
};

// 미리보기를 눌러야 쓰이므로 첫 화면에서는 받지 않는다 - 처음 컴파일할 때 받는다.
const getCompiler = lazyCompiler("./compiler_wasm.wasm");

// 파일 이름 순서(트리와 같은 순서)와 그 내용. 부트스트랩이 초기 data로 채운다.
const fileNames: string[] = [];
const sources = new Map<string, string>();

// 지금 편집 중인 파일과 화면에 반영된 줄 수. 줄 수가 그대로면 갱신을 건너뛴다.
let currentName: string | null = null;

let shownLines = 0;

// 마지막 컴파일 에러의 위치. 편집기가 그 파일을 싣고 있을 때만 줄 표시가 뜬다 - 다른 파일에서
// 난 에러는 표시할 자리가 없어 패널에만 남고, 그 패널을 누르면 그 파일로 이동한다.
// 파일 목록의 에러 표시는 이 값과 파일 이름을 맞춰 켠다(에러가 난 파일이 편집 중이 아니어도 보인다).
let failure: TDiagnostic | null = null;

// 파일 목록을 다시 그린다 - 에러 표시(hasError)만 바뀌므로 개수는 늘 그대로다. replace가 개수가
// 같으면 요소 자리를 지키므로, 행들이 들고 있는 leafIndex(moveFlag가 보관한 것)가 그대로 유효하다.
//
// 행 하나만 켜면 되는데 목록 전체를 넘기는 이유: 에러가 난 파일은 클릭된 적이 없을 수 있어
// 그 행의 leafIndex를 모른다(배열 요소를 이름으로 못 짚는다 - ISSUES).
const refreshFiles = ({ store, replace }: Pick<TCtx, "store" | "replace">) => {
  replace(
    store.files,
    fileNames.map((name) => ({
      name,
      isEntry: name.endsWith(".qubc"),
      isEditing: name === currentName,
      isPreviewing: name === previewingName,
      hasError: failure?.path === name,
    })),
  );
};

// 지금 미리보기 중인 파일 - 목록을 다시 그릴 때 표시를 되살리려면 이름으로 들고 있어야 한다.
let previewingName: string | null = null;

/** 줄 수. 거터의 번호 개수이자 textarea의 rows다 - 둘이 같아야 번호가 코드와 맞는다. */
export const lineCountOf = (text: string) => text.split("\n").length;

/** 거터에 넣을 줄 번호 - 1부터 줄 수까지. */
export const lineNumbersFor = (text: string) =>
  Array.from({ length: lineCountOf(text) }, (_, i) => String(i + 1)).join("\n");

/** 초기 data를 캐시에 심는다. 부트스트랩이 mount 전에 부른다. 첫 파일이 편집기에 실린 채로
 * 시작하므로 그 파일을 지금 편집 중인 것으로 둔다. */
export const seed = (files: { name: string; source: string }[]) => {
  files.forEach((f) => {
    fileNames.push(f.name);
    sources.set(f.name, f.source);
  });
  currentName = files[0]?.name ?? null;
  shownLines = lineCountOf(files[0]?.source ?? "");
};

// 지금 미리보기 중인 인스턴스와 그때 만든 Blob URL들 - 다시 컴파일할 때 정리한다.
let preview: { destroy: () => void; nodes: Node[] } | null = null;
let previewUrls: string[] = [];

const clearPreview = () => {
  preview?.destroy();
  preview = null;
  for (const url of previewUrls) {
    URL.revokeObjectURL(url);
  }
  previewUrls = [];
};

// 콘솔 - 미리보기 앱이 부른 console.*를 셸의 logs 배열에 쌓는다. logs의 leafIndex는 핸들러가
// 불려야 알 수 있어(ctx.store), 처음 받을 때 여기 담아 두고 가로채기가 쓴다. 그전에 난 로그는
// pending에 모았다가 주소가 생기면 흘려보낸다.
type TLogSink = { push: TCtx["push"]; leafIndex: number };
let logSink: TLogSink | null = null;
let loggedCount = 0;
const pendingLogs: { level: string; text: string }[] = [];

const rememberSink = ({ store, push }: TCtx) => {
  if (logSink) {
    return;
  }
  logSink = { push, leafIndex: store.logs };
  for (const entry of pendingLogs.splice(0)) {
    logSink.push(logSink.leafIndex, entry);
    loggedCount++;
  }
};

const appendLog = (level: string, text: string) => {
  if (!logSink) {
    pendingLogs.push({ level, text });
    return;
  }
  logSink.push(logSink.leafIndex, { level, text });
  loggedCount++;
  scrollLogsToEnd();
};

// 새 로그가 붙으면 콘솔을 맨 아래로. DOM이 붙은 뒤여야 스크롤 높이가 잡히므로 다음 프레임에.
const scrollLogsToEnd = () => {
  requestAnimationFrame(() => {
    const body = document.querySelector(".pg__console-body");
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  });
};

const installConsoleCapture = () => {
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      appendLog(
        level,
        args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" "),
      );
    };
  }
};

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

installConsoleCapture();

// 편집기에 텍스트를 싣는다. 화면(.pg__view)/거터/rows는 quble이 그리고, textarea의 value만
// 여기서 직접 쓴다 - textarea는 uncontrolled라 quble이 값을 바인딩할 수 없다(playground.css).
const showText = (text: string, { store, set, replace }: Pick<TCtx, "store" | "set" | "replace">) => {
  const lines = tokenize(text, currentName ?? "");
  // 에러 줄 표시는 그 에러가 난 파일을 싣고 있을 때만.
  replace(
    store.lines,
    failure && failure.path === currentName
      ? markError(lines, failure.line, failure.message)
      : lines,
  );

  const count = lineCountOf(text);
  if (count !== shownLines) {
    shownLines = count;
    set(store.lineNumbers, lineNumbersFor(text));
    set(store.lineCount, count);
  }
};

// 편집기에 파일 하나를 싣는다. caretLine은 커서를 둘 줄(1부터), 0이면 맨 앞.
const openFile = (name: string, ctx: TCtx, caretLine = 0) => {
  currentName = name;
  const text = sources.get(name) ?? "";
  ctx.set(ctx.store.editingName, name);
  refreshFiles(ctx);
  showText(text, ctx);

  const area = document.querySelector<HTMLTextAreaElement>(".pg__area");
  if (!area) {
    return;
  }
  area.value = text;
  // 줄머리 오프셋 - 앞 줄들의 길이 합에 그 사이 개행 수를 더한다.
  const before = text.split("\n").slice(0, Math.max(0, caretLine - 1));
  area.selectionStart = area.selectionEnd = before.length
    ? before.join("").length + before.length
    : 0;
  trackCaret(area, ctx);
};

// 파일 선택 - 그 행이 쏜 이벤트라 $0가 몇 번째 파일인지 준다.
const selectFile = (_data: unknown, ctx: TCtx) => openFile(fileNames[ctx.$0], ctx);

// 진단을 눌러 에러가 난 파일의 그 줄로 간다. 다른 파일에서 난 에러(use로 딸려온 파일)는
// 편집기에 표시할 자리가 없어 이게 유일한 이동 수단이다.
const jumpToError = (_data: unknown, ctx: TCtx) => {
  if (!failure || !fileNames.includes(failure.path)) {
    return;
  }
  openFile(failure.path, ctx, failure.line);
  document.querySelector<HTMLTextAreaElement>(".pg__area")?.focus();
};

// 편집 - textarea의 값이 원본이다. 화면과 캐시를 거기에 맞춘다(value는 이미 사용자가 쳤다).
const editSource = (_data: unknown, ctx: TCtx) => {
  if (!currentName) {
    return;
  }
  const area = ctx.event.target as HTMLTextAreaElement;
  sources.set(currentName, area.value);
  showText(area.value, ctx);
  trackCaret(area, ctx);
};

// 커서만 움직인 경우(화살표/클릭) - 내용은 그대로고 강조와 스크롤만 따라간다.
// 다음 프레임에 읽는다: keydown/click 시점에는 브라우저가 아직 커서를 옮기기 전이다.
const followCaret = (_data: unknown, ctx: TCtx) => {
  const area = ctx.event.target as HTMLTextAreaElement;
  requestAnimationFrame(() => trackCaret(area, ctx));
};

// 커서가 있는 줄로 강조 막대를 옮기고, 커서가 화면 밖이면 보이도록 최소한만 스크롤한다.
//
// 스크롤을 직접 하는 이유: 실제 스크롤은 .pg__code가 갖고 textarea는 overflow:hidden이라(거터와
// 어긋나지 않으려고) 커서를 보이게 유지하는 브라우저 기본 동작이 발동하지 않는다. 부모는 커서
// 위치를 모르므로 여기서 계산해 넣는다. 위치는 폰트가 monospace라 줄 높이 x 줄, 글자 폭 x 열이다.
const trackCaret = (area: HTMLTextAreaElement, { store, set }: Pick<TCtx, "store" | "set">) => {
  const code = area.closest<HTMLElement>(".pg__code");
  if (!code) {
    return;
  }

  const before = area.value.slice(0, area.selectionStart);
  const lastBreak = before.lastIndexOf("\n");
  const line = lastBreak === -1 ? 0 : before.slice(0, lastBreak).split("\n").length;
  const column = before.length - (lastBreak + 1);

  const style = getComputedStyle(area);
  const lineH = parseFloat(style.lineHeight);
  const top = parseFloat(style.paddingTop) + line * lineH;

  // 선택 중에는 강조를 숨긴다 - 선택 영역과 겹쳐 어느 쪽이 무엇인지 읽기 어렵다.
  const selecting = area.selectionStart !== area.selectionEnd;
  set(store.caretLine, selecting ? "display: none" : `transform: translateY(${top}px)`);

  if (top < code.scrollTop) {
    code.scrollTop = top;
  } else if (top + lineH > code.scrollTop + code.clientHeight) {
    code.scrollTop = top + lineH - code.clientHeight;
  }

  // 가로: 거터가 sticky로 왼쪽을 덮으므로 그 폭만큼 더 확보해야 커서가 거터 뒤에 숨지 않는다.
  const gutter = code.querySelector<HTMLElement>(".pg__gutter")?.offsetWidth ?? 0;
  const x = area.getBoundingClientRect().left - code.getBoundingClientRect().left
    + code.scrollLeft + column * charWidth(style.font);
  if (x - gutter < code.scrollLeft) {
    code.scrollLeft = Math.max(0, x - gutter);
  } else if (x > code.scrollLeft + code.clientWidth - CARET_MARGIN) {
    code.scrollLeft = x - code.clientWidth + CARET_MARGIN;
  }
};

// 커서가 오른쪽 끝에 딱 붙지 않도록 남기는 여백(px).
const CARET_MARGIN = 24;

// monospace 한 글자 폭. 한 글자만 재면 반올림 오차가 열 수만큼 누적되므로 여럿을 재서 나눈다.
let cachedCharWidth = 0;
const charWidth = (font: string) => {
  if (!cachedCharWidth) {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(CHAR_SAMPLE);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.style.font = font;
    document.body.appendChild(probe);
    cachedCharWidth = probe.getBoundingClientRect().width / CHAR_SAMPLE;
    probe.remove();
  }
  return cachedCharWidth;
};

const CHAR_SAMPLE = 100;

// 로그 비우기 - 뒤에서부터 지운다(앞에서 지우면 인덱스가 당겨져 어긋난다).
const clearLogs = (_data: unknown, { store, removeAt }: TCtx) => {
  for (let i = loggedCount - 1; i >= 0; i--) {
    removeAt(store.logs, i);
  }
  loggedCount = 0;
};

// 미리보기 - 모든 파일을 등록하고 이 .qubc를 엔트리로 컴파일한다. 핸들러/data는 엔트리와
// 짝인 것만 쓴다(합성 맥락마다 로직이 달라 합치지 않는다).
//
// 편집기에도 그 파일을 싣는다 - 미리보기와 편집 대상이 다르면 어느 소스가 화면에 그려진
// 것인지 알 수 없다.
const runPreview = async (_data: unknown, ctx: TCtx) => {
  const { $0, store, set } = ctx;
  // 진단을 기억해 두고 편집기와 파일 목록을 다시 그린다 - 에러가 이 파일에 있으면 그 줄이
  // 강조되고, 어느 파일이든 목록의 그 행에 표시가 붙는다.
  const fail = (message: string) => {
    set(store.diagnostic, message);
    set(store.hasError, true);
    failure = parseDiagnostic(message);
    showText(sources.get(currentName ?? "") ?? "", ctx);
    refreshFiles(ctx);
  };

  failure = null;
  selectFile(_data, ctx);

  const entry = fileNames[$0];
  const stem = entry.replace(/\.qubc$/, "");

  // wasm 등록은 컴파일러가 보는 파일만 - .qubc와 .css.
  const files: Record<string, string> = {};
  for (const name of fileNames) {
    if (name.endsWith(".qubc") || name.endsWith(".css")) {
      files[name] = sources.get(name) ?? "";
    }
  }

  const { compile } = await getCompiler();
  const result = compile(files, entry);
  if (!result.ok) {
    fail(result.diagnostic);
    return;
  }

  // 사용자 핸들러는 브라우저에서 모듈로 평가한다(Blob URL + 동적 import).
  const handlersUrl = URL.createObjectURL(
    new Blob([sources.get(`${stem}.qubc.handlers.js`) ?? "export default {}"], {
      type: "text/javascript",
    }),
  );
  let handlers: THandlers = {};
  let initialData: unknown = {};
  try {
    handlers = (await import(/* @vite-ignore */ handlersUrl)).default ?? {};
    initialData = JSON.parse(sources.get(`${stem}.data.json`) || "{}");
  } catch (e) {
    URL.revokeObjectURL(handlersUrl);
    fail(`${(e as Error).message}`);
    return;
  }

  // 여기부터 실패 지점이 없다 - 이전 미리보기를 내리고 새것을 올린다.
  clearPreview();
  previewUrls.push(handlersUrl);
  set(store.diagnostic, "");
  set(store.hasError, false);

  // 리소스 경로(resId 순)를 그 내용의 Blob URL로 - LOAD_RES가 <link>로 단다.
  const resourceUrls = result.resources.map((path) => {
    const url = URL.createObjectURL(
      new Blob([sources.get(path) ?? ""], { type: "text/css" }),
    );
    previewUrls.push(url);
    return url;
  });

  try {
    preview = decodeQubb(result.bytecode, resourceUrls)(0)(initialData, handlers);
    document.getElementById("preview")?.replaceChildren(...preview.nodes);
    set(store.previewName, entry);
    set(store.previewSelected, true);
    previewingName = entry;
    refreshFiles(ctx);
  } catch (e) {
    fail(`mount: ${(e as Error).message}`);
  }
};

// 모든 핸들러를 감싸 콘솔 싱크를 먼저 등록한다 - logs의 leafIndex는 ctx로만 오므로, 어느
// 핸들러든 처음 불릴 때 붙잡아 둔다(그전 로그는 pending에 모였다가 그때 흘러간다).
//
// 예외도 여기서 잡아 콘솔에 남긴다 - 런타임은 핸들러 반환값을 await하지 않아, async 핸들러가
// 실패하면 unhandled rejection으로 조용히 사라진다.
const withSink =
  (handler: (data: unknown, ctx: TCtx) => void | Promise<void>) =>
  (data: unknown, ctx: TCtx) => {
    rememberSink(ctx);
    try {
      handler(data, ctx)?.catch(report);
    } catch (e) {
      report(e);
    }
  };

const report = (e: unknown) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
};

export default {
  "Row[$0].CLICK_FILE": withSink(selectFile),
  "Row[$0].CLICK_PREVIEW": withSink(runPreview),
  INPUT_SOURCE: withSink(editSource),
  KEYDOWN_SOURCE: withSink(followCaret),
  CLICK_SOURCE: withSink(followCaret),
  CLICK_CLEAR_LOGS: withSink(clearLogs),
  CLICK_DIAGNOSTIC: withSink(jumpToError),
};
