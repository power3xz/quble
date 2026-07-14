# scope 슬롯 + 값 출처 + 배열 (draft)

> 상태: `array-type` 브랜치 진행 중 논의. **확정 아님.** 머지 전 REACTIVITY.md /
> BYTECODE.md / DESIGN.md에 반영하고 이 draft는 정리한다.
> VALUE-SOURCES.draft.md를 흡수·갱신한 문서(그 draft는 이걸로 대체). `@for`는 FOR.draft.md.

## 한 줄 요약

**scope 슬롯 = `(type, index)` 쌍.** 컴파일러가 root 타입을 알아 offset과 type을 미리
확정하므로, 런타임엔 경로(path/segment)도 경로 캐시도 타입 테이블도 없이 index만 흐른다.


## 슬롯 = (type, index)

부모가 자식에게, `@for`가 몸체에 값을 넘길 때 scope 슬롯에 `(type, index)`를 꽂는다.
type이 index를 어떻게 읽을지 정한다:

    type      index            읽는 법
    -------   --------------   ----------------------
    scalar    leafIndex        store.get(index)
    object    base             base + fieldOffset (필드마다)
    array     arrayInfoIndex   arrayPool[index]
    const     poolIndex        constpool[index]

슬롯은 인터리브 평탄 배열 하나: `slots[2*offset]=type`, `slots[2*offset+1]=index`.


## 경로가 필요 없는 이유

접근 경로(`user.name`)는 use-site에서 컴파일에 고정이다. 컴파일러가 root(props) 타입을
알아 경로를 걸어 **offset과 도달 type을 미리 계산**한다.

    {user.name}    ->  base + nameOffset, type=scalar
    {item.title}   ->  item base + titleOffset, type=scalar

런타임에 변하는 건 **base 하나**뿐이고 그건 scope가 들고 있다. 그래서:

- 매 접근 rootValue를 다시 순회할 이유가 없다 (index가 이미 확정).
- 같은 leaf 재접근도 같은 index -> 경로 캐시 불필요.
- store 밖 rootValue를 다시 읽을 일이 없다 -> path 문자열 불필요.

leafIndex 자체는 런타임 발급이다(요소 개수가 런타임). 컴파일이 박는 건 offset뿐 -
접근 = base(런타임) + offset(컴파일). (no-compiletime-leafindex 유지.)


## 값 출처 - store만 아니다

값 종류에 따라 슬롯 type이 다르고, 소비 지점이 type대로 읽는다:

    반응값   store        구독 O
    상수     상수풀       구독 X (안 변함)

자식은 자기 prop이 리터럴로 왔는지 변수로 왔는지 모른다
(`Comp(x="lit")` vs `Comp(x={v})` - use-site마다 다름). 그래서 부모가 넘길 때 type을
정하고(부모는 앎), 자식은 슬롯 type대로 읽는다. const 슬롯은 구독을 건너뛴다.


## 배열 - store엔 primitive만, 실체는 arrayPool

store는 선형 메모리라 primitive만 담는다. 가변 크기인 배열은 arrayPool(힙)에 두고,
store엔 그걸 가리키는 색인(정수)만 둔다.

    슬롯 (array, arrayInfoIndex)  ->  arrayPool[arrayInfoIndex]

    arrayInfo = {
      elemSize             원소 하나가 차지하는 leaf 수 (string[]=1, {c,d}[]=2). 컴파일 확정.
      elemStartLeafIndex   원소 i의 첫 leafIndex 목록. 길이 = 배열 길이.
      sizeLeafIndex?       배열 길이를 담은 store leaf (아래).
    }

원소 i의 필드 j = `store.get(elemStartLeafIndex[i] + j)`.
원소 **사이**는 목록(leaf는 흩어질 수 있어 시작 위치를 적어 둠), 원소 **안**은 `+j` 산술
(한 원소의 필드는 연속 발급).


### 길이는 arrayInfo.sizeLeafIndex

배열 길이가 참조되면(`{items.length}`, 또는 push/pop) 그 길이를 store leaf로 두고
arrayInfo.sizeLeafIndex가 그 leafIndex를 가리킨다. leaf라서 구독이 걸린다.

    길이 읽기   store.get(sizeLeafIndex)
    push/pop    elemStartLeafIndex 갱신 + store.set(sizeLeafIndex, 새 길이) -> 통지

동적(push/pop) 배열만 구독을 건다. 길이 참조만 있고 안 변하면 leaf만 두고 구독은 건너뛴다.
(배열 슬롯은 늘 1칸(arrayInfoIndex)으로 두어 뒤 필드 offset이 안 밀린다.)


