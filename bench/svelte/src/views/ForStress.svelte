<script>
  // forstress.qubc와 동일 구조로 맞춘다 (공정 비교).
  // Depth1 -> Depth2 -> Depth3 -> StressCard 3단 @for 중첩. 10 x 100 x 100 = 100,000 카드.
  import { onMount } from "svelte";
  import StressDepth2 from "../components/StressDepth2.svelte";
  import "../ForStress.css";

  // 초기 렌더 계측: 스크립트 진입(트리 생성 시작) -> onMount(DOM 부착 후) -> rAF(페인트 후).
  // 세 프레임워크(quble/react/svelte)를 같은 방식으로 재 나란히 비교한다.
  const t0 = performance.now();
  onMount(() => {
    const mounted = performance.now();
    requestAnimationFrame(() => {
      const painted = performance.now();
      console.log(
        `[svelte] 트리+마운트 ${(mounted - t0).toFixed(1)}ms, 페인트까지 ${(painted - t0).toFixed(1)}ms`,
      );
    });
  });

  const D1 = 1;
  const D2 = 50;
  const D3 = 100;

  let rows = $state(D1);
  const rounds = $derived(Array.from({ length: rows }, (_, i) => i));

  // 행 추가(+5,000 카드) 계측 - quble ADD 핸들러와 같은 방식(클릭 t0 -> rAF).
  const addRow = () => {
    const t = performance.now();
    rows += 1;
    requestAnimationFrame(() => {
      console.log(`[svelte] 행 추가(+5,000) ${(performance.now() - t).toFixed(1)}ms`);
    });
  };
</script>

<div class="stress">
  <h1>svelte 부하: rows x 50 x 100 카드</h1>
  <button class="stress__add" onclick={addRow}>행 추가 (+5,000 카드)</button>
  {#each rounds as i}
    <StressDepth2 {i} count={D2} inner={D3} />
  {/each}
</div>
