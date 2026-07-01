<script>
  import Badge from "./Badge.svelte";
  let { label, desc, badge, enabled } = $props();
  let on = $state(enabled);
</script>

<div class="row">
  <div class="row__text">
    <div class="row__label">{label}</div>
    <p class="row__desc">{desc}</p>
  </div>
  <div class="row__control">
    {#if on}
      <Badge role={badge} theme="badge--on" />
      <button class="switch switch--on" onclick={() => (on = !on)}>켜짐</button>
    {:else}
      <button class="switch switch--off" onclick={() => (on = !on)}>꺼짐</button>
    {/if}
  </div>
</div>
