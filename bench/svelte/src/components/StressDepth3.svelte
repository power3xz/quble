<script>
  // forstress.qubc의 Depth3: @for (c of 100). 각 회차가 StressCard 하나.
  import StressCard from "./StressCard.svelte";

  let { i, j, count } = $props();

  const rounds = Array.from({ length: count }, (_, k) => k);
</script>

{#each rounds as k}
  <StressCard {i} {j} {k} />
{/each}
