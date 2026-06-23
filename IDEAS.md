# IDEAS

검토한 아이디어 모음. **미적용**은 아직 안 갔거나 보류·거부한 길(측정 근거·거부 이유 포함),
**구현됨**은 적용 완료해 확정 설계로 승격됐으나 거부 대안·근거는 기록으로 남겨둔 것이다.
확정 설계는 DESIGN.md·REACTIVITY.md, 바이트코드 명세는 proto/BYTECODE.md 참고.

## 미적용 아이디어

### 런타임 트리셰이킹 (필요한 opcode 핸들러만 구성)

지금 runtime.js는 작지만(~5KB), `@for`·`@if`·이벤트·반응성이 들어오면 계속 커져 React 런타임
(46KB gzip)을 향해 간다. "런타임이 작다"는 강점이 희석된다. 해결: **페이지가 실제로 쓰는
기능(opcode)만 든 런타임을 구성**한다.

**우리만의 무기:** qubb는 컴파일타임에 다 알 수 있어, **어떤 opcode를 쓰는지 정적 분석**이 된다.
TEXT_VAR만 쓰고 @for·이벤트가 없는 페이지면 그 핸들러만 보내면 된다. React는 JS 컴포넌트가
런타임의 뭘 쓸지 정적으로 못 가려 통째로 보낸다 — 우리는 가능하다.

**구조:** 코어 런타임(디코드·요소·텍스트·스택 = 모든 qubb 공통, 작고 고정, **캐시 공유**) +
기능별 청크(@for·이벤트·반응성 = 해당 opcode 쓰는 qubb가 있을 때만 로드). React.lazy의 컴포넌트
분할과 비슷하나 **기능(opcode) 단위**로 더 잘게, 정적 분석으로 정확히 자른다.

**주의:** 페이지마다 다른 런타임이면 캐시 공유가 깨진다 → 반드시 "공유 코어 + 필요시 기능 청크"
2단 구조로. opcode 핸들러 하나는 작아서(수십~수백B), 큰 절감은 무거운 기능(반응성 엔진,
이벤트 위임)을 안 쓸 때 난다.

### 비동기 컴포넌트 로드 (코드 분할, `LAZY_RENDER` opcode)

RENDER를 interpret 인라인 재진입으로 바꾸니(REACTIVITY.md 합성), lazy build 구조가
React.lazy/Suspense와 맞아떨어진다는 관찰에서 출발.

**핵심 통찰 — 현재 lazy build와 비동기 로드의 차이는 "code가 있냐"뿐.** 현재 lazy는 code가
메모리에 있고 *해석*만 미룬다(동기 lazyBuild 클로저). 비동기 lazy는 code 자체가 나중에
네트워크로 도착한다 — **lazyBuild가 동기에서 async로 바뀌는 게 본질**이다.

**구현 골격 (새 opcode `LAZY_RENDER <chunkRef> <args…>`):** RENDER와 거의 같되 chunkRef가
컴포넌트 id가 아니라 별도 청크 식별자(URL/해시/청크 인덱스). 핸들러는 ① region·anchor를 깔아
자리를 확보하고(동기 — 컴포넌트 도착 전에도 DOM 자리·swap 경계가 필요. Suspense fallback 자리)
② branch는 built=false, `lazyBuild = async () => { const chunk = await loadChunk(chunkRef);
interpret(chunk.code, paths, …) }` ③ 활성화 트리거를 건다. activateBranch/lazyBuild가 async가 된다.

**조건부 로드는 `@if` 조합으로 공짜.** `LAZY_RENDER`가 비활성 가지에 있으면 그 가지가 켜질
때까지 lazyBuild(=fetch)가 안 불린다. opcode는 "즉시 트리거"만 구현해도 `@if`와 조합하면
"안 보이는 청크는 네트워크도 0"인 진짜 코드 분할이 된다.

**먼저 정할 미결 (코드 전에 설계 합의 — 안 그러면 포맷이 두 번 바뀐다):**
- 청크 경계를 누가 정하나 — 소스 명시 권장(`@lazy Component(…)` 류). use/RENDER는 컴파일타임
  평탄화인데 lazy는 "평탄화 안 하고 경계를 남김"이라 반대 결정 → 의도적 명시가 맞다. 자동 분할은 나중.
