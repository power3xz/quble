// 범용 부트스트랩 — /react/<Name> 의 <Name>을 URL에서 읽어 views/<Name>.jsx를 동적 import 해
// createRoot로 렌더한다. 컴포넌트는 자기완결(props 없음). 새 뷰는 views/에 파일만 추가하면 된다.
import { createElement } from "react";
import { createRoot } from "react-dom/client";

const name = location.pathname.split("/").filter(Boolean).pop();

import(`./views/${name}.jsx`).then((mod) => {
  const t0 = performance.now();
  createRoot(document.getElementById("root")).render(createElement(mod.default));
  const t1 = performance.now();
  const el = document.getElementById("log");
  if (el) el.textContent += `\n렌더: ${(t1 - t0).toFixed(1)}ms`;
});
