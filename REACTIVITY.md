# REACTIVITY

Quble의 반응성·핸들러 모델. DESIGN.md §5.1(배열 요소 식별)·§5.2(reactivity)·events의 미결을
**leafIndex**와 **fullname**으로 꿴 결론이다. 일부 세부(동적 인덱스 swap 등)는 아직 미결로
표시했다.

**전제: 모든 것은 런타임에 결정된다.** `@for`(동적 리스트)는 항상 있다고 본다 - "정적 트리"를
특수 케이스로 분기하지 않는다. 컴포넌트 **정의**(offset만 앎)와 **사용**(바인딩)이 분리돼 있고,
둘이 만나는 건 **렌더 시점**이므로, leafIndex 수치는 컴파일타임에 박을 수 없다. 컴파일타임
산출물은 **offset + 바인딩 식**뿐이고, 실제 leafIndex는 렌더 시 할당기가 정한다.

## 1. pub/sub, 리프 = 토픽

반응성의 단위는 **원시 리프값**(문자열·숫자·불리언)뿐이다. 객체·배열 자체는 **추적하지 않는다**
- 경로일 뿐이다. 각 리프가 하나의 토픽(시그널)이고, 구독/발행하는 pub/sub 구조다.

- 토픽 = 리프 하나 (leafIndex로 식별)
- publish = `set(leafIndex, v)`
- subscribe = 그 리프를 쓰는 DOM 노드 핸들러 (렌더 시 등록)

## 2. `set(leafIndex, v)` - Proxy 없는 명시적 구독

```
set(leafIndex, v)
  → store[leafIndex] = v
  → subscribers[leafIndex] 의 핸들러들 호출 → DOM 갱신
```

Svelte 5는 Proxy로 **런타임에** "무엇을 구독할지" 알아낸다 - 값을 읽는 순간 접근을 가로채
"지금 이 effect가 이 값을 쓴다"를 동적으로 등록한다(접근 trap·재귀 wrap·의존추적).

우리는 Proxy를 안 쓴다. **무엇을 구독할지(어느 리프인지, store 경로)는 컴파일타임에 타입으로
알기** 때문이다 - 읽기를 런타임에 가로챌 필요가 없다. 렌더 시 `TEXT_VAR`를 만나면 그 노드를
해당 리프의 구독자로 등록한다.

주의 - 이건 **"연결이 정적"이라는 뜻이 아니다.** leafIndex 수치는 렌더 시 정해진다(§3). 정적인
것은 **무엇을 구독하는가(리프 식별·상대 offset·바인딩)**이고, **인덱스 수치는 렌더 시점**이다.
즉 *무엇을 구독할지는 컴파일타임, 등록·인덱스는 렌더 시점*.

주된 동기는 **런타임 크기**(Proxy·시그널·의존추적 시스템 코드를 안 실음). 성능은 부수적으로 약간
나은 정도다 - Proxy 오버헤드 자체는 대부분 앱에서 체감 수준이 아니다(Vue 3·Svelte 5가 증명).

## 3. leafIndex는 렌더 시 할당기가 정한다 (모든 경우 일관)

컴포넌트는 단독으로 전역 인덱스를 알 수 없다. 정의는 **로컬 offset**(`TEXT_VAR idx`)만 갖고,
사용처의 **바인딩**(`a(name={store.name})`)이 그 offset을 어느 store 리프에 연결할지 정한다.
정의와 사용이 분리돼 있으니, 실제 leafIndex는 **렌더(인스턴스화) 시점**에야 정해진다.

```
컴파일타임:  offset + 바인딩 식 (어느 store 경로를 가리키는지)
렌더 시점:   할당기가 leafIndex를 동적 배정 → 바인딩 평가해 store 리프로 해석 → 구독 등록
제거 시:     그 구간 회수 (자유 목록)
```

- **정적/동적을 분기하지 않는다.** `@for` 항목이든 한 번 박히는 컴포넌트든, 전부 "렌더 시
  할당" 한 원리. 인스턴스가 생길 때 base를 받고, 노드들은 `base + offset`을 구독.
