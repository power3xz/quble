<script>
  // forstress.qubc의 Depth2: @for (b of 100). 각 회차가 Depth3.
  import StressDepth3 from "./StressDepth3.svelte";

  let { i, count, inner } = $props();

  const rounds = Array.from({ length: count }, (_, j) => j);
</script>

{#each rounds as j}
  <StressDepth3 {i} {j} count={inner} />
{/each}
