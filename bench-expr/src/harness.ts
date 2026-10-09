// 네 대상 페이지가 함께 쓰는 측정 틀.
//
// 페이지는 자기 대상(quble, React, Svelte)만 싣고 이 틀에 mount 함수를 넘긴다. 틀이 하는 일:
//   - 로드: data-<N>.json을 받아 mount하고, 첫 페인트까지의 시간을 잰다.
//   - 네트워크: Resource Timing으로 이 페이지가 받은 파일별 바이트를 읽는다.
//   - 클릭: 컴포넌트 안의 실제 버튼을 .click()으로 누르고, DOM 반영과 페인트까지의 시간을 잰다.
//   - 결과를 localStorage에 넣어 index 페이지의 비교 표가 읽게 한다.

import testVersions from "../tests.json";

export type TRow = { id: number; price: number; qty: number; discount: number; stock: number; url: string };
export type TData = { rows: TRow[]; rate: number; tax: number; threshold: number; pivot: number };

// 버튼이 오가는 값. 환율은 매번 바꿔 모든 행 금액이 바뀌고, 기준은 1만 움직여 경고가 거의 안 바뀐다.
export const nextRate = (rate: number) => (rate === 1300 ? 1350 : 1300);
export const nextThreshold = (threshold: number) => (threshold === 30000 ? 30001 : 30000);// 기준 행은 매번 다음 행으로 옮겨, 모든 행의 비교 식(row.price - rows[pivot].price)이 다른 행을 읽게 한다.
export const nextPivot = (pivot: number, length: number) => (pivot + 1) % length;

// 전체 행 일괄 갱신이 번갈아 넘기는 두 배열 - 처음 데이터와 모든 행의 네 값이 1씩 크고 url이 다른 데이터.
// runTarget이 로드와 네트워크 집계를 마친 뒤 채우므로 로드 지표에 들어가지 않는다.
export const bulk: { base: TRow[]; bumped: TRow[] } = { base: [], bumped: [] };

type TTarget<P> = {
  id: string;
  label: string;
  // 대상만의 자원(quble은 .qubb)을 data와 나란히 받는다.
  prepare?: () => Promise<P>;
  mount: (root: HTMLElement, data: TData, prepared: P) => void;
};

type TFile = { name: string; transfer: number; encoded: number; decoded: number };
type TTiming = { dom: number; layout: number; heap: number };
// heap은 이 필드가 생기기 전 결과에는 없다.
type TStat = { dom: number; layout: number; domP90: number; layoutP90: number; heap?: number };
export type TResult = {
  id: string;
  label: string;
  // 어떤 테스트를 어느 버전으로 쟀는지. 이 필드가 생기기 전 결과에는 없다.
  test?: string;
  version?: number;
  n: number;
  enc: string;
  tag: string;
  files: TFile[];
  load: { fetched: number; mounted: number; painted: number };
  clicks: Record<string, TStat>;
  at: string;
};

export const SCENARIOS = [
  { key: "inc", label: "행 +1", desc: "행 하나의 수량을 올린다" },
  { key: "rate", label: "환율 변경", desc: "모든 행의 금액 식이 바뀐다" },
  { key: "threshold", label: "기준 변경", desc: "모든 행의 경고 식을 다시 세지만 값은 거의 그대로" },
  { key: "pivot", label: "기준 행 이동", desc: "모든 행의 비교 식이 인덱스가 바뀌어 다른 행을 읽는다" },
  { key: "pivotPrice", label: "기준 행 가격 변경", desc: "모든 행의 비교 식이 읽는 기준 행 가격 하나가 바뀐다" },
  { key: "rateAndTax", label: "환율+세율 동시 변경", desc: "한 핸들러가 모든 행의 금액 식이 읽는 두 값을 함께 바꾼다" },
  { key: "rateBurst", label: "환율 연속 3회 변경", desc: "한 핸들러가 같은 값을 세 번 바꾼다" },
  { key: "bulk", label: "전체 행 일괄 갱신", desc: "한 핸들러가 모든 행의 가격, 수량, 할인, 재고, 링크 주소를 한꺼번에 바꾼다" },
] as const;

// 테스트마다 대상 페이지와 결과가 따로다. 테스트가 다르면 같은 표에서 비교하지 않는다.
export const TESTS = [
  { key: "orders", label: "orders", desc: "기본 행" },
  { key: "orders-deep", label: "orders-deep", desc: "값 자리 사이에 정적 하위 트리, 깊은 값 자리, 정적 형제 줄이 낀 행" },
] as const;

