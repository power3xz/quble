# 표현식 평가

값 자리 식(텍스트 보간, 속성값)과 `@if` 조건 식을 런타임이 어떻게 세고, 식이 읽는 leaf가 바뀌면
어떻게 다시 세는지 그림으로 본다. 계약이 아니라 현재 구현 설명이라 코드가 바뀌면 따라 고친다. 바이트
형식은 core/BYTECODE.md #4 `<EXPR>`에 있다.

| 파일 | 맡은 일 |
|---|---|
| expr-opcode.ts | opcode와 명령 크기 |
| expr-skip-table.ts | 식 정의마다 한 번 만드는 표(`buildSkipTable`) |
| runtime.ts | 평가(`runExpr`), 구독(`subscribeExpr`), 구독 다시 걸기(`resubscribeReadLeaf`) |
| region.ts | 가지를 떼고 붙일 때 구독 풀기와 다시 걸기(`restoreBranchSubs`) |

## 1. 식의 모양 - 트리와 후위 바이트

식은 트리이고, 바이트코드는 그 트리를 후위 표기로 편 것이다.

```
((a + b) * c) - (d + e)

              SUB
            /     \
         MUL       ADD
        /   \     /   \
      ADD    c   d     e
     /   \
    a     b
```

`a`는 `LOAD_VAR a` 한 명령이고 3바이트를 차지한다. 연산은 1바이트다. 아래 표의 `=`는 그 부분식이
차지하는 구간이다.

| 위치 | 0 | 3 | 6 | 7 | 10 | 11 | 14 | 17 | 18 |
|---|---|---|---|---|---|---|---|---|---|
| 명령 | `a` | `b` | ADD | `c` | MUL | `d` | `e` | ADD | SUB |
| `a + b` | = | = | = | | | | | | |
| `(a + b) * c` | = | = | = | = | = | | | | |
| `d + e` | | | | | | = | = | = | |
| 식 전체 | = | = | = | = | = | = | = | = | = |

**부분식은 후위 바이트에서 이어진 구간이다.** 구간은 늘 잎에서 시작하고, 끝은 그 부분식의 가장 바깥
연산이다.

한 위치에서 여러 부분식이 시작할 수 있다. 위치마다 거기서 시작하는 부분식의 끝 연산을 바깥 것부터
적어 둔다(`sameStartOpChain`).

| 시작 위치 | 끝 연산(바깥부터) | 부분식 |
|---|---|---|
| 0 | 18, 10, 6 | 식 전체, `(a + b) * c`, `a + b` |
| 11 | 17 | `d + e` |
| 3, 7, 14 | 없음 | `b`, `c`, `e`는 부모의 오른쪽 자식이다 |

런타임은 이 구간을 바이트를 한 번 훑어 얻는다. 스택에 값 대신 "그 값을 만든 부분식의 시작 위치"를
올린다. 연산을 만나면 오른쪽 피연산자의 시작을 꺼내고, 남은 왼쪽 피연산자의 시작이 곧 이 연산의
부분식 시작이다.

| 명령 | 스택(시작 위치) | 이 연산의 부분식 |
|---|---|---|
| `a` | [0] | |
| `b` | [0, 3] | |
| ADD(6) | [0] | 0~6 |
| `c` | [0, 7] | |
| MUL(10) | [0] | 0~10 |

## 2. 평가

`runExpr`가 후위 바이트를 앞에서부터 한 번 돈다. 이 문서의 예는 아래 식 하나로 이어 간다.

```
props { rows: { title: string, score: number }[], cursor: number }

${rows[cursor].score * 2}
```

store의 leaf 배치다. rows 필드 leaf에는 요소가 아니라 arrayInfoIndex가 들고, 요소 목록은 arrayPool의
`elemStartLeafIndices`가 `[2, 4, 6]`으로 든다.

| leaf | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| 값 | 0 | 0 | "A" | 10 | "B" | 20 | "C" | 30 |
| 뜻 | rows(arrayInfoIndex) | cursor | rows[0].title | rows[0].score | rows[1].title | rows[1].score | rows[2].title | rows[2].score |

식의 바이트다.

| 위치 | 0 | 3 | 6 | 7 | 9 | 10 | 12 |
|---|---|---|---|---|---|---|---|
| 명령 | LOAD_VAR rows | LOAD_VAR cursor | ELEM_AT | FIELD_AT 1 | READ_LEAF | LOAD_SMALL_INT 2 | MUL |

