// React, memo 없이 흔히 쓰는 모양. 상태가 바뀌면 App부터 모든 Row가 다시 렌더된다.
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { nextRate, nextThreshold, runTarget } from "./harness.ts";

const Row = ({ row, rate, tax, threshold, onInc }) => (
  <div className="row">
    <span className="row__id">{row.id}</span>
    <span className="row__price">{row.price}</span>
    <span className="row__qty">{row.qty}</span>
    <span className="row__amount">{(((row.price * row.qty - row.discount) * (100 + tax)) / 100) * rate}</span>
    <span className="row__left">{row.stock - row.qty}</span>
    <span className="row__warn" data-warn={String(row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold)}>
      !
    </span>
    <button className="row__inc" onClick={onInc}>
      +1
    </button>
  </div>
);

const App = ({ data }) => {
  const [rows, setRows] = useState(data.rows);
  const [rate, setRate] = useState(data.rate);
  const [threshold, setThreshold] = useState(data.threshold);
  const tax = data.tax;
  return (
    <div className="orders">
      <div className="orders__bar">
        <button id="btn-rate" onClick={() => setRate(nextRate)}>
          환율 변경
        </button>
        <button id="btn-threshold" onClick={() => setThreshold(nextThreshold)}>
          기준 변경
        </button>
        <span className="orders__info">
          환율 <span className="orders__rate">{rate}</span> / 기준 <span className="orders__threshold">{threshold}</span>
        </span>
      </div>
      <div className="orders__list">
        {rows.map((row, i) => (
          <Row
            key={row.id}
            row={row}
            rate={rate}
            tax={tax}
            threshold={threshold}
            onInc={() => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, qty: r.qty + 1 } : r)))}
          />
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
