<script>
  let { icon, text, time } = $props();
</script>

<div class="act">
  <span class="icon">{icon}</span>
  <span class="text">{text}</span>
  <span class="time">{time}</span>
</div>

<style>
  .act {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
    font-size: 13px;
  }

  .icon {
    width: 16px;
    text-align: center;
  }

  .text {
    flex: 1;
  }

  .time {
    font-size: 11px;
    color: #a0a4ac;
  }
</style>
