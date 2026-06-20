// 범용 부트스트랩 — /svelte/<Name> 의 <Name>을 URL에서 읽어 views/<Name>.svelte를 동적 import 해
// mount한다. 뷰는 자기완결(props 없음). 새 뷰는 views/에 파일만 추가하면 된다.
import { mount } from "svelte";

const name = location.pathname.split("/").filter(Boolean).pop();

import(`./views/${name}.svelte`).then((mod) => {
  mount(mod.default, { target: document.getElementById("root") });
});
