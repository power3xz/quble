// Next.js(Pages Router)에서 createComponent를 서버 렌더하는 최소 페이지. 서버가 HTML을 내고 브라우저가 resume한다.
import dynamic from "next/dynamic";
import { createComponent } from "quble/react";
import { useState } from "react";
import CounterBytecode from "../../fixtures/counter.qubc";

// 모듈 최상위에서 한 번만 만든다.
const Counter = createComponent(CounterBytecode);

// 서버 HTML 없이 브라우저에서만 그린다(mount).
const CsrCounter = dynamic(() => import("../csr-counter"), { ssr: false });

export default function Page() {
  const [count, setCount] = useState(1);
  return (
    <main>
      <h2>SSR + React 상태가 props를 바꾼다</h2>
      {/* 핸들러 맵은 마운트할 때의 것을 쓴다. setCount는 바뀌지 않으므로 충분하다. */}
      <Counter label="React" count={count} handlers={{ CLICK: () => setCount((c) => c + 1) }} />
      <h2>SSR + 핸들러가 update로 올린다</h2>
      <Counter
        label="update"
        count={1}
        handlers={{ CLICK: (_data, { props, get, update }) => update({ count: get(props.count) + 1 }) }}
      />
      <h2>CSR 전용 (서버 HTML 없음)</h2>
      <CsrCounter />
    </main>
  );
}
