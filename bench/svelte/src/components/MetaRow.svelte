<script>
  let { icon, text } = $props();
</script>

<p class="metarow">
  <span class="icon">{icon}</span>
  <span class="text">{text}</span>
</p>

<style>
  .metarow {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
    font-size: 13px;
    color: #5a5f68;
  }

  .icon {
    width: 16px;
    text-align: center;
  }
</style>
