# 구독 층과 표현식 층

식 보간(`${rate * 2}`)의 값이 입력 leaf에서 DOM까지 가는 길을 큰 그림으로 적는다. 현재 구현 설명이라 코드가
바뀌면 따라 고친다. 필드, API, 성능상의 이유는 각 파일의 주석에 있다. 식을 세는 법은 `EXPR-EVAL.md`, leaf가
store에 놓이는 모양은 `LEAF-STORE-LAYOUT.md`가 맡는다.

## 1. 층

```
  [vm]      vm.ts, 두 인터프리터
              |        |
              |        +--------------------------+
              v                                   v
  [region]  region.ts                     [expr]  expr-layer.ts 외
              |                                   |
              |  (인자로 받는다)                    |  (import한다)
              +-------------------------> [subscription]  leaf-store.ts의 createLeafStoreSubject
                                                  |
                                                  v
                                          [store]  leaf-store.ts의 leafStore
```

- `[vm]`: 바이트코드를 해석하며 값 자리를 DOM에 걸고, 식 인스턴스를 요청한다.
- `[region]`: `@if`/`@for` 가지를 붙이고 떼고 반납하면서, 가지가 든 통지 구독과 식 인스턴스를 같이 다룬다.
  순환 `import`를 피하려고 store와 식 인스턴스 풀을 `import`하지 않고 함수 인자로 받는다.
- `[expr]`: 식 인스턴스를 풀에 두고, 입력 leaf에 파생 구독을 걸고 푼다. 같은 식을 공유한다(4절).
- `[subscription]`: 구독 층. 통지 구독과 파생 구독을 들고, `set`, `write`, `notify`, batch로 구독을 순서대로
  호출한다. 값은 `[store]`에 기록한다.
- `[store]`: leaf 값을 읽고 기록하기만 한다. 구독을 모른다.

`[subscription]`과 `[store]`는 둘 다 `leaf-store.ts`에 있다.

## 2. 값이 바뀔 때

구독은 두 종류다.

- **파생 구독**(`subscribeDerive`): 입력 leaf에 건다. 바뀐 leaf를 받아 식을 다시 세고 값을 돌려준다. 식 인스턴스마다
  함수 하나이고, 식이 읽는 입력 leaf 모두에 같은 함수를 건다.
- **통지 구독**(`subscribe`): leaf의 확정된 값을 받아 DOM에 기록하거나 가지를 켜고 끈다. `[vm]`이 만든다.

```
  props    rate = leaf 0 (2650)
  템플릿   p() { ${rate} }                          <- 툴바
           @for 행 둘 { span() { ${rate * 2} } }    <- 두 행이 `rate * 2`의 식 인스턴스 하나를 공유한다(4절)
  마운트 뒤
    leaf 0   입력 leaf    <- `rate * 2`의 파생 구독, 툴바의 통지 구독
    leaf 7   결과 leaf    <- 두 행의 통지 구독. 값 5300
```

`set(0, 3000)`이 호출되면 이렇게 진행된다.

```
  1. [subscription]  [store]의 leaf 0에 3000을 기록한다      값이 같으면 여기서 끝
  2. [expr]          파생 구독이 `rate * 2`를 다시 세어 6000을 돌려준다
  3. [subscription]  [store]의 결과 leaf 7에 6000을 기록한다  값이 같으면 기록도 통지도 하지 않는다
  4. [subscription]  통지 구독을 호출한다                    툴바에 3000, 두 행에 6000
```

- 파생 구독은 값을 돌려주기만 한다. 결과 leaf에 기록하는 것은 `[subscription]`이다.
- 통지 구독은 파생 구독이 모두 끝난 뒤에 호출되므로 중간 값이 DOM에 닿지 않는다.

batch 안의 `set`은 값만 기록하고 바뀐 leaf를 모은다. 가장 바깥 batch가 끝날 때 위 2~4가 한 번 진행되고, 파생 구독
함수는 그동안 바뀐 leaf 전체를 받아 한 번만 호출된다.

## 3. 식 인스턴스의 생애

식 인스턴스는 식 하나가 한 스코프에서 읽는 leaf들과 결과다. `[expr]`의 풀에 있고, 가지는 풀의 번호
(`exprInstanceIndex`)만 든다.

