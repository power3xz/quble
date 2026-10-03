# React 컴파일 타겟 실험

같은 `.qubc`를 qubb 대신 React 컴포넌트(TSX)로 낼 수 있는지 본 실험이다(ROADMAP "컴파일 타겟"). 작성은
quble로 하고 산출은 React로 내보내 기존 앱에 넣는 점진 도입이 목적이다. 실험 코드라 `npm test`, 루트
typecheck, 머지 훅의 테스트에 들지 않는다(lint와 포맷은 루트 biome이 본다).

## 구조

| 자리 | 하는 일 |
|---|---|
| `react.rs` | 산출기. 컴파일러 크레이트가 `experimental-react` feature로 이 파일을 모듈로 끼워 넣는다(컴파일러 내부를 써야 해서) |
| `cli/` | `quble-react` 바이너리. core 워크스페이스 밖의 독립 크레이트다 |
| `runtime/` | 산출 컴포넌트가 `quble-react`로 싣는 React 런타임과 qubb 대비 비교 테스트 |
| `fixtures/` | 이 실험만 쓰는 fixture. 나머지는 레포의 `components/`를 쓴다 |
| `playground/` | playground 셸(`core/playground/playground.qubc`)의 React 판. 핸들러는 qubb 셸과 같은 파일이다 |
| `bench/` | bench-expr의 주문 목록 React 판. 하네스, 핸들러, 스타일, 데이터는 bench-expr의 것을 쓴다 |

의존 방향은 이 디렉터리에서 기존 코드 쪽으로만 난다. 생성물은 모두 `dist/`(gitignore)에 둔다. 자기
`package.json`과 `node_modules`(React, vite)를 갖고, 패키지 이름이 `quble-react`라 이 디렉터리 안 파일은
`"quble-react"`를 자기 참조로 푼다.

## 실행

모두 레포 루트에서. `core/target/debug/quble`(qubb 비교용)이 먼저 있어야 한다.

- 의존: `npm install --prefix experiments/react`
- 바이너리: `cargo build --manifest-path experiments/react/cli/Cargo.toml`
- 산출기 테스트: `cargo test --manifest-path core/Cargo.toml -p compiler --features experimental-react react::`
- 런타임 테스트: `npm test --prefix experiments/react` (비교 테스트와 산출 TSX strict 타입 검사)
- 타입 검사: `npm run typecheck --prefix experiments/react`
- playground: `experiments/react/playground.sh` -> http://localhost:8147
- bench: `experiments/react/bench.sh` -> http://localhost:8148/?n=10000

## 걷어 내기

이 디렉터리를 지우고 기존 파일에서 아래만 뺀다.

- `core/crates/compiler/Cargo.toml`의 `experimental-react` feature
- `core/crates/compiler/src/lib.rs`의 `experimental-react` cfg 넷
- `core/crates/compiler/src/dts.rs`의 `type_to_ts`를 `pub(crate)`에서 비공개로
- `WORKSPACES.md` experiments 목록의 `react`

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
| `use "./x.css"` | `import "../x.css"` - 산출 파일 위치 기준 |
| 핸들러 표 `"First.TOGGLE"` | `<QubleRoot handlers>`가 같은 표를 받는다 |

경로 규칙은 quble 것이다 - 쓰는 쪽에서 바깥->안쪽으로 별칭(없으면 타입명)을 쌓고, 루트는 마디를 안
만든다. `@with`는 경로에 안 끼고 컴포넌트 경계를 넘어 산다. `@for` 회차는 다음 합성 마디 뒤에
붙고(`Item[$0]`), 요소에서 바로 발화하면 익명 마디가 된다(`[$0].SELECT`).

검증은 qubb codegen이 한다 - 산출기는 codegen을 통과한 입력만 받아 에러를 안 낸다.

## q - 위치마다 다시 받는 손잡이

컴포넌트 맨 위에서 `const q = $q.useQ()`로 받는다. `@with`, `@for`, 슬롯은 안쪽에 새 `q`를 넘겨 바깥
`q`를 가린다. 같은 컴포넌트 안의 요소는 React context를 다시 읽지 않으므로, 그 위치의 컨텍스트와 회차를
`q`가 들고 있어야 한다.

