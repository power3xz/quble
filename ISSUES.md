# Issues

알려진 문제를 추적한다. 증상·재현만 적고 해결책은 정해지면 채운다(방법 미정이면 비워 둔다).

## 미해결

- **안 쓰는 `use`가 트리셰이킹 안 됨** - `use`로 import했지만 template에서 합성(RENDER)하지
  않는 컴포넌트가 qubb에 def로 포함된다. (재현: `bench/components/profilecard.qubc`의 `Tag`는
  use만 하고 미사용인데, 컴파일 결과 qubb에 def로 들어간다.) 컴파일러가 도달성 분석 없이 use된
  컴포넌트를 전부 방출하는 것으로 보인다.

- **void 요소 구분 없음** - `input`·`img` 등 HTML void 요소도 자식·닫는 태그를 갖는 일반
  요소처럼 렌더된다. (재현: `input(@input:EDIT) { {value} }` -> `<input>A</input>`.) 렌더러·
  런타임이 void 집합을 모른다.

- **버블 차단 끄는 옵션 미정** - 위임 리스너는 `stopPropagation`을 디폴트로 호출해 버블을
  끊는다(runtime.js). 끄거나 캡처 단계로 거는 옵션(modifier 등)은 실수요가 안 잡혀 보류 -
  필요가 구체화되면 그 모양에 맞춰 설계한다.

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

- **인덱스 15비트 상한 가드 없음** - `FieldValue`(이벤트/컨텍스트 fields의 값 출처)는 u16
  한 칸에 MSB=const 표지 + 하위 15비트=인덱스로 패킹한다. 그래서 scope offset·상수풀 인덱스
  상한이 65535 -> 32767(0x7fff)인데, 초과를 막는 가드가 없어 조용히 깨진다. (재현: 인덱스
  0x8000을 `FieldValue::Scope`로 만들면 encode->decode가 `Const(0)`으로 둔갑.) 가드의 자리는
  인덱스 발급 지점(prop 인덱싱·`ConstPool::intern`) - 개수는 파서가 모르고 발급 시점에야
  늘어난다. 발급 전반에 15비트 상한 검사를 까는 별개 작업.

- **지연 로드(lazy load) 미구현** - 지연 build는 하지만(비활성 `@if` 가지는 켜질 때 해석),
  그 가지의 자식 def는 이미 qubb에 통째로 들어있다. "가지 켜질 때 그 코드를 그제서야 받는" 진짜
  지연 로드가 없다. 걸림돌: 떼어낸 조각이 전역 인덱스(상수풀·def ID·resId·leafIndex)를 어떻게
  이어받나 - "한 모듈 = 하나의 전역 인덱스 공간" 전제를 조각화가 깬다. 포맷 전반에 걸친 문제.
  해법 방향: C의 `.o`/동적 링킹처럼 조각은 절대 인덱스 대신 심볼+재배치 표식을 남기고, 로드
  시점에 간접 테이블(import table)로 해소 - 인덱스별 문제를 한 메커니즘으로 통일.
