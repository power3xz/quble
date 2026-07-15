# scope 슬롯 + push 명령 + 배열 (draft)

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
    leaf      leafIndex        store.get(index)
    object    base             base + fieldOffset (필드마다)
    array     arrayPoolIndex   arrayPool[index]
    const     poolIndex        constpool[index]

슬롯은 인터리브 평탄 배열 하나: `slots[2*offset]=type`, `slots[2*offset+1]=index`.


## 경로가 필요 없는 이유

접근 경로(`user.name`)는 use-site에서 컴파일에 고정이다. 컴파일러가 root(props) 타입을
알아 경로를 걸어 **offset과 도달 type을 미리 계산**한다.

    {user.name}    ->  base + nameOffset, type=leaf
    {item.title}   ->  item base + titleOffset, type=leaf

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


## push 명령 - 부모 슬롯을 한 필드 내려가 자식에 넘긴다

부모 스코프 슬롯 `(type, index)`에서 한 필드 내려가 **전환한 슬롯**을 자식 arg로 밀어넣는다.
넘길 필드의 type을 컴파일이 아니, 명령이 결과 type을 정한다(런타임 type 분기 없음).

    PUSH_LEAF    offset   ->  (leaf,   위치)
    PUSH_OBJECT  offset   ->  (object, 위치)
    PUSH_ARRAY   offset   ->  (array,  store.get(위치))
    PUSH_ARG_LIT poolIndex ->  (const,  poolIndex)      리터럴, store/구독 없음

위치는 부모 슬롯 type이 정한다(런타임이 슬롯 태그로):

    부모가 (object, base)     위치 = base + offset
    부모가 (array,  poolIdx)  위치 = arrayPool[poolIdx].elemStartLeafIndex[offset]  (원소 뽑기)

path가 사라져 예전 PUSH_ARG(슬롯 그대로 전파)는 이 세 갈래로 대체된다. 필드 접근이 곧
"내려가는" 명령이라, @for 순회 변수·받은 prop 재전달도 그 슬롯 type의 PUSH_*로 넘긴다.
PUSH_ARG_LIT(const)만 store를 안 거쳐 별개로 남는다.

### 배열은 arrayPoolIndex를 넘긴다 (storeIndex 아님)

PUSH_ARRAY가 넘기는 array 슬롯의 index는 **arrayPoolIndex**(store.get(위치)로 꺼낸 값)다.
"그 arrayPoolIndex가 저장된 store 위치(storeIndex)"를 넘기는 대안도 있으나, 배열의 배열에서
깨진다:

    넘길 값               배열의 배열                          객체의 배열
    ------------------   ---------------------------------   -----------------------
    arrayPoolIndex       (array, store.get(위치))            (array, store.get(위치))
    storeIndex           (array, arrayPool[store.get(위치)]  (array, store.get(위치))
                                 .elemStartLeafIndex[0])

arrayPoolIndex를 넘기면 배열의 배열/객체의 배열이 **둘 다 `store.get(위치)`** - 위치 계산만
부모 type(array/object)이 정하고 그 뒤는 공통이라 PUSH_ARRAY 하나로 처리된다.

storeIndex를 넘기면 배열의 배열에서 안쪽 배열이 원소 안에 있어 `elemStartLeafIndex[i]`를
한 겹 더 타야 store 위치가 나온다 - 객체의 배열(store.get 한 번)과 계산이 달라져 한 명령으로
못 묶인다. 그래서 arrayPoolIndex를 넘긴다. (슬롯 index가 array만 "값"인 예외는 남지만, 이게
배열의 배열을 한 명령으로 만드는 대가.)


## 배열 - store엔 primitive만, 실체는 arrayPool

store는 선형 메모리라 primitive만 담는다. 가변 크기인 배열은 arrayPool(힙)에 두고,
store엔 그걸 가리키는 색인(정수)만 둔다.

    슬롯 (array, arrayPoolIndex)  ->  arrayPool[arrayPoolIndex]

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
(배열 슬롯은 늘 1칸(arrayPoolIndex)으로 두어 뒤 필드 offset이 안 밀린다.)


## 배열의 배열 - 색인 연쇄

    grid = { rows: { cells: string[] }[] }
    rows = [ {cells:[a,b]}, {cells:[c,d,e]} ]

    store.leaves            arrayPool
    ------------            ------------------------------------------
    leaf#0 = arrayInfo#0      arrayInfo#0 (rows)      elemStartLeafIndex [1,4]
    leaf#1 = arrayInfo#1      arrayInfo#1 (rows[0].cells)                [2,3]
    leaf#2 = 'a'            arrayInfo#2 (rows[1].cells)                [5,6,7]
    leaf#3 = 'b'
    leaf#4 = arrayInfo#2
    leaf#5 = 'c'
    leaf#6 = 'd'
    leaf#7 = 'e'

- store 칸 값이 `arrayInfo#N`인 건 그 칸이 arrayInfo 색인(핸들)이라는 뜻. 배열 값이 아니다.
- rows 원소 base = leaf#1, leaf#4 (elemStartLeafIndex [1,4]). 각 원소의 cells 필드 칸이라,
  그 칸에 안쪽 cells 배열의 arrayInfo 색인이 들어 있다.

