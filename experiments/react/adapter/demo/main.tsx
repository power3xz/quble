import { createComponent } from "quble/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { mount } from "../../../../core/web/runtime-entry.ts";
import OrdersBytecode from "./orders.qubc";
import { makeOrdersData, type TOrdersData } from "./orders-data.ts";
import { bulk, ordersHandlers } from "./orders-handlers.ts";

// 모듈 최상위에서 한 번만 만든다.
const Orders = createComponent(OrdersBytecode);

// 같은 import를 React 없이 순수 mount로 그린다.
const PlainMount = ({ data }: { data: TOrdersData }) => {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const inst = mount(OrdersBytecode, container.current as HTMLDivElement, { data, handlers: ordersHandlers });
    return () => inst.destroy();
  }, [data]);
  return <div ref={container} />;
};

// 자식의 mount가 끝난 뒤(자식 이펙트 다음의 부모 이펙트)에 시작부터 걸린 시간을 알린다.
const Timed = ({
  startedAt,
  onDone,
  children,
}: {
  startedAt: number;
  onDone: (ms: number) => void;
  children: ReactNode;
}) => {
  useEffect(() => {
    onDone(performance.now() - startedAt);
  }, [startedAt, onDone]);
  return <>{children}</>;
};

const App = () => {
  const [n, setN] = useState(1000);
  const [mode, setMode] = useState<"adapter" | "plain">("adapter");
  const [shown, setShown] = useState(true);
  const [startedAt, setStartedAt] = useState(() => performance.now());
  const [ms, setMs] = useState<number | null>(null);
  const data = useMemo(() => {
    const made = makeOrdersData(n);
    bulk.base = made.data.rows;
    bulk.bumped = made.bumped;
    return made.data;
  }, [n]);

  // 바꾸기 전에 시작 시각을 적어 둔다 - mount가 끝난 뒤 Timed가 걸린 시간을 알린다.
  const restart = (change: () => void) => {
    setStartedAt(performance.now());
    setMs(null);
    change();
  };

  return (
    <>
      <header className="hud">
        <div className="hud__bar">
          <strong className="hud__title">quble (React adapter)</strong>
          <label>
            행 수{" "}
            <select className="ctl" value={n} onChange={(e) => restart(() => setN(Number(e.target.value)))}>
              {[100, 1000, 10000].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="radio" checked={mode === "adapter"} onChange={() => restart(() => setMode("adapter"))} />{" "}
            createComponent
          </label>
          <label>
            <input type="radio" checked={mode === "plain"} onChange={() => restart(() => setMode("plain"))} /> 순수
            mount
          </label>
          <button type="button" className="btn" onClick={() => restart(() => setShown((s) => !s))}>
            {shown ? "unmount" : "mount"}
          </button>
          <span className="hud__status">{ms === null ? "" : `mount ${ms.toFixed(1)} ms`}</span>
        </div>
      </header>
      <main id="app">
        {shown && (
          <Timed startedAt={startedAt} onDone={setMs}>
            {mode === "adapter" ? <Orders {...data} handlers={ordersHandlers} /> : <PlainMount data={data} />}
          </Timed>
        )}
      </main>
    </>
  );
};

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
