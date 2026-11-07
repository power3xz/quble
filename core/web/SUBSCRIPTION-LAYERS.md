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
- `[expr]`: 식 인스턴스를 풀에 두고, 입력 leaf에 파생 구독을 걸고 푼다(구독 표 `deriveSubscribers`). 바뀐 leaf로
  식을 다시 세는 통지 전 단계(`flush`)를 `[subscription]`에 등록한다. 같은 식을 공유한다(4절).
- `[subscription]`: 구독 층. 통지 구독과 통지 전 단계 하나를 들고, `set`, `write`, `notify`, batch로 통지 전
  단계와 통지 구독을 순서대로 호출한다. 값은 `[store]`에 기록한다. 파생 구독과 식은 모른다.
- `[store]`: leaf 값을 읽고 기록하기만 한다. 구독을 모른다.

`[subscription]`과 `[store]`는 둘 다 `leaf-store.ts`에 있다.

## 2. 값이 바뀔 때

구독은 두 종류다.

- **파생 구독**: `[expr]`의 구독 표에 입력 leaf마다 식 인스턴스 번호를 건다. 식이 읽는 입력 leaf 모두에 같은 번호를
  건다. 입력 leaf가 바뀌면 그 번호의 식을 다시 센다.
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
  1. [subscription]  [store]의 leaf 0에 3000을 기록한다            값이 같으면 여기서 끝
  2. [subscription]  통지 전 단계에 바뀐 leaf 모음 {0}을 넘긴다
  3. [expr]          leaf 0을 읽는 `rate * 2`를 다시 세어 6000을 얻는다.  직전 값(5300)과 같으면 기록도 하지 않는다
                     결과 leaf 7에 기록하고, 값이 바뀐 결과 leaf [7]을 돌려준다
  4. [subscription]  바뀐 leaf 0, 돌려받은 leaf 7 순으로 통지 구독을 호출한다   툴바에 3000, 두 행에 6000
```

- 결과 leaf에 기록하는 것은 `[expr]`이다. `[subscription]`은 돌려받은 leaf를 통지만 한다.
- 통지 구독은 통지 전 단계가 끝난 뒤에 호출되므로 중간 값이 DOM에 닿지 않는다.

batch 안의 `set`은 값만 기록하고 바뀐 leaf를 모은다. 가장 바깥 batch가 끝날 때 위 2~4가 한 번 진행된다. 통지 전
단계는 그동안 바뀐 leaf 전체를 받고, 읽는 leaf 여럿이 함께 바뀐 식 인스턴스도 한 번만 센다.

## 3. 식 인스턴스의 생애

식 인스턴스는 식 하나가 한 스코프에서 읽는 leaf들과 결과다. `[expr]`의 풀에 있고, 가지는 풀의 번호
(`exprInstanceIndex`)만 든다.

| 호출 | 호출하는 쪽, 시점 | 하는 일 |
|---|---|---|
| `create`, `evaluate`, `bindResultLeaf` | `[vm]`, 값 자리를 만들 때 | 인스턴스를 만들고 처음 값을 센다. 결과 leaf를 할당해 인스턴스에 연결한다 |
| `subscribeInputs` | `[vm]`, 새로 만든 인스턴스를 처음 센 직후 | 입력 leaf마다 파생 구독을 건다 |
| `recountPending` | `[region]`, 가지가 DOM에 붙을 때 | 쉬는 동안 바뀐 입력이 있으면 센다(5절) |
| `releaseByBranch` | `[region]`, 가지가 없어질 때 | 파생 구독을 풀고 결과 leaf와 풀 번호를 반납한다 |

인스턴스는 `heldByBranchCount`(인스턴스를 든 가지 수)를 센다. 파생 구독은 인스턴스를 만들 때 걸고 `heldByBranchCount`가 0이 되어
반납할 때 푼다. 가지가 DOM에서 떨어져도 파생 구독은 그대로다 - 떼고 붙일 때 풀고 거는 것은 가지의 통지 구독뿐이다.
처음 붙지 않은 가지(`@if`의 고르지 않은 쪽)는 처음 고를 때 만들어지므로 그전에는 인스턴스도 구독도 없다.

## 4. 공유

같은 컴포넌트 안의 같은 식(`localExprIndex`)이 여러 `@for` 행에 나오고 행마다 읽는 값이 같으면, 행들이 식 인스턴스
하나를 사용한다. 값 자리를 만들 때 `[vm]`이 아래 순서로 공유할지, 어느 인스턴스를 사용할지 정한다.

```
  level 구하기 -> forDepth와 비교 -> scopeUid 고르기 -> 공유 맵 조회 -> 있으면 retainByBranch, 없으면 create + markShared
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
(`vm.ts`의 `scopeUidAtLevel`).

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
- `releaseByBranch`: `heldByBranchCount`가 0이 되면 키를 지운다. `scopeUid`를 다시 사용하지 않으므로, 없어진 스코프의 키에 새 스코프가
  걸리지 않는다.

