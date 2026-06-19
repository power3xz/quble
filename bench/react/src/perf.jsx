// React 갱신 퍼포먼스 — Box 1만 개 중 5000개가 부모 state(shared)를 props로 구독.
// 버튼 → setState → 5000개 리렌더(VDOM diff + DOM 쓰기). 나머지 5000개는 상수 props라
// React.memo로 리렌더 skip. reactive-perf.html(Quble set(shared))과 동일 시나리오.
import { useState, memo } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const N = 10000, HALF = N / 2;

// qubc Box와 동일 마크업: <div class={tone}>상태: {label}</div>
const Box = memo(function Box({ tone, label }) {
  return <div className={tone}>상태: {label}</div>;
});

// 상수 박스 5000개는 App 밖에서 한 번만 생성 → App 리렌더 시 재생성·재diff 없음.
// (요소 객체가 동일 참조라 React가 그 구간을 그대로 건너뛴다.)
const constBoxes = [];
for (let i = 0; i < HALF; i++) {
  constBoxes.push(<Box key={"c" + i} tone="ok" label={"고정" + i} />);
}

function App() {
  const [shared, setShared] = useState("공유0");
  let v = 0;

  const bench = () => {
    const runs = 100;
    // 워밍업
    for (let i = 0; i < 10; i++) flushSync(() => setShared("w" + v++));
    const start = performance.now();
    for (let i = 0; i < runs; i++) flushSync(() => setShared("x" + v++));
    const end = performance.now();
    const per = (end - start) / runs;
    const el = document.getElementById("log");
    el.textContent += `\nset(shared, 구독자 ${HALF}): ${runs}회 평균 ${per.toFixed(4)}ms/set (총 ${(end - start).toFixed(1)}ms)`;
  };

  // shared 구독 5000개만 App이 다룬다 — 매 리렌더의 diff 대상.
  const sharedBoxes = [];
  for (let i = 0; i < HALF; i++) {
    sharedBoxes.push(<Box key={"s" + i} tone="ok" label={shared} />);
  }

  return (
    <>
      <p><button onClick={bench}>set(shared) ×100</button></p>
      <pre id="log">준비됨 — 버튼을 눌러 측정.</pre>
      <div id="cards" style={{ fontSize: 10 }}>{sharedBoxes}{constBoxes}</div>
    </>
  );
}

const t0 = performance.now();
flushSync(() => createRoot(document.getElementById("root")).render(<App />));
const t1 = performance.now();
// 마운트 완료 후 로그에 렌더 시간 기록.
document.getElementById("log").textContent += `\n렌더 ${N}개: ${(t1 - t0).toFixed(1)}ms`;
