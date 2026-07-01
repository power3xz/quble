<script>
  import SettingRow from "./SettingRow.svelte";
  let {
    title, open,
    aLabel, aDesc, aBadge, aEnabled,
    bLabel, bDesc, bBadge, bEnabled,
  } = $props();
  let isOpen = $state(open);
</script>

<section class="section">
  <header class="section__head" onclick={() => (isOpen = !isOpen)}>
    <h2 class="section__title">{title}</h2>
    {#if isOpen}
      <span class="section__chevron section__chevron--open">접기</span>
    {:else}
      <span class="section__chevron">펼치기</span>
    {/if}
  </header>
  {#if isOpen}
    <div class="section__body">
      <SettingRow label={aLabel} desc={aDesc} badge={aBadge} enabled={aEnabled} />
      <SettingRow label={bLabel} desc={bDesc} badge={bBadge} enabled={bEnabled} />
    </div>
  {/if}
</section>
