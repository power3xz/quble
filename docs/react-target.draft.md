# React 컴파일 타겟 (draft)

ROADMAP "컴파일 타겟"의 React 판. 같은 `.qubc`를 qubb 대신 React 컴포넌트(TSX)로 낸다.
동기는 ROADMAP 그대로다 - 작성은 quble로 하고 산출은 React로 내보내 실무에서 쓰며 검증한다.

구조는 React context로 경로 마디와 컨텍스트를 쌓아 내려보내는 방식이다.

## 대응

| quble | React 산출 |
|---|---|
| 합성 `First: Toggle(...)` - 경로 마디 | `<$q.Segment name="First" props={...}>` |
| `@with Area { ... }` | `<$q.With name="Area" value={...}>{(q) => ...}</$q.With>` |
| `@click:TOGGLE` + events payload | `onClick={(e) => q.emit("TOGGLE", {...}, e)}` |
| `@for (row, i of rows)` | `{q.each(p.rows, q.at("rows"), "row", "i", (q, row$, i$) => ...)}` |
| `@if (c) { A } @else { B }` | `{c ? (<>A</>) : (<>B</>)}` |
| 슬롯 콘텐츠 `Header << ...` | 자식에 `$slots={{ "Header": q.slot(...) }}` |
| `@slot(Header)` | `{p.$slots?.["Header"]}` |
| 핸들러 표 `"First.TOGGLE"` | `<QubleRoot handlers>`가 같은 표를 받는다 |

경로 규칙은 quble 것이다 - 쓰는 쪽에서 바깥->안쪽으로 별칭(없으면 타입명)을 쌓고, 루트는
마디를 안 만든다. `@with`는 경로에 안 끼고 컴포넌트 경계를 넘어 산다. 같은 이름 `@with`가
겹치면 안쪽이 통째로 덮는다. `@for` 회차는 다음 합성 마디 뒤에 붙고(`Item[$0]`), 요소에서
바로 발화하면 익명 마디가 된다(`[$0].SELECT`). 회차 깊이는 바깥 컴포넌트의 `@for`부터 센다.

## q - 위치마다 다시 받는 손잡이

컴포넌트 맨 위에서 `const q = $q.useQ()`로 받는다. `@with`, `@for`, 슬롯은 자기 안쪽에 새 `q`를
넘겨 바깥 `q`를 가린다. 같은 컴포넌트 안의 요소는 React context를 다시 읽지 않으므로, 그 위치의
컨텍스트와 회차를 `q`가 들고 있어야 한다.

- `q.emit` - 경로와 회차 마디를 이어 fullname을 만들고 핸들러를 부른다. 버블은 막는다(qubb와 같다).
- `q.at(이름, ...필드)` - prop이나 `@for` 변수의 주소에서 내려간 주소. 자식 props 주소표에 싣는다.
- `q.lit(값)` - 리터럴 인자의 주소. `get`은 값을, `set`은 에러를 낸다.
- `q.each` - 회차마다 그 회차를 보는 `q`와 요소를 넘긴다. key는 회차 번호다.
- `q.slot` - 쓰는 쪽 프레임을 다시 깔아, 자식 안에 붙어도 쓰는 쪽 경로/컨텍스트/회차로 해석되게 한다.

## 컴파일러

- 검증은 qubb codegen이 한다. React 산출기는 codegen을 통과한 FlatComp만 받으므로 에러를 안 낸다.
- `react_tsx(entry_path, src, loader)`, `react_tsx_from_path(path)` - `lib.rs`
- `react.rs`: `generate(comps) -> String`
- 바이너리 `quble-react <component.qubc>` - TSX를 stdout으로 낸다(`quble-dts`와 같은 꼴).

값 표기:

- props는 `p.이름`, `@for` 변수는 `이름$`로 읽는다 - JS 예약어나 `p`/`q`와 부딪히지 않는다.
- 보간은 문자열과 수를 그대로, bool만 `$q.str`로 감싼다 - React는 boolean을 안 찍지만 qubb는
  `"true"`를 찍는다.
- 속성값은 React 속성 타입에 맞춘다 - number만 받는 속성(`rows`, `tabIndex` 등)에는 수를 그대로,
  나머지에는 문자열로 낸다. 속성 이름은 React 이름으로 바꾼다(`class` -> `className`,
  `tabindex` -> `tabIndex`).
- textarea의 자식 텍스트는 `defaultValue`로 낸다.
- `==`/`!=`는 `===`/`!==`로, 인덱스 접근은 범위 밖에서 RangeError를 내는 `$q.idx`로 낸다.

## 런타임 `quble-react` (`core/react`)

- 상태는 루트 store 객체 하나다. `useSyncExternalStore`로 묶고, 쓰기는 경로를 따라 불변 갱신해
  루트부터 다시 그린다.
- 핸들러 ctx는 qubb와 같은 이름을 쓴다 - `get`, `set`, `setObject`, `setArray`, `push`,
  `removeAt`, `swapAt`, `props`, `store`, `context`, `event`, `$0`... 주소가 leafIndex 대신 경로라는
  것만 다르다. `props.rows[0].title`처럼 필드와 인덱스로 내려간다.

## 검증

같은 fixture를 qubb 런타임과 React로 각각 jsdom에 그리고, 같은 클릭 순서와 같은 핸들러를 건 뒤
DOM(`innerHTML`, 주석 제외)과 핸들러가 받은 인자(fullname, data, context, `$N`)가 같은지 본다.
산출 TSX는 `typescript`의 `transpileModule`로 JS로 바꿔 싣고, 따로 strict 타입 검사도 한다.

## qubb와 다른 점

- 배열 주소에 `get`을 하면 React는 배열 값을, qubb는 내부 번호를 돌려준다.
- 같은 이름 `@with`가 겹칠 때 qubb는 경고를 띄우고 React는 안 띄운다.
- `@change`는 React `onChange`로 나간다. React `onChange`는 입력마다 발화해 DOM `change`와 다르다.
- 갱신 단위가 다르다 - qubb는 바뀐 leaf의 구독자만, React는 루트부터 다시 그린다.

## 제약

- 이름에 `-`가 든 prop/필드/`@for` 변수(`my-x`)는 깨진 JS를 낸다(`p.my-x`).
- `style` 속성 문자열은 React가 객체만 받아 안 된다.
