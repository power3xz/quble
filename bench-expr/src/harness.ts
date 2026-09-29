// 네 대상 페이지가 함께 쓰는 측정 틀.
//
// 페이지는 자기 대상(quble, React, Svelte)만 싣고 이 틀에 mount 함수를 넘긴다. 틀이 하는 일:
//   - 로드: data-<N>.json을 받아 mount하고, 첫 페인트까지의 시간을 잰다.
//   - 네트워크: Resource Timing으로 이 페이지가 받은 파일별 바이트를 읽는다.
//   - 클릭: 컴포넌트 안의 실제 버튼을 .click()으로 누르고, DOM 반영과 페인트까지의 시간을 잰다.
//   - 결과를 localStorage에 넣어 index 페이지의 비교 표가 읽게 한다.

export type TRow = { id: number; price: number; qty: number; discount: number; stock: number };
export type TData = { rows: TRow[]; rate: number; tax: number; threshold: number };

// 버튼이 오가는 값. 환율은 매번 바꿔 모든 행 금액이 바뀌고, 기준은 1만 움직여 경고가 거의 안 바뀐다.
export const nextRate = (rate: number) => (rate === 1300 ? 1350 : 1300);
export const nextThreshold = (threshold: number) => (threshold === 30000 ? 30001 : 30000);

type TTarget<P> = {
  id: string;
  label: string;
  // 대상만의 자원(quble은 .qubb)을 data와 나란히 받는다.
  prepare?: () => Promise<P>;
  mount: (root: HTMLElement, data: TData, prepared: P) => void;
};

type TFile = { name: string; transfer: number; encoded: number; decoded: number };
type TTiming = { dom: number; layout: number };
type TStat = { dom: number; layout: number; domP90: number; layoutP90: number };
export type TResult = {
  id: string;
  label: string;
  n: number;
  enc: string;
  files: TFile[];
  load: { fetched: number; mounted: number; painted: number };
  clicks: Record<string, TStat>;
  at: string;
};

export const SCENARIOS = [
  { key: "inc", label: "행 +1", desc: "행 하나의 수량을 올린다" },
  { key: "rate", label: "환율 변경", desc: "모든 행의 금액 식이 바뀐다" },
  { key: "threshold", label: "기준 변경", desc: "모든 행의 경고 식을 다시 세지만 값은 거의 그대로" },
] as const;

export const TARGETS = [
  { id: "quble", label: "quble" },
  { id: "react-memo", label: "React + memo" },
  { id: "react", label: "React" },
  { id: "svelte", label: "Svelte 5" },
];

export const SIZES = [1000, 5000, 10000];
export const ENCODINGS = [
  { key: "none", label: "압축 없음" },
  { key: "gzip", label: "gzip" },
  { key: "br", label: "brotli" },
];

const WARMUP = 5;
const RUNS = 30;
export const STORAGE_KEY = "bench-expr";

export const currentN = () => {
  const n = Number(new URLSearchParams(location.search).get("n"));
  return SIZES.includes(n) ? n : SIZES[0];
};

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
    all[`${r.id}|${r.n}|${r.enc}`] = r;
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

// 버튼 하나를 누르고 두 시간을 잰다.
//   dom    - 클릭부터 MutationObserver가 불릴 때까지. React/Svelte는 갱신을 microtask로 미뤄
//            몰아서 하는데, MutationObserver도 microtask라 그 갱신이 끝난 뒤에 불린다.
//   layout - dom에 더해, 그 자리에서 offsetHeight를 읽어 브라우저가 스타일과 레이아웃을 바로
//            계산하게 한 시간. 다음 프레임을 기다리면 주사율(16.6ms)에 묶여 대상 사이 차이가 안 보인다.
// 측정 뒤에는 한 프레임을 쉬어 다음 클릭이 앞 클릭의 페인트와 겹치지 않게 한다.
const measureClick = async (root: HTMLElement, button: HTMLElement): Promise<TTiming> => {
  let t0 = 0;
  const done = new Promise<TTiming>((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      const dom = performance.now() - t0;
      void root.offsetHeight;
      resolve({ dom, layout: performance.now() - t0 });
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  });
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
  return { dom: quantile(dom, 0.5), layout: quantile(layout, 0.5), domP90: quantile(dom, 0.9), layoutP90: quantile(layout, 0.9) };
};

// 시나리오마다 누를 버튼. 행 +1은 매번 다른 행을 고른다(같은 행만 누르면 캐시가 유리해진다).
const buttonFor = (root: HTMLElement, key: string, k: number): HTMLElement => {
  if (key === "inc") {
    const rows = root.querySelectorAll<HTMLElement>(".row__inc");
    return rows[(k * 7919) % rows.length];
  }
  return root.querySelector<HTMLElement>(key === "rate" ? "#btn-rate" : "#btn-threshold")!;
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
    el("thead", {}, el("tr", {}, el("th", {}, "버튼"), el("th", {}, "DOM 반영"), el("th", {}, "p90"), el("th", {}, "+ 레이아웃"), el("th", {}, "p90"))),
    el(
      "tbody",
      {},
      ...SCENARIOS.map((s) => {
        const c = clicks[s.key];
        return c
          ? el("tr", { title: s.desc }, el("td", {}, s.label), el("td", { class: "num" }, ms(c.dom)), el("td", { class: "num dim" }, ms(c.domP90)), el("td", { class: "num" }, ms(c.layout)), el("td", { class: "num dim" }, ms(c.layoutP90)))
          : el("tr", { title: s.desc }, el("td", {}, s.label), el("td", { class: "dim", colspan: "4" }, "-"));
      }),
    ),
  );

export const runTarget = async <P>(target: TTarget<P>) => {
  const n = currentN();
  const enc = currentEnc();
  document.title = `${target.label} - 식 벤치`;

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
      el("strong", { class: "hud__title" }, target.label),
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
  const result: TResult = {
    id: target.id,
    label: target.label,
    n,
    enc,
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
  saveResult(result);
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