스택에는 값이 오르는데, **인덱스 접근만 값 대신 leafIndex를 올린다.** 요소 위치는 인덱스를 세어 봐야
정해지기 때문이다.

| 명령 | 스택 | 비고 |
|---|---|---|
| LOAD_VAR rows | [0] | rows 필드 leaf의 값 = arrayInfoIndex 0 |
| LOAD_VAR cursor | [0, 0] | cursor |
| ELEM_AT | [2] | `elemStartLeafIndices[0]` = 2 |
| FIELD_AT 1 | [3] | 2 + score의 offset 1 |
| READ_LEAF | [10] | leaf 3의 값 |
| LOAD_SMALL_INT 2 | [10, 2] | |
| MUL | [20] | |

평가하며 두 가지를 모은다.

**cache** - 연산마다 결과 한 칸. 식 길이가 아니라 연산 수만큼 잡는다.

| 연산 | ELEM_AT(6) | FIELD_AT(7) | READ_LEAF(9) | MUL(12) |
|---|---|---|---|---|
| cache | 2 | 3 | 10 | 20 |

**reads** - 읽은 leaf와 읽은 명령의 위치. 처음 셀 때만 모은다. 여기서 구독할 leaf 목록(`readLeaves`)과
leaf마다 그 leaf를 읽은 변수(`varsOfLeaf`)가 나온다. 같은 leaf가 두 번 나오면(`a + a`) 한 번만 담는다.

| 읽은 leaf | 0 | 1 | 3 |
|---|---|---|---|
| 읽은 위치 | 0 | 3 | 9 |
| 변수 | rows | cursor | READ_LEAF |

## 3. 부분 재평가

식이 읽는 leaf 하나가 바뀌면, 그 leaf를 읽지 않는 부분식은 계산하지 않고 cache의 지난번 값을 올린다.

```
(a + b) * (c - d)
```

| 위치 | 0 | 3 | 6 | 7 | 10 | 13 | 14 |
|---|---|---|---|---|---|---|---|
| 명령 | `a` | `b` | ADD | `c` | `d` | SUB | MUL |
| c가 바뀌면 | 건너뜀 | 건너뜀 | cache 값을 올림 | 읽음 | 읽음 | 계산 | 계산 |

건너뛸 곳은 변수마다 미리 정해 둔다(`skipPastOpByVar`). 키는 부분식이 시작하는 잎 위치, 값은 그
부분식의 끝 연산 위치다.

| 바뀐 변수 | 건너뛸 표 | 건너뛰는 부분식 |
|---|---|---|
| a, b | `{ 7: 13 }` | `c - d` |
| c, d | `{ 0: 6 }` | `a + b` |

표를 만들 때는 잎마다, 거기서 시작하는 부분식을 바깥 것부터 보며 바뀐 위치를 품지 않은 첫 부분식을
고른다. c(위치 7)가 바뀔 때 위치 0에서는

| 부분식 | 구간 | 7을 품는가 | |
|---|---|---|---|
| 식 전체 | 0~14 | 품는다 | 안쪽으로 |
| `a + b` | 0~6 | 안 품는다 | 건너뛴다 `{ 0: 6 }` |

끝 연산 다음 명령은 `끝 위치 + 그 명령의 바이트 수`다. `FIELD_AT`처럼 operand가 붙은 연산이 끝일 수
있어 `+ 1`이 아니다.

### 변수

store leaf를 읽는 명령을 "같은 leaf를 읽는가"로 묶은 것이 변수다.

| 식 | 변수 |
|---|---|
| `a + a` | a는 한 변수 - 두 위치가 늘 함께 바뀐다 |
| `s + s.length` | `LOAD_VAR s`와 `LOAD_STRING_LENGTH s`는 둘 다 s의 값 leaf를 읽어 한 변수 |
| `xs[0] + xs.length` | `LOAD_ARRAY_LENGTH xs`는 길이 leaf(`sizeLeafIndex`)를 읽어 `LOAD_VAR xs`와 다른 변수 |
| `rows[i].t + rows[j].t` | `READ_LEAF` 둘은 각각 따로 변수 - 읽는 leaf는 실행 중에 정해지지만 명령 위치는 고정 |

`${rows[cursor].score * 2}`에서 score leaf만 바뀌면 leafIndex를 내는 앞부분은 건너뛴다. `READ_LEAF`
변수의 건너뛸 표는 `{ 0: 7 }`이다.