읽는 법 (`rows[1].cells[2]`):

    arrayInfo#0.elemStartLeafIndex[1] = 4      rows[1] 원소 base
    store.get(4 + cellsOffset=0) = arrayInfo#2 색인
    arrayInfo#2.elemStartLeafIndex[2] = 7      cells[2] base
    store.get(7) = 'e'

elemStartLeafIndex는 늘 leafIndex만 담고, 배열 색인은 store 칸에 값으로 든다. 그래서 몇
겹이든 `leafIndex -> 색인 -> arrayInfo`가 번갈아 이어진다 - 문자열 path처럼 끊기지 않는다.


## plant - 렌더 진입 때 store에 다 채운다

렌더 진입 때 rootValue를 순회하며 store에 **값까지 다 심는다**. leaf는 값, object는
필드마다 재귀(연속 칸), array는 색인 칸 + 원소.

배열 원소를 심는 순서가 관건이다. **바깥 원소를 연속으로 먼저 심고, 안쪽 배열 원소는 그
뒤에** 심는다. 안쪽을 먼저 끼우면 다음 바깥 원소가 밀려 원소끼리 연속이 안 되고
base+elemSize가 깨진다.

    videos = [ {title, tags:[..]}, {title, tags:[..]} ]

    1단계 (바깥 원소 연속)   leaf#0 title  leaf#1 tags색인   <- videos[0]
                            leaf#2 title  leaf#3 tags색인   <- videos[1]
    2단계 (안쪽 배열 원소)   leaf#4.. videos[0].tags 원소
                            leaf#6.. videos[1].tags 원소

심는 순서는 **타입 순서**(값의 키 순서 아님)라야 codegen offset과 맞고, 누락 필드도 자리를
지킨다.

배열 슬롯은 늘 1칸(arrayPoolIndex)이라 뒤 필드 offset이 안 밀린다. 색인 칸엔 안쪽 배열의
arrayPoolIndex가 값으로 들어가, 슬롯 전환 `(object,base) -> (array,poolIdx) -> (leaf,leafIndex)`가
산술로 이어진다 (배열의 배열도 안 끊김 - 위 색인 연쇄).

### 다 채우고, lazy는 나중 최적화

지금은 안 쓰는 leaf까지 다 채운다. 그래야 접근이 `store.get(leafIndex)` 순수 읽기라
제일 단순하고, 슬롯 전환이 참조·경로 없이 산술로만 돈다. 안 쓰는 값 안 심기(lazy)는 큰
배열용 **나중 최적화**로 미룬다 - 그때 값 출처(rootValue 유지)와 미충전 표식을 다시 본다.
보통 규모에선 다 채워도 싸다(10만 leaf ~0.1ms).

### 타입 테이블은 런타임에 없다

접근/넘김이 codegen이 박은 (type, offset)만 쓰듯, plant도 codegen이 심기 명령을 펼친다.
런타임은 명령만 실행하고 타입 테이블을 참조하지 않는다.

    plant Post { title, author: User, tags: string[] }:
      PLANT_LEAF    title
      PLANT_ENTER   author        (value = value.author, 끝나면 복귀)
        PLANT_LEAF    id
        PLANT_LEAF    name
        PLANT_LEAF    avatar
      PLANT_ARRAY   tags          (색인 칸 + 원소, 2단계 순서)

값은 현재 value에서 한 칸씩 내려가며 꺼낸다(`value[key]`) - 전역 path 아님.


## 배열 원소 동적 추가 (items.push - 다음 단계)

핸들러의 `items.push(newItem)` - 위 "push 명령"(슬롯 넘김)과 다른 층이다. 새 심기 명령이
필요 없다 - @for 몸체가 원소 하나를 심는 명령을 이미 가졌으니 재사용한다.

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
- 배열 = (array, arrayPoolIndex) + { elemSize, elemStartLeafIndex, sizeLeafIndex? }.
  배열의 배열 = 색인 연쇄. 길이는 sizeLeafIndex(store leaf, 구독 대상).
- plant는 타입 순서로 심기 명령을 펼치되, 렌더 진입 때 값까지 다 채운다. 배열 원소는
  바깥 연속 먼저, 안쪽 배열 원소는 뒤. lazy는 나중 최적화.
- push 명령은 넘길 type별 세 갈래(PUSH_LEAF/OBJECT/ARRAY) + PUSH_ARG_LIT(const). path가
  사라져 PUSH_ARG(그대로 전파) 폐기. 배열은 arrayPoolIndex를 넘긴다(storeIndex 아님) -
  배열의 배열/객체의 배열이 둘 다 store.get(위치)로 한 명령에 처리되게.

## 미결

- **bytecode 인코딩** - (type, index)의 type 비트, PLANT_*/PUSH_* opcode, FOR_ARRAY operand.
- **@for + 슬롯 실물** - 이 테스트는 읽기만 확인, 순회는 미검증.
- **객체 배열 원소 타입** - 원소를 다시 조립할 정보를 어디 두나. leaf 배열부터 착수해 뒤로.
