// Solid. 행은 createStore의 프록시라 row.qty를 바꾸면 그 값을 읽은 자리만 다시 센다. 값 자리 하나가 효과
// 하나이고, 식이 읽는 값 중 하나라도 바뀌면 그 식을 처음부터 센다. 행은 컴포넌트 없이 For 안에 바로 쓴다
// (quble의 @for, Svelte의 each와 같은 조건). 한 핸들러에서 여러 번 쓰는 곳은 batch로 묶는다.
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
              <span class="row__price">{row.price}</span>
              <span class="row__qty">{row.qty}</span>
              <span class="row__amount">{(((row.price * row.qty - row.discount) * (100 + tax())) / 100) * rate()}</span>
              <span class="row__left">{row.stock - row.qty}</span>
              <span class="row__diff">{row.price - rows[pivot()].price}</span>
              <span class="row__warn" data-warn={String(row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold())}>
                !
              </span>
              <a class="row__link" href={row.url}>
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
  id: "solid",
  label: "Solid",
  mount: (root, data) => {
    render(() => <App data={data} />, root);
  },
});