- `q.emit` - 경로와 회차 마디를 이어 fullname을 만들고 핸들러를 부른다. 버블은 막는다(qubb와 같다).
- `q.at(이름, ...필드)` / `q.lit(값)` - 자식 props의 주소. 리터럴은 `get`이 값을, `set`이 에러를 낸다.
- `q.each` - 회차마다 그 회차를 보는 `q`와 요소를 넘긴다. key는 회차 번호다.
- `q.slot` - 쓰는 쪽 프레임을 다시 깔아, 자식 안에 붙어도 쓰는 쪽 경로/컨텍스트/회차로 해석되게 한다.

## 값 표기

- props는 `p.이름`, `@for` 변수는 `이름$`로 읽는다 - JS 예약어나 `p`/`q`와 부딪히지 않는다.
- 보간은 문자열과 수를 그대로, bool만 `$q.str`로 감싼다 - React는 boolean을 안 찍지만 qubb는 `"true"`를 찍는다.
- 속성값은 React 속성 타입에 맞춘다 - number만 받는 속성(`rows`, `tabIndex` 등)에는 수를 그대로, 나머지에는
  문자열로 낸다. 속성 이름은 React 이름으로 바꾼다(`class` -> `className`, `tabindex` -> `tabIndex`).
- textarea의 자식 텍스트는 `defaultValue`로, `style` 문자열은 `$q.style`로 객체로 낸다.
- `==`/`!=`는 `===`/`!==`로, 인덱스 접근은 범위 밖에서 RangeError를 내는 `$q.idx`로 낸다.

## 런타임

- 상태는 루트 store 객체 하나다. `useSyncExternalStore`로 묶고, 쓰기는 경로를 따라 불변 갱신해 루트부터 다시 그린다.
- 핸들러 ctx는 qubb와 같은 이름을 쓴다 - `get`, `set`, `setObject`, `setArray`, `push`, `removeAt`, `swapAt`,
  `props`, `store`, `context`, `event`, `$0`... 주소가 leafIndex 대신 경로를 든 프록시라는 것만 다르다.

## qubb와 다른 점

- 배열 주소에 `get`을 하면 React는 배열 값을, qubb는 내부 번호를 돌려준다.
- 같은 이름 `@with`가 겹칠 때 qubb는 경고를 띄우고 React는 안 띄운다.
- `@change`는 React `onChange`로 나간다. React `onChange`는 입력마다 발화해 DOM `change`와 다르다.
- 핸들러 표의 타입은 qubb 기준(`TLeafIndex<T>`)이라 React 쪽에 넘길 때 캐스트한다.

## 제약

- 이름에 `-`가 든 prop/필드/`@for` 변수(`my-x`)는 깨진 JS를 낸다(`p.my-x`).

## 얻은 것

- **이벤트와 핸들러 계약이 런타임과 독립적이다.** 핸들러는 fullname과 `get`/`set` 계약만 알아, qubb 셸의
  핸들러가 고치지 않고 React 셸에서 돈다. 경로, `@with`, `@for` 회차가 모두 바깥에서 안으로 쌓이는 값이라
  React context로 그대로 옮겨졌다.
- **검증을 다시 만들 필요가 없다.** 산출기는 qubb codegen을 통과한 입력만 받아 글자를 내는 일만 한다.
- **qubb 런타임이 기준 구현 노릇을 한다.** 같은 fixture를 두 런타임에 그려 견주는 테스트가 `@with` 컨텍스트
  누락, 슬롯 경로, 배열 `length` 같은 어긋남을 바로 잡았다.
- **어긋난 곳은 React 관례였다.** `style` 객체, textarea `defaultValue`, 속성마다 다른 타입 - 셋 다 의미가
  아니라 표기 문제였다.
- **React 산출은 도입 수단이지 성능 수단이 아니다.** 핸들러가 값을 바꾸면 루트부터 다시 그려 memo 없는
  React와 같은 갱신 비용이 들고, 회차마다 `q`와 프레임을 만들어 할당은 그보다 많다. 세밀한 갱신은 qubb에서만
  난다.
