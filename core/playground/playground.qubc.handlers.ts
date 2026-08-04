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

import { lazyCompiler } from "quble-wasm-compiler/browser.ts";
import { compile as decodeQubb, type THandlers } from "../web/runtime.ts";
import { caretTarget } from "./caretkey.ts";
import { entryOf, handlerBody, isKeySlot, usedKeys } from "./completion.ts";
import { parseDiagnostic, type TDiagnostic } from "./diagnostic.ts";
import { markError, tokenize } from "./tokenize.ts";

export { tokenize };

// 헬퍼가 받는 ctx의 타입. 손으로 적지 않고 `handlers`에서 역산한다 - 그 선언에는 ts-plugin이
// 짝 .qubc의 `Partial<Handlers>`를 표기로 붙이므로 주입된 것이 유일한 출처가 된다. 손으로 적으면
// `set`의 `LeafIndex<T>`처럼 주입된 모양과 어긋나 대입 검사에서 걸린다.
//
// 모든 핸들러의 ctx를 합친 유니온이라 회차 인덱스($0, $1...)는 여기 없다 - @for 깊이는 이벤트마다
// 다르다. 그것을 쓰는 헬퍼는 인덱스를 number 인자로 받고, 꺼내는 일은 리터럴의 화살표가 한다.
type TCtx = Parameters<NonNullable<(typeof handlers)[keyof typeof handlers]>>[1];

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
// 그중 스타일시트는 LOAD_RES가 document.head에 <link>로 달아 둔 것이라, URL만 revoke하면
// 죽은 href를 가진 link가 head에 쌓인다. 그래서 떼어낼 대상을 따로 들고 있는다.
let preview: { destroy: () => void; nodes: Node[] } | null = null;
let previewUrls: string[] = [];
let previewLinkedUrls: string[] = [];

const clearPreview = () => {
  preview?.destroy();
  preview = null;
  for (const url of previewLinkedUrls) {
    document.head.querySelector(`link[href="${url}"]`)?.remove();
  }
  previewLinkedUrls = [];
  for (const url of previewUrls) {
    URL.revokeObjectURL(url);
  }
  previewUrls = [];
};

// 콘솔 - 미리보기 앱이 부른 console.*를 셸의 logs 배열에 쌓는다. 로그를 만드는 쪽(가로채기)은
// 미리보기 앱이 부르는 자리라 ctx가 없다 - 넣을 자리(store.logs)와 넣는 법(push)을 아는 것은
// 핸들러뿐이라, 처음 핸들러가 돌 때 그 둘을 담은 함수를 만들어 둔다.
//
// 그전에 난 로그는 pending에 모였다가 함수가 생길 때 흘러간다.
let addLogLine: ((level: string, text: string) => void) | null = null;
let loggedCount = 0;
const pendingLogs: { level: string; text: string }[] = [];

// 로그를 쌓는 함수를 만든다. 넣을 자리를 변수로 꺼내지 않고 클로저에 가둔다 - 그 타입(LeafIndex)은
// 주입된 ctx만 아는 것이라, 밖으로 꺼내면 손으로 적어야 한다.
const openLog = ({ store, push }: TCtx) => {
  if (addLogLine) {
    return;
  }
  addLogLine = (level, text) => {
    push(store.logs, { level, text });
    loggedCount++;
  };
  for (const entry of pendingLogs.splice(0)) {
    addLogLine(entry.level, entry.text);
  }
};

const appendLog = (level: string, text: string) => {
  if (!addLogLine) {
    pendingLogs.push({ level, text });
    return;
  }
  addLogLine(level, text);
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
      appendLog(level, args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" "));
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
    failure && failure.path === currentName ? markError(lines, failure.line, failure.message) : lines,
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
  closeCompletion(ctx);
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
  area.selectionStart = area.selectionEnd = before.length ? before.join("").length + before.length : 0;
  trackCaret(area, ctx);
};

