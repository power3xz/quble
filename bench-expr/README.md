# bench-expr

template 식의 갱신 비용을 quble, React, React + memo, Svelte 5에서 같은 앱으로 잰다. 식 평가 방식(부분
재평가, 인덱스 접근의 구독 다시 걸기)은 core/web/EXPR-EVAL.md에 있고, 측정 방법의 원칙은 그 문서 7절
"잴 때"에 있다. 측정 수치는 런타임이 바뀌면 낡으므로 여기 적지 않는다.

## 실행

레포 루트에서 `./bench-expr.sh`. 의존 설치, `orders.qubc` 컴파일, 데이터 생성, vite 빌드를 하고
http://localhost:8143 에 서버를 띄운다. quble은 레포의 `core/web` 런타임과 quble 바이너리를 그대로 쓴다.

1. 첫 화면(비교 표)에서 행 수(1k, 5k, 10k)와 압축(없음, gzip, brotli)을 고른다.
2. 대상 이름을 누르면 새 탭에 그 대상만 뜬다. 그 탭에서 **측정**을 누른다.
3. 결과는 브라우저 localStorage에 저장되어 비교 표에 들어온다. 다른 브라우저나 기기에는 공유되지 않는다.

같은 대상을 구현만 바꿔 잴 때는 URL에 `tag`를 붙여 결과를 나눠 담는다(`quble.html?n=10000&tag=before`).
비교 표가 같은 대상의 tag별 결과를 나란히 보여 준다.

## 재는 앱

주문 목록 N행(`quble/orders.qubc`, `src/react.jsx`, `src/react-memo.jsx`, `src/Orders.svelte`). 행마다 단순 값
셋(id, 가격, 수량)과 식 넷을 둔다.

```
금액  (row.price * row.qty - row.discount) * (100 + tax) / 100 * rate
재고  row.stock - row.qty
비교  row.price - rows[pivot].price
경고  row.qty > 0 && row.stock - row.qty < 5 && row.price * row.qty > threshold
```

데이터(`gen-data.mjs`)는 시드가 고정이라 매번 같고, 네 대상이 같은 `data-<N>.json`을 받는다.

## 재는 것

**로드**
- 네트워크: 대상 페이지가 받은 파일별 바이트(전송, 압축된 본문, 원본 본문). 서버(`serve.mjs`)가 고른 압축으로
  응답하고 캐시를 끈다.
- mount 시간과 첫 paint까지의 시간.

**클릭** - 버튼 다섯을 각각 예열 5회 뒤 30회 눌러 중앙값과 p90을 낸다.

| 버튼 | 바뀌는 것 |
|---|---|
| 행 +1 | 행 하나의 수량. 누를 때마다 다른 행을 고른다 |
| 환율 변경 | 모든 행의 금액 식 |
| 기준 변경 | 모든 행의 경고 식을 다시 세지만 값은 거의 그대로 |
| 기준 행 이동 | 모든 행의 비교 식이 다른 행의 가격을 읽게 된다(인덱스 접근의 구독 다시 걸기) |
| 기준 행 가격 변경 | 기준 행의 가격 하나. 모든 행의 비교 식이 다시 센다 |

클릭마다 세 값을 잰다.
- **DOM 반영**: 클릭부터 MutationObserver가 불릴 때까지. React와 Svelte가 microtask로 미루는 갱신까지
  들어간다.
- **+ 레이아웃**: DOM 반영 시점에 `offsetHeight`를 읽어 스타일과 레이아웃을 바로 계산시킨 시간까지.
- **힙 증가**: 클릭 직전부터 DOM 반영 시점까지 늘어난 JS 힙. 클릭 한 번의 할당량이다.

## 재지 않는 것

- paint. 다음 프레임까지 재면 주사율(16.7ms)에 묶여 대상 사이 차이가 안 보여 일부러 뺐다.
- 행 생성, 교체, 삭제 같은 목록 구조 변경 - `bench-krausest`가 잰다.
- 컴포넌트 합성, 슬롯, `@if` 가지 교체, `@with` 컨텍스트, payload 있는 이벤트.

## 결과를 읽을 때

**측정 중에는 대상 탭을 앞에 둔다.** 탭이 뒤로 가면 `requestAnimationFrame`이 멈춰 측정이 진행되지 않는다.

**힙 증가는 Chrome을 `--enable-precise-memory-info`로 띄워야 바이트 단위로 나온다.** 그렇지 않으면 값이
거칠게 끊긴다. Chrome이 아니면 `-`로 나온다. 측정 사이에 GC가 끼면 작아지거나 음수가 되므로 중앙값으로 본다.

**대상마다 갱신 방식이 다르다.**
- React(memo 없음)는 상태가 바뀌면 모든 행을 다시 렌더한다.
- React + memo는 바뀐 행만 다시 렌더하지만, 환율과 기준처럼 모든 행의 props가 바뀌면 memo가 소용없다.
- Svelte 5는 template 식마다 effect(읽은 값이 바뀌면 다시 도는 함수)를 하나씩 만든다. 식이 읽는 값 중
  하나라도 바뀌면 그 식을 처음부터 센다.
- quble은 식이 읽는 leaf가 바뀌면 바뀐 부분만 다시 센다(부분 재평가).

**같은 대상을 여러 번 재면 값이 흔들린다.** 비교할 결과는 같은 브라우저, 같은 압축, 같은 행 수에서 이어서
잰 것끼리 본다.
