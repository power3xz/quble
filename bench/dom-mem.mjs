// 실제 Chrome DOM 노드 메모리 측정 (CDP over 내장 WebSocket, puppeteer 없이).
// 빈 페이지 → N개 텍스트 노드 부착 전후의 렌더러 프로세스 메모리 차이를 본다.
//
// 실행: node dom_mem.mjs

import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// 이 프로파일로 뜬 Chrome renderer 프로세스들의 RSS 합(KB). C++ DOM 메모리는 여기 잡힌다.
const rendererRssKB = () => {
  const out = execSync(
    `ps -A -o rss,command | grep 'quble-dom-mem-profile' | grep -i 'renderer' | grep -v grep || true`,
    { encoding: "utf8" },
  );
  return out.trim().split("\n").filter(Boolean)
    .reduce((s, l) => s + parseInt(l.trim().split(/\s+/)[0], 10), 0);
};

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9222;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--headless=new",
  "--no-first-run",
  "--user-data-dir=/tmp/quble-dom-mem-profile",
  "about:blank",
], { stdio: "ignore" });

let id = 0;
const call = (ws, method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    const onMsg = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === mid) { ws.removeEventListener("message", onMsg); resolve(msg.result); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const evalJs = async (ws, expr) => {
  const r = await call(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

// 렌더러 프로세스 총 메모리(private) - CDP Memory.getBrowserSamplingProfile 대신
// Performance.getMetrics의 힙 + Memory.getDOMCounters로 노드수 확인.
const domCounters = async (ws) => call(ws, "Memory.getDOMCounters");

const run = async () => {
  // 포트 열릴 때까지 폴링
  let list;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch {}
  }
  if (!list) throw new Error("Chrome debug port never opened");
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener("open", res, { once: true }));

  await call(ws, "Runtime.enable");
  await call(ws, "Performance.enable");

  const heap = async () => {
    // precise GC 후 JS 힙
    await call(ws, "HeapProfiler.enable");
    await call(ws, "HeapProfiler.collectGarbage");
    const m = await call(ws, "Performance.getMetrics");
    const get = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
    return { jsHeap: get("JSHeapUsedSize"), nodes: get("Nodes") };
  };

  const measure = async (label, count) => {
    // 초기화 + 노드 부착
    await evalJs(ws, `
      document.body.innerHTML = "";
      (function(){
        const frag = document.createDocumentFragment();
        for (let i = 0; i < ${count}; i++) {
          const d = document.createElement("div");
          d.textContent = "member " + i;
          frag.appendChild(d);
        }
        document.body.appendChild(frag);
      })();
      document.body.childNodes.length;
    `);
    const h = await heap();
    await sleep(500);              // RSS 안정화
    const rss = rendererRssKB();
    return { label, count, ...h, rssKB: rss };
  };

  const mb = (b) => (b / 1024 / 1024).toFixed(2);
  console.log("label".padEnd(14), "count".padStart(9), "rendererRSS_MB".padStart(15), "perNode_B".padStart(11));

  const base = await measure("empty", 0);
  console.log("empty".padEnd(14), String(0).padStart(9), (base.rssKB / 1024).toFixed(1).padStart(15));
  for (const n of [10000, 50000, 120000, 500000]) {
    const r = await measure(`div×${n}`, n);
    const perNode = ((r.rssKB - base.rssKB) * 1024 / n).toFixed(0);
    console.log(
      r.label.padEnd(14),
      String(r.count).padStart(9),
      (r.rssKB / 1024).toFixed(1).padStart(15),
      `~${perNode}`.padStart(11),
      `  (+${((r.rssKB - base.rssKB) / 1024).toFixed(1)} MB over empty)`,
    );
  }

  ws.close();
  chrome.kill();
};

run().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
