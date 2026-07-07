<script>
  // forstress.qubc와 동일 구조로 맞춘다 (공정 비교).
  // Depth1 -> Depth2 -> Depth3 -> StressCard 3단 @for 중첩. 10 x 100 x 100 = 100,000 카드.
  import StressDepth2 from "../components/StressDepth2.svelte";
  import "../ForStress.css";

  const D1 = 10;
  const D2 = 100;
  const D3 = 100;

  const rounds = Array.from({ length: D1 }, (_, i) => i);
</script>

<div class="stress">
  <h1>svelte 부하: 10 x 100 x 100 = 100,000 카드</h1>
  {#each rounds as i}
    <StressDepth2 {i} count={D2} inner={D3} />
  {/each}
</div>
