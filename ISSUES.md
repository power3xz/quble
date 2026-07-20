# Issues

알려진 문제를 추적한다. 증상·재현만 적고 해결책은 정해지면 채운다(방법 미정이면 비워 둔다).

## 해결됨

- **라이브 NodeList 순회로 노드 누락 (@for 다중 노드에서 발각)** - runtime.ts가 fragment의
  자식을 부모에 붙일 때 `for (const node of fragment.childNodes) parent.appendChild(node)`로
  돌았다. `childNodes`는 라이브라 `appendChild`가 노드를 fragment에서 떼어낼 때마다 컬렉션이
  줄어 인덱스가 밀리고, 매 순회 한 노드씩 건너뛴다. 단일 노드 컴포넌트에선 안 드러났고, `@for`가
  여러 노드를 조립하면서 발각됐다. 중첩마다 누락이 곱해져 10x100x100=10만이 6250으로, 발화
  인덱스도 `$2`가 건너뛴 값으로 나왔다. (재현: `components/forstress.qubc` 또는 RENDER로
  진입한 자식의 최상위 `@for`가 여러 카드를 낼 때.) **해결:** 두 조립 지점(RENDER 자식 붙이기,
  `@for` 회차 붙이기)을 `while (fragment.firstChild) parent.appendChild(fragment.firstChild)`
  스냅샷 순회로 바꿨다. 다른 `childNodes` 사용처는 이미 `Array.from`으로 스냅샷을 떠 안전했다.

- **void 요소 구분 없음** - `input`·`img` 등 void 요소도 자식·닫는 태그를 갖는 일반 요소처럼
  렌더됐다(`input(@input:EDIT) { {value} }` -> `<input>A</input>`). **해결:** self-close 문법
  (`tag(attrs /)`, SYNTAX §3.1.1)을 구현하고 void 집합을 컴파일러가 알게 했다. void 요소는
  self-close 필수 - 자식 블록/무슨 자식이든 컴파일 에러. 자식 없는 요소·컴포넌트는 모두
  self-close로만 쓴다(빈 블록 `{}` 금지, 처음엔 엄격하게 - DESIGN §4.5). 자식 없는 요소는
  `ELEM_OPEN..ELEM_CLOSE_OPEN..ELEM_END`로 그대로 나가 새 opcode 없이 `<input>`(내용 없음)으로
  렌더된다.

## 미해결

- **renderer(SSR) 보류** - 상수풀 엔트리가 타입(Str/Num/Bool)을 갖게 바뀌면서 renderer가 빌드
  실패한다(`get_const`가 `&str` 대신 `&Const` 반환). renderer는 바이트코드로 렌더 가능한지 보는
  POC였고 그 역할은 끝났다 - 언어가 어느 정도 완성된 뒤 다시 본다. 당분간 처리하지 않는다.
  워크스페이스 members에서 빼고 exclude로 뒀다(크레이트 파일은 복구용으로 남김). quble 크레이트의
  render_source/render_with와 tests/end_to_end.rs(SSR 통합 테스트)도 제거했다.

- **핸들러가 set/get할 수 있는 prop이 이벤트 payload에 선언한 것뿐** - 핸들러의 `set`/`get`은
  `props.<이름>`으로 prop을 가리키는데, 런타임(runtime.ts BIND_EVENT)이 그 `props` 맵을 이벤트
  payload 필드로만 채운다. 그래서 payload에 없는 prop은 핸들러에서 못 바꾼다. (재현:
  `TOGGLE_SECTION({ title, open })`처럼 payload에 `dirty`가 없으면, 컴포넌트가 `dirty`를 prop으로
  받아도 `set(props.dirty, ...)`가 undefined를 건드려 아무 일도 안 일어난다.) d.ts는 이와 어긋나게
  컴포넌트 **전체 prop**을 `props`로 타이핑해, TS는 통과하고 런타임에서만 조용히 깨진다.
  - **엮인 결정**: "무엇을 담느냐"(payload만 vs 전체 prop)와 "어떻게 담느냐"(지금은 이름->leafIndex
    맵을 미리 짓는데, 자식 컴포넌트는 prop 이름이 바이트코드에 없어 이름 맵을 못 짓는다)가
    prop 이름을 런타임에 어떻게 공급하느냐(지금은 바이트코드에 이름이 없어 scope index만)에 달려
    있다 - 이건 바이트코드/manifest 포맷 결정이라 신중히 정한다. (검토된 갈래: `data`에 값 대신
    leafIndex를 담아 `set(data.x, v)`로 통합, prop 이름을 manifest 사이드카/바이트코드에 두기,
    scope index+paths 폐기하고 이름 기반으로 복귀.)

