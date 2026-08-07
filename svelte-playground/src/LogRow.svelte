<script>
  // logrow.qubc와 같은 마크업.
  let { text, level } = $props();
</script>

<div class="logrow">
  <span class="logrow__level" data-level={level}>{level}</span>
  <span class="logrow__text">{text}</span>
</div>
