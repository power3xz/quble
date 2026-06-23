# Quble 바이트코드 — 프로토타입 v0

스코프: **여러 컴포넌트 정의·합성, 문자열/변수 속성값, props 변수 보간(텍스트·속성)과 스칼라
반응성.** 출력은 HTML 문자열(SSR)과 살아있는 DOM(클라). 이 문서는 컴파일러(생성)와
렌더러·런타임(소비)의 계약이다.

---

## 1. 다루는 입력

```
component Hello {
  template {
    div(class="greeting") {
      h1() { "Hello" }
      p(class="sub") { "world" }
    }
  }
}
```

기대 출력: `<div class="greeting"><h1>Hello</h1><p class="sub">world</p></div>`

**props 보간 (1단계):** `props { name }`로 선언한 변수를 `{name}`으로 텍스트 자리에서 참조.
선언 순서가 scope 인덱스이고, 렌더 시 `render(qubb, comp_id, scope)`로 값 배열을 넘긴다.

```
component Greeting {
  props { name }
  template { h1() { "Hello, " {name} "!" } }
}
```

scope `["world"]` → `<h1>Hello, world!</h1>`. (값은 문자열만. `{name}`은 단순 식별자 참조이며,
`{expr}` 전체 표현식은 아직 아니다.)

이 단계에서 없는 것: 합성/별칭, 슬롯, `@if/@for/@with`, 전체 `{expr}`, contexts, events,
props 객체·반응성.

---

## 2. 상수풀 3단 구조 — 분리

| 풀                   | 내용                                                         | 정의 위치                                  | 참조 방식       |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------ | --------------- |
| **내장 태그 테이블** | 알려진 HTML **태그명만** (`div`, `h1`, `p`, …)               | 언어 스펙에 고정. **파일에 직렬화 안 함.** | 예약 ID (u16)   |
| **전역 상수풀**      | 흔한 **속성명만** (`class`, `id`, `src`, …)                  | 언어 스펙에 고정. **파일에 직렬화 안 함.** | 전역 ID (u16)   |
| **컴포넌트 상수풀**  | 텍스트·속성값·전역에 없는 속성명 등 컴포넌트마다 다른 문자열 | 파일의 상수풀 섹션                         | 풀 인덱스 (u16) |

- 내장 태그 테이블·전역 상수풀은 컴파일러·런타임이 **같은 테이블을 코드로** 들고 있다. `div`/`class`는
  어느 컴포넌트든 항상 같은 ID → 파일에 안 실린다. (DESIGN.md 요소 9)
- **속성명은 흔한 것만 전역 상수풀**에 두고, 전역에 없는 임의 속성명(`data-*`, `aria-*` 등)은
  **컴포넌트 상수풀**로 빠진다.
- **속성값은 항상 컴포넌트 상수풀.** `"card"` 같은 값은 컴포넌트마다 달라 전역에 못 넣는다.
- 풀의 구분은 **인덱스 비트가 아니라 opcode로** 한다(§4). `ELEM_OPEN`의 operand는
  내장 태그 ID, `ATTR_G`의 name은 전역 상수풀 ID, `ATTR_L`의 name과 모든 value·`TEXT`는
  컴포넌트 상수풀 인덱스. (`ELEM_END`는 operand가 없다 — §5.)

### 내장 태그 테이블 (프로토타입 시작 집합)

코드에 하드코딩. 워킹 확인 후 확장.

```
0:div  1:span  2:p  3:h1  4:h2  5:h3  6:a  7:ul  8:li  9:button  10:article  11:img
```

### 전역 상수풀 — 속성명 (프로토타입 시작 집합)

코드에 하드코딩. 흔한 속성명만. 어떤 속성명을 전역에 넣을지는 나중에 **컴파일타임 usage 추적**으로
데이터를 보고 정한다.

```
0:class  1:id  2:src  3:alt  4:href  5:type  6:name  7:value  8:title  9:style  10:placeholder
```

