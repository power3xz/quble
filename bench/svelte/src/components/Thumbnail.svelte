<script>
  let { avatar, name } = $props();
</script>

<img class="avatar" src={avatar} alt={name} />

<style>
  .avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid rgba(255, 255, 255, 0.6);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  }
</style>