- **충돌은 할당기 책임.** 단순 평탄 정수에 base+offset을 쌓으면 `@for` 길이가 가변이라 뒤
  영역을 침범한다(밀림). 그래서 leafIndex를 컴파일타임에 고정하지 않고 **할당기가 빈 자리를
  내주고 회수**한다. push/제거 = 할당/회수.

### 공유 - "같은 리프냐"는 런타임 바인딩 귀결

서로 다른 컴포넌트의 로컬 참조가 같은 store 리프를 가리킬 수 있다:

```
store = { name: 'good', price: 1 }
a => div() { {name} }              // a의 로컬 name (offset 다름)
b => div() { {price} {name} }      // b의 로컬 name (offset 다름)

use: a(name={store.name}) {}
     b(price={store.price} name={store.name}) {}
```

a의 `{name}`과 b의 `{name}`은 로컬 offset이 다르지만 **둘 다 `store.name`에 바인딩**된다.
"같음"은 컴파일타임에 박는 게 아니라, **렌더 시 바인딩이 같은 store 리프(같은 leafIndex)로
귀결되며 나타난다.** 그러면 `set(그_leafIndex, v)` 한 번에 a·b 둘 다 갱신된다. 즉 **leafIndex의
정체성 기준은 컴포넌트 로컬이 아니라 store 리프**이고, 로컬 offset은 바인딩을 따라 그 리프로
정규화된다.

## 4. 배열 length도 토픽

`list.length`(원시 숫자)도 추적한다. 단 구독자가 다르다:

| 토픽 | 구독자 | 갱신 |
|---|---|---|
| `store.user.name` | 텍스트 노드 핸들러 | textContent 교체 |
| `store.list.length` | **`@for` 블록 핸들러** | 항목 노드 추가/제거 + 파생 리프 인덱스 동적 할당/해제 |

push/pop = length 변경 → `@for` 재구성. length가 **항목 인스턴스의 생애주기를 관장**한다 -
항목 생성 시 할당기에서 base를 받아 리프들을 구독 등록, 제거 시 그 구간을 회수(§3). "구조 변경은
반응성이 아니라 `@for` 영역"의 구체 메커니즘이 곧 length 토픽이다.

## 5. 객체 변경 = 리프 일괄 set

객체 재할당·swap(`list[0]=list[1]`)에 특별한 연산은 없다. **그 객체가 품은 리프들의 값이 바뀐
것**으로 환원한다. 컴파일러가 타입으로 객체의 리프 집합을 알아 변경을 리프 set들로 전개한다.
객체 자체는 토픽이 아니다.

> 🛑 미결: 동적 인덱스(`list[i]=list[j]`, i/j 런타임)에서 바뀐 leafIndex 판단.
> 분해 방향만 - **어느 리프가 바뀌나(상대 offset 집합)는 타입으로 컴파일타임 확정**,
> **어느 인스턴스인가(base)는 렌더 시 할당기가 부여**(§3). `leafIndex = base + offset`.
> 노드 이동(key 기반 reconciliation)은 채택 안 함이 기본 - 위치 기반으로 내용만 교체.

**검사 책임 경계 - 컴파일러가 처리할 수 있는 건 JS로 끌어올리지 않는다.** 런타임
store(leafStore)는 set에서 객체 여부 같은 타입 검사를 하지 않는다 - leafIndex에 객체를
넣어도 그냥 저장될 뿐, 자식 리프들과 동기화되지 않는다(서로를 모름). 이 안전성은
**컴파일러가** 책임진다: 비-말단 path를 리프로 관측하려는 접근을 컴파일타임에 거부해
객체가 애초에 리프에 닿지 않게 한다. JS는 컴파일러가 못 보는 것(런타임에야 드러나는
것)만 최소한으로 검사한다 - 컴파일타임에 이미 보장된 걸 런타임이 중복 확인하지 않는다.
store가 가벼워지고(set은 대입+통지뿐) 책임이 한 곳에 모인다.

