<script>
  import SettingRow from "./SettingRow.svelte";
  // quble 동작에 맞춤: open은 문자열이라 @if 불변(항상 열림), 클릭은 title 텍스트만 마킹.
  let {
    title: initialTitle,
    aLabel, aDesc, aBadge,
    bLabel, bDesc, bBadge,
  } = $props();
  let title = $state(initialTitle);
  const mark = (text, suffix) => (text.endsWith(suffix) ? text.slice(0, -suffix.length) : text + suffix);
</script>

<section class="section">
  <header class="section__head" onclick={() => (title = mark(title, " (접힘)"))}>
    <h2 class="section__title">{title}</h2>
    <span class="section__chevron section__chevron--open">접기</span>
  </header>
  <div class="section__body">
    <SettingRow label={aLabel} desc={aDesc} badge={aBadge} />
    <SettingRow label={bLabel} desc={bDesc} badge={bBadge} />
  </div>
</section>