(프로토타입이라 ID 호환성은 신경 쓰지 않는다 — 필요하면 재배치.)

---

## 3. 정의(definition) vs 렌더(render)

바이트코드 파일은 **컴포넌트 정의(들)** 를 담는다. 정의는 컴파일타임에 고정된 청사진으로,
그 자체로는 그려지지 않는다. 실제 출력은 **컴포넌트를 RENDER** 할 때 일어난다.

- `@if`/`@for` 같은 분기·반복도 모두 **정의 안에 표현**된다. 구조는 고정이고, 렌더 시점의
  값에 따라 어느 가지를 타고 몇 번 도는지가 정해질 뿐이다. 그래서 정의는 **불변·재사용**이고,
  합성은 정의를 복사(인라이닝)하지 않고 **`RENDER`로 호출**한다.
- **page도 결국 하나의 컴포넌트다.** "페이지 단위 렌더" = 최상위 컴포넌트를 RENDER 하는 것.
- 무엇을 렌더할지는 **정의 파일이 정하지 않는다** — `RENDER comp_id` 호출이 정한다(진입점은
  호출자/브라우저가 결정). 프로토타입은 props/state·합성이 없으므로 인자 없이 RENDER 한다.

---

## 4. 파일 포맷

리틀엔디안. 문자열은 길이 접두(`u16` 바이트 길이) + UTF-8.

```
[ 헤더 ]
  magic      : "QBL\0"   (4 bytes)
  version    : u16        (= 0)
[ 컴포넌트 상수풀 ]
  count      : u16
  entries    : count × ( len:u16, bytes:[u8;len] )
[ 컴포넌트 테이블 ]        // ID = 배열 인덱스 (0,1,2…)
  count      : u16
  defs       : count × ( name_idx:u16, code_off:u32, code_len:u32 )
               // name_idx = 상수풀의 컴포넌트명. code_off/len = 코드 영역 내 구획.
[ 코드 ]
  len        : u32
  code       : [u8; len]   // 모든 정의의 코드가 이어짐. 테이블의 off/len으로 구획.
```

- 내장 태그 테이블·전역 상수풀은 파일에 없다 — 헤더의 version이 이 테이블들의 버전을 함께
  결정한다고 본다.
- **컴포넌트명은 상수풀에 둔다**(`name_idx`로 참조).
- **컴포넌트 ID = 테이블 배열 인덱스.** `RENDER`/합성은 이 ID로 정의를 직접 인덱싱한다.
- 진입점(엔트리포인트) 정보는 파일에 없다 — `RENDER comp_id` 호출이 지정.

---

## 5. opcode (프로토타입)

opcode = `u8`. operand는 뒤에 가변으로 붙는다. **operand가 어느 풀을 가리키는지는 opcode가 결정.**

