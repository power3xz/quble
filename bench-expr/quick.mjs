// bench-expr quble 페이지 하나를 headless Chromium으로 열어 mount, 힙, 클릭 시간을 재고 기록으로 남긴다.
//
// 수정 전후 비교용이다. 사람이 누르는 페이지(quble.html, 테스트가 orders-deep이면 quble-deep.html)를 그대로 연다 - mount 시간과 클릭 시간은
// 하네스가 재서 localStorage에 넣은 결과를 읽고, 힙만 여기서 mount 직후 GC를 강제하고 읽는다.
// 클릭 시간은 하네스의 DOM 반영 시간(클릭부터 MutationObserver까지)이다.
//
// 보통 ./bench-expr-quick.sh가 빌드를 띄우고 부른다. 직접 부를 때:
//   node bench-expr/quick.mjs http://localhost:포트 기록.json [orders|orders-deep]
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const ROUNDS = 5;
// 행 수. 환경 변수 BENCH_N(1000, 5000, 10000)으로 줄여 빠르게 돌려 볼 수 있다. 기록 파일은 행 수가 달라도 같은
// 이름이니, 줄여 돌린 기록을 커밋 비교에 쓰지 않는다.
const N = Number(process.env.BENCH_N ?? 10000);
// 하네스 SCENARIOS와 같은 키와 순서. 표의 열을 padEnd로 맞추므로 라벨도 키 그대로 둔다(한글은 폭이 2칸).
const SCENARIOS = ["inc", "rate", "threshold", "pivot", "pivotPrice", "rateAndTax", "rateBurst", "bulk"];
// 테스트마다 페이지와 하네스가 결과를 담는 id가 다르다 - 결과가 서로 섞이지 않는다.
const TESTS = {
  orders: { page: "quble.html", id: "quble" },
  "orders-deep": { page: "quble-deep.html", id: "quble-deep" },
};

const [url, outPath, testName = "orders"] = process.argv.slice(2);
if (!outPath || !TESTS[testName]) {
  console.error("사용: node bench-expr/quick.mjs http://localhost:포트 기록.json [orders|orders-deep]");
  process.exit(1);
}
const { page: PAGE, id: TARGET_ID } = TESTS[testName];
const RESULT_KEY = `${TARGET_ID}|${N}|none`;
const mount = [];
const heap = [];
const clicks = SCENARIOS.map(() => []);
// 하네스가 결과에 적은 테스트 버전(bench-expr/tests.json). 회차마다 같다.
let version;

const readResult = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem("bench-expr-pivot"))[key], RESULT_KEY);

const browser = await chromium.launch({ headless: true });
for (let round = 0; round < ROUNDS; round++) {
  // 새 페이지는 새 컨텍스트라 localStorage가 비어 있다 - 앞 회차 결과가 섞이지 않는다.
  const page = await browser.newPage();
  await page.goto(`${url}/${PAGE}?n=${N}`);
  await page.waitForSelector(".btn--primary:not([disabled])");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  heap.push(usedSize / 1024 / 1024);
  await page.click(".btn--primary");
  await page.waitForFunction(() => document.querySelector(".hud__status")?.textContent?.startsWith("완료"), null, {
    timeout: 300000,
  });
  // 하네스는 측정을 마쳐야 로드와 클릭을 함께 저장한다.
  const result = await readResult(page);
  version = result.version;
  mount.push(result.load.mounted);
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
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, test: testName, version, n: N, rows }, null, 2));
