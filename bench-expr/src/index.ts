// 비교 표. 각 대상 탭이 localStorage에 넣은 결과를 읽어 그린다. 다른 탭이 결과를 넣으면
// storage 이벤트가 와서 바로 다시 그린다.
import { controls, currentEnc, currentN, ENCODINGS, loadResults, SCENARIOS, STORAGE_KEY, TARGETS, type TResult } from "./harness.ts";

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
  const all = Object.values(loadResults());
  // 대상마다 tag 없는 결과 다음에 tag 붙은 결과를 잰 순서대로 한 행씩. tag 필드가 생기기 전 결과는 tag가 없다.
  const results = TARGETS.flatMap((t) => {
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
      const values = results.map((x) => (x.result ? c.value(x.result) : undefined)).filter((x): x is number => x !== undefined);
      const max = Math.max(...values);
      const min = Math.min(...values);
      const best = v === min && values.length > 1 ? " best" : "";
      return `<td class="cell${best}"><div class="bar" style="width:${max > 0 ? (v / max) * 100 : 0}%"></div><span>${c.format(v)}</span></td>`;
    });
    tr.innerHTML = `<td class="target">${link}${result ? `<div class="dim small">${new Date(result.at).toLocaleTimeString()}</div>` : `<div class="dim small">결과 없음</div>`}</td>${cells.join("")}`;
    return tr;
  });

  const table = document.getElementById("compare")!;
  table.replaceChildren(document.createElement("thead"), document.createElement("tbody"));
  table.tHead!.append(head);
  table.tBodies[0].append(...rows);
  document.getElementById("caption")!.textContent =
    `${n.toLocaleString()} 행, ${ENCODINGS.find((e) => e.key === enc)!.label}, 클릭은 ${METRIC_LABEL[metric]} 중앙값`;
};

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

document.getElementById("controls")!.append(...controls(render), metricSelect, clear);
addEventListener("storage", render);
render();
