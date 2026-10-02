// quble krausest 번들 하나의 동작별 스크립트 시간과 힙을 headless Chromium에서 재고 기록으로 남긴다.
//
// 수정 전후 비교용이다. krausest와 달리 paint는 재지 않고(같은 DOM을 그리면 수정과 무관하게 같다) 창을
// 띄우지 않는다. 최종 수치는 ./bench-krausest.sh로 확인한다.
//
// 스크립트 시간은 잴 클릭 하나를 performance.now()로 감싼다 - 핸들러부터 DOM 생성까지 동기로 끝나므로
// krausest의 script 구간과 같은 범위다. 교차 출처 격리가 없어 performance.now()가 0.1ms 단위로 거칠다.
// 힙은 1k 생성 후 GC를 강제하고 읽는다(krausest 22_run-memory와 같은 시점).
//
// 보통 ./bench-krausest-quick.sh가 번들을 만들어 부른다. 직접 부를 때:
//   node bench-krausest/quick.mjs 번들.js 기록.json
import { readFileSync, writeFileSync } from "node:fs";
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

const [bundlePath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("사용: node bench-krausest/quick.mjs 번들.js 기록.json");
  process.exit(1);
}
const code = readFileSync(bundlePath, "utf8");
const times = OPS.map(() => []);
const heaps = [];

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

const openPage = async (browser) => {
  const page = await browser.newPage();
  await page.setContent(HTML);
  await page.addScriptTag({ content: code });
  return page;
};

const browser = await chromium.launch({ headless: true });
for (let round = 0; round < ROUNDS; round++) {
  for (let i = 0; i < OPS.length; i++) {
    const page = await openPage(browser);
    for (let w = 0; w < WARMUP; w++) {
      await click(page, ["#run", "#clear"]);
    }
    await click(page, OPS[i].setup);
    times[i].push(await timeClick(page, OPS[i].measure));
    await page.close();
  }
  const page = await openPage(browser);
  await click(page, ["#run"]);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  heaps.push(usedSize / 1024 / 1024);
  await page.close();
}
await browser.close();

const rows = [
  ...OPS.map((op, i) => ({ label: `${op.name} (ms)`, digits: 2, values: times[i] })),
  { label: "heap after 1k (MB)", digits: 3, values: heaps },
];
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, rows }, null, 2));
