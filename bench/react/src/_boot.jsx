// 범용 부트스트랩 — /react/<Name> 의 <Name>을 URL에서 읽어 views/<Name>.jsx를 동적 import 해
// createRoot로 렌더한다. 컴포넌트는 자기완결(props 없음). 새 뷰는 views/에 파일만 추가하면 된다.
import { createElement } from "react";
import { createRoot } from "react-dom/client";

// 보통은 /react/<Name> 경로 끝에서 뷰명을 읽지만, 다른 페이지(좌우 비교 html 등)에
// 직접 임베드할 땐 window.__VIEW__ 로 뷰명을 지정한다.
const name = window.__VIEW__ ?? location.pathname.split("/").filter(Boolean).pop();

import(`./views/${name}.jsx`).then((mod) => {
  const t0 = performance.now();
  createRoot(document.getElementById("root")).render(createElement(mod.default));
  const t1 = performance.now();
  const el = document.getElementById("log");
  if (el) el.textContent += `\n렌더: ${(t1 - t0).toFixed(1)}ms`;
});
