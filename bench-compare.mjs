// 빠른 비교 기록(bench-results/<커밋>.<벤치>.json)을 커밋별로 나란히 놓고 첫 커밋 대비 차이를 낸다.
//
// 기록은 ./bench-krausest-quick.sh, ./bench-expr-quick.sh가 커밋 하나를 잴 때마다 남긴다. 따로 잰 기록끼리
// 견주므로, 잰 시각이 멀면 그 사이 기계 상태의 차이가 섞인다 - 이어서 잰 기록끼리 본다.
//
// 사용: node bench-compare.mjs <krausest|expr> <ref> [ref ...]   예: node bench-compare.mjs expr HEAD~1 HEAD
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL(".", import.meta.url).pathname;
const [bench, ...refs] = process.argv.slice(2);
if (!["krausest", "expr"].includes(bench) || refs.length === 0) {
  console.error("사용: node bench-compare.mjs <krausest|expr> <ref> [ref ...]");
  process.exit(1);
}

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
const records = refs.map((ref) => {
  const sha = git("rev-parse", "--short=7", ref);
  const path = `${ROOT}bench-results/${sha}.${bench}.json`;
  if (!existsSync(path)) {
    console.error(`${ref}(${sha})의 ${bench} 기록이 없다 - ./bench-${bench}-quick.sh ${ref}로 잰다`);
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

for (const r of records) {
  console.log(`${r.sha}  ${r.at}  ${r.rounds}회  ${r.subject}`);
}
const table = [["", ...records.map((r) => r.sha)]];
records[0].rows.forEach((row, i) => {
  table.push([
    row.label,
    ...records.map((r, k) => {
      const values = r.rows[i].values;
      return cell(values, row.digits) + (k > 0 ? ` ${diff(values, row.values)}` : "");
    }),
  ]);
});
const widths = table[0].map((_, c) => Math.max(...table.map((r) => r[c].length)));
console.log("중앙값 (최소~최대)");
for (const r of table) {
  console.log(r.map((v, c) => v.padEnd(widths[c])).join("  "));
}