// 파일 선택 - 몇 번째 파일인지는 회차 인덱스로 온다(부르는 쪽이 ctx.$0에서 꺼내 넘긴다).
const selectFile = (at: number, ctx: TCtx) => openFile(fileNames[at], ctx);

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
  // 이 파일이 바뀌면 그 엔트리로 뽑아 둔 후보가 낡는다.
  if (currentName.endsWith(".qubc")) {
    namesCache.delete(currentName);
  }
  showText(area.value, ctx);
  trackCaret(area, ctx);

  // 여는 따옴표가 자동완성을 연다. 그 외 입력은 이미 떠 있는 목록을 거른다.
  if ((ctx.event as InputEvent).data === '"') {
    openCompletion(area, ctx).catch(report);
  } else {
    filterCompletion(area, ctx);
  }
};

// Home/End/PageUp/PageDown - 캐럿을 직접 옮긴다. 처리했으면 true.
//
// 브라우저에 맡기면 첫 타가 스크롤에 먹힌다: textarea가 화면보다 크고(rows=줄 수, height:100%)
// overflow:hidden이라 자기 안에서 스크롤할 수 없어, 브라우저가 캐럿을 옮기는 대신 부모
// (.pg__code)를 캐럿 자리까지 스크롤하는 데 입력을 쓴다. 그래서 같은 키를 두 번 눌러야 움직였다.
const caretKey = (event: KeyboardEvent, area: HTMLTextAreaElement) => {
  const code = area.closest<HTMLElement>(".pg__code");
  if (!code) {
    return false;
  }
  // 보이는 만큼이 한 페이지다 - textarea 높이(콘텐츠 전체)가 아니라 창 높이를 쓴다.
  const lineH = parseFloat(getComputedStyle(area).lineHeight);
  const to = caretTarget(event.key, area.value, event.shiftKey ? area.selectionEnd : area.selectionStart, {
    toDocEdge: event.ctrlKey || event.metaKey,
    pageLines: Math.max(1, Math.floor(code.clientHeight / lineH) - 1),
  });
  if (to === null) {
    return false;
  }

  area.selectionEnd = to;
  if (!event.shiftKey) {
    area.selectionStart = to;
  }
  return true;
};