| opcode            | 값   | operand               | 풀                        | 동작                                                                     |
| ----------------- | ---- | --------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `HALT`            | 0x00 | —                     | —                         | 실행 종료.                                                               |
| `ELEM_OPEN`       | 0x01 | tag: u16              | 내장 태그                 | `<TAG` 출력, "여는 태그 진행 중".                                        |
| `ATTR_G`          | 0x02 | name: u16, value: u16 | name=전역, value=컴포넌트 | ` name="value"` 출력. name은 전역 상수풀 ID.                             |
| `ELEM_CLOSE_OPEN` | 0x03 | —                     | —                         | `>` 출력. 여는 태그 종료, 자식 시작.                                     |
| `TEXT`            | 0x04 | text: u16             | 컴포넌트                  | 텍스트 출력 (HTML 이스케이프).                                           |
| `ELEM_END`        | 0x05 | —                     | —                         | 가장 최근에 연 태그를 닫는다(`</TAG>`). 닫을 태그는 스택 top으로 안다.   |
| `RENDER`          | 0x06 | comp_id: u16          | —                         | 쌓인 인자를 자식 scope로 넘겨 comp_id 정의를 렌더(호출). 인자 버퍼를 비운다. |
| `ATTR_L`          | 0x07 | name: u16, value: u16 | 컴포넌트                  | ` name="value"` 출력. name은 컴포넌트 상수풀 인덱스(전역에 없는 속성명). |
| `TEXT_VAR`        | 0x08 | idx: u16              | scope                     | `scope[idx]`(런타임 주입 값)를 텍스트로 출력 (HTML 이스케이프).          |
| `ATTR_G_VAR`      | 0x09 | name: u16, idx: u16   | name=전역, idx=scope      | ` name="scope[idx]"` 출력. name은 전역 상수풀 ID, 값은 변수(속성값 이스케이프). |
| `ATTR_L_VAR`      | 0x0a | name: u16, idx: u16   | name=컴포넌트, idx=scope  | ` name="scope[idx]"` 출력. name은 컴포넌트 상수풀 인덱스, 값은 변수.        |
| `PUSH_ARG`        | 0x0b | offset: u16           | scope                     | 부모 `scope[offset]`을 자식 인자 버퍼에 push. 뒤따르는 `RENDER`가 소비.     |
| `IF`              | 0x0c | cond: u16             | scope                     | `scope[cond]`(불리언)으로 분기 시작. then 가지 코드가 이어진다.            |
| `ELSE`            | 0x0d | —                     | —                         | then 가지 끝, else 가지 시작. (else 있을 때만)                            |
| `IF_END`          | 0x0e | —                     | —                         | if 블록 끝.                                                              |
| `LOAD_RES`        | 0x0f | res: u16              | 모듈 전역 리소스          | `res`(resId)의 외부 리소스(CSS 등)를 로드. resId->URL은 런타임이 주입.    |

설계 메모:

- `ELEM_END`는 operand가 없다. 트리는 항상 올바르게 중첩되므로(컴파일러 보장) END는 **가장
  최근에 연 태그**를 닫을 수밖에 없다 — 어느 태그인지 명시할 필요가 없다. 닫을 대상은 런타임이
  스택으로 안다: SSR 렌더러는 `</TAG>`를 써야 해 **태그 이름 스택**을, JS 런타임은 부모로
  복귀만 하면 돼 **DOM 노드 스택**을 유지한다. (이전엔 END가 tag ID를 들었으나 잉여라 제거.
  요소당 2B 절감 — grid raw −8.7% 실측.)
- 빈 요소 `h1() {}`도 OPEN → CLOSE_OPEN → END (`<h1></h1>`). void element 최적화는 나중.
- **합성 — `PUSH_ARG` + `RENDER`.** 부모가 자식을 호출할 때, use-site 바인딩
  (`Comp(name={b})` — `b`는 부모 offset)을 `PUSH_ARG offset`으로 **자식 offset 순서대로** 쌓고
  `RENDER comp_id`가 그 인자 버퍼를 **자식 scope**로 넘긴다(그리고 비운다). `ATTR`이 `ELEM` 앞에
  쌓이고 `CLOSE_OPEN`이 닫는 것과 같은 패턴 — 인자가 `RENDER` 앞에 쌓이고 `RENDER`가 흡수한다.
  - `PUSH_ARG`가 싣는 건 **값이 아니라 부모 offset**이다. 부모 `scope[offset]`(SSR) /
    `paths[offset]`(클라 반응성)을 **한 단계 풀어** 자식에게 준다. 그래서 leafIndex 같은 전역
    인덱스를 넘기지 않는다 — 같은 컴포넌트가 use-site마다 다른 값을 받을 수 있기 때문(§ 정의 vs 사용).
  - 인자는 **자식 offset 0,1,2… 순서**로 쌓는다. 지금은 use-site가 자식 props를 **전부** 바인딩한다고
    보고 순서만으로 매핑한다. 일부 생략을 허용할 때 `PUSH_ARG`에 offset을 명시하거나 빈 자리용 opcode를
    더한다(미정).
  - 진입점(최상위)은 외부에서 `render(qubb, comp_id, scope)`로 scope를 직접 준다. 인자 버퍼는
    `RENDER`로 합성할 때만 쓰인다.
