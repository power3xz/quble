// 빠른 비교 기록(bench-results/<커밋>.<벤치>.json)을 커밋별로 나란히 놓고 첫 커밋 대비 차이를 낸다.
//
// 기록은 ./bench-krausest-quick.sh, ./bench-expr-quick.sh가 커밋 하나를 잴 때마다 남긴다. 따로 잰 기록끼리
// 견주므로, 잰 시각이 멀면 그 사이 기계 상태의 차이가 섞인다 - 이어서 잰 기록끼리 본다.
//
// expr 계열은 환경 변수 BENCH_N(1000, 5000, 10000, 기본 1000)으로 행 수를 골라 그 행 수의 기록을 읽는다 -
// ./bench-expr-quick.sh를 같은 BENCH_N으로 돌린 기록이다. 10000이 아니면 기록 이름에 .1k, .5k가 붙는다.
//
// 사용: node bench-compare.mjs <krausest|expr|expr-deep> <ref> [ref ...]   예: node bench-compare.mjs expr HEAD~1 HEAD
//       BENCH_N=10000 node bench-compare.mjs expr HEAD~1 HEAD
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL(".", import.meta.url).pathname;
const [bench, ...refs] = process.argv.slice(2);
if (!["krausest", "expr", "expr-deep"].includes(bench) || refs.length === 0) {
  console.error("사용: node bench-compare.mjs <krausest|expr|expr-deep> <ref> [ref ...]");
  process.exit(1);
}
const BENCH_N = Number(process.env.BENCH_N ?? 1000);
if (![1000, 5000, 10000].includes(BENCH_N)) {
  console.error(`BENCH_N은 1000, 5000, 10000 중 하나다: ${BENCH_N}`);
  process.exit(1);
}
const suffix = bench === "krausest" || BENCH_N === 10000 ? "" : `.${BENCH_N / 1000}k`;

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
const records = refs.map((ref) => {
  const sha = git("rev-parse", "--short=7", ref);
  const path = `${ROOT}bench-results/${sha}.${bench}${suffix}.json`;
  if (!existsSync(path)) {
    const test = bench === "expr-deep" ? " orders-deep" : "";
    const quick = bench === "krausest" ? `./bench-krausest-quick.sh ${ref}` : `${BENCH_N === 1000 ? "" : `BENCH_N=${BENCH_N} `}./bench-expr-quick.sh ${ref}${test}`;
    console.error(`${ref}(${sha})의 ${bench}${suffix} 기록이 없다 - ${quick}로 잰다`);
    process.exit(1);
  }
  return { sha, subject: git("log", "-1", "--format=%s", sha), ...JSON.parse(readFileSync(path, "utf8")) };
});

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const cell = (xs, digits) => {
  const s = [...xs].sort((a, b) => a - b);
  return `${median(xs).toFixed(digits)} (${s[0].toFixed(digits)}~${s[s.length - 1].toFixed(digits)})`;
};
// 첫 기록 대비 중앙값 차이.
const diff = (xs, base) => {
  const d = ((median(xs) - median(base)) / median(base)) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
};

// expr 계열 기록에는 테스트 버전이 있다(bench-expr/tests.json). 버전이 다른 기록끼리는 같은 벤치 앱으로 잰 게
// 아니라 견줄 수 없다 - 첫 기록과 버전이 다르면 퍼센트를 내지 않는다. 버전 필드가 생기기 전 기록은 버전이 없다.
const versioned = bench !== "krausest";
const versionLabel = (r) => (!versioned ? "" : r.version === undefined ? "  버전 없음" : `  v${r.version}`);
const sameVersion = (r) => !versioned || r.version === records[0].version;

for (const r of records) {
  console.log(`${r.sha}  ${r.at}  ${r.rounds}회${versionLabel(r)}  ${r.subject}`);
}
const table = [["", ...records.map((r) => r.sha)]];
records[0].rows.forEach((row, i) => {
  table.push([
    row.label,
    ...records.map((r, k) => {
      const values = r.rows[i].values;
      if (k === 0) {
        return cell(values, row.digits);
      }
      return cell(values, row.digits) + (sameVersion(r) ? ` ${diff(values, row.values)}` : " (버전 다름)");
    }),
  ]);
});
const mismatched = records.filter((r) => !sameVersion(r));
if (mismatched.length > 0) {
  console.warn(`경고: ${mismatched.map((r) => r.sha).join(", ")}는 첫 기록(${records[0].sha})과 테스트 버전이 달라 퍼센트를 내지 않았다.`);
}
const widths = table[0].map((_, c) => Math.max(...table.map((r) => r[c].length)));
console.log("중앙값 (최소~최대)");
for (const r of table) {
  console.log(r.map((v, c) => v.padEnd(widths[c])).join("  "));
}