| 위치 | 0 | 3 | 6 | 7 | 9 | 10 | 12 |
|---|---|---|---|---|---|---|---|
| 명령 | LOAD_VAR rows | LOAD_VAR cursor | ELEM_AT | FIELD_AT 1 | READ_LEAF | LOAD_SMALL_INT 2 | MUL |
| score가 바뀌면 | 건너뜀 | 건너뜀 | 건너뜀 | cache 값 3을 올림 | 다시 읽음 | 읽음 | 계산 |

### 식 정의당 한 번과 인스턴스마다

**식 정의당 한 번** - 식 바이트만으로 정해져, 같은 식을 쓰는 인스턴스(`@for` 회차마다 생기는 것)가
공유한다. 런타임이 식 바이트 객체를 키로 한 `WeakMap`에 둔다.

| 무엇 | 사용처 |
|---|---|
| `skipPastOpByVar` | 변수마다 건너뛸 표 |
| `cacheIndex`, `opCount` | 연산 위치 -> cache 칸 번호, 연산 수 |
| `positionsByVar`, `varAt` | 변수 -> 읽는 위치, 위치 -> 변수. 처음 셀 때 어느 leaf를 어느 변수가 읽었는지 모은다 |
| `leafIndexOpsByVar` | 인덱스 접근의 구독을 다시 건다(5절) |
| `sameStartOpChain` | 위의 표를 만들 때만 사용한다 |

**인스턴스마다**

| 무엇 | 크기 |
|---|---|
| cache | 연산 수 |
| 구독 함수 | 하나(4절) |
| `readLeaves`, `skipPastOpOfLeaf` | 읽은 leaf 수. `skipPastOpOfLeaf`는 대개 정의의 표를 가리키기만 한다 |
| 지난번 결과 | 값 하나. 다시 센 값이 같으면 DOM에 반영하지 않는다 |

어느 변수가 바뀌어도 건너뛸 부분식이 없으면(`a - b`, `big > 50`) 표가 null이다. 이런 식은
`subscribeWholeExpr`로 가서 cache도 leaf마다 표도 없이, leaf가 바뀌면 처음부터 센다.

## 4. 구독

**식 인스턴스마다 구독 함수는 하나다.** 식이 읽는 leaf마다 같은 함수를 걸고, 함수는 호출될 때 받은
leafIndex로 그 leaf의 건너뛸 표를 고른다.

```
leaf 0 (rows)    --\
leaf 1 (cursor)  ---+--> reevalOnChange(value, leafIndex)
leaf 3 (score)   --/       k = readLeaves.indexOf(leafIndex)
                           reeval with skipPastOpOfLeaf[k]
```

다시 센 값이 지난번과 같으면 DOM에 반영하지 않는다.

leaf마다 함수를 따로 두면 많은 행에서 함수가 수만 개 늘어, 명령 수가 아니라 메모리가 CPU 캐시를
넘쳐 다시 세기가 처음부터 세기보다 느려졌다. 같은 이유로 구독 함수가 잡는 변수도 줄인다 - 건너뛸
것이 있는 식과 없는 식을 메서드로 나누고, `varsOfLeaf`는 인덱스 접근이 있는 식에서만 남긴다.

**두 변수가 한 leaf를 읽을 때** - 부모가 같은 leaf를 두 prop으로 넘긴 경우다. 자식 식 `${x + y}`에
부모가 x, y로 같은 leaf 23을 넘기면

```
readLeaves   [23]
varsOfLeaf   [[x, y]]
```

leaf 23이 바뀌면 x, y가 함께 바뀌므로, 두 변수의 위치를 합쳐 이 인스턴스용 표를 새로 만든다.

**가지를 떼고 붙일 때** - 구독은 식이 놓인 가지(`TBranch`)의 목록에 함께 담긴다.

```
branch.leafIndices   [0,  1,  3 ]
branch.updateFns     [fn, fn, fn]
```

- 가지를 떼면 목록대로 구독을 푼다.
- 가지를 붙이면 목록대로 모두 건 뒤, 목록의 사본을 돌며 떼어져 있던 동안 놓친 값을 따라잡는다.

모두 건 뒤에 따라잡는 이유는, 따라잡는 구독 함수가 인덱스 접근의 구독을 다시 걸며 목록을 고칠 수
있어서다(5절). 사본에 남은 옛 leafIndex로 함수가 다시 호출되면, 그 leafIndex는 `readLeaves`에 없으므로
함수가 바로 끝난다.