- `TEXT_VAR`는 런타임 주입 값을 가리킨다. 렌더 시 `render(qubb, comp_id, scope)`로 **scope**
  (값 배열)를 넘기고, `TEXT_VAR idx`가 `scope[idx]`를 출력한다. 심볼 이름은 바이트코드에 없다
  — 컴파일타임에 **scope 인덱스로 확정**되므로(정적 분석), 런타임은 배열 인덱스로 O(1) 접근한다.
  (1단계: 값은 문자열. 객체·반응성은 이후 단계.)
- 속성은 **두 축**으로 갈린다 — name(전역 `G` / 컴포넌트 `L`) × value(정적 / 변수 `_VAR`).
  네 조합이 `ATTR_G`·`ATTR_L`·`ATTR_G_VAR`·`ATTR_L_VAR`. 변수 속성값의 idx는 **`TEXT_VAR`와
  같은 scope offset 공간**을 쓴다 (값이 텍스트로 가든 속성으로 가든 같은 주입 값 배열).
- **분기 — `IF`/`ELSE`/`IF_END` (마커).** `@if`/`@else`를 세 마커로 감싼다. 형태와 "왜 점프가
  없어야 하는가"는 §5.1에서 따로 설명한다.
- 반복(`@for`)용 opcode는 형태가 미확정이라 지금 추가하지 않는다. 방향만 — 점프 없이 **해석단이
  본문 구간을 N회 반복 해석**한다(pc 되감기가 아니라 호스트 루프). 본문 경계 표기·leafIndex 회수
  (REACTIVITY.md §3)가 엮여 별도 작업.
- **외부 리소스 — `LOAD_RES res`.** 컴포넌트가 `use './style.css'`로 CSS를 참조하면 정의 코드
  앞머리에 `LOAD_RES resId`를 하나 낸다. 런타임이 resId를 URL로 풀어 로드(클라: `<link>` 삽입,
  중복 URL 스킵). **URL은 바이트코드에 없다** — 빌드/배포마다 바뀌므로(해시 파일명·CDN 경로)
  런타임이 `{resId: url}` 맵을 주입한다. 컴파일러는 `resId -> 경로` 사이드맵을 qubb 밖으로 내보내고,
  빌드가 거기에 URL을 붙여 런타임 맵을 만든다.
  - **resId는 모듈 전역 인덱스**다. scope offset·comp_id가 모듈 로컬인 것과 같은 결 — 한 모듈
    안에서만 유효한 0,1,2…. 같은 경로는 같은 resId로 합친다(컴파일타임 정규화·중복 제거).
  - **qubb 안에 리소스 테이블은 두지 않는다.** 빌드가 이미 resId->경로를 알아 qubb에 또 담는 건
    잉여. 나중에 필요하면 추가는 쉽고 제거는 어려우므로 지금은 안 넣는다(IDEAS.md 보류).

## 5.1 분기 — `IF`/`ELSE`/`IF_END`

```
if-only :  IF cond  [then]            IF_END
if-else :  IF cond  [then]  ELSE  [else]  IF_END
```

`cond`는 불리언 scope offset 하나(truthy면 then, falsy면 else). 표현식 조건은 `{expr}`에서 확장.

양쪽 가지를 다 해석해 두 청사진을 모두 들고 있되, **활성 가지만 build**(DOM·구독 생성)한다.
비활성 가지는 청사진으로만 보관 — 구독이 없어 `set`이 와도 갱신 대상이 아니다. `cond`가 바뀌면
현재 가지를 버리고 반대 청사진을 build 한다.

### 왜 점프가 없어야 하는가

해석기는 pc를 어디로도 점프시키지 않고 모든 바이트를 순차 해석한다. 마커는 가지 경계만 표시한다.
점프를 두지 않는 건 단순함이 아니라 원칙이다:

