# REACTIVITY

Quble의 반응성·핸들러 모델. DESIGN.md §5.1(provided)·§5.2(reactivity)·events의 미결을
**leafIndex**와 **fullname**으로 꿴 결론이다. 일부 세부(동적 인덱스 swap 등)는 아직 미결로
표시했다.

**전제: 모든 것은 런타임에 결정된다.** `@for`(동적 리스트)는 항상 있다고 본다 — "정적 트리"를
특수 케이스로 분기하지 않는다. 컴포넌트 **정의**(offset만 앎)와 **사용**(바인딩)이 분리돼 있고,
둘이 만나는 건 **렌더 시점**이므로, leafIndex 수치는 컴파일타임에 박을 수 없다. 컴파일타임
산출물은 **offset + 바인딩 식**뿐이고, 실제 leafIndex는 렌더 시 할당기가 정한다.

## 1. pub/sub, 리프 = 토픽

반응성의 단위는 **원시 리프값**(문자열·숫자·불리언)뿐이다. 객체·배열 자체는 **추적하지 않는다**
— 경로일 뿐이다. 각 리프가 하나의 토픽(시그널)이고, 구독/발행하는 pub/sub 구조다.

- 토픽 = 리프 하나 (leafIndex로 식별)
- publish = `set(leafIndex, v)`
- subscribe = 그 리프를 쓰는 DOM 노드 핸들러 (렌더 시 등록)

## 2. `set(leafIndex, v)` — Proxy 없는 명시적 구독

```
set(leafIndex, v)
  → store[leafIndex] = v
  → subscribers[leafIndex] 의 핸들러들 호출 → DOM 갱신
```

Svelte 5는 Proxy로 **런타임에** "무엇을 구독할지" 알아낸다 — 값을 읽는 순간 접근을 가로채
"지금 이 effect가 이 값을 쓴다"를 동적으로 등록한다(접근 trap·재귀 wrap·의존추적).

우리는 Proxy를 안 쓴다. **무엇을 구독할지(어느 리프인지, store 경로)는 컴파일타임에 타입으로
알기** 때문이다 — 읽기를 런타임에 가로챌 필요가 없다. 렌더 시 `TEXT_VAR`를 만나면 그 노드를
해당 리프의 구독자로 등록한다.

주의 — 이건 **"연결이 정적"이라는 뜻이 아니다.** leafIndex 수치는 렌더 시 정해진다(§3). 정적인
것은 **무엇을 구독하는가(리프 식별·상대 offset·바인딩)**이고, **인덱스 수치는 렌더 시점**이다.
즉 *무엇을 구독할지는 컴파일타임, 등록·인덱스는 렌더 시점*.

주된 동기는 **런타임 크기**(Proxy·시그널·의존추적 시스템 코드를 안 실음). 성능은 부수적으로 약간
나은 정도다 — Proxy 오버헤드 자체는 대부분 앱에서 체감 수준이 아니다(Vue 3·Svelte 5가 증명).

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

### 공유 — "같은 리프냐"는 런타임 바인딩 귀결

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

push/pop = length 변경 → `@for` 재구성. length가 **항목 인스턴스의 생애주기를 관장**한다 —
항목 생성 시 할당기에서 base를 받아 리프들을 구독 등록, 제거 시 그 구간을 회수(§3). "구조 변경은
반응성이 아니라 `@for` 영역"의 구체 메커니즘이 곧 length 토픽이다.

## 5. 객체 변경 = 리프 일괄 set

객체 재할당·swap(`list[0]=list[1]`)에 특별한 연산은 없다. **그 객체가 품은 리프들의 값이 바뀐
것**으로 환원한다. 컴파일러가 타입으로 객체의 리프 집합을 알아 변경을 리프 set들로 전개한다.
객체 자체는 토픽이 아니다.

> 🛑 미결: 동적 인덱스(`list[i]=list[j]`, i/j 런타임)에서 바뀐 leafIndex 판단.
> 분해 방향만 — **어느 리프가 바뀌나(상대 offset 집합)는 타입으로 컴파일타임 확정**,
> **어느 인스턴스인가(base)는 렌더 시 할당기가 부여**(§3). `leafIndex = base + offset`.
> 노드 이동(key 기반 reconciliation)은 채택 안 함이 기본 — 위치 기반으로 내용만 교체.

## 6. leafIndex = 상태·이벤트·식별의 공통 키

하나의 인덱스 체계가 셋을 관통한다:

| 용도 | 활용 |
|---|---|
| 반응성 | `set(leafIndex, v)` → 구독 노드 갱신 |
| store 조회 | `get()[leafIndex]` |
| provided | leafIndex로 인스턴스 식별 (같은 fullname의 두 인스턴스는 leafIndex가 다름) |
| 이벤트 | 발생 인스턴스의 leafIndex를 페이로드에 실음 |

DESIGN §5.1에서 provided가 식별해야 할 "인스턴스 구분"이 **leafIndex(인스턴스 베이스)**로 풀린다.
컨텍스트 메타데이터는 별개(context, leafIndex와 무관).

## 7. 핸들러 = fullname에 묶인다

컴포넌트는 **이벤트 스키마**(payload 타입)와 **단독 핸들러**(개발용 기본 로직)를 가진다. 합성되면
fullname이 누적돼 길어지고, 그 긴 fullname의 핸들러(부모/페이지가 정의)가 실효한다. 컴포넌트의
단독 핸들러는 fullname이 달라 **자연히 비실효**가 된다(무시가 아니라 다른 fullname).

```
// Switch 단독 (개발 중 직접 컨트롤)
events  { TOGGLE: { isOn } }
handler { TOGGLE: (data) => isOn = !data.isOn }

// PrivateData에 합성되면 — 부모가 긴 fullname으로 처리
handler { "PrivateData.TOGGLE": (data) => privateData.visible = !data.isOn }
```

- **스키마는 컴포넌트가 선언, 로직(핸들러)은 use-site가 결정.** fullname이 use-site에서 정해지는
  것과 같은 규칙의 자연스러운 결과다.
- 실효 핸들러는 **현재 루트(페이지) 기준으로 컴파일타임에 정적 결정**. "페이지도 컴포넌트"이므로
  브라우저가 보는 건 페이지 컴포넌트이고 거기서 로직이 처리된다.
- 데이터 변경은 `set(leafIndex, v)`, 식별은 fullname + leafIndex.

## 구현 현황

- [x] props 변수 보간 — 텍스트(`TEXT_VAR`)·속성(`ATTR_*_VAR`). 같은 scope offset 공간.
- [x] 스칼라 반응성 — `subscribers[leafIndex]`(구독자=함수) + `set(leafIndex, v)`. 렌더 시 구독 등록.
- [x] 바인딩 해석 / 공유 — `resolve(store, path)`로 path -> leafIndex lazy 발급·캐시. 같은 path는 같은 leaf로 귀결(공유). 검증 완료.
- [x] 합성 시 자식 paths 주입 — `PUSH_ARG`(부모 offset)+`RENDER`로 부모가 자식 paths를 채운다. 부모·자식이 같은 store 리프를 가리키면 공유. 검증 완료.
- [ ] leafIndex 할당기 / free list (지금은 `leaves.length`로 증가만 — `@for` 회수 시 필요).
- [ ] 객체(여러 리프 일괄), `@for`(length 토픽·동적 인덱스), 핸들러/이벤트.