- 트리거 모델 — 즉시 로드(단순) vs 조건부(`@if` 조합). 즉시만 구현 + `@if` 조합 권장.

범위: 새 opcode + chunkRef + 자식을 별도 .qubb 청크로 빼는 컴파일러 변경 + 클라 loadChunk.
바이트코드 포맷 변경이라 크다 — 런타임 트리셰이킹(기능 청크 분할)과 같은 "필요할 때만 로드"
계열이니 함께 검토.

### qubb 리소스 테이블 (`LOAD_EX`의 resId -> 경로)

외부 리소스 로드(`LOAD_EX resId`, 컴포넌트가 `use './x.css'` 한 CSS를 로드)에서, resId가 어느
파일인지 알려주는 `resId -> 원본경로` 테이블을 **qubb 안에** 둘지에 대한 검토.

**현재 결정 — 테이블 없이 resId(정수)만.** qubb엔 `LOAD_EX resId`만 두고, `resId -> 경로`는
컴파일러 부산물(qubb 밖)로, `resId -> url`은 런타임 주입 맵으로 처리한다(url은 빌드마다 바뀌어
qubb에 못 박는다). 런타임은 `resourceMap[resId]`로 url 찾아 로드, 중복 url은 스킵. resId는
**모듈(qubb) 로컬 인덱스** — scope offset·컴포넌트 id와 같은 스코프.

**테이블을 안 넣은 이유:** `resId -> url` 매핑은 어차피 런타임에 주입돼야 하고(불가피), 그 맵을
만드는 빌드가 `resId -> 경로`를 이미 안다. qubb에 경로를 또 박는 건 잉여다. qubb 단독 해석
명분(인스펙터가 "resId 0 = x.css" 표시, 로컬 단독 로드)은 약하다 — 런타임은 어차피 resourceMap
주입 없이는 url을 몰라 로드 자체가 안 되고, 인스펙터는 `resId 0`으로 표시하면 그만(scope를 argN으로
표시하듯).

**그래도 유보로 남기는 이유:** 스타일링 전체 설계(클래스 참조·격리)가 아직이라, qubb가 리소스
경로를 알아야 할 상황이 나올지 지금 단정 못 한다. 그리고 **추가는 쉽고(상수풀과 같은 패턴의 섹션
하나 + 디코더 루프, 옛 qubb는 재컴파일) 제거는 어렵다(인스펙터·런타임·SSR이 의존하면 다 걷어내야).**
불확실할 땐 가역적인 쪽 — 지금은 안 넣고, 필요성이 드러나면 그때 추가한다.

### 컴파일타임 속성명 usage 추적

전역 상수풀(속성명)에 **어떤 속성명을 넣을지**를 손으로 정하지 않고, 컴파일타임 정적분석으로
**각 속성명이 몇 개 컴포넌트에서 쓰이는지** 추적한다. 그 데이터를 보고 전역 테이블에 추가할지
말지 결정한다.

- 현재는 전역 속성명 테이블(`proto/crates/bytecode/src/attrs.rs`)을 흔한 HTML 속성명으로
  손수 박아둔 상태.
- usage 추적이 있으면 실제 코드베이스 기준으로 전역 편입 여부를 데이터로 판단 가능.
- 값(속성값)은 대상 아님 — '흔한 값'의 기준이 없어 값은 항상 컴포넌트 상수풀에 둔다.

### 후위(post-order) 바이트코드 인코딩

요소를 **여는 순서(전위)**가 아니라 **속성·자식을 먼저 내고 OPEN을 나중에**(post-order) 인코딩하는
방안. OPEN이 그 시점까지 쌓인 자식/속성을 흡수해 조립한다. `ELEM_END`·`ELEM_CLOSE_OPEN`이
사라지고, **void 요소(`<img>`)가 자연 해결**된다(OPEN 시점에 자식 0개임을 알아 `</img>`를 안 냄).

