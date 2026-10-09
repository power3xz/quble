// React 모범 사례 모양(memo)에 deep 행(quble/orders-deep.qubc와 같은 DOM)을 그린다. Row를 memo로 감싼다 - memo는
// 컴포넌트에만 걸려서 행을 인라인으로 쓸 수 없다. 결과는 react-memo와 따로 쌓인다.
import { memo, useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { bulk, nextPivot, nextRate, nextThreshold, runTarget } from "./harness.ts";

const Row = memo(({ row, index, pivotPrice, rate, tax, threshold, onInc }) => (
  <div className="row">
    <span className="row__id">{row.id}</span>
    <div className="row__pad">
      <div>
        <div>
          <div>
            <span>.</span>
            <span>.</span>
          </div>
        </div>
      </div>
    </div>
    <span className="row__price">{row.price}</span>
    <div className="row__deep">
      <div>
        <div>
          <div>
            <span className="row__qty">{row.qty}</span>
          </div>
        </div>
      </div>
    </div>
    <span className="row__amount">{(((row.price * row.qty - row.discount) * (100 + tax)) / 100) * rate}</span>
    <ul className="row__meta">
      <li>a</li>
      <li>b</li>
      <li>c</li>
      <li>d</li>
      <li>{row.stock}</li>
      <li>e</li>
      <li>f</li>
      <li>g</li>
      <li>h</li>
      <li>i</li>
      <li>{row.discount}</li>
    </ul>
    <span className="row__left">{row.stock - row.qty}</span>
    <span className="row__diff">{row.price - pivotPrice}</span>
    <span className="row__warn" data-warn={String(row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold)}>
      !
    </span>
    <a className="row__link" href={row.url} data-p={row.price} data-q={row.qty}>
      link
    </a>
    <button className="row__inc" onClick={() => onInc(index)}>
      +1
    </button>
  </div>
));

const App = ({ data }) => {
  const [rows, setRows] = useState(data.rows);
  const [rate, setRate] = useState(data.rate);
  const [threshold, setThreshold] = useState(data.threshold);
  const [pivot, setPivot] = useState(data.pivot);
  const [tax, setTax] = useState(data.tax);
  const onInc = useCallback((i) => {
    setRows((rs) => {
      const next = rs.slice();
      next[i] = { ...rs[i], qty: rs[i].qty + 1 };
      return next;
    });
  }, []);
  const onPivotPrice = () => {
    setRows((rs) => {
      const next = rs.slice();
      next[pivot] = { ...rs[pivot], price: rs[pivot].price + 1 };
      return next;
    });
  };
  const pivotPrice = rows[pivot].price;
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
        <button id="btn-pivot-price" onClick={onPivotPrice}>
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
          <Row
            key={row.id}
            row={row}
            index={i}
            pivotPrice={pivotPrice}
            rate={rate}
            tax={tax}
            threshold={threshold}
            onInc={onInc}
          />
        ))}
      </div>
    </div>
  );
};

runTarget({
  id: "react-memo-deep",
  label: "React + memo (deep)",
  mount: (root, data) => {
    flushSync(() => createRoot(root).render(<App data={data} />));
  },
});