## 5. 인덱스 접근과 구독 다시 걸기

`cursor`가 바뀌면 `READ_LEAF`가 읽는 leaf 자체가 바뀐다. 구독도 새 leaf에 다시 걸어야 한다.

| cursor | ELEM_AT | FIELD_AT | READ_LEAF가 읽는 leaf | 구독하는 leaf |
|---|---|---|---|---|
| 0 | 2 | 3 | 3 (10) | 0, 1, 3 |
| 1 | 4 | 5 | 5 (20) | 0, 1, 5 |

**어느 변수가 이 leafIndex를 정하는지는 표를 만들 때 정해진다.** `READ_LEAF`를 만나면, 그 바로 앞
연산(leafIndex를 넘기는 연산)의 부분식 구간 안에서 읽히는 변수마다 그 연산 위치를 단다
(`leafIndexOpsByVar`).

| 위치 | 0 | 3 | 6 | 7 | 9 | 10 | 12 |
|---|---|---|---|---|---|---|---|
| 명령 | LOAD_VAR rows | LOAD_VAR cursor | ELEM_AT | FIELD_AT 1 | READ_LEAF | LOAD_SMALL_INT 2 | MUL |
| FIELD_AT(7)의 구간 | = | = | = | = | | | |

| 변수 | `leafIndexOpsByVar` | |
|---|---|---|
| rows | [7] | 구간 안 - 인덱스 쪽만이 아니라 배열 쪽도 든다 |
| cursor | [7] | 구간 안 |
| READ_LEAF | [] | |

**다시 센 뒤 구독을 다시 건다.** cursor가 0에서 1로 바뀌면

1. cursor 변수의 건너뛸 표로 다시 센다. `cache[FIELD_AT]`이 5가 된다.
2. `leafIndexOpsByVar[cursor]`가 `[7]`이다.
3. `cache[FIELD_AT(7)]`의 5가 `READ_LEAF`가 방금 읽은 leafIndex다.
4. `resubscribeReadLeaf`가 지금 구독하는 3과 5를 비교한다. 다르므로
   - 3을 읽는 변수가 더 없으니 3의 구독을 풀고 가지 목록에서 뺀다.
   - 5는 처음 읽으니 5에 구독을 걸고 가지 목록에 더한다.

새 leaf를 이미 다른 변수가 읽고 있으면, 구독을 새로 걸지 않고 두 변수의 위치를 합쳐 그 leaf의 건너뛸
표를 새로 만든다(`${rows[cursor].score + rows[0].score}`에서 cursor가 0이 된 경우).

**중첩은 따로 다룰 것이 없다.** 안쪽 부분식이 바깥 구간에 통째로 들어가, 안쪽을 정하는 변수는 두
연산에 모두 달린다.

```
${columns[lane].cards[seat].title}
```

| 명령 | LOAD_VAR columns | LOAD_VAR lane | ELEM_AT | FIELD_AT(cards) | READ_LEAF | LOAD_VAR seat | ELEM_AT | FIELD_AT(title) | READ_LEAF |
|---|---|---|---|---|---|---|---|---|---|
| 안쪽 FIELD_AT의 구간 | = | = | = | = | | | | | |
| 바깥 FIELD_AT의 구간 | = | = | = | = | = | = | = | = | |

| 변수 | `leafIndexOpsByVar` |
|---|---|
| columns, lane | 안쪽 FIELD_AT, 바깥 FIELD_AT |
| 안쪽 READ_LEAF, seat | 바깥 FIELD_AT |

### 배열 조작

**removeAt** - 목록만 당기고 요소 leaf는 옮기지 않는다.

```
removeAt(rows, 0)

elemStartLeafIndices   [2, 4, 6]  ->  [4, 6]
leaf 0 (rows)          0          ->  0
```

cursor 0이 가리키는 요소는 A에서 B로 바뀌었지만, 식이 읽는 leaf(0, 1, 3)는 하나도 값이 바뀌지 않았다.
`set`은 값이 같으면 구독 함수를 호출하지 않으므로, `removeArrayElementAt`이 rows 필드 leaf에 `notify`를
호출한다. 식은 rows 변수가 바뀐 것으로 받아 위와 같은 경로로 다시 세고 구독을 다시 건다.

```
notify(leaf 0)
  -> reeval with skip table of rows    ELEM_AT 4, FIELD_AT 5
  -> leafIndexOpsByVar[rows] = [7]
  -> resubscribe 3 -> 5
```