**도입 안 한 이유 (측정):** raw 이득이 없다. 후위가 없애는 `CLOSE_OPEN`+`END`(grid 482B)를 OPEN에
붙는 개수 operand(자식수·속성수)가 그대로 먹어 **±0**(u8 개수 기준, grid 5087B→5087B). u16이면
오히려 +482B. 한편 비용은 실재 — post-order 인코딩, SSR 렌더러의 노드 객체화(지금은 문자열 직접
push), 역순 디버깅. **이득(void 정합성)에 비해 비용이 크다.**

- 스트리밍과는 무관 — SSR 즉시 스트리밍의 단위는 요소가 아니라 **합성 컴포넌트(RENDER 경계)**라,
  컴포넌트 내부 인코딩이 전위든 후위든 스트리밍을 깨지 않는다.
- 인코딩을 본격 재설계할 때(데이터 흐름·`@for` 확정 이후) 다시 판단할 것. void는 그때 더 작은
  수단(자식 유무 플래그 1비트 등)도 함께 검토.

### 닫고-열기 opcode (`END_OPEN`)

형제 요소 사이의 `END + OPEN`을 한 opcode(`END_OPEN tag`)로 합쳐 닫기 1B를 흡수하는 방안.
전위 인코딩을 유지하면서 바이트코드 양을 줄이는 최적화.

**보류 이유 (측정):** 효과가 작다. grid에서 형제 경계(END→OPEN) 167곳 × 1B = **−167B(−3.3%)**.
`ELEM_END`의 operand를 이미 제거(3B→1B)해 핵심 이득을 챙긴 뒤라, 남은 몫이 작아졌다. gzip 후엔
무의미(반복이라 이미 압축됨). 대신 `END`가 두 종류가 되어 컴파일러·양쪽 런타임이 "형제로
이어지는가"를 분기해야 해 인코딩이 복잡해진다. **raw 3%를 위해 opcode 종류를 늘리는 건 지금
복잡도 대비 가치가 약하다.**

- 인코딩 재설계 시 후위 표기와 함께 다시 검토.

### `ELEM_CLOSE_OPEN` 추론 제거

`ELEM_CLOSE_OPEN`(`>`, 속성 끝·자식 시작 경계)을 명시 opcode 없이 **추론**하는 방안. 여는 태그
진행 중 올 수 있는 건 속성(`ATTR_*`)뿐이므로, **속성이 아닌 op**(`ELEM_OPEN`·`TEXT`·`ELEM_END`·
`RENDER`·`IF`…)가 나오면 그게 곧 "속성 끝" 신호다. 그 순간 `>`를 닫고 자식 모드로 전환한다.
요소당 1B 절감(`ELEM_END` operand 제거와 같은 결).

**보류 이유:** `ELEM_END` operand 제거는 잉여 제거(스택으로 100% 결정, 모호 0)였지만, 이건
마커를 **상태 + 매 op 분기**로 치환한다 — 렌더러·런타임 양쪽에 "여는 태그 열림" 플래그가 생기고,
op마다 "태그 여는 중인데 속성 아니면 먼저 `>` 닫기"를 검사해야 한다. 빈 요소(`<div></div>`)는
`ELEM_END`가 닫기 전에 `>`를 먼저 닫는 식으로 처리. 미래에 **조건부 속성**(`div(@if c { class=… })`)이
오면 `IF`/`ELSE`/`IF_END`도 "속성 모드 중 올 수 있는 op"가 되어 추론이 꼬인다.

- 효과는 요소당 1B로 `ELEM_END`와 동급이라 **grid류로 실측해 −% 데이터를 보고 결정**할 것.
  데이터 흐름·`@for` 확정 후 인코딩 재설계 시 후위 표기·`END_OPEN`과 함께 검토.

## 구현됨 (기록 보존)

적용 완료해 확정 설계로 승격된 아이디어. 본문은 거부한 대안·근거를 남기기 위한 기록이다.

### 컴포넌트 뷰어 (스토리북류) — qubb 인스펙터

→ **구현 완료. `bench/server/public/inspector.html` + `proto/web/disasm.js`** (`bench/server`에서
`cargo run` 후 /public/inspector.html). 아래는 원래 아이디어와 그보다 더 간 부분의 기록.