export const TARGETS = [
  { id: "quble", label: "quble", test: "orders" },
  { id: "react-memo", label: "React + memo", test: "orders" },
  { id: "react", label: "React", test: "orders" },
  { id: "svelte", label: "Svelte 5", test: "orders" },
  { id: "quble-deep", label: "quble (deep)", test: "orders-deep" },
  { id: "react-memo-deep", label: "React + memo (deep)", test: "orders-deep" },
  { id: "react-deep", label: "React (deep)", test: "orders-deep" },
  { id: "svelte-deep", label: "Svelte 5 (deep)", test: "orders-deep" },
];

// 테스트의 지금 버전(tests.json). 행 모양, 데이터, 시나리오, 측정 방식이 바뀌면 그 테스트의 버전을 올린다 -
// 버전이 다른 결과끼리는 견주지 않는다.
export const testVersion = (test: string): number => (testVersions as Record<string, { version: number }>)[test].version;

// 비교 표가 보여 줄 테스트. compare 페이지 URL의 test 값(?test=orders-deep), 없거나 모르는 값이면 첫 테스트.
export const currentTest = (): string => {
  const test = new URLSearchParams(location.search).get("test");
  return TESTS.some((t) => t.key === test) ? (test as string) : TESTS[0].key;
};

export const SIZES = [1000, 5000, 10000];
export const ENCODINGS = [
  { key: "none", label: "압축 없음" },
  { key: "gzip", label: "gzip" },
  { key: "br", label: "brotli" },
];

const WARMUP = 5;
const RUNS = 30;
// 식이나 시나리오가 바뀌면 키를 바꿔 옛 결과와 섞지 않는다.
export const STORAGE_KEY = "bench-expr-pivot";

export const currentN = () => {
  const n = Number(new URLSearchParams(location.search).get("n"));
  return SIZES.includes(n) ? n : SIZES[0];
};

// 같은 대상을 구현을 바꿔 가며 잴 때 결과를 나눠 담는 이름. quble.html?n=10000&tag=before -> "before"
export const currentTag = (): string => new URLSearchParams(location.search).get("tag") ?? "";

export const currentEnc = () => {
  const m = document.cookie.match(/(?:^|; )enc=(\w+)/);
  return m && ENCODINGS.some((e) => e.key === m[1]) ? m[1] : "none";
};

export const setEnc = (enc: string) => {
  document.cookie = `enc=${enc}; path=/; max-age=31536000`;
};

export const loadResults = (): Record<string, TResult> => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
};

const saveResult = (r: TResult) => {
  try {
    const all = loadResults();
    all[r.tag ? `${r.id}|${r.n}|${r.enc}|${r.tag}` : `${r.id}|${r.n}|${r.enc}`] = r;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 저장이 막힌 브라우저면 이 탭에만 보인다.
  }
};

// 다음 프레임이 그려진 뒤. rAF 콜백은 페인트 직전에 돌므로, 거기서 메시지를 하나 더 넘겨
// 페인트가 끝난 다음 태스크에서 시각을 잰다.
const afterPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    });
  });