// 커서만 움직인 경우(화살표/클릭) - 내용은 그대로고 강조와 스크롤만 따라간다.
// 다음 프레임에 읽는다: keydown/click 시점에는 브라우저가 아직 커서를 옮기기 전이다.
//
// 팝업이 떠 있으면 목록 탐색이 먼저다 - 위/아래/Enter는 편집기가 아니라 팝업의 키다.
const followCaret = (_data: unknown, ctx: TCtx) => {
  const area = ctx.event.target as HTMLTextAreaElement;
  if (ctx.event.type === "keydown" && completionKey(ctx.event as KeyboardEvent, ctx)) {
    ctx.event.preventDefault();
    return;
  }
  // 직접 옮겼으면 이번 프레임에 이미 캐럿이 제자리다 - 다음 프레임을 기다리지 않는다.
  if (ctx.event.type === "keydown" && caretKey(ctx.event as KeyboardEvent, area)) {
    ctx.event.preventDefault();
    trackCaret(area, ctx);
    return;
  }
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
  const x =
    area.getBoundingClientRect().left -
    code.getBoundingClientRect().left +
    code.scrollLeft +
    column * charWidth(style.font);
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

// 자동완성 - .qubc.handlers.js의 키 자리에 그 엔트리의 핸들러 fullname을 띄운다.
//
// 트리거는 여는 큰따옴표다. 키를 새로 쓰기 시작하는 순간이 곧 후보가 필요한 순간이라, 매 입력마다
// 자리를 따지지 않고 그 한 글자만 본다. 열린 뒤로는 타이핑이 후보를 거른다.
//
// 후보는 wasm이 낸다(handlerNames) - 컴파일러가 합성 트리를 걸어 낸 이름이라 손으로 맞출 필요가
// 없다. 짝이 되는 .qubc는 파일명으로 안다: card.qubc.handlers.js -> card.qubc.

// 열려 있는 팝업. slotStart는 따옴표 안쪽 시작 오프셋 - 삽입할 때 여기부터 캐럿까지를 갈아끼운다.
let completion: { slotStart: number; names: string[]; shown: string[]; selected: number } | null = null;

// 엔트리별 후보 캐시. .qubc가 바뀌지 않는 한 그대로다 - 핸들러 파일을 타이핑하는 동안은
// 다시 뽑을 이유가 없다.
const namesCache = new Map<string, string[]>();

/** 엔트리의 핸들러 fullname 후보. 처음 한 번만 wasm을 태우고 그 뒤로는 캐시를 쓴다. */
const namesFor = async (entry: string) => {
  const cached = namesCache.get(entry);
  if (cached) {
    return cached;
  }
  const files: Record<string, string> = {};
  for (const name of fileNames) {
    if (name.endsWith(".qubc") || name.endsWith(".css")) {
      files[name] = sources.get(name) ?? "";
    }
  }
  const { handlerNames } = await getCompiler();
  const names = handlerNames(files, entry);
  namesCache.set(entry, names);
  return names;
};

// 팝업을 캐럿 자리에 놓는다. 좌표는 trackCaret과 같은 규칙(줄 높이 x 줄, 글자 폭 x 열)이고
// 기준도 같다(.pg__sheet). 아래로 열 자리가 모자라면 위로 뒤집는다.
const placeCompletion = (area: HTMLTextAreaElement, { store, set }: Pick<TCtx, "store" | "set">) => {
  const style = getComputedStyle(area);
  const lineH = parseFloat(style.lineHeight);

  const before = area.value.slice(0, area.selectionStart);
  const lastBreak = before.lastIndexOf("\n");
  const line = lastBreak === -1 ? 0 : before.slice(0, lastBreak).split("\n").length;
  const column = before.length - (lastBreak + 1);

  const top = parseFloat(style.paddingTop) + line * lineH;
  const left = column * charWidth(style.font);

  // 아래 남은 높이가 팝업 최대치에 못 미치면 위로 - 뒤집는 기준은 CSS의 max-height와 맞춘다.
  const code = area.closest<HTMLElement>(".pg__code");
  const below = code ? code.scrollTop + code.clientHeight - (top + lineH) : Number.POSITIVE_INFINITY;
  set(store.completion.isAbove, below < POPUP_MAX_H);
  set(store.completion.style, `top: ${top}px; left: ${left}px`);
};

// completion.css의 .completion max-height와 같은 값(18rem, 1rem = 10px).
const POPUP_MAX_H = 180;

// 후보 목록을 화면에 싣는다. 선택 이동도 이걸 다시 부른다 - 배열 요소의 leafIndex를 개별로
// 짚을 수 없어(ISSUES) 목록째 갈아끼운다. 후보가 열 개 남짓이라 실측상 문제가 없다.
const renderCompletion = ({ store, replace }: Pick<TCtx, "store" | "replace">) => {
  replace(
    store.completion.items,
    (completion?.shown ?? []).map((name, i) => ({
      name,
      isSelected: i === completion?.selected,
    })),
  );
};

// 고른 항목이 팝업 밖에 있으면 보이도록 최소한만 스크롤한다. 목록을 replace로 갈아끼우므로
// DOM이 새로 붙은 다음 프레임에 잰다.
const revealSelected = () => {
  requestAnimationFrame(() => {
    const box = document.querySelector<HTMLElement>(".completion");
    const item = box?.children[completion?.selected ?? 0] as HTMLElement | undefined;
    if (!box || !item) {
      return;
    }
    if (item.offsetTop < box.scrollTop) {
      box.scrollTop = item.offsetTop;
    } else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
    }
  });
};