빌드 산출물 .qubb를 **클라에서 그대로 로드**해 컴포넌트를 골라 확인하는 도구. 별도 빌드 단계 없이
runtime.js로 즉시 인스턴스화하는 강점을 그대로 활용한다 — Storybook이 번들러·메타 파일을 요구하는
것과 달리 산출물 하나로 끝난다. 흐름: ① .qubb 디코드해 컴포넌트 목록(defs) 표시 ② 선택하면 props
입력 필드 자동 생성 ③ 값 입력 -> `ctx.set`으로 반영(반응 갱신).

**아이디어보다 더 간 부분:**
- **디컴파일(qubb -> qubc)** 추가 — 목록만이 아니라 선택한 컴포넌트를 qubc 소스로 복원해 보여준다
  (`disasm.js`: `inspect`/`decompileComponent`/`componentArgs`). 변수·prop명은 바이트코드에 없어
  `arg0`·`arg1`…로, 합성은 `Child(arg0={arg1}…) {}` 키워드 바인딩으로, use는 `./<Name>.qubc`로 복원.
- **props 타입 단서 미결을 용도 추론으로 해결** — 원래 "타입 단서 없음 -> 입력 위젯 뭘 줄지 미결,
  1차 텍스트 단일"이었으나, opcode 사용처로 추론한다: `IF`->bool(체크박스), `FOR`->number(숫자),
  그 외->string(텍스트). 바이트코드 포맷은 안 바꿨다(qubb에 props명·타입 안 넣음 — 그 결정 유지).

**한계(원리적):** number(`@for` count)는 set으로 반영 안 됨(런타임 @for 미완) — 첫 렌더만. 별칭·
슬롯·진짜 변수명은 바이트코드에 없어 복원 불가. 트리셰이킹 안 되는 use도 def 목록에 그대로 보인다
(인스펙터로 그 버그를 발견 — ISSUES.md).

### @if swap 시 비활성 가지 lazy build (클라 region)

→ **구현 완료. 확정 설계는 REACTIVITY.md §8.** 아래는 도입 당시 설계 메모(기록 보존).

클라 런타임에서 `@if`는 한 자리(Region)에서 두 가지 중 하나만 보인다. 비활성 가지는 "안 보이는
노드 0 비용"을 위해 build(노드·구독)를 미뤄야 한다(skip). 그러면 나중에 cond가 바뀌어 swap할 때
그 가지를 처음 build해야 하는데 — **최초 인스턴스화 루프는 끝나 스택 문맥이 사라진 상태**다.

**핵심:** swap build에는 전체 스택 복원이 필요 없다. 그 가지부터 아래로만 새로 자라므로,
**시작 Branch + 코드 범위(startPc~endPc)** 두 가지만 있으면 된다. 인스턴스화 루프를 재사용
가능하게 만든다:

```
interpret(startPc, endPc, regionIndex, branchIndex)
  // 시작 가지를 받아 start~end 해석. 한 호출 = 한 가지.
  // 최초 인스턴스화: interpret(0, len, 0, THEN_INDEX)
  // swap build:     interpret(가지start, 가지end, regionIndex, branchIndex)
  // 중첩 if는 재귀 호출 — JS 호출 스택이 수동 region/branch 스택을 대신한다.
```

**코드 범위는 마커로 이미 표시돼 있다** — then = IF다음~ELSE, else = ELSE다음~IF_END. 추가 마커
불필요(점프/길이 operand는 우리가 거부한 것). 단 IF 진입 시점엔 ELSE·IF_END 위치를 아직 모르므로,
비활성 가지를 **skip_branch(depth 카운팅, SSR renderer와 같은 패턴)로 건너뛰면서 경계 위치를
구한다**.

비활성 가지 안의 **중첩 if**는 skip돼 region이 안 생긴다 → 그 가지를 swap으로 처음 build할 때
비로소 생성된다("런타임 생성 + 제거 없음, append만"과 일관).

검증 순서: ① 스킵 없는 버전(양쪽 다 build, IF_END에서 비활성 구독 해제)으로 뼈대 확인 →
② cond 변경 swap 동작 확인 → ③ skip + lazy build 도입. **①·②·③ 모두 완료**
(`proto/web/compile.js`, `region.js`, `region-build.test.js` 8 테스트).
