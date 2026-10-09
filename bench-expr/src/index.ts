// 비교 표. 각 대상 탭이 localStorage에 넣은 결과를 읽어 그린다. 다른 탭이 결과를 넣으면
// storage 이벤트가 와서 바로 다시 그린다.
import {
  controls,
  currentEnc,
  currentN,
  currentTest,
  ENCODINGS,
  loadResults,
  SCENARIOS,
  STORAGE_KEY,
  TARGETS,
  TESTS,
  type TResult,
  testVersion,
} from "./harness.ts";

type TColumn = { label: string; hint: string; value: (r: TResult) => number | undefined; format: (v: number) => string };

const kb = (v: number) => `${(v / 1024).toFixed(1)} KB`;
const ms = (v: number) => `${v.toFixed(3)} ms`;

type TMetric = "dom" | "layout" | "heap";

// 시나리오 열의 값. 힙 증가를 재지 못한 결과(Chrome이 아니거나 이전 결과)는 비운다.
const clickValue = (r: TResult, key: string, metric: TMetric): number | undefined => {
  const v = r.clicks[key]?.[metric];
  return v === undefined || !Number.isFinite(v) ? undefined : v;
};

const columns = (metric: TMetric): TColumn[] => [
  { label: "전송 합계", hint: "HTML, JS, CSS, 데이터, .qubb 합계", value: (r) => r.files.reduce((a, f) => a + f.transfer, 0), format: kb },
  {
    label: "JS 전송",
    hint: ".js 파일만",
    value: (r) => r.files.filter((f) => f.name.endsWith(".js")).reduce((a, f) => a + f.transfer, 0),
    format: kb,
  },
  { label: "mount", hint: "데이터를 받은 뒤 N행을 그리기까지", value: (r) => r.load.mounted, format: ms },
  { label: "첫 페인트", hint: "페이지 요청 시작부터", value: (r) => r.load.painted, format: ms },
  ...SCENARIOS.map((s) => ({ label: s.label, hint: s.desc, value: (r: TResult) => clickValue(r, s.key, metric), format: metric === "heap" ? kb : ms })),
];

let metric: TMetric = "dom";

const METRIC_LABEL: Record<TMetric, string> = {
  dom: "DOM 반영까지",
  layout: "DOM 반영 + 레이아웃까지",
  heap: "DOM 반영까지의 힙 증가",
};

const render = () => {
  const n = currentN();
  const enc = currentEnc();
  const test = currentTest();
  const version = testVersion(test);
  // 지금 버전이 아닌 결과(버전 필드가 생기기 전 결과 포함)는 옛 버전이다 - 흐리게 보이고 막대와 최소 표시에서 뺀다.
  const isStale = (r: TResult | undefined) => r !== undefined && r.version !== version;
  const all = Object.values(loadResults());
  // 선택한 테스트의 대상마다 tag 없는 결과 다음에 tag 붙은 결과를 잰 순서대로 한 행씩. tag 필드가 생기기 전 결과는 tag가 없다.
  const results = TARGETS.filter((t) => t.test === test).flatMap((t) => {
    const mine = all
      .filter((r) => r.id === t.id && r.n === n && r.enc === enc)
      .sort((a, b) => Number(Boolean(a.tag)) - Number(Boolean(b.tag)));
    return mine.length > 0 ? mine.map((r) => ({ target: t, result: r as TResult | undefined })) : [{ target: t, result: undefined }];
  });
  const cols = columns(metric);

  const head = document.createElement("tr");
  head.innerHTML = `<th>대상</th>${cols.map((c) => `<th title="${c.hint}">${c.label}</th>`).join("")}`;

  const rows = results.map(({ target, result }) => {
    const tr = document.createElement("tr");
    const tag = result?.tag ?? "";
    const link = tag
      ? `<a href="./${target.id}.html?n=${n}&tag=${encodeURIComponent(tag)}" target="_blank" rel="noopener">${target.label} (${tag})</a>`
      : `<a href="./${target.id}.html?n=${n}" target="_blank" rel="noopener">${target.label}</a>`;
    const cells = cols.map((c) => {
      const v = result ? c.value(result) : undefined;
      if (v === undefined) {
        return `<td class="dim">-</td>`;
      }
      if (isStale(result)) {
        return `<td class="cell dim"><span>${c.format(v)}</span></td>`;
      }
      const values = results
        .map((x) => (x.result && !isStale(x.result) ? c.value(x.result) : undefined))
        .filter((x): x is number => x !== undefined);
      const max = Math.max(...values);
      const min = Math.min(...values);
      const best = v === min && values.length > 1 ? " best" : "";
      return `<td class="cell${best}"><div class="bar" style="width:${max > 0 ? (v / max) * 100 : 0}%"></div><span>${c.format(v)}</span></td>`;
    });
    const meta = result
      ? `${new Date(result.at).toLocaleTimeString()}, v${result.version ?? "없음"}${isStale(result) ? " (옛 버전, 지금 v" + version + ")" : ""}`
      : "결과 없음";
    tr.innerHTML = `<td class="target">${link}<div class="dim small">${meta}</div></td>${cells.join("")}`;
    return tr;
  });

  const table = document.getElementById("compare")!;
  table.replaceChildren(document.createElement("thead"), document.createElement("tbody"));
  table.tHead!.append(head);
  table.tBodies[0].append(...rows);
  document.getElementById("caption")!.textContent =
    `${test} v${version}, ${n.toLocaleString()} 행, ${ENCODINGS.find((e) => e.key === enc)!.label}, 클릭은 ${METRIC_LABEL[metric]} 중앙값`;
};