- **트리는 항상 올바르게 중첩되어야 한다.** `ELEM_END`가 operand 없이 "스택 top을 닫는다"로
  성립하는 건 *연 만큼 닫는다*는 전제 덕이다. 점프는 그 짝을 깬다 — 열고 안 닫거나, 안 열고 닫게
  된다. 분기도 중첩 블록이라 통째로 들어가거나 안 들어가거나 둘 뿐, 블록 중간으로 뛰어들 일이 없다.
- **선언이지 명령이 아니다.** 템플릿은 "이 트리를 그려라"는 선언이다. 블록 경계를 무시하고 임의
  위치로 가는 흐름(break·goto류)은 이 모델에 속하지 않는다. 점프는 우리가 갖지 않기로 한 의미다.

### 이스케이프 규칙

출력이 결정적이도록 런타임은 다음 이스케이프를 적용한다. 텍스트와 속성값의 규칙이 다르다.

| 위치                                | 이스케이프 대상                     |
| ----------------------------------- | ----------------------------------- |
| `TEXT` (텍스트 노드)                | `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;` |
| `ATTR_G`/`ATTR_L` 의 value (속성값) | 텍스트 규칙 + `"`→`&quot;`          |

태그명·속성명은 신뢰된 식별자라 이스케이프하지 않는다.

---

## 6. 위 예시의 컴파일 결과 (개념)

내장 태그: `div=0, h1=3, p=2`
전역 상수풀(속성명): `class=0`
컴포넌트 상수풀:

```
0:"greeting" 1:"Hello" 2:"sub" 3:"world"
```

컴포넌트 테이블: `[ id 0: name_idx=1("Hello"), code_off=0, code_len=… ]`
진입: 런타임이 `RENDER 0` 으로 시작.

코드 (들여쓰기는 가독성용, 실제는 평탄):

```
ELEM_OPEN 0            ; <div                (내장 0)
ATTR_G 0 0             ;  class="greeting"   (전역 0, 컴포넌트 0)
ELEM_CLOSE_OPEN        ; >
  ELEM_OPEN 3          ; <h1                 (내장 3)
  ELEM_CLOSE_OPEN      ; >
  TEXT 1               ; Hello               (컴포넌트 1)
  ELEM_END             ; </h1>               (스택 top = h1)
  ELEM_OPEN 2          ; <p                  (내장 2)
  ATTR_G 0 2           ;  class="sub"        (전역 0, 컴포넌트 2)
  ELEM_CLOSE_OPEN      ; >
  TEXT 3               ; world               (컴포넌트 3)
  ELEM_END             ; </p>                (스택 top = p)
ELEM_END               ; </div>              (스택 top = div)
HALT
```

---

## 7. Rust 크레이트 구조

```
proto/
  Cargo.toml            # workspace
  crates/
    bytecode/   # opcode, 내장 태그 테이블, 전역 상수풀(속성명), 컴포넌트 상수풀, 직렬화/역직렬화 (컴파일러·렌더러 공용)
    compiler/   # .qubc 소스 → bytecode. 프론트엔드(lexer/parse→ast) + 백엔드(codegen)
    renderer/   # bytecode → HTML 문자열 (SSR, render_to_string)
  examples/hello.qubc
  src/main.rs           # .qubc → 컴파일 → 실행 → stdout
```

`bytecode` 크레이트가 포맷의 단일 정의처(내장 태그 테이블 포함). 컴파일러·렌더러가 공유해 계약
불일치를 컴파일타임에 막는다.

---

## 8. 진행 순서

1. `bytecode` — opcode enum, 내장 태그 테이블, ConstPool, 컴포넌트 테이블, 직렬화/역직렬화 + 라운드트립 테스트.
2. `renderer` — 손으로 만든 바이트코드 → HTML. (컴파일러 없이 먼저 검증)
3. `compiler` — `.qubc` → bytecode.
4. `main` — end-to-end: hello.qubc → HTML. 출력 일치 테스트.

각 단계는 다음으로 넘어가기 전 테스트로 검증한다.

```

```
