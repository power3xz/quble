# leaves 메모리 레이아웃

`leaf-store.ts`가 관리하는 평탄 배열 `leaves`가 실제로 어떤 모습인지, 요소가 늘고 줄 때
어떻게 변하는지 그림으로 본다. 왜 이 구조인지(배열 앵커, 색인 연쇄)는 REACTIVITY #3.2에
있고, 여기는 **그 구조가 시간에 따라 어떻게 변하는지**를 다룬다.

## 1. 진입 시점 - plant가 심은 모습

`leaves`는 값만 담은 평탄 배열이다 - 칸 하나만 봐서는 그게 무엇인지 알 수 없다(`leaves[1]`의
`0`이 숫자 값인지 arrayInfoIndex인지 구분이 안 된다). 구조를 아는 건 둘로 갈린다.

- **타입 테이블(`module.types`)** - 어떤 모양인가. 루트는 `defs[0].propsTypeRef`로,
  배열 원소는 `arrayInfo.elemTypeRef`로 들어가 필드 순서와 중첩을 얻는다. 값을 다시 객체로
  조립하는 `assemble`이 이걸 따라 걷는다.
- **arrayPool** - 그 요소가 지금 어디 있나. 요소 수와 시작 leafIndex는 push/removeAt으로
  계속 바뀌므로 타입이 아니라 여기가 든다.

`elemSize`가 "몇 칸"만 알려주고 "어떤 모양"은 모르기 때문에 둘이 다 필요하다.

```
props { title: string, tags: string[],
        rows: { label: string, meta: { author: string, level: number },
                cells: string[] }[] }
값     { title:"TTL", tags:["tagA","tagB"],
         rows:[ {label:"R0", meta:{author:"kim",level:7}, cells:["c00"]},
                {label:"R1", meta:{author:"lee",level:9}, cells:["c10","c11"]} ] }

leaves
          0        1        2        3        4        5        6        7        8        9        10       11       12       13       14       15
      ┌────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┐
      │ "TTL"  │   0    │   1    │ "tagA" │ "tagB" │  "R0"  │ "kim"  │   7    │   2    │  "R1"  │ "lee"  │   9    │   3    │ "c00"  │ "c10"  │ "c11"  │
      └────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┘
          │        │        │     └───────────────┘ └─────────────────────────────────┘ └─────────────────────────────────┘ └──────┘ └───────────────┘
          │        │        │           tags                      rows[0]                             rows[1]               r0.cells     r1.cells
          │        │        │                       label   author   level  cells칸
          │        │        └ rows -> arrayInfoIndex 1
          │        └───────── tags -> arrayInfoIndex 0
          └────────────────── title 값 (스칼라는 값이 그 자리에)

       └────────────────────────┘ └───────────────────────────────────────────────────────────────────────────────────────┘ └────────────────────────┘
                  깊이 0                                                        깊이 1                                                      깊이 2

arrayPool
  [0] tags          elemSize 1   elemStart [3, 4]
  [1] rows          elemSize 4   elemStart [5, 9]     <- label+author+level+cells칸 = 4
  [2] rows[0].cells elemSize 1   elemStart [13]
  [3] rows[1].cells elemSize 1   elemStart [14, 15]
```

**두 규칙이 이 배치를 만든다.**

- **배열은 한 칸만 쓴다** - 배열 필드가 차지하는 건 `arrayInfoIndex` 한 칸이고 실체는
  arrayPool에 있다. 그래서 뒤 필드의 offset이 요소 수에 안 밀린다.
- **배열 중첩 깊이 순서로 심는다** - 그림 아래의 깊이 0/1/2가 그 구간이다. 어떤 배열에도
  안 들어간 값이 깊이 0(`title`), `rows` 안이 깊이 1(`rows[0].label`), `rows` 안 `cells`
  안이 깊이 2(`rows[0].cells[0]`)다. 객체를 거치는 건 깊이를 안 늘린다 - `meta.author`는
  배열을 더 통과하지 않으므로 `label`과 같은 깊이 1이다.

  같은 깊이를 전부 깔고 나서 다음 깊이로 넘어간다(너비 우선, BFS). 깊이 1의 `rows[0]`을
  심다가 그 안의 `cells` 요소까지 바로 따라 내려가면(깊이 우선, DFS) `cells` 요소들이
  `rows[0]`과 `rows[1]` 사이에 끼어든다. 요소 하나가 차지하는 `elemSize`칸은 연속이어야
  하는데(필드를 `base + j`로 읽는다) 그 사이가 갈라진다. 그래서 안쪽 배열의 요소는 미뤄
  두었다가 뒤에 몰아 심는다.

읽는 법은 색인 연쇄다.

```
rows[1].cells[1]
  -> leaves[2] = 1              rows의 arrayInfoIndex
  -> pool[1].elemStart[1] = 8   rows[1]이 8에서 시작
  -> leaves[8 + 2] = 3          cells칸(요소 안 offset +2) = arrayInfoIndex 3
  -> pool[3].elemStart[1] = 13
  -> leaves[13] = "z"
```