const testSelect = document.createElement("select");
testSelect.className = "ctl";
testSelect.innerHTML = TESTS.map(
  (t) => `<option value="${t.key}"${t.key === currentTest() ? " selected" : ""} title="${t.desc}">${t.label}</option>`,
).join("");
testSelect.addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.set("test", testSelect.value);
  history.replaceState(null, "", url);
  render();
});

const metricSelect = document.createElement("select");
metricSelect.className = "ctl";
metricSelect.innerHTML = `<option value="dom">클릭 -> DOM 반영</option><option value="layout">클릭 -> DOM 반영 + 레이아웃</option><option value="heap">클릭 -> DOM 반영의 힙 증가</option>`;
metricSelect.addEventListener("change", () => {
  metric = metricSelect.value as TMetric;
  render();
});

const clear = document.createElement("button");
clear.className = "btn";
clear.textContent = "결과 지우기";
clear.addEventListener("click", () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  render();
});

// 지금 그려진 표를 캡션과 함께 탭으로 나눈 텍스트로 만든다. 셀 안의 줄바꿈(대상 이름 아래 측정 시각)은 공백으로 잇는다.
const tableText = (): string => {
  const table = document.getElementById("compare") as HTMLTableElement;
  const lines = [...table.rows].map((tr) => [...tr.cells].map((c) => c.innerText.replace(/\s+/g, " ").trim()).join("\t"));
  return [document.getElementById("caption")!.textContent, ...lines].join("\n");
};

// 세 지표(DOM 반영, 레이아웃, 힙) 표를 모두 이어 복사한다. 보이는 표를 바꿔 가며 그린 뒤 원래 지표로 돌려놓는다.
// 복사가 끝나면 버튼 글자가 잠깐 바뀐다.
const METRICS: TMetric[] = ["dom", "layout", "heap"];
const copy = document.createElement("button");
copy.className = "btn";
copy.textContent = "표 복사";
copy.addEventListener("click", async () => {
  const shown = metric;
  const texts = METRICS.map((m) => {
    metric = m;
    render();
    return tableText();
  });
  metric = shown;
  render();
  try {
    await navigator.clipboard.writeText(texts.join("\n\n"));
    copy.textContent = "복사됨 (표 3개)";
  } catch {
    copy.textContent = "복사 실패";
  }
  setTimeout(() => {
    copy.textContent = "표 복사";
  }, 1500);
});

document.getElementById("controls")!.append(testSelect, ...controls(render), metricSelect, copy, clear);
addEventListener("storage", render);
render();
