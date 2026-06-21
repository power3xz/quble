<script>
  // 무거운 가지의 행 반복. HeavyIf의 {#if} 양 가지와 build 벤치 mount 대상이 공유한다.
  let { keys, rowClass, tag, value } = $props();
</script>

{#each keys as i (i)}
  <div class={rowClass}><span class="idx">#</span><span class="label">{value}</span><span class="tag">{tag}</span></div>
{/each}