## 배열의 배열 - 색인 연쇄

    grid = { rows: { cells: string[] }[] }
    rows = [ {cells:[a,b]}, {cells:[c,d,e]} ]

    store.leaves            arrayPool
    ------------            ------------------------------------------
    leaf#0 = arrInfo#0      arrInfo#0 (rows)      elemStartLeafIndex [1,4]
    leaf#1 = arrInfo#1      arrInfo#1 (rows[0].cells)                [2,3]
    leaf#2 = 'a'            arrInfo#2 (rows[1].cells)                [5,6,7]
    leaf#3 = 'b'
    leaf#4 = arrInfo#2
    leaf#5 = 'c'
    leaf#6 = 'd'
    leaf#7 = 'e'

- store 칸 값이 `arrInfo#N`인 건 그 칸이 arrayInfo 색인(핸들)이라는 뜻. 배열 값이 아니다.
- rows 원소 base = leaf#1, leaf#4 (elemStartLeafIndex [1,4]). 각 원소의 cells 필드 칸이라,
  그 칸에 안쪽 cells 배열의 arrInfo 색인이 들어 있다.

읽는 법 (`rows[1].cells[2]`):

    arrInfo#0.elemStartLeafIndex[1] = 4      rows[1] 원소 base
    store.get(4 + cellsOffset=0) = arrInfo#2 색인
    arrInfo#2.elemStartLeafIndex[2] = 7      cells[2] base
    store.get(7) = 'e'

elemStartLeafIndex는 늘 leafIndex만 담고, 배열 색인은 store 칸에 값으로 든다. 그래서 몇
겹이든 `leafIndex -> 색인 -> arrayInfo`가 번갈아 이어진다 - 문자열 path처럼 끊기지 않는다.


## plant - 값을 store에 심기

root(props)를 렌더 진입 때 심는다. 고정 구조(scalar/object)는 값+칸을 연속으로, 배열은
색인 칸만 두고 멈춘다(원소는 @for가 돌 때 심는다).

    plant(root):
      scalar  ->  값 심음
      object  ->  필드마다 재귀 (연속 칸)
      array   ->  색인 칸 하나 (원소 안 폄)

배열을 여기서 펴면 안쪽 leaf가 부모 칸을 밀어 base+offset이 깨진다 - 색인 칸에서 멈춘다.
심는 순서는 **타입 순서**(값의 키 순서 아님)라야 codegen offset과 맞고, 누락 필드도 자리를
지킨다.

### 타입 테이블은 런타임에 없다

접근/넘김이 codegen이 박은 (type, offset)만 쓰듯, plant도 codegen이 심기 명령을 펼친다.
런타임은 명령만 실행하고 타입 테이블을 참조하지 않는다.

    plant Post { title, author: User, tags: string[] }:
      PLANT_SCALAR  title
      PLANT_ENTER   author        (value = value.author, 끝나면 복귀)
        PLANT_SCALAR  id
        PLANT_SCALAR  name
        PLANT_SCALAR  avatar
      PLANT_ARRAY   tags          (색인 칸, 원소는 @for)

값은 현재 value에서 한 칸씩 내려가며 꺼낸다(`value[key]`) - 전역 path 아님.


## push - 동적 추가 (다음 단계)

새 심기 명령이 필요 없다 - @for 몸체가 원소 하나를 심는 명령을 이미 가졌으니 재사용한다.

    items.push(newItem):
      1. slot에서 arrayInfo 찾음
      2. 원소 심기 실행 -> 새 base (store에 elemSize칸)
      3. elemStartLeafIndex.push(새 base)
      4. sizeLeafIndex 있으면 store.set(sizeLeafIndex, 새 길이) -> 통지
      5. DOM 생성, region 꼬리에 붙임

값은 핸들러가 준다(rootValue 무관).


## 닫힌 결정

- 슬롯 = (type, index) 인터리브 평탄. path/segment, 경로 캐시, RAW 폐기.
- 컴파일이 root 타입으로 offset/type 확정 -> 런타임 순회·타입 테이블 불필요.
  leafIndex는 런타임 발급, 컴파일은 offset만 (no-compiletime-leafindex 유지).
- store엔 primitive만 (leaf 값 또는 arrayInfo 색인). 배열 실체는 arrayPool.
- 배열 = (array, arrayInfoIndex) + { elemSize, elemStartLeafIndex, sizeLeafIndex? }.
  배열의 배열 = 색인 연쇄. 길이는 sizeLeafIndex(store leaf, 구독 대상).
- plant는 타입 순서로, 심기 명령으로 펼침. 배열은 색인 칸에서 멈춤.

## 미결

- **bytecode 인코딩** - (type, index)의 type 비트, PLANT_* opcode, FOR_ARRAY operand.
- **forId <-> arrayInfoIndex** - forId(컴파일)로 런타임 arrayInfoIndex를 찾는 다리. 한
  컴포넌트를 부모가 다른 배열로 여러 번 그리면 forId는 같고 arrayInfo가 다르다.
- **객체 배열 원소 타입** - 원소를 다시 조립할 정보를 어디 두나. 스칼라 배열부터 착수해 뒤로.
