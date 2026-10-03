// canvas 실험의 메인 스레드 쪽. canvas를 Worker(worker.ts)에 넘기고 클릭, 휠, 크기 변경만 전한다.
// Worker가 알려 주는 mount 시간과 프레임 시간을 위쪽 막대에 보인다.

import { currentN } from "../../../../bench-expr/src/harness.ts";
// bench-expr DOM 페이지와 같은 스타일. Worker가 해석해 canvas에 맞춘다.
import css from "../../../../bench-expr/src/style.css?raw";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const info = document.getElementById("info") as HTMLElement;
const n = currentN();

const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight, dpr: devicePixelRatio });
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const offscreen = canvas.transferControlToOffscreen();
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
worker.postMessage({ type: "init", canvas: offscreen, n, base: location.href, css, dark, ...size() }, [offscreen]);

worker.onerror = (e) => {
  info.textContent = `Worker 오류: ${e.message}`;
};

let mountMs = 0;
worker.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "mounted") {
    mountMs = msg.mountMs;
  } else if (msg.type === "frame") {
    const click = msg.sinceClickMs < 0 ? "" : ` / 클릭부터 ${msg.sinceClickMs.toFixed(2)} ms`;
    info.textContent = `${n.toLocaleString()} 행 / mount ${mountMs.toFixed(1)} ms / 레이아웃 ${msg.layoutMs.toFixed(2)} ms / 그리기 ${msg.drawMs.toFixed(2)} ms${click}`;
  }
};

canvas.addEventListener("click", (e) => worker.postMessage({ type: "click", x: e.offsetX, y: e.offsetY }));
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    worker.postMessage({ type: "scroll", dy: e.deltaY });
  },
  { passive: false },
);
new ResizeObserver(() => worker.postMessage({ type: "resize", ...size() })).observe(canvas);
