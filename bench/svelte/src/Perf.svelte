<script>
  // Svelte 5 갱신 퍼포먼스 — Box 1만 개 중 5000개가 shared($state)를 구독.
  // shared 변경 → signal 구독자(5000개)만 직접 갱신(VDOM 없음). 나머지 5000개는 상수.
  // reactive-perf.html(Quble)·react-perf.html(React)과 동일 시나리오.
  import { flushSync } from "svelte";
  import Box from "./Box.svelte";

  const N = 10000, HALF = N / 2;
  let shared = $state("공유0");
  let log = $state("준비됨 — 버튼을 눌러 측정.");

  const consts = Array.from({ length: HALF }, (_, i) => "고정" + i);
  const sharedKeys = Array.from({ length: HALF }, (_, i) => i);

  let v = 0;
  function bench() {
    const runs = 100;
    // 워밍업
    for (let i = 0; i < 10; i++) { shared = "w" + v++; flushSync(); }
    const start = performance.now();
    for (let i = 0; i < runs; i++) { shared = "x" + v++; flushSync(); }
    const end = performance.now();
    const per = (end - start) / runs;
    log += `\nset(shared, 구독자 ${HALF}): ${runs}회 평균 ${per.toFixed(4)}ms/set (총 ${(end - start).toFixed(1)}ms)`;
  }
</script>

<h3>단일 갱신 퍼포먼스 — Box 1만 개 (Svelte 5)</h3>
<p>5000개는 shared($state)를 구독, 나머지 5000개는 상수. shared 변경 1회 → signal 구독자 5000개만 직접 갱신.
   flushSync로 동기 렌더 후 측정.</p>
<p><button onclick={bench}>set(shared) ×100</button></p>
<pre id="log">{log}</pre>
<div id="cards" style="font-size:10px">
  {#each sharedKeys as i (i)}
    <Box tone="ok" label={shared} />
  {/each}
  {#each consts as label (label)}
    <Box tone="ok" {label} />
  {/each}
</div>
