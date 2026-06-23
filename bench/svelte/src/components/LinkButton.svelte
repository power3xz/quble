<script>
  let { link, theme } = $props();
</script>

<a class={theme} href={link}>프로필 보기</a>

<style>
  a {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
    text-decoration: none;
  }

  a.light {
    background: #e7eef7;
    color: #34537a;
  }

  a.dark {
    background: #2f3b4d;
    color: #b9c9de;
  }
</style>