## 6. leafIndex = 상태·이벤트·식별의 공통 키

하나의 인덱스 체계가 셋을 관통한다:

| 용도 | 활용 |
|---|---|
| 반응성 | `set(leafIndex, v)` → 구독 노드 갱신 |
| store 조회 | `get()[leafIndex]` |
| 배열 요소 식별 | leafIndex로 인스턴스 식별 (같은 fullname의 두 인스턴스는 leafIndex가 다름) |
| 이벤트 | 발생 인스턴스의 leafIndex를 페이로드에 실음 |

DESIGN §5.1의 배열 요소 식별 슬롯(이름 미정)이 식별해야 할 "인스턴스 구분"이
**leafIndex(인스턴스 베이스)**로 풀린다. 컨텍스트 메타데이터는 별개(`context`, leafIndex와 무관).

## 7. 핸들러 = fullname에 묶인다

컴포넌트는 **이벤트 스키마**(payload 타입)와 **단독 핸들러**(개발용 기본 로직)를 가진다. 합성되면
fullname이 누적돼 길어지고, 그 긴 fullname의 핸들러(부모/페이지가 정의)가 실효한다. 컴포넌트의
단독 핸들러는 fullname이 달라 **자연히 비실효**가 된다(무시가 아니라 다른 fullname).

```
// Switch 단독 (개발 중 직접 컨트롤)
events  { TOGGLE: { isOn } }
handler { TOGGLE: (data) => isOn = !data.isOn }

// PrivateData에 합성되면 - 부모가 긴 fullname으로 처리
handler { "PrivateData.TOGGLE": (data) => privateData.visible = !data.isOn }
```

- **스키마는 컴포넌트가 선언, 로직(핸들러)은 use-site가 결정.** fullname이 use-site에서 정해지는
  것과 같은 규칙의 자연스러운 결과다.
- 실효 핸들러는 **현재 루트(페이지) 기준으로 컴파일타임에 정적 결정**. "페이지도 컴포넌트"이므로
  브라우저가 보는 건 페이지 컴포넌트이고 거기서 로직이 처리된다.
- 데이터 변경은 `set(leafIndex, v)`, 식별은 fullname + leafIndex.

## 7.1. 핸들러 실행 계약 - store 경로로 상태를 읽고 쓴다

핸들러가 실제로 실행되려면 몸통에서 상태를 읽고 써야 한다. 상태 접근은 **store 경로**로 한다:
핸들러가 받는 `store`는 값을 담은 객체가 아니라 **경로를 leafIndex로 해석하는 주소기**다.
`store.a.b`를 언급하면 그 경로에 대응하는 leafIndex가 정해지고, `get`/`set`이 그 index로
반응성(§2 `set(leafIndex, v)`)에 닿는다.

```
handler(data, { store, get, set }) {
  get(store.a.b)        // 경로 -> leafIndex -> 현재 값
  set(store.a.b, v)     // 경로 -> leafIndex -> set -> 구독자 -> DOM
}
```

**두 스텝으로 나눈다.**

- **스텝 1 (지금) - 명시적 get/set, 핸들러는 순수 JS.** `.qubc.handlers.ts`에 TS로 쓰되
  `get(store.a.b)`/`set(store.a.b, v)`처럼 함수 호출로 접근한다. `store`는 런타임 주소기
  (경로 -> leafIndex). 핸들러 몸통은 그냥 JS라 컴파일러가 **분석하지 않고 트랜스파일만** 해
  리소스화하고, 런타임이 fullname으로 물려 실행한다.
- **스텝 2 (최종, qubh) - 자연 대입.** 핸들러 전용 파일에서 `store.a.b = v`처럼 직접 대입하면
  컴파일러가 이를 `set($i, v)`로 낮춘다(대입을 set 호출로 변환하므로 이때는 몸통을 분석한다).
  스텝 1의 런타임 주소기가 그대로 기반이 되고, qubh는 그 위의 문법 층이다.