- **안 쓰는 `use`가 트리셰이킹 안 됨** - `use`로 import했지만 template에서 합성(RENDER)하지
  않는 컴포넌트가 qubb에 def로 포함된다. (재현: `components/profilecard.qubc`의 `Tag`는
  use만 하고 미사용인데, 컴파일 결과 qubb에 def로 들어간다.) 컴파일러가 도달성 분석 없이 use된
  컴포넌트를 전부 방출하는 것으로 보인다.

- **버블 차단 끄는 옵션 미정** - 위임 리스너는 `stopPropagation`을 디폴트로 호출해 버블을
  끊는다(runtime.ts). 끄거나 캡처 단계로 거는 옵션(modifier 등)은 실수요가 안 잡혀 보류 -
  필요가 구체화되면 그 모양에 맞춰 설계한다.

- **pathCache 문자열 키 메모리 (실제 문제 아닐 수 있음)** - `leaf-store.ts`의 pathCache는
  `Map<path-string, leafIndex>`라, 배열 요소마다 `organizations.0...members.M.profileDetails.name`
  같은 경로 문자열을 키로 영구 보관한다. 요소가 많고 중첩이 깊으면 문자열 키가 쌓인다. **실측**
  (node --expose-gc): 5만 경로 1.75MB, 12만 3.5MB, 120만 56MB (경로당 ~47B - 정수 leafIndex만이면
  사실상 0). 문자열 길이보다 **경로 개수**가 지배 요인. **다만 우선순위 낮음:** 그 leaf가 실제로
  화면에 살아있으려면 DOM이 훨씬 크다 - 실측(headless Chrome renderer RSS) 노드당 ~2.5KB로,
  12만 요소면 DOM +347MB vs pathCache 3.5MB(DOM이 ~100배). 즉 이만한 규모는 가상 스크롤이 강제되고
  살아있는 leaf는 화면분뿐이라 pathCache도 작다. 진짜 걸림돌은 캐시 키 표현(문자열 vs 정수)이
  아니라 **회수 없음**(leafOf가 `leaves.length`로 증가만, 스크롤로 지나간 경로가 안 지워지고 누적) -
  leafIndex 회수(REACTIVITY.md §3, 아래 createdContexts 항목과 같은 free-list 메커니즘)로 풀 문제.

- **createdContexts 회수 미구현 (@for 들어올 때)** - 런타임은 EnterContext마다 컨텍스트를
  createdContexts에 append하고 contextIndex로 참조한다. 컨텍스트 fields는 그 시점
  paths로 푼 leafIndex라 인스턴스마다 달라 공유·캐시가 안 되고, 매번 새로 만든다. 지금은 정적
  구조라 회수가 불필요해 append만 한다. `@for`가 들어와 항목이 동적으로 생기고 사라지면 그 안의
  컨텍스트도 회수돼야 한다 - leafIndex 회수(REACTIVITY.md §3)와 같은 메커니즘으로 풀 문제라
  그때 함께 정한다.

- **같은 컨텍스트명 중첩** - 방향성: 맥락(컨텍스트)이라는 정보는 그 성격상 같은 이름이 중복으로
  쌓이지 않는 게 맞다. `@with Area`가 합성 경계를 넘어 중첩되면(`Outer`의 `@with Area` 안에 합성된
  `Inner`가 또 `@with Area`) 활성 스택에 같은 이름이 쌓인다. **지금 처리:** `context.Area`는 가장
  안쪽 것으로 통째 덮어쓰고(필드 머지·바깥 보존 안 함), 런타임이 push 시 같은 이름을 발견하면
  console.warn으로 알린다. 컴파일타임 금지는 불가 - 독립 컴파일/머지하면 합성 경계 너머 중첩을
  codegen이 못 본다. 더 나은 방법(안정적 식별·중복 방지 메커니즘)은 나중에 고민한다.

