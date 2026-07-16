<script>
  // forstress.qubc의 ProfileCard에 대응. 클릭 시 3뎁스 회차 인덱스를 콘솔에 찍는다
  // (Quble의 $0/$1/$2 fullname에 대응).
  let { i, j, k } = $props();

  const onClick = () => {
    console.log("card clicked", { $0: i, $1: j, $2: k });
  };
</script>

<div class="card" onclick={onClick}>
  <div class="card__name">Jane Doe</div>
  <div class="card__job">Engineer</div>
  <div class="card__loc">Seoul</div>
</div>