**왜 proxy를 반응성 엔진으로 쓰지 않나.** store 주소기는 hot path에 없다. 값이 바뀌고 구독자가
DOM을 갱신하는 반응성 루프는 leafIndex(정수) 기반 pub/sub이고 proxy가 끼지 않는다. 주소기는
핸들러가 경로를 지목하는 순간 경로 -> index 해석에만 쓰이고(이벤트당 저빈도), 스텝 2에선 그마저
컴파일타임에 `$i`로 낮춰져 사라진다. 값 흐름(빠른 index)과 주소 지정(저빈도 주소기)을 갈라 둔 것이다.

**store 경로는 키별 타입을 실는다.** `store.title`은 string, `store.isOn`은 boolean -
`store: string | boolean`으로 뭉치지 않고 **키마다 정확한 타입**이어야 `set(store.isOn, "x")`가
에러로 잡힌다. `get(k)`가 내주는 값·`set(k, v)`가 받는 값이 그 키의 타입으로 강제된다. 지금
범위는 스칼라(string·boolean) - props/payload가 스칼라뿐이므로 컴파일러가 키별 타입을 이미 안다.
중첩·객체 경로(`store.a.b`)는 타입 표기(ROADMAP)가 온 뒤다. `store` 타입은 `handlersDts`가
payload 타입을 내듯 **같은 파이프라인으로 컴파일러가 생성**한다(새 메커니즘 아님).

**미결.**

- **경로 -> leafIndex 결정론.** SSR이 그린 것을 클라가 이어받으려면 같은 경로가 SSR·클라에서
  같은 index여야 한다. §3의 렌더 시 할당 규칙을 핸들러가 지목하는 경로에도 일관되게 적용해야 한다.
- **정적 / 동적 leafIndex 구분.** 보간·props에 나오는 상태는 컴파일타임에 index가 정해진다(정적,
  지금 방식). 핸들러가 화면에 안 뿌리고 처음 건드리는 경로나 `@for` 항목은 런타임 발급이 필요할
  수 있다(동적). 이 구분은 leafIndex 할당기(ROADMAP - `@for`에서 회수)와 한 몸이다. **지금은
  정적만, 동적은 필요해질 때.** 런타임이 어느 index가 어느 종류인지 구분해야 할 수 있다.
- **`store`가 가리키는 scope.** 핸들러는 fullname(트리 깊은 자식)에 묶이는데 `store`가 그 자식
  것인지 루트(페이지) 것인지. §5.1(provided 구조)과 닿는 지점이라 여기서 확정하지 않는다.

## 8. `@if` = Region + 재진입 `interpret` + lazy build

클라 런타임에서 `@if`는 한 자리(**Region**)에서 두 가지(then/else) 중 하나만 보인다. @if의 본질은
"분기에 따라 어떤 컴포넌트가 보이고 안 보이는 것 = 미래 가능성의 인코딩(양쪽 가지를 다 안다)".
그래서 두 불변을 지킨다: **해석 ≠ build**(양쪽 청사진은 알되 활성 가지만 노드·구독을 만든다),
**안 보이는 가지는 구독 0**(set에 반응하지 않는다).

### 핵심 결정 - 인스턴스화 루프를 재진입 가능하게

`interpret(startPc, endPc, regionIndex, branchIndex)` 하나가 "**한 가지를 build하는 단위**"다.
최초 인스턴스화·lazy swap build·중첩 if가 전부 이 함수 하나로 통일된다.

- **IF를 만날 때마다 Region을 1개 생성**하고, 자식 가지는 **재귀 `interpret` 호출**로 들어간다.
  활성 가지는 즉시 재귀 build, 비활성 가지는 `lazyBuild` 클로저만 심어 둔다(노드 0·구독 0).
- 한 `interpret` 호출 = 한 가지라, 그 안에서 region/branch는 **불변**이다. IF는 자기 region을
  안 바꾸고 자식 region을 재귀에 넘긴 뒤 `pc`를 IF_END 다음으로 점프할 뿐. 그래서 **중첩 if의
  컨텍스트 추적을 수동 스택이 아니라 JS 호출 스택(재귀)이 대신**한다.
