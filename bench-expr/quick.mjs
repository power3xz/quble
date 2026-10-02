// bench-expr quble 페이지 하나를 headless Chromium으로 열어 mount, 힙, 클릭 시간을 재고 기록으로 남긴다.
//
// 수정 전후 비교용이다. 사람이 누르는 페이지(quble.html)를 그대로 연다 - mount 시간과 클릭 시간은
// 하네스가 재서 localStorage에 넣은 결과를 읽고, 힙만 여기서 mount 직후 GC를 강제하고 읽는다.
// 클릭 시간은 하네스의 DOM 반영 시간(클릭부터 MutationObserver까지)이다.
//
// 보통 ./bench-expr-quick.sh가 빌드를 띄우고 부른다. 직접 부를 때:
//   node bench-expr/quick.mjs http://localhost:포트 기록.json
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const ROUNDS = 5;
const N = 10000;
// 하네스 SCENARIOS와 같은 키와 순서. 표의 열을 padEnd로 맞추므로 라벨도 키 그대로 둔다(한글은 폭이 2칸).
const SCENARIOS = ["inc", "rate", "threshold", "pivot", "pivotPrice"];
const RESULT_KEY = `quble|${N}|none`;

const [url, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("사용: node bench-expr/quick.mjs http://localhost:포트 기록.json");
  process.exit(1);
}
const mount = [];
const heap = [];
const clicks = SCENARIOS.map(() => []);

const readResult = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem("bench-expr-pivot"))[key], RESULT_KEY);

const browser = await chromium.launch({ headless: true });
for (let round = 0; round < ROUNDS; round++) {
  // 새 페이지는 새 컨텍스트라 localStorage가 비어 있다 - 앞 회차 결과가 섞이지 않는다.
  const page = await browser.newPage();
  await page.goto(`${url}/quble.html?n=${N}`);
  await page.waitForSelector(".btn--primary:not([disabled])");
  mount.push((await readResult(page)).load.mounted);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  heap.push(usedSize / 1024 / 1024);
  await page.click(".btn--primary");
  await page.waitForFunction(() => document.querySelector(".hud__status")?.textContent?.startsWith("완료"), null, {
    timeout: 300000,
  });
  const result = await readResult(page);
  SCENARIOS.forEach((key, i) => {
    clicks[i].push(result.clicks[key].dom);
  });
  await page.close();
}
await browser.close();

// 클릭 값은 페이지마다 하네스가 낸 30회 중앙값이다.
const rows = [
  { label: `mount ${N / 1000}k (ms)`, digits: 1, values: mount },
  { label: "heap after mount (MB)", digits: 2, values: heap },
  ...SCENARIOS.map((key, i) => ({ label: `click ${key} (ms)`, digits: 3, values: clicks[i] })),
];
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, rows }, null, 2));
