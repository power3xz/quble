<script>
  import Badge from "./Badge.svelte";
  // quble 동작에 맞춤: enabled는 문자열이라 @if 불변(항상 켜짐), 클릭은 label 텍스트만 마킹.
  let { label: initialLabel, desc, badge } = $props();
  let label = $state(initialLabel);
  const mark = (text, suffix) => (text.endsWith(suffix) ? text.slice(0, -suffix.length) : text + suffix);
</script>

<div class="row">
  <div class="row__text">
    <div class="row__label">{label}</div>
    <p class="row__desc">{desc}</p>
  </div>
  <div class="row__control">
    <Badge role={badge} theme="badge--on" />
    <button class="switch switch--on" onclick={() => (label = mark(label, " [ON]"))}>켜짐</button>
  </div>
</div>