### 재사용

찾은 인스턴스는 `retainByBranch`로 `heldByBranchCount`만 올리고, 같은 결과 leaf에 통지 구독을 건다. 식은 다시 세지 않고 결과
leaf의 값을 읽는다. 그 값이 낡았으면 가지가 붙을 때 `recountPending`이 센다.

## 5. 쉬는 동안 바뀐 입력

`@if` 가지가 떨어져 쉬는 동안에도 식 인스턴스의 파생 구독은 남는다. 입력이 바뀌면 push가 바뀐 변수의 비트를
`pendingVarMask`에 켠다. pull은 incoming labeled edge의 시작점(조건 식 인스턴스)의 값이 label과 맞지 않아 그
인스턴스를 세지 않는다(`docs/flush-push-pull.draft.md`의 pull). 마스크가 이미 0이 아닌 인스턴스는 push가 다시 셀
목록에 넣지 않으므로, 쉬는 동안 flush가 여러 번 지나가도 비트만 쌓인다. 결과 leaf는 낡은 채 남는다.

가지가 다시 붙을 때 `[region]`이 가지의 식 인스턴스마다 `recountPending`을 호출한다. `recountPending`은 pull과 같은
요청으로 incoming edge의 시작점을 먼저 요청하고, 마스크가 남은 인스턴스만 그 마스크로 센다. 값이 바뀌었으면 결과
leaf에 기록하고 그 leaf를 `notify`한다. 가지가 붙는 것은 flush의 통지 단계라, 값이 바뀐 결과 leaf를 돌려줄 통지
전 단계가 이미 끝났기 때문이다. 쉬는 동안 입력이 바뀌지 않은 인스턴스는 마스크가 0이라 세지 않는다.

마스크에는 쉬는 동안 바뀐 변수가 모두 모여 있어 식을 한 번 센다. 바뀐 변수마다 따로 세면 나머지 입력이 낡은 채
센 중간 값까지 결과 leaf에 기록하고 통지한다.

행이 `@if (show)` 안에 있어 꺼졌던 가지가 다시 붙을 때:

```
  꺼진 동안   set(0, 3000)      push가 `rate * 2`의 마스크에 rate 비트를 켠다. show가 false라 pull은 세지 않는다.
                                leaf 7은 5300 그대로
  다시 붙임   1. 통지 구독을 건다
              2. leaf 7의 낡은 값(5300)으로 DOM을 한 번 맞춘다
              3. recountPending: show가 true이고 마스크가 남아 식을 센다 -> leaf 7에 6000을 기록하고 통지 -> DOM 6000
```

꺼진 동안 새 행이 붙으면, 새 행은 `retainByBranch`로 leaf 7의 낡은 값(5300)을 읽어 DOM을 채운다. 새 행의 가지는 부모
가지의 간선을 물려받아 `recountPending`도 show가 false라 세지 않는다. 행이 모두 보이지 않으므로 낡은 값은 화면에
나오지 않고, show가 true가 되어 다시 붙을 때 위 3에서 함께 고쳐진다.

셀지는 가지가 아니라 인스턴스의 마스크가 정한다. 새 행은 처음 붙는 가지지만, 공유한 인스턴스는 그전부터 쉬며
비트를 모았을 수 있다.

## 6. 남은 것

- **파생 구독이 다른 파생 구독을 입력으로 받는 경우**는 설계하지 않았다. 지금 파생 구독의 입력은 변수 leaf뿐이다.
  파생 값을 컴포넌트 변수로 선언하는 문법이 생기면 계산 순서, 입력 인스턴스를 언제 반납할지, `level` 계산을 정해야
  한다.
- **`[vm]`의 경계**: `vm.ts` 한 파일이 DOM 바인딩과 조립(식 인스턴스, 풀, store 연결)을 함께 맡는다.
- **`scopeUid` 낭비**: `@for` 행과 `RENDER`마다 번호를 받지만 대부분의 행에는 공유하는 식이 없다.
- **같은 깊이의 중복**: `forDepth`와 `level`이 같으면 같은 행 안에서 같은 식이 두 번 나와도 공유하지 않는다.
- 공유 결정의 이유와 버린 안은 `DECISIONS.md`의 "식 인스턴스 공유"에 있다.
