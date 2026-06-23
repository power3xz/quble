<script>
  let { text, theme } = $props();
</script>

<span class={theme}>#{text}</span>

<style>
  span {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
  }

  span.light {
    background: #e7eef7;
    color: #34537a;
  }

  span.dark {
    background: #2f3b4d;
    color: #b9c9de;
  }
</style>
