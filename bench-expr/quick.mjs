// bench-expr quble 페이지를 서버 여럿에서 headless Chromium으로 열어 mount, 힙, 클릭 시간을 비교한다.
//
// 수정 전후 비교용이다. 사람이 누르는 페이지(quble.html)를 그대로 연다 - mount 시간과 클릭 시간은
// 하네스가 재서 localStorage에 넣은 결과를 읽고, 힙만 여기서 mount 직후 GC를 강제하고 읽는다.
// 클릭 시간은 하네스의 DOM 반영 시간(클릭부터 MutationObserver까지)이다.
//
// 보통 ./bench-expr-quick.sh가 두 빌드를 띄우고 부른다. 서버를 직접 넘길 때:
//   node bench-expr/quick.mjs 이름=http://localhost:포트 [이름=http://localhost:포트 ...]
import { chromium } from "playwright";

const ROUNDS = 5;
const N = 10000;
// 하네스 SCENARIOS와 같은 키와 순서. 표의 열을 padEnd로 맞추므로 라벨도 키 그대로 둔다(한글은 폭이 2칸).
const SCENARIOS = ["inc", "rate", "threshold", "pivot", "pivotPrice"];
const RESULT_KEY = `quble|${N}|none`;

const targets = process.argv.slice(2).map((arg) => {
  const [name, url] = arg.split("=");
  return { name, url, mount: [], heap: [], clicks: SCENARIOS.map(() => []) };
});
if (targets.length === 0) {
  console.error("사용: node bench-expr/quick.mjs 이름=http://localhost:포트 [이름=http://localhost:포트 ...]");
  process.exit(1);
}

const readResult = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem("bench-expr-pivot"))[key], RESULT_KEY);

const browser = await chromium.launch({ headless: true });
for (let round = 0; round < ROUNDS; round++) {
  // 회차마다 서버를 번갈아 재 시간에 따른 흔들림이 한쪽에만 쏠리지 않게 한다.
  for (const t of targets) {
    // 새 페이지는 새 컨텍스트라 localStorage가 비어 있다 - 앞 회차 결과가 섞이지 않는다.
    const page = await browser.newPage();
    await page.goto(`${t.url}/quble.html?n=${N}`);
    await page.waitForSelector(".btn--primary:not([disabled])");
    t.mount.push((await readResult(page)).load.mounted);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await cdp.send("Runtime.getHeapUsage");
    t.heap.push(usedSize / 1024 / 1024);
    await page.click(".btn--primary");
    await page.waitForFunction(() => document.querySelector(".hud__status")?.textContent?.startsWith("완료"), null, {
      timeout: 300000,
    });
    const { clicks } = await readResult(page);
    SCENARIOS.forEach((key, i) => {
      t.clicks[i].push(clicks[key].dom);
    });
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
// 첫 서버 대비 중앙값 차이.
const diff = (xs, base) => {
  const d = ((median(xs) - median(base)) / median(base)) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
};
const line = (label, pick, digits) => [
  label,
  ...targets.map((t, k) => cell(pick(t), digits) + (k > 0 ? ` ${diff(pick(t), pick(targets[0]))}` : "")),
];

const rows = [["", ...targets.map((t) => t.name)]];
rows.push(line(`mount ${N / 1000}k (ms)`, (t) => t.mount, 1));
rows.push(line("heap after mount (MB)", (t) => t.heap, 2));
SCENARIOS.forEach((key, i) => {
  rows.push(line(`click ${key} (ms)`, (t) => t.clicks[i], 3));
});
const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
console.log(`${ROUNDS}회 중앙값 (최소~최대). 클릭은 페이지마다 하네스가 낸 30회 중앙값의 중앙값`);
for (const r of rows) {
  console.log(r.map((v, c) => v.padEnd(widths[c])).join("  "));
}
