// 범용 CSR 진입점. 서버가 window.__CSR__ = { component, props }를 주입하면,
// 해당 컴포넌트를 동적 import 해서 props 객체를 그대로 넘겨 렌더한다.
// (우리 /csr/:id 의 React 대칭. React는 이름 기반 props라 query를 객체로 그대로 받는다.)
import { lazy, Suspense, createElement } from "react";
import { createRoot } from "react-dom/client";

// 컴포넌트명 → 모듈 로더. (컴포넌트 추가 시 등록)
const REGISTRY = {
  greeting: () => import("./Greeting.jsx"),
};

const { component, props = {} } = window.__CSR__ || {};
const load = REGISTRY[component];

const root = createRoot(document.getElementById("root"));
if (!load) {
  root.render(`알 수 없는 컴포넌트: ${component}`);
} else {
  const Comp = lazy(load);
  root.render(
    createElement(Suspense, { fallback: "로딩 중…" }, createElement(Comp, props))
  );
}
