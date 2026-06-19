import { mount } from "svelte";
import Perf from "./Perf.svelte";

const t0 = performance.now();
mount(Perf, { target: document.getElementById("root") });
const t1 = performance.now();
// 렌더 시간은 Svelte가 관리하지 않는 별도 노드(#rendertime)에 쓴다 — 컴포넌트 #log와 충돌 방지.
document.getElementById("rendertime").textContent = `렌더 10000개: ${(t1 - t0).toFixed(1)}ms`;
