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

## 2. 두 개의 문자열 풀 — 분리

| 풀 | 내용 | 정의 위치 | 참조 방식 |
|---|---|---|---|
| **내장 풀 (builtin)** | 알려진 HTML **태그명만** (`div`, `h1`, `p`, …) | 언어 스펙에 고정. **파일에 직렬화 안 함.** | 예약 ID (u16) |
| **상수풀 (user)** | 텍스트·속성명·속성값 등 컴포넌트마다 다른 문자열 | 파일의 상수풀 섹션 | 풀 인덱스 (u16) |

- 내장 풀은 컴파일러·VM이 **같은 테이블을 코드로** 들고 있다. `div`는 어느 컴포넌트든 항상 같은
  예약 ID → 파일에 안 실린다. (DESIGN.md 요소 9)
- **속성명(`class` 등)은 내장이 아니라 사용자 상수풀**에 넣는다. `data-*` 같은 임의 속성을
  균일하게 다루기 위함.
- 두 풀의 구분은 **인덱스 비트가 아니라 opcode로** 한다(§4). `ELEM_OPEN`/`ELEM_END`의 operand는
  항상 내장 태그 ID, `ATTR`/`TEXT`의 operand는 항상 사용자 상수풀 인덱스.

### 내장 태그 테이블 (프로토타입 시작 집합)

코드에 하드코딩. 워킹 확인 후 확장.

```
0:div  1:span  2:p  3:h1  4:h2  5:h3  6:a  7:ul  8:li  9:button
```

(예약 ID는 안정적이어야 하므로 **추가만, 재배치 금지**.)

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
[ 상수풀 (user) ]
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

- 내장 풀은 파일에 없다 — 헤더의 version이 내장 테이블 버전을 함께 결정한다고 본다.
- **컴포넌트명은 상수풀에 둔다**(`name_idx`로 참조).
- **컴포넌트 ID = 테이블 배열 인덱스.** `RENDER`/합성은 이 ID로 정의를 직접 인덱싱한다.
- 진입점(엔트리포인트) 정보는 파일에 없다 — `RENDER comp_id` 호출이 지정.

---

## 5. opcode (프로토타입)

opcode = `u8`. operand는 뒤에 가변으로 붙는다. **operand가 어느 풀을 가리키는지는 opcode가 결정.**

| opcode | 값 | operand | 풀 | 동작 |
|---|---|---|---|---|
| `HALT`            | 0x00 | — | — | 실행 종료. |
| `ELEM_OPEN`       | 0x01 | tag: u16 | 내장 | `<TAG` 출력, "여는 태그 진행 중". |
| `ATTR`            | 0x02 | name: u16, value: u16 | 사용자 | ` name="value"` 출력 (ELEM_OPEN 직후). |
| `ELEM_CLOSE_OPEN` | 0x03 | — | — | `>` 출력. 여는 태그 종료, 자식 시작. |
| `TEXT`            | 0x04 | text: u16 | 사용자 | 텍스트 출력 (HTML 이스케이프). |
| `ELEM_END`        | 0x05 | tag: u16 | 내장 | `</TAG>` 출력. |
| `RENDER`          | 0x06 | comp_id: u16 | — | 컴포넌트 ID로 정의를 찾아 렌더(호출). |

설계 메모:
- `ELEM_OPEN`/`ELEM_END`가 tag ID를 각각 들고 있어 VM이 태그 스택을 유지하지 않아도 된다
  (파서가 짝을 보장). 단순/검증 우선의 선택. 스택 기반 축약은 나중.
- 빈 요소 `h1() {}`도 OPEN → CLOSE_OPEN → END (`<h1></h1>`). void element 최적화는 나중.
- `RENDER`는 합성·진입점 호출용. 프로토타입은 합성이 없어 **정의 코드 안엔 등장하지 않고**,
  VM이 외부에서 `RENDER comp_id`로 진입할 때만 쓰인다.
- 분기/반복(`@if`/`@for`)용 opcode는 형태가 미확정이라 지금 추가하지 않는다.

---

## 6. 위 예시의 컴파일 결과 (개념)

내장 태그: `div=0, h1=3, p=2`
사용자 상수풀:
```
0:"class" 1:"greeting" 2:"Hello" 3:"sub" 4:"world"
```

컴포넌트 테이블: `[ id 0: name_idx=2("Hello"), code_off=0, code_len=… ]`
진입: VM이 `RENDER 0` 으로 시작.

코드 (들여쓰기는 가독성용, 실제는 평탄):
```
ELEM_OPEN 0            ; <div         (내장 0)
ATTR 0 1               ;  class="greeting"   (사용자 0,1)
ELEM_CLOSE_OPEN        ; >
  ELEM_OPEN 3          ; <h1          (내장 3)
  ELEM_CLOSE_OPEN      ; >
  TEXT 2               ; Hello        (사용자 2)
  ELEM_END 3           ; </h1>
  ELEM_OPEN 2          ; <p           (내장 2)
  ATTR 0 3             ;  class="sub" (사용자 0,3)
  ELEM_CLOSE_OPEN      ; >
  TEXT 4               ; world        (사용자 4)
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
    bytecode/   # opcode, 내장 태그 테이블, 사용자 상수풀, 직렬화/역직렬화 (파서·VM 공용)
    parser/     # .comp 소스 → bytecode
    vm/         # bytecode → HTML 문자열
  examples/hello.comp
  src/main.rs           # comp → 컴파일 → 실행 → stdout
```

`bytecode` 크레이트가 포맷의 단일 정의처(내장 태그 테이블 포함). 파서·VM이 공유해 계약
불일치를 컴파일타임에 막는다.

---

## 8. 진행 순서

1. `bytecode` — opcode enum, 내장 태그 테이블, ConstPool, 컴포넌트 테이블, 직렬화/역직렬화 + 라운드트립 테스트.
2. `vm` — 손으로 만든 바이트코드 → HTML. (파서 없이 먼저 검증)
3. `parser` — `.comp` → bytecode.
4. `main` — end-to-end: hello.comp → HTML. 출력 일치 테스트.

각 단계는 다음으로 넘어가기 전 테스트로 검증한다.
```