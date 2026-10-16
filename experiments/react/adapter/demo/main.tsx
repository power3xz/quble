import { createComponent } from "quble/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { mount } from "../../../../core/web/runtime-entry.ts";
import CounterBytecode from "./counter.qubc";

// 모듈 최상위에서 한 번만 만든다.
const Counter = createComponent<{ label: string; count: number }>(CounterBytecode);

// 같은 import를 React 없이 순수 mount로 그린다.
const PlainMount = () => {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const inst = mount(CounterBytecode, container.current as HTMLDivElement, {
      data: { label: "plain mount", count: 7 },
    });
    return () => inst.destroy();
  }, []);
  return <div ref={container} />;
};

const App = () => {
  const [count, setCount] = useState(0);
  const [label, setLabel] = useState("add");
  return (
    <>
      <section>
        <h2>
          <code>createComponent(bytecode)</code>
        </h2>
        <Counter label={label} count={count} handlers={{ CLICK: () => setCount((c) => c + 1) }} />
      </section>
      <section>
        <h2>label을 바꾸면 props가 바뀌어 다시 mount</h2>
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </section>
      <section>
        <h2>
          순수 <code>mount(bytecode, container, ...)</code>
        </h2>
        <PlainMount />
      </section>
    </>
  );
};

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
