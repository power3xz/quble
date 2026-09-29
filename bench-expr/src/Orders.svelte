<script>
  // Svelte 5. rows는 $state 깊은 프록시라 row.qty++가 그 행의 식만 다시 세게 한다.
  // 템플릿 식 하나가 효과 하나다 - 식이 읽는 값 중 하나라도 바뀌면 그 식을 처음부터 센다.
  import { nextRate, nextThreshold } from "./harness.ts";

  let { data } = $props();
  let rows = $state(data.rows);
  let rate = $state(data.rate);
  let threshold = $state(data.threshold);
  const tax = data.tax;
</script>

<div class="orders">
  <div class="orders__bar">
    <button id="btn-rate" onclick={() => (rate = nextRate(rate))}>환율 변경</button>
    <button id="btn-threshold" onclick={() => (threshold = nextThreshold(threshold))}>기준 변경</button>
    <span class="orders__info">
      환율 <span class="orders__rate">{rate}</span> / 기준 <span class="orders__threshold">{threshold}</span>
    </span>
  </div>
  <div class="orders__list">
    {#each rows as row (row.id)}
      <!-- 태그 사이 공백 텍스트 노드가 생기지 않게 한 줄로 이어 쓴다(다른 대상과 같은 마크업). -->
      <div class="row"><span class="row__id">{row.id}</span><span class="row__price">{row.price}</span><span class="row__qty">{row.qty}</span><span class="row__amount">{((row.price * row.qty - row.discount) * (100 + tax)) / 100 * rate}</span><span class="row__left">{row.stock - row.qty}</span><span class="row__warn" data-warn={String(row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold)}>!</span><button class="row__inc" onclick={() => row.qty++}>+1</button></div>
    {/each}
  </div>
</div>
