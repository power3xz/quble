// 데모용 주문 데이터. bench-expr/gen-data.mjs와 같은 난수식이라 같은 행 수면 같은 데이터가 나온다.

export type TRow = { id: number; price: number; qty: number; discount: number; stock: number; url: string };
export type TOrdersData = { rows: TRow[]; rate: number; tax: number; threshold: number; pivot: number };

export const makeOrdersData = (n: number): { data: TOrdersData; bumped: TRow[] } => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const rows: TRow[] = [];
  for (let i = 0; i < n; i++) {
    const qty = int(0, 10);
    const id = i + 1;
    rows.push({
      id,
      price: int(100, 10000),
      qty,
      discount: int(0, 500),
      stock: qty + int(0, 20),
      url: `https://example.com/item/${id}`,
    });
  }
  // 전체 행 일괄 갱신이 처음 데이터와 번갈아 넘기는 배열 - 모든 행의 네 값이 1씩 크다.
  const bumped = rows.map((r) => ({
    ...r,
    price: r.price + 1,
    qty: r.qty + 1,
    discount: r.discount + 1,
    stock: r.stock + 1,
    url: `${r.url}?v=1`,
  }));
  return { data: { rows, rate: 1300, tax: 10, threshold: 30000, pivot: 0 }, bumped };
};
