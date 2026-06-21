<script>
  // Svelte 5 @if swap 비교 — 무거운 가지(가지당 1000행)를 {#if}로 조건부 렌더.
  // then=sharedA(.row.a), else=sharedB(.row.b). heavyif.qubc·React HeavyIf와 동일 구조.
  // 세 벤치: swap(show 토글), set(보이는 가지 값++), build(mount/unmount).
  import { flushSync, mount, unmount } from "svelte";
  import Rows from "./HeavyRows.svelte";

  const ROWS = 1000;
  const keys = Array.from({ length: ROWS }, (_, i) => i);

  let show = $state(true);
  let a = $state(0);
  let b = $state(0);
  let log = $state("준비됨 — 버튼을 눌러 측정.");

  const append = (line) => { log += "\n" + line; };

  function benchSwap() {
    const runs = 101; // 홀수 — 끝나고 가지가 바뀐 채로 남아 화면에서 swap이 보인다
    for (let i = 0; i < 10; i++) { show = !show; flushSync(); }
    const start = performance.now();
    for (let i = 0; i < runs; i++) { show = !show; flushSync(); }
    const end = performance.now();
    append(`swap(show) ${runs}회: 평균 ${((end - start) / runs).toFixed(4)}ms (총 ${(end - start).toFixed(1)}ms)`);
  }

  function benchSet() {
    const runs = 100;
    const bump = show ? () => a++ : () => b++;
    for (let i = 0; i < 10; i++) { bump(); flushSync(); }
    const start = performance.now();
    for (let i = 0; i < runs; i++) { bump(); flushSync(); }
    const end = performance.now();
    append(`set(보이는 가지 ${ROWS}행) ${runs}회: 평균 ${((end - start) / runs).toFixed(4)}ms (총 ${(end - start).toFixed(1)}ms)`);
  }

  function benchBuild() {
    const runs = 100;
    // 매번 detached 호스트에 mount(한 가지만) 후 unmount.
    const make = () => {
      const host = document.createElement("div");
      const app = mount(Rows, { target: host, props: { keys, rowClass: "row a", tag: "A", value: 0 } });
      flushSync();
      unmount(app);
    };
    for (let i = 0; i < 5; i++) make();
    const start = performance.now();
    for (let i = 0; i < runs; i++) make();
    const end = performance.now();
    append(`build(mount, 한 가지 ${ROWS}행) ${runs}회: 평균 ${((end - start) / runs).toFixed(4)}ms (총 ${(end - start).toFixed(1)}ms)`);
  }
</script>

<h3>Svelte @if swap — 무거운 가지 {ROWS}행 (Svelte 5)</h3>
<p>
  <button onclick={benchSwap}>swap(show) ×100</button>
  <button onclick={benchSet}>set(보이는 값) ×100</button>
  <button onclick={benchBuild}>build ×100</button>
</p>
<pre id="log">{log}</pre>
<div class="heavy">
  {#if show}
    <Rows {keys} rowClass="row a" tag="A" value={a} />
  {:else}
    <Rows {keys} rowClass="row b" tag="B" value={b} />
  {/if}
</div>
