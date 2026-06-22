// React @if swap 비교 — 무거운 가지(가지당 1000행)를 조건부 렌더.
// then=sharedA(초록 .row.a), else=sharedB(빨강 .row.b). heavyif.qubc와 동일 구조.
// 세 벤치: swap(show 토글), set(보이는 가지 값++), build(새 root에 render).
import { useState, memo } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const ROWS = 1000;
const keys = Array.from({ length: ROWS }, (_, i) => i);

const Branch = memo(function Branch({ rowClass, tag, value }) {
  return (
    <>
      {keys.map((i) => (
        <div className={rowClass} key={i}>
          <span className="idx">#</span>
          <span className="label">{value}</span>
          <span className="tag">{tag}</span>
        </div>
      ))}
    </>
  );
});

function Heavy({ show, a, b }) {
  return (
    <div className="heavy">
      {show ? <Branch rowClass="row a" tag="A" value={a} /> : <Branch rowClass="row b" tag="B" value={b} />}
    </div>
  );
}

export default function App() {
  const [show, setShow] = useState(true);
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);

  const log = (line) => {
    document.getElementById("log").textContent += "\n" + line;
  };

  const benchSwap = () => {
    const runs = 101; // 홀수 — 끝나고 가지가 바뀐 채로 남아 화면에서 swap이 보인다
    for (let i = 0; i < 10; i++) flushSync(() => setShow((s) => !s));
    const start = performance.now();
    for (let i = 0; i < runs; i++) flushSync(() => setShow((s) => !s));
    const end = performance.now();
    log(`swap(show) ${runs}회: 평균 ${((end - start) / runs).toFixed(4)}ms (총 ${(end - start).toFixed(1)}ms)`);
  };

  const benchSet = () => {
    const runs = 100;
    // 현재 보이는 가지의 값만 증가
    const bump = show ? () => setA((v) => v + 1) : () => setB((v) => v + 1);
    for (let i = 0; i < 10; i++) flushSync(bump);
    const start = performance.now();
    for (let i = 0; i < runs; i++) flushSync(bump);
    const end = performance.now();
    log(`set(보이는 가지 ${ROWS}행) ${runs}회: 평균 ${((end - start) / runs).toFixed(4)}ms (총 ${(end - start).toFixed(1)}ms)`);
  };

  const benchBuild = () => {
    const runs = 100;
    // 매번 detached root에 새로 render(한 가지만 — React는 보이는 가지만 만든다).
    const make = () => {
      const host = document.createElement("div");
      const root = createRoot(host);
      flushSync(() => root.render(<Heavy show={true} a={0} b={0} />));
      root.unmount();
    };
    for (let i = 0; i < 5; i++) make();
    const start = performance.now();
    for (let i = 0; i < runs; i++) make();
    const end = performance.now();
    log(`build(render, 한 가지 ${ROWS}행) ${runs}회: 평균 ${((end - start) / runs).toFixed(4)}ms (총 ${(end - start).toFixed(1)}ms)`);
  };

  return (
    <>
      <h3>React @if swap — 무거운 가지 {ROWS}행 (React 18)</h3>
      <p>
        <button onClick={benchSwap}>swap(show) ×100</button>{" "}
        <button onClick={benchSet}>set(보이는 값) ×100</button>{" "}
        <button onClick={benchBuild}>build ×100</button>
      </p>
      <pre id="log">준비됨 — 버튼을 눌러 측정.</pre>
      <Heavy show={show} a={a} b={b} />
    </>
  );
}