- **DOM 입력값을 이벤트 payload로 못 보냄** - `@input:INPUT`으로 이벤트는 걸 수 있지만,
  그 입력 요소의 현재 값(React의 `e.target.value`)을 payload에 실을 문법이 없다. payload 식은
  props 변수·리터럴·표현식만 참조한다(SYNTAX.md §2.3). (재현: `TextInput`이 입력값을 핸들러로
  보내려 해도 선언 시점 prop만 참조 가능 - 실제 타이핑된 값을 가리킬 방법이 없다.) 폼 입력은
  가장 흔한 패턴이라 LLM 분리 추론(UI/로직 분리) 셀링포인트의 실제 검증에도 걸린다. 이벤트
  발생 지점(DOM 요소)의 값을 payload가 참조하는 문법·의미가 미설계.

- **인덱스 상한 가드 없음** - `FieldValue`(이벤트/컨텍스트 fields의 값 출처)는 u16 한 칸에
  kind 표지 + 인덱스로 패킹한다. STACK(`@for`) 대비로 kind가 3진이 되면 비대칭 인코딩을
  쓴다 - Const는 상수풀이 문자열 전반을 공유해 상한 리스크가 커 15비트(0x7fff) 유지, 여유
  있는 Scope/Stack은 14비트(0x3fff). 그래서 **상한이 축별로 다르다**. 초과를 막는 가드가
  없어 조용히 깨진다(인덱스가 kind 비트를 오염, 엉뚱한 축으로 디코드). 가드의 자리는 인덱스
  발급 지점(prop 인덱싱·`ConstPool::intern`) - 개수는 파서가 모르고 발급 시점에야 늘어난다.
  단 발급 지점은 Const/Scope 축을 모르고 pool 인덱스는 leaf 아닌 자리(속성값 등)에도 쓰여
  u16 전체가 정당하므로, 상한 검사는 **leaf로 인코딩되는 지점**(FieldValue 생성/encode)에서
  축별로 걸어야 정확하다. FieldValue 작업에 딸린 별개 스텝.

- **핸들러 타입 공급이 d.ts 파일 방식 (LSP 아님)** - 확장이 `.qubc`를 컴파일해 짝
  `x.qubc.d.ts`(`Handlers` 인터페이스)를 디스크에 쓰고, handlers.ts가 `import type { Handlers }
  from './x.qubc'`로 받아 키·payload·context를 타입으로 강제한다(잘못된 fullname은 컴파일 에러,
  리터럴은 literal type). 한계: (1) import 한 줄이 필요하다 - `.ts`<->`.d.ts` 같은 basename
  자동 짝은 TS가 안 묶고(실험으로 확인), Svelte식 "옆에 두면 자동"은 비-TS 소스(`.svelte`)
  모듈 해석이라 우리 `.ts` 핸들러엔 안 통한다. (2) d.ts가 디스크 부산물이다(gitignore). (3)
  생성이 handlers.ts 열림·`.qubc` 저장 시 매번 풀 컴파일이고, 컴파일러 경로가 워크스페이스
  루트 기준 하드코딩이다(다른 레포에서 쓰려면 못 씀). 더 깔끔한 길은 **TS Language Service
  plugin(또는 LSP)** 으로 메모리상 가상 타입을 주입하는 것 - import도 파일도 없이 `handlers`에
  타입이 붙는다(Svelte의 `svelte2tsx`+`svelte-language-server`가 이 층위). 비용이 커서
  보류했다(별도 npm 패키지 + LanguageService 프록시 + 가상 SourceFile 주입). 타입 생성 알맹이
  (`handlersDts`)는 어느 길이든 재사용되니, plugin은 그 위의 "주입 배관"만 얹으면 된다.

- **지연 로드(lazy load) 미구현** - 지연 build는 하지만(비활성 `@if` 가지는 켜질 때 해석),
  그 가지의 자식 def는 이미 qubb에 통째로 들어있다. "가지 켜질 때 그 코드를 그제서야 받는" 진짜
  지연 로드가 없다. 걸림돌: 떼어낸 조각이 전역 인덱스(상수풀·def ID·resId·leafIndex)를 어떻게
  이어받나 - "한 모듈 = 하나의 전역 인덱스 공간" 전제를 조각화가 깬다. 포맷 전반에 걸친 문제.
  해법 방향: C의 `.o`/동적 링킹처럼 조각은 절대 인덱스 대신 심볼+재배치 표식을 남기고, 로드
  시점에 간접 테이블(import table)로 해소 - 인덱스별 문제를 한 메커니즘으로 통일.
