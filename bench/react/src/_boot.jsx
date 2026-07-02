// 범용 부트스트랩 — /react/<Name> 의 <Name>을 URL에서 읽어 views/<Name>.jsx를 동적 import 해
// createRoot로 렌더한다. 컴포넌트는 자기완결(props 없음). 새 뷰는 views/에 파일만 추가하면 된다.
import { createElement } from "react";
import { createRoot } from "react-dom/client";

// 보통은 /react/<Name> 경로 끝에서 뷰명을 읽지만, 다른 페이지(좌우 비교 html 등)에
// 직접 임베드할 땐 window.__VIEW__ 로 뷰명을 지정한다.
const name = window.__VIEW__ ?? location.pathname.split("/").filter(Boolean).pop();

// 뷰를 변수 경로로 동적 import 하면 Vite가 그 청크의 CSS <link>를 자동 주입하지 못한다.
// 뷰와 같은 이름의 <Name>.css를 직접 건다(스타일 없는 뷰는 404지만 무해).
const css = document.createElement("link");
css.rel = "stylesheet";
css.href = `/react/assets/${name}.css`;
document.head.appendChild(css);

import(`./views/${name}.jsx`).then((mod) => {
  const root = createRoot(document.getElementById("root"));
  root.render(createElement(mod.default));
});
