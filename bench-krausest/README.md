# bench-krausest

[krausest js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)(이하 krausest)의 테이블
앱을 quble로 구현해 성능과 메모리를 잰다. 측정 스크립트가 둘 있다.

- **전체 비교** (`./bench-krausest.sh`): quble과 다른 프레임워크 6개를 krausest 공식 runner로 함께 잰다.
- **빠른 측정** (`./bench-krausest-quick.sh`): 커밋 하나의 quble 런타임을 재고 기록으로 남긴다. 커밋끼리
  기록을 견줘 수정 전후를 본다.

이 문서는 각 스크립트가 무엇을 재고 무엇을 못 재는지 적는다. 측정 수치는 런타임이 바뀌면 낡으므로 적지 않는다.

## 측정 스크립트

둘 다 레포 루트에서 실행한다. 의존 설치와 quble 빌드는 스크립트가 먼저 한다.

### 전체 비교 - `./bench-krausest.sh [runner 인자]`

- krausest를 `bench-krausest/js-framework-benchmark/`에 받아 quble 구현을 non-keyed 부문에 넣고, 비교 대상
  6개(non-keyed vanillajs, svelte-classic / keyed vanillajs, svelte, react-hooks, solid)와 함께 잰다.
- 항목: 동작 9개의 클릭부터 paint 끝까지 시간, 메모리 3개, 번들 크기, 첫 paint.
- Chrome 창을 화면에 띄우고 수십 분 걸린다. 창이 가려지면 paint 이벤트가 빠져 수치가 틀어지므로 측정 중에는
  창을 가리지 않는다. 화면 보호기와 디스플레이 꺼짐은 스크립트가 `caffeinate -d`로 막는다.
- runner 인자로 항목을 고를 수 있다. 예: `./bench-krausest.sh --benchmark 01_ 07_ --count 5`

### 빠른 측정 - `./bench-krausest-quick.sh [git ref]`

- 커밋 하나(기본 HEAD)를 임시 worktree로 꺼내 그 quble 런타임으로 잰다. 작업 트리의 커밋 안 한 변경은 재지
  않는다. 앱(`app.qubc`)은 지금 컴파일러로 컴파일한다.
- 항목: 전체 비교와 같은 동작 9개의 스크립트 시간(paint 제외), 1k 행 생성 후 JS 힙.
- headless Chromium이라 창이 뜨지 않고 1분 안쪽에 끝난다. 측정은 `bench-krausest/quick.mjs`가 한다.
- 기록은 `bench-results/<커밋>.krausest.json`에 남는다. 커밋끼리는 `node bench-compare.mjs krausest <ref> <ref>`로
  견준다. 따로 잰 기록끼리 견주므로 잰 시각 사이의 기계 상태 차이가 섞인다 - 견줄 커밋은 이어서 잰다.

수정을 시도할 때는 커밋하고 빠른 측정으로 남길지 정하고, 남긴 수정이 모이면 전체 비교로 한 번 확인한다.

## 재는 앱

krausest가 정한 앱 그대로다(`quble/src/app.qubc`).

- 컴포넌트 하나 안에 `@for` 하나 - 평평한 테이블
- 행마다 값 바인딩 셋 - id 텍스트, label 텍스트, class 속성. 모두 단순 변수이고 식이 없다
- 행마다 이벤트 둘(선택, 삭제) - payload 필드와 `@with` 컨텍스트가 없다
- 핸들러(`quble/src/main.ts`)는 `store`, `set`, `setArray`, `push`, `removeAt`, `swapAt`만 쓴다

동작 9개: 1k 행 생성, 1k 행 교체, 10행마다 label 갱신, 행 선택, 두 행 맞바꾸기, 행 하나 삭제, 10k 행 생성,
1k 행 추가, 전체 삭제.

## 재지 않는 것

위 앱이 쓰지 않는 기능은 전체 비교와 빠른 측정 모두 재지 않는다. 이 기능들을 건드리는 런타임 수정은 여기서
효과가 보이지 않을 수 있다.

- 컴포넌트 합성(행을 자식 컴포넌트로 두기), 슬롯
- `@if` 가지 교체, 중첩 `@for`
- 식 바인딩과 부분 재평가, 인덱스 접근 - 이것은 `./bench-expr.sh`가 잰다
- `@with` 컨텍스트, payload 필드가 있는 이벤트
- 핸들러가 `props`를 쓸 때의 비용(첫 발화 때 props를 만드는 비용)

## 결과를 읽을 때

**quble 구현은 non-keyed다.** `setArray`는 겹치는 자리의 행 DOM을 다시 쓰고, `swapAt`은 행 DOM을 둔 채 값만
맞바꾼다. krausest 판정도 non-keyed로 나온다. 행 교체와 맞바꾸기는 non-keyed 구현이 유리하므로, 이 두 항목은
keyed 구현(react-hooks, solid 등)과 견주지 않는다.

**행 선택은 실제보다 유리하게 나온다.** quble에 삼항 연산자가 없어 선택 표시를 행 데이터의 `cls` 필드로
넣었다. krausest가 결과표에 표시하는 #800 "View state on the model"에 해당한다. 다른 구현은 `selected` 값
하나를 바꾸고 모든 행이 `selected === row.id`를 다시 평가하는데, quble 구현은 두 행의 `cls`만 바꾼다. 그래서
krausest 앱에서 template 식 재평가 비용이 드러나는 유일한 자리를 quble은 재지 않는다. 삼항 연산자가 생기면
`class={row.id == selected ? "danger" : ""}`로 바꾼다.

**0.5ms 미만 동작은 차이를 읽기 어렵다.** 전체 비교에서는 회차마다 한 프레임(약 16.7ms)씩 밀리는 일이 섞여
반복값이 크게 흩어진다. 빠른 측정에서는 교차 출처 격리가 없어 `performance.now()`가 0.1ms 단위로 끊긴다.

**빠른 측정의 값은 전체 비교의 값과 크기가 다르다.** 빠른 측정의 시간은 클릭 하나의 동기 실행만 잰다. 전체
비교의 script 시간은 이벤트 전달과 브라우저 쪽 작업을 더 포함한다. 힙도 빠른 측정은 CSS 없는 빈 페이지에서
잰다. 빠른 측정의 값은 커밋 사이의 차이를 보는 데만 쓴다.
