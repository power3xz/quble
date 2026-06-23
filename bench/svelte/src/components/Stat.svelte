<script>
  let { label, value } = $props();
</script>

<div class="stat">
  <span class="value">{value}</span>
  <span class="label">{label}</span>
</div>

<style>
  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
  }

  .value {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.2;
  }

  .label {
    font-size: 12px;
    color: #8a8f98;
    margin-top: 2px;
  }
</style>