| 호출 | 호출하는 쪽, 시점 | 하는 일 |
|---|---|---|
| `create`, `evaluate`, `bindResultLeaf` | `[vm]`, 값 자리를 만들 때 | 인스턴스를 만들고 처음 값을 센다. 결과 leaf를 할당해 파생 구독 함수와 연결한다. 구독은 아직 걸지 않는다 |
| `attach` | `[region]`, 가지가 DOM에 붙을 때 | 입력 leaf마다 파생 구독을 건다. 구독이 풀렸던 적이 있으면 따라잡는다 |
| `detach` | `[region]`, 가지가 DOM에서 떨어질 때 | 파생 구독을 푼다 |
| `release` | `[region]`, 가지가 없어질 때 | 결과 leaf와 풀 번호를 반납한다 |

인스턴스는 두 수를 센다. `refCount`는 인스턴스를 든 가지 수, `attachedCount`는 그중 DOM에 붙은 가지 수다.
구독은 `attachedCount`가 0에서 1이 될 때 걸고 0이 될 때 푼다. 반납은 `refCount`가 0이 될 때 한다. 그래서
보이지 않는 가지만 든 인스턴스는 입력 leaf에 구독이 하나도 없다. 인스턴스는 구독을 한 번이라도 걸었는지도
(`everAttached`) 들고, 구독을 다시 걸 때 따라잡을지를 이것으로 정한다.

## 4. 공유

같은 컴포넌트 안의 같은 식(`localExprIndex`)이 여러 `@for` 행에 나오고 행마다 읽는 값이 같으면, 행들이 식 인스턴스
하나를 사용한다. 값 자리를 만들 때 `[vm]`이 아래 순서로 공유할지, 어느 인스턴스를 사용할지 정한다.

```
  level 구하기 -> forDepth와 비교 -> scopeUid 고르기 -> 공유 맵 조회 -> 있으면 retain, 없으면 create + markShared
```

### level

식이 읽는 변수 중 가장 깊은 변수가 정의된 스코프의 깊이다(컴포넌트 0, 첫 `@for` 1). `expr-level.ts`가 슬롯
배치와 식이 읽는 가장 큰 `scope_index`로 구한다. 슬롯은 props 뒤에 `@for`마다 item, index 둘이 붙는다.

```
  props a, b, rows    scope_index 0~2    level 0
  첫 @for             3, 4               level 1
  안쪽 @for           5, 6               level 2
```

컴포넌트마다 처음 필요할 때 한 번 구해 둔다.

### forDepth

값 자리가 이 컴포넌트 안에서 든 `@for` 깊이다. `loopIndexStack`(열린 `@for` 행마다 둘씩 쌓인다) 길이의 절반에서,
이 컴포넌트에 들어올 때까지 쌓인 깊이(`loopIndexBase`)를 뺀다. `level`이 `forDepth`보다 작을 때만 공유한다.
같으면 행마다 값이 다르다.

| 식 | 읽는 변수 | `level` | 자리의 `forDepth` | 동작 |
|---|---|---|---|---|
| `${a * b}` | props | 0 | 0 (루트) | 새로 만든다 |
| `${a * b}` | props | 0 | 1 (`@for` 행 안) | 컴포넌트 전체가 인스턴스 하나를 사용한다 |
| `${row.x * a}` | `@for` 변수, props | 1 | 1 | 행마다 새로 만든다 |
| `${outer.age * 2}` | 바깥 `@for` 변수 | 1 | 2 (안쪽 `@for` 행 안) | 같은 바깥 행 아래의 안쪽 행들이 하나를 사용한다 |

### scopeUid

스코프(컴포넌트 RENDER 한 번 또는 `@for` 행 하나)가 열릴 때마다 받는 번호다. `ScopeUidCounter`가 하나씩 올려
주고 다시 사용하지 않는다. RENDER와 `@for` 행(`buildIteration`)이 열릴 때 `scopeUidStack`에 쌓고 닫힐 때 꺼낸다.
나중에 만드는 가지(`@if`의 `lazyBuild`, `@for`가 늘 때)는 만든 시점의 스택을 복사해 두므로 같은 번호를 본다.

공유 키의 `scopeUid`는 `level`이 가리키는 스코프의 번호다. 스택은 컴포넌트를 가로질러 쌓이므로 이 컴포넌트의
루트 스코프는 맨 위에서 `forDepth`만큼 내려간 자리고, 거기서 `level`만큼 올라간 자리를 고른다
(`vm.ts`의 `sharedScopeUidOf`).

