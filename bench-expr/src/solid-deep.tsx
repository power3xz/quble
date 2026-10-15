// Solid에 deep 행(quble/orders-deep.qubc와 같은 DOM)을 그린다. 값 자리 사이에 정적 하위 트리, 깊은 값 자리,
// 정적 형제 줄이 낀다. 행은 solid.tsx처럼 컴포넌트 없이 For 안에 바로 쓴다. 결과는 solid와 따로 쌓인다.
import { batch, createSignal, For } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import { bulk, nextPivot, nextRate, nextThreshold, runTarget, type TData } from "./harness.ts";

const App = (props: { data: TData }) => {
  // store가 넘긴 객체를 직접 바꾸므로 bulk가 비교하는 data.rows를 건드리지 않게 복사한다.
  const [rows, setRows] = createStore(props.data.rows.map((r) => ({ ...r })));
  const [rate, setRate] = createSignal(props.data.rate);
  const [threshold, setThreshold] = createSignal(props.data.threshold);
  const [pivot, setPivot] = createSignal(props.data.pivot);
  const [tax, setTax] = createSignal(props.data.tax);
  let bumped = false;
  return (
    <div class="orders">
      <div class="orders__bar">
        <button id="btn-rate" onClick={() => setRate(nextRate)}>
          환율 변경
        </button>
        <button id="btn-threshold" onClick={() => setThreshold(nextThreshold)}>
          기준 변경
        </button>
        <button id="btn-pivot" onClick={() => setPivot((p) => nextPivot(p, rows.length))}>
          기준 행 이동
        </button>
        <button id="btn-pivot-price" onClick={() => setRows(pivot(), "price", (p) => p + 1)}>
          기준 행 가격 변경
        </button>
        <button
          id="btn-rate-tax"
          onClick={() =>
            batch(() => {
              setRate((r) => r + 1);
              setTax((t) => t + 1);
            })
          }
        >
          환율+세율 동시 변경
        </button>
        <button
          id="btn-rate-burst"
          onClick={() =>
            batch(() => {
              setRate((r) => r + 1);
              setRate((r) => r + 1);
              setRate((r) => r + 1);
            })
          }
        >
          환율 연속 3회 변경
        </button>
        <button
          id="btn-bulk"
          onClick={() => {
            bumped = !bumped;
            setRows(reconcile(bumped ? bulk.bumped : bulk.base, { key: "id", merge: true }));
          }}
        >
          전체 행 일괄 갱신
        </button>
        <span class="orders__info">
          환율 <span class="orders__rate">{rate()}</span> / 기준 <span class="orders__threshold">{threshold()}</span> / 기준 행{" "}
          <span class="orders__pivot">{pivot()}</span>
        </span>
      </div>
      <div class="orders__list">
        <For each={rows}>
          {(row, i) => (
            <div class="row">
              <span class="row__id">{row.id}</span>
              <div class="row__pad">
                <div>
                  <div>
                    <div>
                      <span>.</span>
                      <span>.</span>
                    </div>
                  </div>
                </div>
              </div>
              <span class="row__price">{row.price}</span>
              <div class="row__deep">
                <div>
                  <div>
                    <div>
                      <span class="row__qty">{row.qty}</span>
                    </div>
                  </div>
                </div>
              </div>
              <span class="row__amount">{(((row.price * row.qty - row.discount) * (100 + tax())) / 100) * rate()}</span>
              <ul class="row__meta">
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
              <span class="row__left">{row.stock - row.qty}</span>
              <span class="row__diff">{row.price - rows[pivot()].price}</span>
              <span class="row__warn" data-warn={String(row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold())}>
                !
              </span>
              <a class="row__link" href={row.url} data-p={row.price} data-q={row.qty}>
                link
              </a>
              <button class="row__inc" onClick={() => setRows(i(), "qty", (q) => q + 1)}>
                +1
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

runTarget({
  id: "solid-deep",
  label: "Solid (deep)",
  mount: (root, data) => {
    render(() => <App data={data} />, root);
  },
});
