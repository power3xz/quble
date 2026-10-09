// React, memo 없이 흔히 쓰는 모양. 행은 컴포넌트 없이 map 안에 바로 쓴다(quble의 @for, Svelte의 each와 같은 조건).
// 상태가 바뀌면 App이 모든 행을 다시 그린다.
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { bulk, nextPivot, nextRate, nextThreshold, runTarget } from "./harness.ts";

const App = ({ data }) => {
  const [rows, setRows] = useState(data.rows);
  const [rate, setRate] = useState(data.rate);
  const [threshold, setThreshold] = useState(data.threshold);
  const [pivot, setPivot] = useState(data.pivot);
  const [tax, setTax] = useState(data.tax);
  return (
    <div className="orders">
      <div className="orders__bar">
        <button id="btn-rate" onClick={() => setRate(nextRate)}>
          환율 변경
        </button>
        <button id="btn-threshold" onClick={() => setThreshold(nextThreshold)}>
          기준 변경
        </button>
        <button id="btn-pivot" onClick={() => setPivot((p) => nextPivot(p, rows.length))}>
          기준 행 이동
        </button>
        <button
          id="btn-pivot-price"
          onClick={() => setRows((rs) => rs.map((r, j) => (j === pivot ? { ...r, price: r.price + 1 } : r)))}
        >
          기준 행 가격 변경
        </button>
        <button
          id="btn-rate-tax"
          onClick={() => {
            setRate((r) => r + 1);
            setTax((t) => t + 1);
          }}
        >
          환율+세율 동시 변경
        </button>
        <button
          id="btn-rate-burst"
          onClick={() => {
            setRate((r) => r + 1);
            setRate((r) => r + 1);
            setRate((r) => r + 1);
          }}
        >
          환율 연속 3회 변경
        </button>
        <button
          id="btn-bulk"
          onClick={() => setRows((rs) => (rs[0].price === bulk.base[0].price ? bulk.bumped : bulk.base))}
        >
          전체 행 일괄 갱신
        </button>
        <span className="orders__info">
          환율 <span className="orders__rate">{rate}</span> / 기준 <span className="orders__threshold">{threshold}</span> / 기준 행{" "}
          <span className="orders__pivot">{pivot}</span>
        </span>
      </div>
      <div className="orders__list">
        {rows.map((row, i) => (
          <div key={row.id} className="row">
            <span className="row__id">{row.id}</span>
            <span className="row__price">{row.price}</span>
            <span className="row__qty">{row.qty}</span>
            <span className="row__amount">{(((row.price * row.qty - row.discount) * (100 + tax)) / 100) * rate}</span>
            <span className="row__left">{row.stock - row.qty}</span>
            <span className="row__diff">{row.price - rows[pivot].price}</span>
            <span className="row__warn" data-warn={String(row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold)}>
              !
            </span>
            <a className="row__link" href={row.url}>
              link
            </a>
            <button
              className="row__inc"
              onClick={() => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, qty: r.qty + 1 } : r)))}
            >
              +1
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

runTarget({
  id: "react",
  label: "React",
  mount: (root, data) => {
    flushSync(() => createRoot(root).render(<App data={data} />));
  },
});
