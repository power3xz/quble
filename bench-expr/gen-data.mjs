// public/data-<N>.json을 만든다. 네 대상이 모두 같은 파일을 fetch한다.
// 난수는 시드 고정이라 매번 같은 데이터가 나온다.
import { mkdirSync, writeFileSync } from "node:fs";

let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

mkdirSync(new URL("./public", import.meta.url), { recursive: true });
for (const n of [1000, 5000, 10000]) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const qty = int(0, 10);
    rows.push({ id: i + 1, price: int(100, 10000), qty, discount: int(0, 500), stock: qty + int(0, 20) });
  }
  const data = { rows, rate: 1300, tax: 10, threshold: 30000 };
  writeFileSync(new URL(`./public/data-${n}.json`, import.meta.url), JSON.stringify(data));
}
