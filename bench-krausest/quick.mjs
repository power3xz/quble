// quble krausest 번들 여럿의 동작별 스크립트 시간과 힙을 headless Chromium에서 빠르게 비교한다.
//
// 수정 전후 비교용이다. krausest와 달리 paint는 재지 않고(같은 DOM을 그리면 수정과 무관하게 같다) 창을
// 띄우지 않는다. 최종 수치는 ./bench-krausest.sh로 확인한다.
//
// 스크립트 시간은 잴 클릭 하나를 performance.now()로 감싼다 - 핸들러부터 DOM 생성까지 동기로 끝나므로
// krausest의 script 구간과 같은 범위다. 교차 출처 격리가 없어 performance.now()가 0.1ms 단위로 거칠다.
// 힙은 1k 생성 후 GC를 강제하고 읽는다(krausest 22_run-memory와 같은 시점).
//
// 보통 ./bench-krausest-quick.sh가 번들을 만들어 부른다. 번들을 직접 넘길 때:
//   node bench-krausest/quick.mjs 이름=번들.js [이름=번들.js ...]
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const ROUNDS = 15;
// 잴 동작마다 앞서 run/clear를 이만큼 돌려 JIT를 데운다.
const WARMUP = 5;
const HTML = '<!DOCTYPE html><html><body><div id="main"></div></body></html>';
const SECOND_ROW = "tbody>tr:nth-of-type(2)";

// setup 클릭들로 상태를 만든 뒤 measure 클릭 하나만 잰다. krausest 01~09와 같은 동작이다.
const OPS = [
  { name: "create 1k", setup: ["#clear"], measure: "#run" },
  { name: "replace 1k", setup: ["#run"], measure: "#run" },
  { name: "update 10th", setup: ["#run"], measure: "#update" },
  { name: "select", setup: ["#run"], measure: `${SECOND_ROW}>td:nth-of-type(2)>a` },
  { name: "swap", setup: ["#run"], measure: "#swaprows" },
  { name: "remove", setup: ["#run"], measure: `${SECOND_ROW}>td:nth-of-type(3)>a` },
  { name: "create 10k", setup: ["#clear"], measure: "#runlots" },
  { name: "append 1k", setup: ["#run"], measure: "#add" },
  { name: "clear", setup: ["#run"], measure: "#clear" },
];

const targets = process.argv.slice(2).map((arg) => {
  const [name, path] = arg.split("=");
  return { name, code: readFileSync(path, "utf8"), times: OPS.map(() => []), heaps: [] };
});
if (targets.length === 0) {
  console.error("사용: node bench-krausest/quick.mjs 이름=번들.js [이름=번들.js ...]");
  process.exit(1);
}

const click = (page, selectors) =>
  page.evaluate((list) => {
    for (const s of list) {
      document.querySelector(s).click();
    }
  }, selectors);

const timeClick = (page, selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    const start = performance.now();
    el.click();
    return performance.now() - start;
  }, selector);

const openPage = async (browser, code) => {
  const page = await browser.newPage();
  await page.setContent(HTML);
  await page.addScriptTag({ content: code });
  return page;
};

const browser = await chromium.launch({ headless: true });
for (let round = 0; round < ROUNDS; round++) {
  // 회차마다 번들을 번갈아 재 시간에 따른 흔들림이 한쪽에만 쏠리지 않게 한다.
  for (const t of targets) {
    for (let i = 0; i < OPS.length; i++) {
      const page = await openPage(browser, t.code);
      for (let w = 0; w < WARMUP; w++) {
        await click(page, ["#run", "#clear"]);
      }
      await click(page, OPS[i].setup);
      t.times[i].push(await timeClick(page, OPS[i].measure));
      await page.close();
    }
    const page = await openPage(browser, t.code);
    await click(page, ["#run"]);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await cdp.send("Runtime.getHeapUsage");
    t.heaps.push(usedSize / 1024 / 1024);
    await page.close();
  }
}
await browser.close();

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const cell = (xs, digits) => {
  const s = [...xs].sort((a, b) => a - b);
  return `${median(xs).toFixed(digits)} (${s[0].toFixed(digits)}~${s[s.length - 1].toFixed(digits)})`;
};
// 첫 번들 대비 중앙값 차이.
const diff = (xs, base) => {
  const d = ((median(xs) - median(base)) / median(base)) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
};

const rows = [["", ...targets.map((t) => t.name)]];
OPS.forEach((op, i) => {
  rows.push([
    `${op.name} (ms)`,
    ...targets.map((t, k) => cell(t.times[i], 2) + (k > 0 ? ` ${diff(t.times[i], targets[0].times[i])}` : "")),
  ]);
});
rows.push([
  "heap after 1k (MB)",
  ...targets.map((t, k) => cell(t.heaps, 3) + (k > 0 ? ` ${diff(t.heaps, targets[0].heaps)}` : "")),
]);
const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
console.log(`${ROUNDS}회 중앙값 (최소~최대)`);
for (const r of rows) {
  console.log(r.map((v, c) => v.padEnd(widths[c])).join("  "));
}
