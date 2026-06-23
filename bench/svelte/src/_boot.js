// 범용 부트스트랩 — /svelte/<Name> 의 <Name>을 URL에서 읽어 views/<Name>.svelte를 동적 import 해
// mount한다. 뷰는 자기완결(props 없음). 새 뷰는 views/에 파일만 추가하면 된다.
import { mount } from "svelte";

const name = location.pathname.split("/").filter(Boolean).pop();

// 뷰를 변수 경로로 동적 import 하면 Vite가 그 청크의 CSS <link>를 자동 주입하지 못한다.
// 뷰와 같은 이름의 <Name>.css를 직접 건다(스타일 없는 뷰는 404지만 무해).
const css = document.createElement("link");
css.rel = "stylesheet";
css.href = `/svelte/assets/${name}.css`;
document.head.appendChild(css);

import(`./views/${name}.svelte`).then((mod) => {
  mount(mod.default, { target: document.getElementById("root") });
});