const closeCompletion = ({ store, set, replace }: Pick<TCtx, "store" | "set" | "replace">) => {
  if (!completion) {
    return;
  }
  completion = null;
  replace(store.completion.items, []);
  set(store.completion.isOpen, false);
};

// 캐럿 앞 접두사로 후보를 거른다. 남는 게 없으면 닫는다 - 오타를 계속 붙들고 있을 이유가 없다.
const filterCompletion = (area: HTMLTextAreaElement, ctx: TCtx) => {
  if (!completion) {
    return;
  }
  const prefix = area.value.slice(completion.slotStart, area.selectionStart);
  // 따옴표를 닫았거나 슬롯 밖으로 나갔다.
  if (area.selectionStart < completion.slotStart || prefix.includes('"')) {
    closeCompletion(ctx);
    return;
  }
  const used = usedKeys(area.value, completion.slotStart);
  completion.shown = completion.names.filter((n) => n.startsWith(prefix) && !used.has(n));
  completion.selected = 0;
  if (!completion.shown.length) {
    closeCompletion(ctx);
    return;
  }
  renderCompletion(ctx);
};

// 여는 따옴표를 쳤다 - 키 자리면 후보를 뽑아 연다.
const openCompletion = async (area: HTMLTextAreaElement, ctx: TCtx) => {
  const entry = entryOf(currentName);
  if (!entry || !isKeySlot(area.value, area.selectionStart - 1)) {
    return;
  }
  const names = await namesFor(entry);
  if (!names.length) {
    return;
  }
  // await 사이에 커서가 움직였을 수 있다 - 그 자리가 아직 방금 연 따옴표 뒤인지 다시 본다.
  if (area.value[area.selectionStart - 1] !== '"') {
    return;
  }
  const slotStart = area.selectionStart;
  const used = usedKeys(area.value, slotStart);
  const shown = names.filter((n) => !used.has(n));
  if (!shown.length) {
    return;
  }
  completion = { slotStart, names, shown, selected: 0 };
  placeCompletion(area, ctx);
  renderCompletion(ctx);
  ctx.set(ctx.store.completion.isOpen, true);
};

// 고른 후보를 슬롯에 써넣고 닫는다. 닫는 따옴표까지 이쪽이 맞춘다 - 캐럿 뒤에 이미 있으면
// 그것을 쓰고(따옴표가 겹치지 않게), 없으면 넣는다.
//
// 값이 아직 없으면(뒤에 `:`가 안 보이면) 함수 뼈대까지 이어 넣고 커서를 그 몸통에 둔다.
// 기존 키를 고쳐 쓰는 중이면 이름만 갈아끼운다 - 이미 쓴 몸통을 밀어낼 수 없다.
const applyCompletion = (name: string, ctx: TCtx) => {
  const area = document.querySelector<HTMLTextAreaElement>(".pg__area");
  if (!area || !completion) {
    return;
  }
  const { slotStart } = completion;
  const rest = area.value.slice(area.selectionStart);
  const closed = rest.startsWith('"');
  const tail = closed ? rest.slice(1) : rest;

  const head = `${area.value.slice(0, slotStart) + name}"`;
  if (/^\s*:/.test(tail)) {
    area.value = head + tail;
    area.selectionStart = area.selectionEnd = head.length;
  } else {
    const line = area.value.slice(0, slotStart);
    const indent = line.slice(line.lastIndexOf("\n") + 1).match(/^\s*/)?.[0] ?? "";
    const body = handlerBody(name, indent);
    area.value = head + body.text + tail;
    area.selectionStart = area.selectionEnd = head.length + body.caret;
  }

  closeCompletion(ctx);
  if (currentName) {
    sources.set(currentName, area.value);
  }
  showText(area.value, ctx);
  trackCaret(area, ctx);
  area.focus();
};

