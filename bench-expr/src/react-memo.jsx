// React 모범 사례 모양. Row를 memo로 감싸고, 클릭 핸들러를 useCallback으로 고정하고, 바뀐 행만
// 새 객체로 바꾼다. 그래서 행 +1은 그 행만 다시 렌더된다. 환율/기준은 모든 Row의 props가 바뀌어
// memo가 소용없다.
import { memo, useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { nextRate, nextThreshold, runTarget } from "./harness.ts";

const Row = memo(({ row, index, rate, tax, threshold, onInc }) => (
  <div className="row">
    <span className="row__id">{row.id}</span>
    <span className="row__price">{row.price}</span>
    <span className="row__qty">{row.qty}</span>
    <span className="row__amount">{(((row.price * row.qty - row.discount) * (100 + tax)) / 100) * rate}</span>
    <span className="row__left">{row.stock - row.qty}</span>
    <span className="row__warn" data-warn={String(row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold)}>
      !
    </span>
    <button className="row__inc" onClick={() => onInc(index)}>
      +1
    </button>
  </div>
));

const App = ({ data }) => {
  const [rows, setRows] = useState(data.rows);
  const [rate, setRate] = useState(data.rate);
  const [threshold, setThreshold] = useState(data.threshold);
  const tax = data.tax;
  const onInc = useCallback((i) => {
    setRows((rs) => {
      const next = rs.slice();
      next[i] = { ...rs[i], qty: rs[i].qty + 1 };
      return next;
    });
  }, []);
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
          <Row key={row.id} row={row} index={i} rate={rate} tax={tax} threshold={threshold} onInc={onInc} />
        ))}
      </div>
    </div>
  );
};

runTarget({
  id: "react-memo",
  label: "React + memo",
  mount: (root, data) => {
    flushSync(() => createRoot(root).render(<App data={data} />));
  },
});