- 코드 범위는 마커로 이미 표시돼 있다 - then = IF다음~ELSE, else = ELSE다음~IF_END. 추가 마커
  불필요(점프/길이 operand는 §거부). IF 진입 시점엔 ELSE·IF_END 위치를 모르므로 `skipBranch`
  (depth 카운팅, SSR `skip_branch`와 동일 패턴)로 경계를 찾아 lazyBuild 클로저에 묶는다.

### lazy build - 비활성 가지는 첫 swap 때 build

각 가지는 **생애 첫 활성화 때 딱 한 번** build(`branch.built`)되고, 이후엔 detach/attach만 한다.
초기 활성화도 swap과 동일 경로(`activateBranch`)를 탄다 - `activateBranch`가 첫 활성화면
`lazyBuild()` 호출·구독 복원·anchor 뒤 부착을 일괄한다. "런타임 생성 + 제거 없음, append만"과 일관.

- **비활성 가지 안의 중첩 if는 skip돼 Region이 안 생긴다** → 그 가지를 swap으로 처음 build할 때
  비로소 생성된다. 그래서 `regions` 수 = 실제로 build된 가지들이 품은 IF 수.
- swap 시 노드는 가지 루트에서만 detach/attach(자손 DOM은 따라온다), 구독은 자식 Region까지
  **재귀로** 끊고/복원한다(`shownIndex`로 활성 자식만). off/on 비대칭은 region.js 참고.

### 거부한 대안

- **양쪽 가지 eager build** - 단순하나 안 보이는 가지의 build 비용을 항상 치른다(벤치 build 약점).
  lazy build로 "보이는 한 가지만 build"가 되어 최초 build가 React/Svelte와 동급이 된다.
- **수동 region/branch 스택 유지** - 한 루프로 IF→ELSE→IF_END를 순차 처리하며 스택 push/pop.
  재귀 `interpret`이 같은 일을 JS 호출 스택으로 해내므로 제거했다(스택 3개 → `branch` 상수 1개).
- **점프/길이 operand** - 가지 경계를 바이트코드에 박지 않는다. `skipBranch`의 depth 카운팅으로
  런타임에 찾는다(마커만으로 충분, 인코딩을 키우지 않는다).

### 전제 - `@for` 도입 시 재검토

"IF 위치 1개 → Region 1개"는 지금 `@for`가 없어 성립한다. for의 각 항목이 같은 IF를 품으면
"IF × 반복 횟수"만큼 Region이 생겨 이 1:1 전제가 깨진다. `@for` 설계 때 함께 다룬다.

## 구현 현황

- [x] props 변수 보간 - 텍스트(`TEXT_VAR`)·속성(`ATTR_*_VAR`). 같은 scope offset 공간.
- [x] 스칼라 반응성 - `subscribers[leafIndex]`(구독자=함수) + `set(leafIndex, v)`. 렌더 시 구독 등록.
- [x] 바인딩 해석 / 공유 - `resolve(store, path)`로 path -> leafIndex lazy 발급·캐시. 같은 path는 같은 leaf로 귀결(공유). 검증 완료.
- [x] 합성 시 자식 paths 주입 - `PUSH_ARG`(부모 offset)+`RENDER`로 부모가 자식 paths를 채운다. 부모·자식이 같은 store 리프를 가리키면 공유. 검증 완료.
- [x] `@if` Region + 재진입 `interpret` + lazy build(§8) - 활성 가지만 build·구독, 비활성은 첫 swap 때 build. 단일 컴포넌트 내 단일·중첩 if. (`proto/web/compile.js`, `region.js`, `region-build.test.js`)
- [ ] `@if` Region 병합 - RENDER 자식 컴포넌트 안의 if region을 부모 가지에 엮기(지금은 단일 컴포넌트 내부만).
- [ ] leafIndex 할당기 / free list (지금은 `leaves.length`로 증가만 - `@for` 회수 시 필요).
- [ ] 객체(여러 리프 일괄), `@for`(length 토픽·동적 인덱스), 핸들러/이벤트.