## 2. 요소가 늘 때 - alloc

먼저 `freeBySize` - 회수된 빈 블록을 **크기별 목록(버킷)**으로 모아 둔 것이다. 키가 블록
크기(칸 수), 값이 그 크기로 비어 있는 블록들의 시작 leafIndex다.

```
freeBySize { 2 -> [10, 4],    2칸짜리 빈 블록이 10번과 4번에 있다
             3 -> [7] }       3칸짜리가 7번에
```

크기가 정확히 같을 때만 재사용한다 - 3칸 블록을 쪼개 2칸으로 쓰거나, 붙은 두 블록을 합쳐
큰 요청에 내주지 않는다. 배열 요소의 크기는 타입이 정하므로 나올 수 있는 크기가 몇 종류로
정해져 있고, 그래서 쪼개기/합치기 없이 버킷에서 꺼내 쓰는 것만으로 충분하다.
덕분에 넣고 빼는 게 전부 O(1)이다.

`push`가 요소 한 벌을 펴서 `alloc`에 넘긴다. 두 경로가 있고 **둘 다 O(1)**이다.

```
(a) 같은 크기 빈 블록이 버킷에 있으면 그 자리를 재사용

    freeBySize { 2 -> [2] }          leaves ["a","b","c","d","e","f"]
                     ^                              ^^^^^^^^^ 죽은 값
    alloc(["X","Y"])  size 2 -> 버킷에서 2를 꺼냄

    freeBySize { 2 -> [] }           leaves ["a","b","X","Y","e","f"]
                                                     ^^^^^^^^^ 그 자리에 덮어씀
    반환값 2 (재사용한 시작 leafIndex)

(b) 없으면 leaves 끝에 확보

    freeBySize { 2 -> [] }           leaves ["a","b","X","Y","e","f"]  len 6
    alloc(["P"])  size 1 -> 버킷 없음

                                     leaves ["a","b","X","Y","e","f","P"]  len 7
                                                                      ^ 새 칸
    반환값 6
```

크기가 안 맞으면 버킷을 못 쓴다 - 위 (b)에서 size 2 블록이 비어 있어도 size 1 요청은
끝에 확보한다. **병합도 split도 안 한다**: 배열 요소 크기 집합은 타입이 정해 정적/유한이라
크기별 정확 매칭이면 충분하다.

## 3. 요소가 줄 때 - free

`removeAt`이 요소 칸 `[start, start+size)`를 회수한다. **자리가 어디냐로 갈린다.**

```
회수할 칸이 맨 뒤면 leaves 길이를 줄여 배열 자체를 짧게 만든다

    leaves ["a","b","c","d"]  len 4
    free(3, 1)   start+size === leaves.length 이므로 꼬리
    leaves ["a","b","c"]      len 3        <- leaves.length = start

중간이면 값을 안 지우고 버킷에 반납한다

    leaves ["a","b","c","d"]  len 4
    free(1, 1)   중간
    leaves ["a","b","c","d"]  len 4        <- "b" 그대로 남음(죽은 값)
    freeBySize { 1 -> [1] }                <- 자리만 기록

    다음 alloc(["Z"])이 size 1이라 그 자리를 재사용
    leaves ["a","Z","c","d"]  len 4        <- 죽은 값 위에 덮어씀(길이 그대로)
```

**중간 회수가 값을 안 지우는 건 의도다.** 그 칸은 버킷이 잡고 있어 아무도 안 읽고,
다음 alloc이 덮어쓴다. 지우는 건 순수 비용이다.

`free`는 값과 버킷만 만지고 구독(`subscribers`)은 안 건드린다. 구독 회수는
`removeBranchAt`(region.ts)이 한다.

## 4. 값이 바뀔 때 - set과 통지

```
set(leafIndex, v)
  │
  ├ 같은 값이면 여기서 끝  (leafStore.get(i) === value -> return)
  │                        재렌더가 안 도는 지점
  │
  ├ leaves[leafIndex] = v
  │
  └ subscribers[leafIndex] 를 [...subs]로 복사한 뒤 그 복사본을 순회하며 호출
```

복사본을 도는 이유는 **구독자를 부르는 도중에 구독자 목록이 바뀔 수 있어서**다. 구독자가
하는 일이 값 하나 갱신으로 끝나지 않고, 화면에서 사라지는 부분의 구독을 정리하는 데까지
이어질 수 있다. 그러면 지금 순회하고 있는 그 목록에서 원소가 빠진다. 원본을 돌던 중이면
순회가 어긋나므로, 부르기 전에 복사해 둔다.

`alloc`은 통지하지 않는다 - 새 칸이라 구독자가 없다.

## 열어둔 것

- 한 조작이 여러 칸을 쓰면 칸마다 통지가 나가 중간 상태가 보인다(ISSUES.md). 지금은
  구독자가 자기 칸만 봐서 안 드러난다.