// 팝업이 떠 있을 때의 키 처리. 삼킨 키는 true - 부르는 쪽이 기본 동작을 막는다.
const completionKey = (event: KeyboardEvent, ctx: TCtx) => {
  if (!completion) {
    return false;
  }
  const last = completion.shown.length - 1;
  switch (event.key) {
    case "ArrowDown":
      completion.selected = completion.selected >= last ? 0 : completion.selected + 1;
      renderCompletion(ctx);
      revealSelected();
      return true;
    case "ArrowUp":
      completion.selected = completion.selected <= 0 ? last : completion.selected - 1;
      renderCompletion(ctx);
      revealSelected();
      return true;
    case "Enter":
    case "Tab":
      applyCompletion(completion.shown[completion.selected], ctx);
      return true;
    case "Escape":
      closeCompletion(ctx);
      return true;
    default:
      return false;
  }
};

// 항목 클릭 - 몇 번째 후보인지는 회차 인덱스로 온다.
const clickCompletionItem = (at: number, ctx: TCtx) => {
  if (completion) {
    applyCompletion(completion.shown[at], ctx);
  }
};

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
const runPreview = async (at: number, ctx: TCtx) => {
  const { store, set } = ctx;
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
  selectFile(at, ctx);

  const entry = fileNames[at];
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
    new Blob([sources.get(`${stem}.qubc.handlers.js`) ?? "export const handlers = {}"], {
      type: "text/javascript",
    }),
  );
  let handlers: THandlers = {};
  let initialData: unknown = {};
  try {
    handlers = (await import(/* @vite-ignore */ handlersUrl)).handlers ?? {};
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
    const url = URL.createObjectURL(new Blob([sources.get(path) ?? ""], { type: "text/css" }));
    previewUrls.push(url);
    previewLinkedUrls.push(url);
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

const report = (e: unknown) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
};

// 모든 핸들러를 감싸 로그 함수를 먼저 만든다 - logs의 leafIndex는 ctx로만 오므로, 어느
// 핸들러든 처음 불릴 때 붙잡는다(그전 로그는 pending에 모였다가 그때 흘러간다).
//
// 예외도 여기서 잡아 콘솔에 남긴다 - 런타임은 핸들러 반환값을 await하지 않아, async 핸들러가
// 실패하면 unhandled rejection으로 조용히 사라진다.
//
// 인자와 반환을 `typeof handlers`로 둔 것이 타입의 핵심이다. 아래 리터럴이 이 자리에서 그
// 표기(ts-plugin이 붙인 `Partial<Handlers>`)를 문맥으로 받아, 화살표의 `data`/`ctx`가 **키마다**
// 추론된다 - 회차 인덱스도 그 이벤트의 @for 깊이대로 딸려온다. 없는 이벤트명은 초과 속성으로
// 걸린다. 제네릭(`<T extends ...>`)으로 두면 그 검사가 풀리므로 쓰지 않는다.
const wrap = (table: typeof handlers): typeof handlers =>
  Object.fromEntries(
    Object.entries(table).map(([name, handler]) => [
      name,
      (data: never, ctx: never) => {
        openLog(ctx);
        try {
          (handler as (d: never, c: never) => void | Promise<void>)(data, ctx)?.catch(report);
        } catch (e) {
          report(e);
        }
      },
    ]),
  );

export const handlers = wrap({
  "Row[$0].CLICK_FILE": (_data, ctx) => selectFile(ctx.$0, ctx),
  "Row[$0].CLICK_PREVIEW": (_data, ctx) => runPreview(ctx.$0, ctx),
  INPUT_SOURCE: editSource,
  KEYDOWN_SOURCE: followCaret,
  CLICK_SOURCE: followCaret,
  CLICK_CLEAR_LOGS: clearLogs,
  CLICK_DIAGNOSTIC: jumpToError,
  "Completion[$0].CLICK_ITEM": (_data, ctx) => clickCompletionItem(ctx.$0, ctx),
});
