<script>
  // Svelte 5. Orders.svelte와 같은 상태와 시나리오에 deep 행(quble/orders-deep.qubc와 같은 DOM)을 그린다.
  // 기본 행의 Orders.svelte가 달라지지 않게 따로 둔다.
  import { nextPivot, nextRate, nextThreshold } from "./harness.ts";

  let { data } = $props();
  let rows = $state(data.rows);
  let rate = $state(data.rate);
  let threshold = $state(data.threshold);
  let pivot = $state(data.pivot);
  let tax = $state(data.tax);
</script>

<div class="orders">
  <div class="orders__bar">
    <button id="btn-rate" onclick={() => (rate = nextRate(rate))}>환율 변경</button>
    <button id="btn-threshold" onclick={() => (threshold = nextThreshold(threshold))}>기준 변경</button>
    <button id="btn-pivot" onclick={() => (pivot = nextPivot(pivot, rows.length))}>기준 행 이동</button>
    <button id="btn-pivot-price" onclick={() => rows[pivot].price++}>기준 행 가격 변경</button>
    <button id="btn-rate-tax" onclick={() => { rate++; tax++; }}>환율+세율 동시 변경</button>
    <button id="btn-rate-burst" onclick={() => { rate++; rate++; rate++; }}>환율 연속 3회 변경</button>
    <button id="btn-bulk" onclick={() => { for (const r of rows) { r.price++; r.qty++; r.discount++; r.stock++; r.url += "1"; } }}>전체 행 일괄 갱신</button>
    <span class="orders__info">
      환율 <span class="orders__rate">{rate}</span> / 기준 <span class="orders__threshold">{threshold}</span> / 기준 행 <span class="orders__pivot">{pivot}</span>
    </span>
  </div>
  <div class="orders__list">
    {#each rows as row (row.id)}
      <!-- 태그 사이 공백 텍스트 노드가 생기지 않게 한 줄로 이어 쓴다(다른 대상과 같은 마크업). -->
      <div class="row"><span class="row__id">{row.id}</span><div class="row__pad"><div><div><div><span>.</span><span>.</span></div></div></div></div><span class="row__price">{row.price}</span><div class="row__deep"><div><div><div><span class="row__qty">{row.qty}</span></div></div></div></div><span class="row__amount">{((row.price * row.qty - row.discount) * (100 + tax)) / 100 * rate}</span><ul class="row__meta"><li>a</li><li>b</li><li>c</li><li>d</li><li>{row.stock}</li><li>e</li><li>f</li><li>g</li><li>h</li><li>i</li><li>{row.discount}</li></ul><span class="row__left">{row.stock - row.qty}</span><span class="row__diff">{row.price - rows[pivot].price}</span><span class="row__warn" data-warn={String(row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold)}>!</span><a class="row__link" href={row.url} data-p={row.price} data-q={row.qty}>link</a><button class="row__inc" onclick={() => row.qty++}>+1</button></div>
    {/each}
  </div>
</div>
