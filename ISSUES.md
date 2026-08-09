# Issues

알려진 문제를 추적한다. 증상/재현만 적고 해결책은 정해지면 채운다(방법 미정이면 비워 둔다).

## 해결됨

- **주석 문법 없음** - 렉서가 `/`를 self-close 토큰으로만 보고 주석을 건너뛰지 않아 `.qubc`
  소스에 설명을 달 수 없었다(비ASCII를 쓰면 `unexpected character`로 터졌다). **해결:** `//`와
  `/* */`를 렉서가 건너뛴다(SYNTAX #1.1). 주석은 앞 공백 여부를 그대로 통과시킨다 - 공백을
  세우면 `img(class="x"/**//)`처럼 붙여 쓴 주석이 `/` 앞 공백을 대신해 self-close 검증이 뚫린다.

- **루트 store에서 배열 요소 경로로 못 내려감** - `store.items[2].title` 같은 접근이 안 됐다
  (`leafTree`가 배열을 칸 leafIndex 하나로 두고 멈췄다). **해결:** 배열 칸도 노드로 낸다
  (`arrayNode`). 요소 주소는 컴파일타임 offset이 아니라 `elemStartLeafIndices`가 들고
  push/removeAt으로 계속 바뀌므로, 요소 노드를 미리 펴지 않고 **인덱싱하는 그 순간에** 만든다
  (Proxy). 노드가 `NODE_BASE`에 배열 칸 leafIndex를 실어 push/removeAt/setArray가 거기서 요소
  목록에 닿는다. 타입은 `TLeafIndex<T[]>`에서 `TLeafArray<T>`로 갈리고, 요소가 객체면 객체 노드,
  스칼라면 leaf로 파생된다. `length`도 지금 개수를 준다.

- **라이브 NodeList 순회로 노드 누락 (@for 다중 노드에서 발각)** - runtime.ts가 fragment의
  자식을 부모에 붙일 때 `for (const node of fragment.childNodes) parent.appendChild(node)`로
  돌았다. `childNodes`는 라이브라 `appendChild`가 노드를 fragment에서 떼어낼 때마다 컬렉션이
  줄어 인덱스가 밀리고, 매 순회 한 노드씩 건너뛴다. 단일 노드 컴포넌트에선 안 드러났고, `@for`가
  여러 노드를 조립하면서 발각됐다. 중첩마다 누락이 곱해져 10x100x100=10만이 6250으로, 발화
  인덱스도 `$2`가 건너뛴 값으로 나왔다. (재현: `components/forstress.qubc` 또는 RENDER로
  진입한 자식의 최상위 `@for`가 여러 카드를 낼 때.) **해결:** 두 조립 지점(RENDER 자식 붙이기,
  `@for` 회차 붙이기)을 `while (fragment.firstChild) parent.appendChild(fragment.firstChild)`
  스냅샷 순회로 바꿨다. 다른 `childNodes` 사용처는 이미 `Array.from`으로 스냅샷을 떠 안전했다.

- **void 요소 구분 없음** - `input`/`img` 등 void 요소도 자식/닫는 태그를 갖는 일반 요소처럼
  렌더됐다(`input(@input:EDIT) { {value} }` -> `<input>A</input>`). **해결:** self-close 문법
  (`tag(attrs /)`, SYNTAX #3.1.1)을 구현하고 void 집합을 컴파일러가 알게 했다. void 요소는
  self-close 필수 - 자식 블록/무슨 자식이든 컴파일 에러. 자식 없는 요소/컴포넌트는 모두
  self-close로만 쓴다(빈 블록 `{}` 금지, 처음엔 엄격하게 - DESIGN #4.5). 자식 없는 요소는
  `ELEM_OPEN..ELEM_CLOSE_OPEN..ELEM_END`로 그대로 나가 새 opcode 없이 `<input>`(내용 없음)으로
  렌더된다.

- **핸들러가 set/get할 수 있는 prop이 이벤트 payload에 선언한 것뿐** - 핸들러의 `props`를 런타임이
  이벤트 payload 필드로만 채워, payload에 없는 prop은 핸들러에서 못 바꿨다(d.ts는 전체 prop을
  타이핑해 TS는 통과하고 런타임에서만 조용히 깨졌다). 엮인 결정은 prop 이름을 런타임에 어떻게
  공급하느냐였다. **해결:** 이름을 런타임으로 넘기지 않는 쪽으로 갔다 - 모든 comp props 타입을
  Object로 intern해(`def.props_type_ref`) 발화 comp의 전체 props를 leafIndex 중첩 객체로 주고,
  루트 절대 경로는 `store`로 함께 노출한다(같은 메커니즘). 이름은 컴파일타임에 소진되고 런타임은
  leafIndex만 본다. 리터럴(CONST) 접근은 set 대상이 없어 Proxy가 throw.

- **pathCache 문자열 키 메모리** - leaf-store가 경로 문자열을 키로 leafIndex를 lazy 발급해
  (`Map<path-string, leafIndex>`), 배열 요소마다 경로 문자열이 영구 누적됐다. 실측으로 캐시 자체는
  작았고(경로당 ~47B, 같은 규모의 DOM이 ~100배) 진짜 걸림돌은 **회수 없음**이었다 - 발급이 증가만
  해서 지나간 경로가 안 지워졌다. **해결:** 경로 기반 해소가 사라져 캐시가 없어졌고(leafIndex는
  컴파일타임 슬롯과 `alloc`으로 직접 받는다), 누적도 배열 항목 제거 시 크기별 free list로 회수하게
  됐다.

- **DOM 입력값을 핸들러가 못 읽음** - `@input:EDIT`으로 이벤트는 걸리는데 그 요소의 현재 값
  (React의 `e.target.value`)에 도달할 길이 없었다. payload 식은 props 변수/리터럴만 참조해
  (SYNTAX.md #2.3) 선언 시점 store 값에 묶이고, 타이핑한 값은 어디에도 안 실렸다. **해결:**
  payload 문법을 늘리지 않고 핸들러 ctx에 발화한 DOM `Event`를 그대로 넘긴다(`ctx.event`,
  runtime.ts dispatch). 값은 `event.target.value`로 읽고, 필요하면 `set`으로 store에 되먹여
  형제 보간을 갱신한다 - 입력 요소 자신은 재대입하지 않는 **uncontrolled** 방식이다(DOM이 표시값의
  주인, store는 되먹인 값만 가짐). payload는 여전히 store 값이라 타이핑 값과 다르고, 그 구분까지
  테스트가 못박는다(`core/web/event-dom-types.test.ts`).

- **codegen 진단이 엔트리 파일 기준으로 위치를 셈** - `use`한 파일에서 난 codegen 에러가 엔트리
  파일의 엉뚱한 줄을 짚었다(`board.qubc`를 컴파일하면 `column.qubc`의 에러가 `board.qubc`에 있는
  것처럼). `CodegenError`가 `range`(바이트 오프셋)만 들고 출처 파일을 몰라, 그 오프셋을 엔트리
  소스에 대고 셌다. codegen 단계 에러 전부가 해당. **해결:** lex/parse가 쓰던 `Sourced<E>`를
  codegen에도 적용 - `FlatComp`가 출처를 들고 `generate`의 컴포넌트 루프에서 에러에 붙인다.

- **핸들러 타입 공급이 d.ts 파일 방식 (LSP 아님)** - 확장이 `.qubc`를 컴파일해 짝
  `x.qubc.d.ts`(`Handlers` 인터페이스)를 디스크에 쓰고, handlers.ts가 `import type { Handlers }
  from './x.qubc'`로 받아 키/payload/context를 타입으로 강제했다. 한계: (1) import 한 줄이
  필요하다 - `.ts`<->`.d.ts` 같은 basename 자동 짝은 TS가 안 묶고(실험으로 확인), Svelte식
  "옆에 두면 자동"은 비-TS 소스(`.svelte`) 모듈 해석이라 우리 `.ts` 핸들러엔 안 통한다.
  (2) d.ts가 디스크 부산물이다(gitignore). (3) 생성이 handlers.ts 열림/`.qubc` 저장 시 매번 풀
  컴파일이다. **해결:** TS Language Service plugin으로 갔다(`editors/ts-plugin`). 짝 `.qubc`를
  컴파일한 d.ts를 handlers.ts 스냅샷 **앞에** 한 줄로 얹고 `export const handlers`에 타입을
  표기한다 - tsserver만 그 스냅샷을 보고 디스크와 화면은 원본 그대로다. 이름 `handlers`가 규약이
  됐고(`export default` 폐기), 세 한계가 모두 사라졌다.

- **핸들러 타입이 에디터 안에서만 붙었다** - 위 plugin 방식의 맞바꿈이었다. 주입이 tsserver
  안에서만 일어나므로 `tsc`나 CI에서는 handlers.ts가 타입 없이 남았고, 그래서 그 파일은 타입을
  **손으로 적어** 쓰고 있었다 - 주입된 것과 어긋나 편집기에서는 오히려 오류가 났다(출처가 둘).
  **해결:** `editors/ts-plugin/typecheck-handlers.ts`. `tsc` 대신 LanguageService를 세우고 plugin을
  올려, 편집기가 보는 것과 같은 주입본에 진단을 묻는다(`typecheck` 스크립트가 돌린다).
  tsconfig의 `plugins`는 language service 전용이라 `tsc`로는 안 되는 것을 확인했다. 손으로 적던
  타입은 없앴다 - `handlers` 리터럴이 주입된 표기를 문맥으로 받아 키마다 ctx가 추론된다.

## 미해결

- **여러 칸을 쓰는 조작이 중간 상태를 통지한다** - `leaf-store.ts`의 `set`은 칸 하나를 쓰고
  구독자 콜백을 그 자리에서 동기로 부른다(통지 큐 없음). 그래서 한 번의 조작이 여러 칸을 쓰면
  칸마다 통지가 나가고, 그 사이의 중간 상태가 구독자에게 관측된다(`setObject`가 필드 수만큼,
  `push`/`removeAt`도 요소 칸 + 길이 칸). 지금은 문제로 드러나지 않는다 - 전부 같은 동기 블록
  안이라 브라우저가 중간에 페인트하지 않고, 구독자가 칸 하나만 보는 보간/속성이라 자기 칸이
  바뀔 때만 깨어난다. **드러날 조건:** 구독자가 여러 칸을 함께 보는 순간이다. `{expr}` 표현식
  보간(DESIGN.md #137)이 들어와 한 식이 두 칸을 참조하면, 첫 칸만 바뀐 중간 상태로 한 번
  평가된다. 해결하려면 조작 단위로 통지를 모으는 배치가 필요한데, 그건 `setObject` 하나가 아니라
  반응성 모델 전반(구독/통지 단위)의 변경이라 표현식이 실물로 올 때 그 모양에 맞춰 정한다.

- **확장이 클린 클론에서 `npm install`부터 못 한다** - `editors/vscode`의 `dependencies`에
  `"quble-ts-plugin": "0.0.1"`이 있는데 레지스트리에 없는 이름이라 404다. 실물은 `npm run
  build`가 `node_modules/quble-ts-plugin`에 직접 놓으므로, build를 먼저 돌리면 install이 된다
  (README도 그 순서). install보다 build가 앞서는 뒤집힌 구조다. 세 요구가 서로 물려 있다:
  (1) `dependencies`에 이름이 있어야 VSCode가 tsserver의 `pluginProbeLocations`에 확장 경로를
  넣는다(없으면 조용히 실패), (2) `npm install`이 그 spec으로 뭔가 설치할 수 있어야 한다
  (`file:../ts-plugin`이면 된다), (3) vsce 포장 시점에는 **실물**이어야 한다 - 링크면
  `npm list`가 링크 너머 devDependencies를 훑다 실패한다(ts-plugin의 `@types/node`가 루트와
  버전이 달라 hoist되지 않고 자기 밑에 남는 것이 방아쇠). `file:`은 (2)를 만족하고 (3)에서
  걸리며, `0.0.1`은 그 반대다.
  시도해 본 것(2026-08-07, 전부 막힘): `--no-dependencies`는 node_modules를 통째로 빼고
  `.vscodeignore` negated glob으로도 안 되살아난다. 워크스페이스 멤버로 넣으면 vsce가
  워크스페이스 루트를 패키지 루트로 봐서 레포 전체(7만여 파일)를 담으려 든다. 플러그인을
  node_modules 밖에 두는 것도 안 된다 - tsserver가 node_modules 체인으로만 찾는다.

- **renderer(SSR) 보류** - 상수풀 엔트리가 타입(Str/Num/Bool)을 갖게 바뀌면서 renderer가 빌드
  실패한다(`get_const`가 `&str` 대신 `&Const` 반환). renderer는 바이트코드로 렌더 가능한지 보는
  POC였고 그 역할은 끝났다 - 언어가 어느 정도 완성된 뒤 다시 본다. 당분간 처리하지 않는다.
  워크스페이스 members에서 빼고 exclude로 뒀다(크레이트 파일은 복구용으로 남김). quble 크레이트의
  render_source/render_with와 tests/end_to_end.rs(SSR 통합 테스트)도 제거했다.

- **안 쓰는 `use`가 트리셰이킹 안 됨** - `use`로 import했지만 template에서 합성(RENDER)하지
  않는 컴포넌트가 qubb에 def로 포함된다. (재현: `components/profilecard.qubc`의 `Tag`는
  use만 하고 미사용인데, 컴파일 결과 qubb에 def로 들어간다.) 컴파일러가 도달성 분석 없이 use된
  컴포넌트를 전부 방출하는 것으로 보인다.

- **버블 차단 끄는 옵션 미정** - 위임 리스너는 `stopPropagation`을 디폴트로 호출해 버블을
  끊는다(runtime.ts). 끄거나 캡처 단계로 거는 옵션(modifier 등)은 실수요가 안 잡혀 보류 -
  필요가 구체화되면 그 모양에 맞춰 설계한다.

- **createdContexts 회수 - 지금 구현 불가** - 런타임은 EnterContext마다 컨텍스트를
  createdContexts에 append하고 contextIndex로 참조한다. ExitContext는 활성 스택에서만 빼서,
  `@for` 회차가 사라져도 그 안에서 만든 컨텍스트는 남는다(회차를 넣고 빼면 누적).
  **막힌 이유:** 이벤트 핸들러가 그 컨텍스트를 언제 참조할지 런타임이 알 수 없어 회수 시점을
  정할 수 없다. 핸들러가 컴파일 대상에 들어오면(참조 시점을 컴파일러가 봄) 풀 수 있다.

- **같은 컨텍스트명 중첩** - 방향성: 맥락(컨텍스트)이라는 정보는 그 성격상 같은 이름이 중복으로
  쌓이지 않는 게 맞다. `@with Area`가 합성 경계를 넘어 중첩되면(`Outer`의 `@with Area` 안에 합성된
  `Inner`가 또 `@with Area`) 활성 스택에 같은 이름이 쌓인다. **지금 처리:** `context.Area`는 가장
  안쪽 것으로 통째 덮어쓰고(필드 머지/바깥 보존 안 함), 런타임이 push 시 같은 이름을 발견하면
  console.warn으로 알린다. 컴파일타임 금지는 불가 - 독립 컴파일/머지하면 합성 경계 너머 중첩을
  codegen이 못 본다. 더 나은 방법(안정적 식별/중복 방지 메커니즘)은 나중에 고민한다.

- **인덱스 상한 가드 없음** - `FieldValue`(이벤트/컨텍스트 fields의 값 출처)는 u16 한 칸에
  kind 표지 + 인덱스로 패킹한다. STACK(`@for`) 대비로 kind가 3진이 되면 비대칭 인코딩을
  쓴다 - Const는 상수풀이 문자열 전반을 공유해 상한 리스크가 커 15비트(0x7fff) 유지, 여유
  있는 Scope/Stack은 14비트(0x3fff). 그래서 **상한이 축별로 다르다**. 초과를 막는 가드가
  없어 조용히 깨진다(인덱스가 kind 비트를 오염, 엉뚱한 축으로 디코드). 가드의 자리는 인덱스
  발급 지점(prop 인덱싱/`ConstPool::intern`) - 개수는 파서가 모르고 발급 시점에야 늘어난다.
  단 발급 지점은 Const/Scope 축을 모르고 pool 인덱스는 leaf 아닌 자리(속성값 등)에도 쓰여
  u16 전체가 정당하므로, 상한 검사는 **leaf로 인코딩되는 지점**(FieldValue 생성/encode)에서
  축별로 걸어야 정확하다. FieldValue 작업에 딸린 별개 스텝.

- **지연 로드(lazy load) 미구현** - 지연 build는 하지만(비활성 `@if` 가지는 켜질 때 해석),
  그 가지의 자식 def는 이미 qubb에 통째로 들어있다. "가지 켜질 때 그 코드를 그제서야 받는" 진짜
  지연 로드가 없다. 걸림돌: 떼어낸 조각이 전역 인덱스(상수풀/def ID/resId/leafIndex)를 어떻게
  이어받나 - "한 모듈 = 하나의 전역 인덱스 공간" 전제를 조각화가 깬다. 포맷 전반에 걸친 문제.
  해법 방향: C의 `.o`/동적 링킹처럼 조각은 절대 인덱스 대신 심볼+재배치 표식을 남기고, 로드
  시점에 간접 테이블(import table)로 해소 - 인덱스별 문제를 한 메커니즘으로 통일.

- **leaf free가 구독(subscribers)을 회수하지 않음** - leaf-store `free`는 값과 free list만
  만지고 `subscribers[leafIndex]`는 안 건드린다. 구독 회수는 `removeBranchAt`(region.ts)이
  한다.

- **playground manifest 중복 로드** - 진입 페이지가 초기 data를 만들려고 manifest를 읽고
  `mount`가 같은 것을 또 읽는다.

- **playground가 `quble-web`을 선언 안 함** - `../web/runtime.ts`를 상대경로로 쓰면서
  `dependencies`에 없다.

- **wasm 크기 - dts를 feature로 가를지 미정** - `qb_handlers_dts`가 wasm을 42KB 늘렸는데
  playground는 d.ts를 안 쓴다.

- **browser.ts의 wasm URL 기본값 미정** - `node.ts`와 달리 URL을 항상 받아야 한다.
  `new URL(..., import.meta.url)`이 esbuild에서 안 된다.

- **quble-dts 바이너리를 지울지 미정** - 확장이 wasm으로 옮기면서 레포 안에서 부르는 곳이 없다.

- **`compile_src`/`compile_file`의 접미사 미정** - dts 쪽은 `_from_path`로 바꿨는데 컴파일 쪽은
  그대로다.
