# Quble 바이트코드 — 프로토타입 v0

프로토타입 스코프: **단일 컴포넌트, 문자열 속성값만, 표현식 없음.** 출력은 HTML 문자열(SSR).
이 문서는 파서(생성)와 VM(소비)의 계약이다. 합의 후 Rust 구현으로 간다.

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

이 단계에서 없는 것: 합성/별칭, 슬롯, `@if/@for/@with`, `{expr}`, contexts, events, props.

---

## 2. 상수풀 3단 구조 — 분리

| 풀 | 내용 | 정의 위치 | 참조 방식 |
|---|---|---|---|
| **내장 태그 테이블** | 알려진 HTML **태그명만** (`div`, `h1`, `p`, …) | 언어 스펙에 고정. **파일에 직렬화 안 함.** | 예약 ID (u16) |
| **전역 상수풀** | 흔한 **속성명만** (`class`, `id`, `src`, …) | 언어 스펙에 고정. **파일에 직렬화 안 함.** | 전역 ID (u16) |
| **컴포넌트 상수풀** | 텍스트·속성값·전역에 없는 속성명 등 컴포넌트마다 다른 문자열 | 파일의 상수풀 섹션 | 풀 인덱스 (u16) |

- 내장 태그 테이블·전역 상수풀은 컴파일러·VM이 **같은 테이블을 코드로** 들고 있다. `div`/`class`는
  어느 컴포넌트든 항상 같은 ID → 파일에 안 실린다. (DESIGN.md 요소 9)
- **속성명은 흔한 것만 전역 상수풀**에 두고, 전역에 없는 임의 속성명(`data-*`, `aria-*` 등)은
  **컴포넌트 상수풀**로 빠진다.
- **속성값은 항상 컴포넌트 상수풀.** `"card"` 같은 값은 컴포넌트마다 달라 전역에 못 넣는다.
- 풀의 구분은 **인덱스 비트가 아니라 opcode로** 한다(§4). `ELEM_OPEN`/`ELEM_END`의 operand는
  내장 태그 ID, `ATTR_G`의 name은 전역 상수풀 ID, `ATTR_L`의 name과 모든 value·`TEXT`는
  컴포넌트 상수풀 인덱스.

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

| opcode | 값 | operand | 풀 | 동작 |
|---|---|---|---|---|
| `HALT`            | 0x00 | — | — | 실행 종료. |
| `ELEM_OPEN`       | 0x01 | tag: u16 | 내장 태그 | `<TAG` 출력, "여는 태그 진행 중". |
| `ATTR_G`          | 0x02 | name: u16, value: u16 | name=전역, value=컴포넌트 | ` name="value"` 출력. name은 전역 상수풀 ID. |
| `ELEM_CLOSE_OPEN` | 0x03 | — | — | `>` 출력. 여는 태그 종료, 자식 시작. |
| `TEXT`            | 0x04 | text: u16 | 컴포넌트 | 텍스트 출력 (HTML 이스케이프). |
| `ELEM_END`        | 0x05 | tag: u16 | 내장 태그 | `</TAG>` 출력. |
| `RENDER`          | 0x06 | comp_id: u16 | — | 컴포넌트 ID로 정의를 찾아 렌더(호출). |
| `ATTR_L`          | 0x07 | name: u16, value: u16 | 컴포넌트 | ` name="value"` 출력. name은 컴포넌트 상수풀 인덱스(전역에 없는 속성명). |

설계 메모:
- `ELEM_OPEN`/`ELEM_END`가 tag ID를 각각 들고 있어 VM이 태그 스택을 유지하지 않아도 된다
  (파서가 짝을 보장). 단순/검증 우선의 선택. 스택 기반 축약은 나중.
- 빈 요소 `h1() {}`도 OPEN → CLOSE_OPEN → END (`<h1></h1>`). void element 최적화는 나중.
- `RENDER`는 합성·진입점 호출용. 프로토타입은 합성이 없어 **정의 코드 안엔 등장하지 않고**,
  VM이 외부에서 `RENDER comp_id`로 진입할 때만 쓰인다.
- 분기/반복(`@if`/`@for`)용 opcode는 형태가 미확정이라 지금 추가하지 않는다.

### 이스케이프 규칙

출력이 결정적이도록 VM은 다음 이스케이프를 적용한다. 텍스트와 속성값의 규칙이 다르다.

| 위치 | 이스케이프 대상 |
|---|---|
| `TEXT` (텍스트 노드) | `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;` |
| `ATTR_G`/`ATTR_L` 의 value (속성값) | 텍스트 규칙 + `"`→`&quot;` |

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
진입: VM이 `RENDER 0` 으로 시작.

코드 (들여쓰기는 가독성용, 실제는 평탄):
```
ELEM_OPEN 0            ; <div                (내장 0)
ATTR_G 0 0             ;  class="greeting"   (전역 0, 컴포넌트 0)
ELEM_CLOSE_OPEN        ; >
  ELEM_OPEN 3          ; <h1                 (내장 3)
  ELEM_CLOSE_OPEN      ; >
  TEXT 1               ; Hello               (컴포넌트 1)
  ELEM_END 3           ; </h1>
  ELEM_OPEN 2          ; <p                  (내장 2)
  ATTR_G 0 2           ;  class="sub"        (전역 0, 컴포넌트 2)
  ELEM_CLOSE_OPEN      ; >
  TEXT 3               ; world               (컴포넌트 3)
  ELEM_END 2           ; </p>
ELEM_END 0             ; </div>
HALT
```

---

## 7. Rust 크레이트 구조

```
proto/
  Cargo.toml            # workspace
  crates/
    bytecode/   # opcode, 내장 태그 테이블, 전역 상수풀(속성명), 컴포넌트 상수풀, 직렬화/역직렬화 (컴파일러·VM 공용)
    compiler/   # .qubc 소스 → bytecode. 프론트엔드(lexer/parse→ast) + 백엔드(codegen)
    vm/         # bytecode → HTML 문자열
  examples/hello.qubc
  src/main.rs           # .qubc → 컴파일 → 실행 → stdout
```

`bytecode` 크레이트가 포맷의 단일 정의처(내장 태그 테이블 포함). 컴파일러·VM이 공유해 계약
불일치를 컴파일타임에 막는다.

---

## 8. 진행 순서

1. `bytecode` — opcode enum, 내장 태그 테이블, ConstPool, 컴포넌트 테이블, 직렬화/역직렬화 + 라운드트립 테스트.
2. `vm` — 손으로 만든 바이트코드 → HTML. (컴파일러 없이 먼저 검증)
3. `compiler` — `.qubc` → bytecode.
4. `main` — end-to-end: hello.qubc → HTML. 출력 일치 테스트.

각 단계는 다음으로 넘어가기 전 테스트로 검증한다.
```