| 조작 | 처리 |
|---|---|
| `removeAt` | 위와 같이 `notify` |
| `setArray`, `swapAt` | 요소 자리를 두고 요소 leaf에 값을 기록한다. 구독 중인 leaf에 새 값이 들어와 따로 할 일이 없다 |
| `push` | 꼬리에 붙여 기존 인덱스가 가리키는 요소가 안 바뀐다 |

**범위 밖 인덱스는 쓰는 쪽에서 검사한다.** 인덱스가 배열 길이를 넘으면 `ELEM_AT`이 `undefined`를 낸다.
다른 언어의 배열 접근처럼 핸들러가 인덱스를 범위 안에 두어야 한다.

## 6. 버린 안

| 안 | 버린 이유 |
|---|---|
| 다시 셀 때마다 건너뛸 부분식을 고른다 - 잎 위치마다 거기서 시작하는 부분식을 바깥 것부터 보며, 바뀐 leaf를 읽는 위치가 구간 안에 있는지 비교한다 | 비교 비용이 다시 셀 때마다 들어, 다시 계산할 연산이 많으면 처음부터 세도록 비율 판단을 따로 두어야 했다. 변수마다 표를 미리 계산하면 비교도 비율 판단도 없다 |
| 식이 읽는 leaf마다 구독 함수를 따로 둔다 | 많은 행에서 힙이 크게 늘어 다시 세기가 처음부터 세기보다 느려졌다(4절) |
| 건너뛸 표를 인스턴스마다 식 길이의 배열로 | 조회는 객체와 같거나 느렸고, 인스턴스마다 배열이 늘어 메모리만 커졌다 |
| 컴파일러가 명령어에 건너뛸 자리를 표시한다 - 부분식 앞에 `SKIP`(건너뛸 곳, cache 번호), 뒤에 `STORE` | 런타임 분석은 없어지지만 갱신 속도 이득이 없다. 건너뛸 것이 없을 때 처음부터 세기로 돌아가지 못해 최악의 경우 크게 느리다 |
| 결합/분배 법칙으로 식 모양 바꾸기 - `((a + b) + c) + d`를 `(a + b) + (c + d)`로, `x*b0 + x*b1`을 `x*(b0 + b1)`로 | number가 부동소수점이라 묶는 순서를 바꾸면 값이 달라진다(`(0.1 + 0.2) + 0.3` 대 `0.1 + (0.2 + 0.3)`) |
| `ELEM_AT`에 인덱스 쪽 부분식 길이를 operand로 싣는다 | 포맷이 바뀌어 BYTECODE.md, codegen, 런타임, qubb 인스펙터가 함께 바뀌는데, 런타임이 표를 만들 때 이미 식을 훑고 있어 얻을 것이 없다 |

**보류** - 식 평가를 wasm으로. wasm 해석기가 JS 해석기보다 빨랐지만, 지금 병목은 식 계산이 아니라
메모리와 DOM 반영이라 넣지 않았다.

## 7. 잴 때

벤치는 레포 루트의 bench-expr/에 있다(`./bench-expr.sh`).

- 여러 구현을 한 프로세스에서 차례로 재면 V8의 최적화 상태가 섞여 같은 코드가 측정마다 크게
  흔들린다. 식과 구현 조합마다 프로세스(브라우저는 페이지)를 따로 띄운다.
- 라운드 최솟값은 GC 비용을 가린다. 중앙값과 p90을 같이 본다.
- 다음 프레임까지 재면 주사율에 묶여 차이가 안 보인다. DOM 반영 시점은 MutationObserver로 잰다.
- node에서 DOM 없이 재면 메모리 차이가 안 보인다(4절). 인스턴스 메모리를 바꾸는 변경은 브라우저에서
  잰다.

## 8. 남은 것

- **여러 leaf가 한 번에 바뀌는 경우** - 핸들러 하나가 leaf 여럿을 바꾸면 leaf마다 한 번씩 다시 센다.
  값은 맞지만 중간 값이 한 번씩 DOM에 반영된다. 갱신을 모아 한 번에 처리하는 배치와 함께 본다.
- **모든 행의 값이 바뀌는 갱신이 처음부터 세기보다 약간 느리다**(환율 변경). 식 계산 자체는 더
  빠른데, 프로파일에서 차이가 텍스트 반영과 `reevalExpr` 호출 쪽에서 난다. 원인은 모른다.