```
  scopeUidStack[length - 1 - forDepth + level]

  Page RENDER > Page의 @for 행 > Card RENDER > Card의 @for 행
  scopeUidStack    [ 0 ,  1 ,  2 ,  3 ]
  Card 안 forDepth 1에서   level 0 -> [2] (Card RENDER)   level 1 -> [3] (Card의 행)
```

### 공유 맵

`ExprInstancePool.shared[globalExprIndex].get(scopeUid)`가 인스턴스 번호다.

- `findShared`: 키로 찾는다. 없으면 `NOT_SHARED`.
- `markShared`: 새로 만든 인스턴스를 키로 올린다.
- `release`: `refCount`가 0이 되면 키를 지운다. `scopeUid`를 다시 사용하지 않으므로, 없어진 스코프의 키에 새 스코프가
  걸리지 않는다.

### 재사용

찾은 인스턴스는 `retain`으로 `refCount`만 올리고, 같은 결과 leaf에 통지 구독을 건다. 식은 다시 세지 않고 결과
leaf의 값을 읽는다. 그 값이 낡았으면 가지가 붙을 때 `attach`가 따라잡는다.

## 5. 구독을 다시 걸 때 따라잡기

구독이 풀린 인스턴스는 입력 leaf에 구독이 없어, 그동안 입력이 바뀌면 결과 leaf가 낡는다. 그래서 `attach`는 붙은
가지가 0에서 1이 될 때 `everAttached`가 참이면 입력 leaf 전체를 바뀐 leaf로 넘겨 파생 구독 함수를 한 번 직접
호출해(`refreshDerive`) 결과 leaf를 맞춘다. 처음 걸 때는 `evaluate`가 방금 센 값이 최신이므로 따라잡지 않는다.

입력 leaf마다 따로 호출하지 않는다. 그러면 식을 입력 leaf 수만큼 세고, 나머지 입력이 낡은 채 센 중간 값까지
결과 leaf에 기록하고 통지한다. 한 번 호출하면 flush와 같이 바뀐 입력을 한꺼번에 반영한다.

꺼졌던 가지가 다시 붙을 때:

```
  꺼진 동안   set(0, 3000)      구독이 없어 아무것도 호출되지 않는다. leaf 7은 5300 그대로
  다시 붙임   1. 통지 구독을 건다
              2. leaf 7의 낡은 값(5300)으로 DOM을 한 번 맞춘다
              3. attach: 파생 구독을 걸고 한 번 호출한다 -> leaf 7에 6000을 기록하고 통지 -> DOM 6000
```

행이 `@if` 안에 있어 두 행이 모두 꺼진 동안 새 행이 붙을 때:

```
  모두 꺼진 동안   set(0, 3000)   leaf 7은 5300 그대로
  새 행            1. retain, leaf 7의 낡은 값(5300)으로 DOM을 채운다
                   2. attach: 붙은 가지 0 -> 1, everAttached 참 -> 한 번 호출한다 -> leaf 7에 6000 -> DOM 6000
```

1과 2는 한 번의 동기 호출(`resizeFor`) 안에서 일어나 낡은 값이 화면에 그려지지 않는다.

새 행은 처음 붙는 가지지만 인스턴스는 구독이 풀렸던 적이 있다. 그래서 따라잡을지는 가지가 아니라 인스턴스가
정한다.

## 6. 남은 것

- **파생 구독이 다른 파생 구독을 입력으로 받는 경우**는 설계하지 않았다. 지금 파생 구독의 입력은 변수 leaf뿐이다.
  파생 값을 컴포넌트 변수로 선언하는 문법이 생기면 계산 순서, 입력 인스턴스의 `refCount`, `level` 계산을 정해야
  한다.
- **`[vm]`의 경계**: `vm.ts` 한 파일이 DOM 바인딩과 조립(식 인스턴스, 풀, store 연결)을 함께 맡는다.
- **`scopeUid` 낭비**: `@for` 행과 `RENDER`마다 번호를 받지만 대부분의 행에는 공유하는 식이 없다.
- **같은 깊이의 중복**: `forDepth`와 `level`이 같으면 같은 행 안에서 같은 식이 두 번 나와도 공유하지 않는다.
- 공유 결정의 이유와 버린 안은 `DECISIONS.md`의 "식 인스턴스 공유"에 있다.