// JS 힙 사용량(바이트). Chrome만 있고, --enable-precise-memory-info로 띄워야 바이트 단위로 갱신된다.
// 없으면 NaN.
const usedHeap = (): number =>
  (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? Number.NaN;

// 버튼 하나를 누르고 두 시간과 힙 증가량을 잰다.
//   dom    - 클릭부터 MutationObserver가 불릴 때까지. React/Svelte는 갱신을 microtask로 미뤄
//            몰아서 하는데, MutationObserver도 microtask라 그 갱신이 끝난 뒤에 불린다.
//   layout - dom에 더해, 그 자리에서 offsetHeight를 읽어 브라우저가 스타일과 레이아웃을 바로
//            계산하게 한 시간. 다음 프레임을 기다리면 주사율(16.6ms)에 묶여 대상 사이 차이가 안 보인다.
//   heap   - 클릭 직전부터 dom 시점까지 늘어난 힙. 그 사이 GC가 없으면 클릭 한 번의 할당량이다.
//            GC가 끼면 작아지거나 음수가 되어, 중앙값으로 본다.
// 측정 뒤에는 한 프레임을 쉬어 다음 클릭이 앞 클릭의 페인트와 겹치지 않게 한다.
const measureClick = async (root: HTMLElement, button: HTMLElement): Promise<TTiming> => {
  let t0 = 0;
  let heap0 = 0;
  const done = new Promise<TTiming>((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      const dom = performance.now() - t0;
      const heap = usedHeap() - heap0;
      void root.offsetHeight;
      resolve({ dom, layout: performance.now() - t0, heap });
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  heap0 = usedHeap();
  t0 = performance.now();
  button.click();
  const timing = await done;
  await afterPaint();
  return timing;
};

const quantile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

const statOf = (timings: TTiming[]): TStat => {
  const dom = timings.map((t) => t.dom);
  const layout = timings.map((t) => t.layout);
  const heap = timings.map((t) => t.heap);
  return {
    dom: quantile(dom, 0.5),
    layout: quantile(layout, 0.5),
    domP90: quantile(dom, 0.9),
    layoutP90: quantile(layout, 0.9),
    heap: quantile(heap, 0.5),
  };
};

// 시나리오마다 누를 버튼. 행 +1은 매번 다른 행을 고른다(같은 행만 누르면 캐시가 유리해진다).
const BUTTON_OF: Record<string, string> = {
  rate: "#btn-rate",
  threshold: "#btn-threshold",
  pivot: "#btn-pivot",
  pivotPrice: "#btn-pivot-price",
  rateAndTax: "#btn-rate-tax",
  rateBurst: "#btn-rate-burst",
  bulk: "#btn-bulk",
};
const buttonFor = (root: HTMLElement, key: string, k: number): HTMLElement => {
  if (key === "inc") {
    const rows = root.querySelectorAll<HTMLElement>(".row__inc");
    return rows[(k * 7919) % rows.length];
  }
  return root.querySelector<HTMLElement>(BUTTON_OF[key])!;
};

const collectFiles = (): TFile[] => {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const entries = [
    ...(nav ? [nav] : []),
    ...(performance.getEntriesByType("resource") as PerformanceResourceTiming[]),
  ];
  return entries
    .filter((e) => !e.name.includes("favicon"))
    .map((e) => ({
      name: new URL(e.name).pathname.split("/").pop() || "index.html",
      transfer: e.transferSize,
      encoded: e.encodedBodySize,
      decoded: e.decodedBodySize,
    }));
};

// ---- 화면 ----

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const ms = (v: number) => `${v.toFixed(3)} ms`;
// 힙 증가량. 재지 못했으면(Chrome이 아니거나 이전 결과) "-".
const heapKb = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "-" : kb(v));

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
};

export const controls = (onChange?: () => void) => {
  const n = currentN();
  const enc = currentEnc();
  const sizeSelect = el("select", { class: "ctl" }, ...SIZES.map((s) => el("option", s === n ? { value: String(s), selected: "" } : { value: String(s) }, `${s.toLocaleString()} 행`)));
  sizeSelect.addEventListener("change", () => {
    const url = new URL(location.href);
    url.searchParams.set("n", sizeSelect.value);
    if (onChange) {
      history.replaceState(null, "", url);
      onChange();
    } else {
      location.href = url.href;
    }
  });
  const encSelect = el("select", { class: "ctl" }, ...ENCODINGS.map((e) => el("option", e.key === enc ? { value: e.key, selected: "" } : { value: e.key }, e.label)));
  encSelect.addEventListener("change", () => {
    setEnc(encSelect.value);
    if (onChange) {
      onChange();
    } else {
      location.reload();
    }
  });
  return [sizeSelect, encSelect];
};

const renderNet = (files: TFile[]) => {
  const sum = (k: keyof TFile) => files.reduce((a, f) => a + (f[k] as number), 0);
  return el(
    "table",
    { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", {}, "파일"), el("th", {}, "전송"), el("th", {}, "본문(인코딩)"), el("th", {}, "본문(원본)"))),
    el(
      "tbody",
      {},
      ...files.map((f) => el("tr", {}, el("td", { class: "mono" }, f.name), el("td", {}, kb(f.transfer)), el("td", {}, kb(f.encoded)), el("td", {}, kb(f.decoded)))),
      el("tr", { class: "tbl__sum" }, el("td", {}, "합계"), el("td", {}, kb(sum("transfer"))), el("td", {}, kb(sum("encoded"))), el("td", {}, kb(sum("decoded")))),
    ),
  );
};

const renderClicks = (clicks: Record<string, TStat>) =>
  el(
    "table",
    { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", {}, "버튼"), el("th", {}, "DOM 반영"), el("th", {}, "p90"), el("th", {}, "+ 레이아웃"), el("th", {}, "p90"), el("th", {}, "힙 증가"))),
    el(
      "tbody",
      {},
      ...SCENARIOS.map((s) => {
        const c = clicks[s.key];
        return c
          ? el("tr", { title: s.desc }, el("td", {}, s.label), el("td", { class: "num" }, ms(c.dom)), el("td", { class: "num dim" }, ms(c.domP90)), el("td", { class: "num" }, ms(c.layout)), el("td", { class: "num dim" }, ms(c.layoutP90)), el("td", { class: "num" }, heapKb(c.heap)))
          : el("tr", { title: s.desc }, el("td", {}, s.label), el("td", { class: "dim", colspan: "5" }, "-"));
      }),
    ),
  );

export const runTarget = async <P>(target: TTarget<P>) => {
  const n = currentN();
  const enc = currentEnc();
  const tag = currentTag();
  const title = tag ? `${target.label} (${tag})` : target.label;
  document.title = `${title} - 식 벤치`;

  const status = el("span", { class: "hud__status" }, "로드 중");
  const runButton = el("button", { class: "btn btn--primary", disabled: "" }, "측정") as HTMLButtonElement;
  const netBox = el("div", { class: "panel" }, el("h3", {}, "네트워크"), el("p", { class: "dim" }, "-"));
  const loadBox = el("div", { class: "panel" }, el("h3", {}, "로드"), el("p", { class: "dim" }, "-"));
  const clickBox = el("div", { class: "panel panel--wide" }, el("h3", {}, `클릭 (예열 ${WARMUP}회 뒤 ${RUNS}회 중앙값)`), renderClicks({}));
  const hud = document.getElementById("hud")!;
  hud.append(
    el(
      "div",
      { class: "hud__bar" },
      el("a", { class: "hud__back", href: `./?n=${n}` }, "<- 비교 표"),
      el("strong", { class: "hud__title" }, title),
      ...controls(),
      runButton,
      status,
    ),
    el("div", { class: "hud__panels" }, netBox, loadBox, clickBox),
  );

  const root = document.getElementById("app")!;
  const [data, prepared] = await Promise.all([
    fetch(`./data-${n}.json`).then((r) => r.json() as Promise<TData>),
    target.prepare ? target.prepare() : Promise.resolve(undefined as P),
  ]);
  const fetched = performance.now();
  target.mount(root, data, prepared);
  const mounted = performance.now();
  await afterPaint();
  const painted = performance.now();

  // 페이지 로드가 끝나야 Resource Timing에 모든 파일이 잡힌다.
  if (document.readyState !== "complete") {
    await new Promise((r) => addEventListener("load", r, { once: true }));
  }
  const files = collectFiles();
  bulk.base = data.rows;
  bulk.bumped = await fetch(`./bulk-${n}.json`).then((r) => r.json() as Promise<TRow[]>);
  const test = TARGETS.find((t) => t.id === target.id)!.test;
  const result: TResult = {
    id: target.id,
    label: target.label,
    test,
    version: testVersion(test),
    n,
    enc,
    tag,
    files,
    load: { fetched, mounted: mounted - fetched, painted },
    clicks: {},
    at: new Date().toISOString(),
  };

  netBox.replaceChildren(el("h3", {}, `네트워크 (${ENCODINGS.find((e) => e.key === enc)!.label})`), renderNet(files));
  loadBox.replaceChildren(
    el("h3", {}, "로드 (페이지 요청 시작 기준)"),
    el(
      "table",
      { class: "tbl" },
      el(
        "tbody",
        {},
        el("tr", {}, el("td", {}, "자원 받음"), el("td", { class: "num" }, ms(fetched))),
        el("tr", {}, el("td", {}, `mount (${n.toLocaleString()} 행)`), el("td", { class: "num" }, ms(mounted - fetched))),
        el("tr", { class: "tbl__sum" }, el("td", {}, "첫 페인트"), el("td", { class: "num" }, ms(painted))),
      ),
    ),
  );
  // 측정을 마쳐야 저장한다 - 새로고침만으로 지난 측정의 클릭 결과를 덮지 않고, 저장된 로드와 클릭이
  // 늘 같은 페이지 로드에서 나온다.
  status.textContent = "준비됨 - 측정 중에는 이 탭을 앞에 둔다(뒤로 가면 rAF가 멈춘다)";
  runButton.disabled = false;

  runButton.addEventListener("click", async () => {
    runButton.disabled = true;
    for (const s of SCENARIOS) {
      const timings: TTiming[] = [];
      for (let k = 0; k < WARMUP + RUNS; k++) {
        status.textContent = `${s.label} ${k + 1}/${WARMUP + RUNS}`;
        const t = await measureClick(root, buttonFor(root, s.key, k));
        if (k >= WARMUP) {
          timings.push(t);
        }
      }
      result.clicks[s.key] = statOf(timings);
      clickBox.replaceChildren(clickBox.firstChild!, renderClicks(result.clicks));
    }
    result.at = new Date().toISOString();
    saveResult(result);
    status.textContent = "완료 - 비교 표에 저장했다";
    runButton.disabled = false;
  });
};
