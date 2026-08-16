# Quble 바이트코드 - v0

스코프: **여러 컴포넌트 정의/합성, 문자열/변수 속성값, props 변수 보간(텍스트/속성)과 스칼라
반응성, 외부 CSS 리소스 로드(`use "..."`).** 출력은 HTML 문자열(SSR)과 살아있는 DOM(클라).
이 문서는 컴파일러(생성)와 렌더러/런타임(소비)의 계약이다.

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

scope `["world"]` -> `<h1>Hello, world!</h1>`. (값은 문자열만. `{name}`은 단순 식별자 참조이며,
`{expr}` 전체 표현식은 아직 아니다.)

---

## 2. 상수풀 3단 구조 - 분리

| 풀                   | 내용                                                         | 정의 위치                                  | 참조 방식       |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------ | --------------- |
| **내장 태그 테이블** | 알려진 HTML **태그명만** (`div`, `h1`, `p`, ...)               | 언어 스펙에 고정. **파일에 직렬화 안 함.** | 예약 ID (u16)   |
| **전역 상수풀**      | 흔한 **속성명만** (`class`, `id`, `src`, ...)                  | 언어 스펙에 고정. **파일에 직렬화 안 함.** | 전역 ID (u16)   |
| **컴포넌트 상수풀**  | 텍스트/속성값/전역에 없는 속성명 등 컴포넌트마다 다른 상수    | 파일의 상수풀 섹션                         | 풀 인덱스 (u16) |

- 내장 태그 테이블/전역 상수풀은 컴파일러/런타임이 **같은 테이블을 코드로** 들고 있다. `div`/`class`는
  어느 컴포넌트든 항상 같은 ID -> 파일에 안 실린다. (DESIGN.md 요소 9)
- **속성명은 흔한 것만 전역 상수풀**에 두고, 전역에 없는 임의 속성명(`data-*`, `aria-*` 등)은
  **컴포넌트 상수풀**로 빠진다.
- **속성값은 항상 컴포넌트 상수풀.** `"card"` 같은 값은 컴포넌트마다 달라 전역에 못 넣는다.
- **컴포넌트 상수풀 엔트리는 타입을 갖는다**(Str/Num/Bool). quble이 타입을 소유하므로 리터럴은
  소스의 타입대로 실리고(`42`->Num, `true`->Bool), 런타임이 인덱스로 꺼내면 이미 올바른 값이다 -
  `@if` 등 소비 지점이 문자열을 다시 해석하지 않는다. 이름/텍스트/속성값은 Str.
- 풀의 구분은 **인덱스 비트가 아니라 opcode로** 한다(#4). `ELEM_OPEN`의 operand는
  내장 태그 ID, `ATTR_G`의 name은 전역 상수풀 ID, `ATTR_L`의 name과 모든 value/`TEXT`는
  컴포넌트 상수풀 인덱스. (`ELEM_END`는 operand가 없다 - #5.)

### 내장 태그 테이블

코드에 하드코딩. 워킹 확인 후 확장.

```
0:div  1:span  2:p  3:h1  4:h2  5:h3  6:a  7:ul  8:li  9:button  10:article  11:img
12:section  13:header  14:footer  15:nav  16:main  17:aside  18:label  19:input
20:em  21:b  22:strong  23:i  24:small  25:code  26:pre  27:h4  28:h5  29:h6
30:br  31:hr  32:ol  33:dl  34:dt  35:dd  36:table  37:thead  38:tbody  39:tr
40:th  41:td  42:form  43:textarea  44:select  45:option  46:figure  47:figcaption
48:time  49:blockquote  50:video  51:audio  52:canvas
```

추가만, 재배치 금지(예약 ID 안정). 시맨틱 태그(section~label)는 알림 패널 데모에서 편입.
SVG 계열은 없다 - `createElementNS`와 자손 네임스페이스 전파가 필요해 이 테이블로 안 다룬다.

### 전역 상수풀 - 속성명

코드에 하드코딩. 흔한 속성명만. 어떤 속성명을 전역에 넣을지는 나중에 **컴파일타임 usage 추적**으로
데이터를 보고 정한다.

```
0:class  1:id  2:src  3:alt  4:href  5:type  6:name  7:value  8:title  9:style  10:placeholder
11:for  12:disabled  13:checked  14:readonly  15:required  16:rel  17:target  18:width
19:height  20:colspan  21:rowspan  22:role  23:tabindex  24:datetime  25:controls
```

(아직 ID 호환성은 신경 쓰지 않는다 - 필요하면 재배치.)

### 전역 DOM 이벤트 테이블

`번호: 이벤트종류` 표. `BIND_EVENT`의 `event_type`이 이 번호로 어떤 DOM 이벤트인지 가리킨다.

```
0:click  1:input  2:change  3:submit  4:focus  5:blur  6:keydown  7:keyup
8:mousedown  9:mouseup  10:mouseenter  11:mouseleave  12:scroll
```

---

## 3. 정의(definition) vs 렌더(render)

바이트코드 파일은 **컴포넌트 정의(들)** 를 담는다. 정의는 컴파일타임에 고정된 청사진으로,
그 자체로는 그려지지 않는다. 실제 출력은 **컴포넌트를 RENDER** 할 때 일어난다.

- `@if`/`@for` 같은 분기/반복도 모두 **정의 안에 표현**된다. 구조는 고정이고, 렌더 시점의
  값에 따라 어느 가지를 타고 몇 번 도는지가 정해질 뿐이다. 그래서 정의는 **불변/재사용**이고,
  합성은 정의를 복사(인라이닝)하지 않고 **`RENDER`로 호출**한다.
- **page도 결국 하나의 컴포넌트다.** "페이지 단위 렌더" = 최상위 컴포넌트를 RENDER 하는 것.
- 무엇을 렌더할지는 **정의 파일이 정하지 않는다** - `RENDER comp_id` 호출이 정한다(진입점은
  호출자/브라우저가 결정). props는 호출 전에 `PUSH_ARG*`로 쌓아 두고 `RENDER`가 자식 scope로 넘긴다.

---

## 4. 파일 포맷

리틀엔디안. 문자열은 길이 접두(`u16` 바이트 길이) + UTF-8.

```
[ 헤더 ]
  magic      : "QBL\0"   (4 bytes)
  version    : u16        (= 0)
[ 컴포넌트 상수풀 ]           // 엔트리는 타입 태그 1바이트 + 타입별 payload
  count      : u16
  entries    : count x ( tag:u8, payload )
                 tag 0 (Str)  : len:u16, bytes:[u8;len]   // UTF-8
                 tag 1 (Num)  : f64 (8 bytes, LE)
                 tag 2 (Bool) : u8 (0/1)
[ 타입 테이블 ]              // 모듈 전역. payload/context가 담는 객체 구조(dedup). type_ref = 배열 인덱스
  count      : u16
  entries    : count x ( tag:u8, payload )
                 tag 0 (Scalar) : payload 없음
                 tag 1 (Object) : field_count:u16, fields:field_count x ( name_const_index:u16, type_ref:u16 )
                                  // type_ref로 자식 타입을 가리켜 중첩/공유를 표현
                 tag 2 (Array)  : elem_type_ref:u16   // 원소 타입. 배열의 배열은 elem이 다시 Array
                                  //   (string[][] = #0 Array(1) -> #1 Array(2) -> #2 Scalar)
[ 컴포넌트 테이블 ]        // ID = 배열 인덱스 (0,1,2...)
  count      : u16
  defs       : count x (
                 name_const_index : u16  // 상수풀의 컴포넌트명
                 props_type_ref   : u16  // 이 컴포넌트 props를 하나의 Object로 묶은 타입(타입 테이블
                                         //   인덱스). 필드 순서 = scope 슬롯 순서. props 없으면 빈
                                         //   Object. 진입점은 defs[0].props_type_ref로 rootValue를
                                         //   store에 풀필하고, 핸들러 props 접근은 발화 comp의 이걸
                                         //   argumentSourcePairs(런타임 슬롯 출처)와 결합해 해소한다
                 code_off   : u32        // 코드 영역 내 구획
                 code_len   : u32
                 event_count: u16        // 이 컴포넌트가 선언한 이벤트 수
                 events     : event_count x (
                   name_const_index : u16  // 이벤트명("CLICK") - 상수풀. 핸들러 키 매칭용
                   fields           : <FIELDS>   // 아래 FIELDS 구조
                 )
                 context_count: u16      // 이 컴포넌트가 선언한 컨텍스트 수(@with)
                 contexts   : context_count x (
                   name_const_index : u16  // 컨텍스트명("Area") - 상수풀
                   fields           : <FIELDS>   // 이벤트 payload와 같은 인코딩
                 )
                 expr_count : u8         // 이 컴포넌트가 쓰는 표현식 수(최대 255). `IF_EXPR`의
                                         //   expr_index가 이 배열의 인덱스라 폭을 맞춘다.
                                         //   개수가 255까지라 쓰이는 인덱스는 0~254 - expr_index가
                                         //   표현할 수 있는 255는 나오지 않는다
                 exprs      : expr_count x (
                   len  : u8             // code 바이트 수(최대 255)
                   code : [u8; len]      // 후위 표기 - 아래 <EXPR> 태그들
                 )
               )

  // EXPR - 식 하나의 바이트. 후위 표기라 앞에서 뒤로 한 번 훑으면 끝난다(되돌아갈 일이 없다).
  //   런타임은 이 바이트를 두 번 훑는다 - 구독을 걸 때 한 번, 값을 셀 때 한 번(#5.2).
  //   스택에는 **값만** 올라간다. 칸 번호(leafIndex)는 안 올라간다 - 주소와 값이 섞이면 연산자가
  //   무엇을 계산하는지 알 수 없어진다. Load*가 이미 값을 꺼내 올린다.
  //   타입은 컴파일타임에 검사가 끝나(compiler/src/expr_type.rs) 런타임은 타입을 안 본다.
  <EXPR> = 태그 1바이트 + 태그별 operand
           0x00 LoadVar          : scope_index:u8, offset:u8  // 그 칸의 값
           0x01 LoadConst        : const_index:u16            // 컴포넌트 상수풀
           0x02 LoadArrayLength  : scope_index:u8, offset:u8  // 배열 길이
           0x03 LoadStringLength : scope_index:u8, offset:u8  // 문자열 길이
           0x04 LoadSmallInt     : value:u8                   // 0~255 정수. 음수는 Neg가 붙는다
           0x05 LoadTrue         : -
           0x06 LoadFalse        : -
           0x10 Add   0x11 Sub   0x12 Mul   0x13 Div   0x14 Rem   // 이항, operand 없음
           0x15 Eq    0x16 Ne    0x17 Lt    0x18 Le    0x19 Gt    0x1a Ge
           0x1b And   0x1c Or
           0x1d Not   0x1e Neg                                    // 단항, operand 없음

  // FIELDS - 이벤트 payload와 컨텍스트가 공유하는 필드 목록 인코딩
  <FIELDS> = field_count : u16
             fields      : field_count x (
               name_const_index : u16   // 필드명("title") 상수풀
               type_ref         : u16   // 타입 테이블 인덱스 - 이 슬롯을 어떤 구조로 조립할지
               ref              : <REF>  // 이 field를 채울 값 하나(객체도 슬롯 하나 - 안 펼친다)
             )

  // REF - field 값 하나의 출처. 태그 1바이트로 세 종류를 가른다. 슬롯을 펼치지 않으므로 Scope는
  //   (scope_index, offset) 위치만 담고, 슬롯의 실제 kind(store/const)는 런타임이 정한다.
  <REF> = tag : u8   // 0=Scope, 1=Const, 2=Raw
          tag 0 (Scope) : scope_index:u8, offset:u8  // 부모 scope[scope_index]의 base+offset
          tag 1 (Const) : const_index:u16            // 컴포넌트 상수풀 리터럴
          tag 2 (Raw)   : value:u16                  // @for 런타임 원시값(지금은 @for 인덱스)
[ 코드 ]
  len        : u32
  code       : [u8; len]   // 모든 정의의 코드가 이어짐. 테이블의 off/len으로 구획.
```

- 내장 태그 테이블/전역 상수풀은 파일에 없다 - 헤더의 version이 이 테이블들의 버전을 함께
  결정한다고 본다.
- **타입 테이블은 모듈 전역/dedup.** payload/context가 담는 타입 + **모든 comp의 props 타입**을
  등록한다(props는 핸들러가 접근하려면 선언 전체가 필요). Object 필드가 자식을 `type_ref`로 가리켜
  중첩/공유를 표현한다. field는
  `type_ref`로 이 테이블을 참조하고 값 출처(`ref`)만 따로 싣는다 - 구조는 전역에, 인스턴스는
  컴포넌트 field에. 슬롯을 펼치지 않으므로 객체 field도 ref 하나로 그 슬롯을 가리킨다(런타임이
  type_ref 구조로 store에서 조립). 조립은 런타임 값 레이어 전용 - 왜 이렇게 나눴는지는
  DECISIONS.md "이벤트 payload/context에 객체 전달".
- **`elem_type_ref`/`type_ref`는 말단(Scalar)으로 내려가는 하위 참조만.** 자기/조상 인덱스를
  가리키는 재귀 타입(`type Tree = Tree[]`)은 미지원 - 컴파일러가 그런 엔트리를 내지 않는다
  (내면 순회가 무한). 필요해지면 사이클 검출을 그때 추가.
- **컴포넌트명은 상수풀에 둔다**(`name_const_index`로 참조).
- **컴포넌트 ID = 테이블 배열 인덱스.** `RENDER`/합성은 이 ID로 정의를 직접 인덱싱한다.
- 진입점(엔트리포인트) 정보는 파일에 없다 - `RENDER comp_id` 호출이 지정.

---

## 5. opcode

opcode = `u8`. operand는 뒤에 가변으로 붙는다. **operand가 어느 풀을 가리키는지는 opcode가 결정.**

| opcode            | 값   | operand               | 풀                        | 동작                                                                     |
| ----------------- | ---- | --------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `HALT`            | 0x00 | -                     | -                         | 실행 종료.                                                               |
| `ELEM_OPEN`       | 0x01 | tag: u16              | 내장 태그                 | `<TAG` 출력, "여는 태그 진행 중".                                        |
| `ATTR_G`          | 0x02 | name: u16, value: u16 | name=전역, value=컴포넌트 | ` name="value"` 출력. name은 전역 상수풀 ID.                             |
| `ELEM_CLOSE_OPEN` | 0x03 | -                     | -                         | `>` 출력. 여는 태그 종료, 자식 시작.                                     |
| `TEXT`            | 0x04 | text: u16             | 컴포넌트                  | 텍스트 출력 (HTML 이스케이프).                                           |
| `ELEM_END`        | 0x05 | -                     | -                         | 가장 최근에 연 태그를 닫는다(`</TAG>`). 닫을 태그는 스택 top으로 안다.   |
| `RENDER`          | 0x06 | comp_id: u16          | -                         | 쌓인 인자를 자식 scope로 넘겨 comp_id 정의를 렌더(호출). 인자 버퍼를 비운다. |
| `ATTR_L`          | 0x07 | name: u16, value: u16 | 컴포넌트                  | ` name="value"` 출력. name은 컴포넌트 상수풀 인덱스(전역에 없는 속성명). |
| `TEXT_VAR`        | 0x08 | scope_index:u8, offset:u8 | scope                 | `scope[scope_index]` 슬롯 `(kind,base)`에서 `base+offset` 값을 텍스트로 출력 (HTML 이스케이프). 경로 없는 `{title}`은 offset 0, 객체 필드 `{user.name}`은 필드 거리. |
| `ATTR_G_VAR`      | 0x09 | name:u16, scope_index:u8, offset:u8 | name=전역, value=scope | ` name="..."` 출력. name은 전역 상수풀 ID, 값은 `scope[scope_index]`의 `base+offset`(속성값 이스케이프). |
| `ATTR_L_VAR`      | 0x0a | name:u16, scope_index:u8, offset:u8 | name=컴포넌트, value=scope | ` name="..."` 출력. name은 컴포넌트 상수풀 인덱스, 값은 `scope[scope_index]`의 `base+offset`. |
| `PUSH_THROUGH`    | 0x0b | scope_index: u8       | scope                     | 부모 `scope[scope_index]` 슬롯 `(kind,index)`을 편집 없이 그대로 자식 인자 버퍼에 push(경로 없는 참조 `{a}`/`{user}`). 뒤따르는 `RENDER`가 소비. |
| `IF`              | 0x0c | scope_index:u8, offset:u8 | scope                 | `scope[scope_index]`의 `base+offset`(불리언)으로 분기 시작. 경로 없는 조건은 offset 0. then 가지 코드가 이어진다. |
| `ELSE`            | 0x0d | -                     | -                         | then 가지 끝, else 가지 시작. (else 있을 때만)                            |
| `IF_END`          | 0x0e | -                     | -                         | if 블록 끝.                                                              |
| `LOAD_RES`        | 0x0f | res: u16              | 모듈 전역 리소스          | `res`(resId)의 외부 리소스(CSS 등)를 로드. resId->URL은 런타임이 주입.    |
| `BIND_EVENT`      | 0x10 | event_type:u16, event_index:u16 | type=전역 DOM 이벤트, index=컴포넌트 이벤트 | 지금 여는 요소에 리스너를 묶는다. `event_type` DOM 이벤트가 일어나면 컴포넌트 이벤트 `event_index`를 발생시킨다. |
| `PUSH_ARG_LIT`    | 0x11 | const_index: u16      | 컴포넌트 상수풀           | 리터럴 값을 자식 인자 버퍼에 push. 부모 슬롯과 분리된 독립 leaf(use-site `Comp(prop="lit")`). |
| `PUSH_PATH_SEGMENT` | 0x12 | seg_index: u16      | 컴포넌트 상수풀           | 합성 경로(fullname)에 세그먼트 하나를 민다(자식 type-name/alias). 뒤따르는 `RENDER`가 소비. |
| `ENTER_CONTEXT`   | 0x13 | context_index: u16    | 컴포넌트 컨텍스트 테이블   | `@with` 진입. `ContextDef.fields`를 읽어 활성 컨텍스트 스택에 push. 이후 코드가 그 범위. |
| `EXIT_CONTEXT`    | 0x14 | -                     | -                         | `@with` 블록 끝(IF_END 동형 마커). 활성 컨텍스트 스택 pop.                 |
| `FOR_RAW`         | 0x15 | count: u16            | -                         | 리터럴 횟수 반복(`@for (x of 3)`). 슬롯 안 거치고 직접 인라인. `FOR_END`까지가 몸체. |
| `FOR_COUNT_VAR`   | 0x16 | scope_index:u8, offset:u8 | scope                 | count가 숫자 슬롯인 반복(`@for (x of n)`). `scope[scope_index]`의 `base+offset` 값을 횟수로. |
| `FOR_END`         | 0x17 | -                     | -                         | `@for` 몸체 끝(IF_END 동형 마커). 중첩은 깊이로 짝짓기.                    |
| `PUSH_PATH_INDEX_SEGMENT` | 0x18 | depth: u16    | -                         | 합성 경로에 `@for` 회차 인덱스 세그먼트를 민다. `depth`는 loopIndexStack에서 읽을 위치. 직전 이름 세그먼트에 접미(`VideoItem[3]`)하거나, 직전 이름이 없으면 익명 세그먼트(`[3]`). |
| `PUSH_FIELD`      | 0x19 | scope_index:u8, offset:u8 | scope                 | 부모 `scope[scope_index]`에서 필드로 내려가 `(kind, base+offset)`을 자식에 push(경로 참조 `{user.name}`). kind(출처)는 부모 슬롯 그대로 전파, 위치만 넘긴다 - 결과 타입은 자식이 자기 선언으로 안다(leaf면 `store.get`, object면 base+offset, array면 `arrayPool[store.get()]`). |
| `FOR_ARRAY_VAR`   | 0x1a | scope_index:u8, offset:u8 | scope                 | count가 배열 슬롯인 반복(`@for (item of arr)`). 그 칸의 `arrayInfoIndex`로 요소 수/위치를 얻어 요소 수만큼 반복하며, 회차마다 회차변수 슬롯을 그 요소 leaf에 바인딩. |
| `PUSH_SLOT_PLACEHOLDER_CONTENT` | 0x1b | slot_placeholder_index: u16 | - | 슬롯 콘텐츠 구간 시작(**사용쪽**). `SLOT_PLACEHOLDER_CONTENT_END`까지가 콘텐츠 코드이고 뒤따르는 `RENDER`가 소비한다. 콘텐츠는 부모 def 안에 그대로 남아 **부모 scope/path**로 해석된다(SYNTAX #3.3). |
| `SLOT_PLACEHOLDER_CONTENT_END` | 0x1c | -              | -                         | 콘텐츠 구간 끝 마커(`IF_END` 동형). 다음 op가 `PUSH_SLOT_PLACEHOLDER_CONTENT`가 아니면 콘텐츠 목록도 끝. |
| `FILL_SLOT_PLACEHOLDER` | 0x1d | slot_placeholder_index: u16 | -          | `@slot(name)` 자리(**정의쪽**). 그 인덱스의 콘텐츠 구간을 **부모 컨텍스트**(argumentSourcePairs/compId/pathPrefix)로 해석해 이 자리에 끼운다. 안 채운 슬롯이면 아무것도 안 넣는다(미채움 허용). |
| `IF_EXPR`         | 0x1e | expr_index: u8        | 컴포넌트 표현식 테이블     | 연산자가 붙은 조건으로 분기 시작(`@if (count > 0)`). 이후는 `IF`와 같다 - then 가지가 이어지고 `ELSE`/`IF_END`도 그대로. 런타임이 파생 칸을 잡고 식이 읽는 칸들을 구독해 그 칸에 결과를 넣는다(#5.2). |

설계 메모:

- `ELEM_END`는 operand가 없다. 트리는 항상 올바르게 중첩되므로(컴파일러 보장) END는 **가장
  최근에 연 태그**를 닫을 수밖에 없다 - 어느 태그인지 명시할 필요가 없다. 닫을 대상은 런타임이
  스택으로 안다: SSR 렌더러는 `</TAG>`를 써야 해 **태그 이름 스택**을, JS 런타임은 부모로
  복귀만 하면 돼 **DOM 노드 스택**을 유지한다. (이전엔 END가 tag ID를 들었으나 잉여라 제거.
  요소당 2B 절감 - grid raw -8.7% 실측.)
- 빈 요소 `h1() {}`도 OPEN -> CLOSE_OPEN -> END (`<h1></h1>`). void element 최적화는 나중.
- **합성 - `PUSH_THROUGH`/`PUSH_FIELD`/`PUSH_ARG_LIT` + `RENDER`.** 부모가 자식을 호출할 때,
  use-site 바인딩을 자식 scope index 순서대로 쌓고 `RENDER comp_id`가 그 인자 버퍼를 **자식
  scope**로 넘긴다(그리고 비운다). `ATTR`이 `ELEM` 앞에 쌓이고 `CLOSE_OPEN`이 닫는 것과 같은
  패턴 - 인자가 `RENDER` 앞에 쌓이고 `RENDER`가 흡수한다.
  - 셋의 갈림 - **경로 유무 + 출처**다:
    - `Comp(x={a})`(경로 없음) -> `PUSH_THROUGH scope_index`: 부모 슬롯 `(kind, index)`을 편집
      없이 그대로. 넘기는 게 leaf든 object든 array든 슬롯을 통째로 전파한다.
    - `Comp(x={user.name})`(경로 있음) -> `PUSH_FIELD scope_index, offset`: 부모 슬롯에서
      `base+offset`으로 내려가 `(kind, base+offset)`을 넘긴다. kind는 그대로 전파, **위치만**
      넘기고 결과 타입은 자식이 자기 선언으로 안다(array면 자식이 `arrayPool[store.get()]`).
    - `Comp(x="lit")`(리터럴) -> `PUSH_ARG_LIT const_index`: 부모 슬롯과 분리된 독립 const.
  - **싣는 건 값이 아니라 부모 scope의 (kind, index)**다. 같은 컴포넌트가 use-site마다 다른
    값을 받을 수 있어(# 정의 vs 사용) 전역 leafIndex가 아니라 부모 슬롯을 한 단계 풀어 준다.
  - 인자는 **자식 scope index 0,1,2... 순서**로 쌓는다. 지금은 use-site가 자식 props를 **전부**
    바인딩한다고 보고 순서만으로 매핑한다. 일부 생략 허용은 미정(빈 자리용 opcode 등).
  - 진입점(최상위)은 외부에서 `render(qubb, comp_id, scope)`로 scope를 직접 준다. 인자 버퍼는
    `RENDER`로 합성할 때만 쓰인다.
- `TEXT_VAR`는 런타임 주입 값을 가리킨다. 렌더 시 `render(qubb, comp_id, scope)`로 **scope**
  (슬롯 배열)를 넘기고, `TEXT_VAR scope_index, offset`이 `scope[scope_index]` 슬롯의 `base+offset`을
  출력한다. 심볼 이름은 바이트코드에 없다
  - 값 자리(`TEXT_VAR`/`ATTR_*_VAR`/`IF`)는 **자기 scope**라 컴파일이 레이아웃을 안다. push와
    달리 kind를 전파할 필요가 없어 `(scope_index, offset)` 한 형태로 통일한다 - 경로 없는
    `{title}`은 offset 0, 객체 필드 `{user.name}`은 필드 거리. (push는 자식이 kind를 런타임에
    받아야 해 `THROUGH`/`FIELD`로 갈리지만, 값 자리는 나눌 실익이 없어 offset을 항상 싣는다.)
- 속성은 **두 축**으로 갈린다 - name(전역 `G` / 컴포넌트 `L`) x value(정적 / 변수 `_VAR`).
  네 조합이 `ATTR_G`/`ATTR_L`/`ATTR_G_VAR`/`ATTR_L_VAR`. 변수 속성값의 `(scope_index, offset)`은
  **`TEXT_VAR`와 같은 slot 공간**을 쓴다 (값이 텍스트로 가든 속성으로 가든 같은 주입 슬롯 배열).
- **분기 - `IF`/`ELSE`/`IF_END` (마커).** `@if`/`@else`를 세 마커로 감싼다. 형태와 "왜 점프가
  없어야 하는가"는 #5.1에서 따로 설명한다.
- **반복 - `FOR_* ... FOR_END` (마커 경계).** `@for`는 점프가 아니라 **해석단이 본문 구간을 N회
  반복 해석**한다(pc 되감기가 아니라 호스트 루프). 본문 경계는 `FOR_END` 마커(IF_END와 동형,
  중첩은 깊이로 짝짓기). 여는 opcode는 **count의 컴파일타임 타입**으로 갈린다 - 런타임이 값을 보고
  추정하지 않는다.
  - `FOR_RAW count:u16` - 리터럴 횟수(`@for (x of 3)`). 슬롯 안 거치고 직접 인라인.
  - `FOR_COUNT_VAR scope_index:u8, offset:u8` - count가 숫자 슬롯(`@for (x of n)`, 필드면
    `a.count`라 offset). 런타임이 그 leaf 값을 횟수로. STORE면 count leaf 구독으로 꼬리 회차를
    늘리고/줄인다(전용 region). CONST(부모가 리터럴로 준 prop)는 안 변하니 인라인.
  - `FOR_ARRAY_VAR scope_index:u8, offset:u8` - count가 배열 슬롯(`@for (item of arr)`). 배열
    칸은 `arrayInfoIndex` 하나라(슬롯 안 펼침) 그 값으로 arrayPool에서 요소 수/위치를 얻어 요소
    수만큼 반복한다. 회차마다 **회차변수(item)** 슬롯을 그 요소 leaf에 바인딩해 본문의
    `TEXT_VAR`/push가 요소값을 쓴다.
  - **회차변수 슬롯은 operand에 없다.** codegen이 `props 슬롯 수 + 바깥 @for 깊이`로 정해 `{item}`을
    그 slot의 `TEXT_VAR`로 내고, 런타임도 같은 규칙으로 그 자리를 구해 회차 leaf를 꽂는다. 양쪽이
    같은 식이라 operand로 나를 필요가 없다.
  - **회차 인덱스**(fullname의 `[i]`)는 `PUSH_PATH_INDEX_SEGMENT depth:u16`로 별개 축. 런타임이
    loopIndexStack의 그 깊이 값을 직전 이름 세그먼트에 접미한다.
- **슬롯 - 콘텐츠는 부모 코드에 남고 자식 자리에서 끼운다.** 사용쪽 `PUSH_SLOT_PLACEHOLDER_CONTENT
  idx ... SLOT_PLACEHOLDER_CONTENT_END`를 `RENDER` **앞**에 깔면(다른 `PUSH_*`와 같은 자리) RENDER가
  소비해 자식에 넘기고, 자식의 `FILL_SLOT_PLACEHOLDER idx`가 그 구간을 실행한다. 콘텐츠 코드를
  자식 def로 옮기지 않는 것이 핵심 - 부모 def에 그대로 있어야 부모 scope/path로 해석된다.
  - **세 축이 갈린다.** 해석 컨텍스트(argumentSourcePairs/compId/pathPrefix)는 **부모**(콘텐츠를 쓴 곳),
    DOM 부착 위치(`nodeTop()`)와 수명(branch)은 **자식**(콘텐츠가 놓인 곳). `RENDER`가 이미 같은
    분리를 반대 방향으로 한다 - 자식을 해석해 fragment를 받고 부모 자리에 붙인다.
  - **인덱스는 컴포넌트-로컬**이고 정의쪽/사용쪽이 같은 공간을 쓴다(자식 def의 `@slot` 선언 순서).
    props와 같은 방식이라 사용처가 어떤 순서로 채우든 codegen이 이 순서로 정규화한다 - 이름은
    컴파일타임에 소진되고 런타임은 인덱스만 본다. 전역 인덱스가 아니라 def 안에서 닫힌다.
  - **미채움 허용** - 자식이 정의한 슬롯을 부모가 안 채우면 그 `PUSH_*`를 아예 안 낸다. 런타임은
    해당 인덱스가 비면 아무것도 안 넣는다(props는 전부 필수인 것과 다르다).
- **외부 리소스 - `LOAD_RES res`.** 파일이 `use "./style.css"`로 CSS를 참조하면, 그 파일의
  **모든 컴포넌트** 정의 앞머리에 `LOAD_RES resId`를 하나씩 낸다. 런타임이 resId를 URL로 풀어
  로드(클라: `<link>` 삽입, 중복 URL 스킵).
  - **왜 모든 컴포넌트 앞에 두는가.** `use`는 파일 단위 선언이라 그 파일의 어느 컴포넌트가 CSS를
    쓰는지 특정할 수 없다 - 전부 후보다. 게다가 **lazy build**에서 `@if` 비활성 가지나 RENDER되지
    않는 컴포넌트는 build되지 않아 그 안의 `LOAD_RES`도 실행되지 않는다. 즉 리소스는 **컴포넌트가
    실제로 그려질 때만** 로드된다 - 정의 앞머리에 두는 것이 안전장치가 아니라 lazy 로딩의 메커니즘이다.
  - **URL은 바이트코드에 없다** - 빌드/배포마다 바뀌므로(해시 파일명/CDN 경로) 런타임이
    `{resId: url}` 맵을 주입한다. 컴파일러는 CSS를 산출물(`dist/res/<basename>.<내용해시>.css`)로
    복사하고 `resId -> 산출 경로` 사이드맵(`<name>.resmap.json`, 인덱스가 resId)을 qubb 밖으로
    낸다. 산출물이 자립적이도록 CSS 파일도 함께 둔다. URL prefix(CDN 등)는 이후 빌드/배포가 붙인다.
  - **내용 해시 파일명**은 평탄화 시 동명 충돌을 막고 캐시 버스팅도 겸한다(FNV-1a 64bit). 파일명을
    `<basename>.<hash>`로 두면 충돌하려면 basename/내용 해시가 둘 다 같아야 해 사실상 0.
  - **resId는 모듈 전역 인덱스**다. scope index/comp_id가 모듈 로컬인 것과 같은 결 - 한 모듈
    안에서만 유효한 0,1,2.... 같은 정규화 경로는 같은 resId로 합친다(컴파일타임 정규화/중복 제거).
  - **qubb 안에 리소스 테이블은 두지 않는다.** 빌드가 이미 resId->경로를 알아 qubb에 또 담는 건
    잉여. 나중에 필요하면 추가는 쉽고 제거는 어려우므로 지금은 안 넣는다(IDEAS.md 보류).
- **이벤트 - `BIND_EVENT` + 컴포넌트 이벤트 테이블.** 정의와 발생이 나뉜다.
  - **정의**는 컴포넌트 테이블(#4)에 둔다. 컴포넌트가 `events { TOGGLE({ title }) }`로 선언하면,
    이벤트명/fields(필드명 + type_ref + ref)가 그 컴포넌트의 이벤트 배열에 들어간다.
    `event_index`는 이 배열의 인덱스(0,1,2...). 각 field는 `type_ref`(타입 테이블)로 조립 구조를,
    **ref**로 그 구조를 채울 값 하나를 가리킨다(슬롯을 안 펼쳐 객체도 ref 하나). ref는 태그로
    Scope(부모 슬롯의 scope_index+offset) / Const(리터럴) / Raw(@for)를 가른다. 컨텍스트와 같은
    인코딩(<FIELDS>, #4).
  - **발생 배선**은 코드의 `BIND_EVENT`다. `button(@click:TOGGLE)`은 그 요소에
    `BIND_EVENT click, 0`(click이 일어나면 0번 이벤트)을 낸다. 속성처럼 `ELEM_OPEN`과
    `ELEM_CLOSE_OPEN` 사이에 온다.
  - **발생 시 런타임**: 0번 이벤트 정의를 보고, 각 field의 ref를 현재값으로 읽어 `type_ref`
    구조대로 **조립**해 `data = { title: ... }`를 만들고, 핸들러(fullname으로 찾음)에 넘긴다.
    스칼라 field는 그 슬롯이 값이 되고, 객체 field는 슬롯의 store 위치부터 구조대로 중첩 객체로
    조립된다(조립 절차는 런타임 전용 - `core/web/runtime.ts`). 핸들러는 JS로 런타임에 주입된다.
    같은 fullname = 같은 핸들러.
  - 핸들러 본문/`set`은 바이트코드에 없다 - 컴파일러는 "발생 배선"(`BIND_EVENT`)과 정의(테이블)만
    낸다. 본문은 호스트 JS에 위임(DESIGN 미결 "핸들러 문법"의 방향).
- **컨텍스트 - `ENTER_CONTEXT`/`EXIT_CONTEXT` + 컴포넌트 컨텍스트 테이블.** `@with`로 주입하는
  메타데이터. 이벤트와 같은 결로 정의와 활성화가 나뉜다.
  - **정의**는 컴포넌트 테이블(#4)에 둔다. `contexts { Area { userId: assignee } }`가 컨텍스트명/
    fields(이벤트와 같은 인코딩)로 컨텍스트 배열에 들어간다. `context_index`는 이 배열의 인덱스.
  - **활성화**는 코드의 `ENTER_CONTEXT context_index` ... `EXIT_CONTEXT`다. `@with Area { ... }`가
    이 짝으로 감싼다(IF/IF_END와 동형 - 점프 없는 마커, 중첩 보장).
  - **런타임**: ENTER가 그 컨텍스트를 활성 스택에 올리고(각 field를 type_ref 구조로 조립), 그 범위 안의
    `BIND_EVENT`가 활성 컨텍스트를 핸들러의 `context`로 전달한다(`context.Area.userId` = 발생 시점
    현재값, payload와 같은 조립). EXIT가 스택에서 내린다. 컨텍스트는 DOM 출력엔 영향 없다(SSR은 skip).
  - 같은 컨텍스트명 중첩은 비정상이나(맥락은 중복이 없는 게 맞다), 합성 경계 너머 중첩은 컴파일타임에
    못 봐 런타임이 안쪽 우선으로 덮고 경고한다(ISSUES.md).

## 5.1 분기 - `IF`/`ELSE`/`IF_END`

```
if-only :  IF cond  [then]            IF_END
if-else :  IF cond  [then]  ELSE  [else]  IF_END
```

`cond`는 불리언 칸 하나. 연산자가 붙은 조건은 `IF` 자리에 `IF_EXPR`이 오고 나머지는 같다(#5.2).

양쪽 가지를 다 해석해 두 청사진을 모두 들고 있되, **활성 가지만 build**(DOM/구독 생성)한다.
비활성 가지는 청사진으로만 보관 - 구독이 없어 `set`이 와도 갱신 대상이 아니다. `cond`가 바뀌면
현재 가지를 버리고 반대 청사진을 build 한다.

### 왜 점프가 없어야 하는가

해석기는 pc를 어디로도 점프시키지 않고 모든 바이트를 순차 해석한다. 마커는 가지 경계만 표시한다.
점프를 두지 않는 건 단순함이 아니라 원칙이다:

- **트리는 항상 올바르게 중첩되어야 한다.** `ELEM_END`가 operand 없이 "스택 top을 닫는다"로
  성립하는 건 *연 만큼 닫는다*는 전제 덕이다. 점프는 그 짝을 깬다 - 열고 안 닫거나, 안 열고 닫게
  된다. 분기도 중첩 블록이라 통째로 들어가거나 안 들어가거나 둘 뿐, 블록 중간으로 뛰어들 일이 없다.
- **선언이지 명령이 아니다.** 템플릿은 "이 트리를 그려라"는 선언이다. 블록 경계를 무시하고 임의
  위치로 가는 흐름(break/goto류)은 이 모델에 속하지 않는다. 점프는 우리가 갖지 않기로 한 의미다.

### 이스케이프 규칙

출력이 결정적이도록 런타임은 다음 이스케이프를 적용한다. 텍스트와 속성값의 규칙이 다르다.

| 위치                                | 이스케이프 대상                     |
| ----------------------------------- | ----------------------------------- |
| `TEXT` (텍스트 노드)                | `&`->`&amp;`, `<`->`&lt;`, `>`->`&gt;` |
| `ATTR_G`/`ATTR_L` 의 value (속성값) | 텍스트 규칙 + `"`->`&quot;`          |

태그명/속성명은 신뢰된 식별자라 이스케이프하지 않는다.

## 5.2 표현식 조건 - `IF_EXPR`

`@if (count > 0)`처럼 연산자가 붙은 조건. 잎 하나짜리 조건(`@if (isPaid)`)은 그대로 `IF`가
받는다 - 표현식 테이블을 거칠 이유가 없다.

```
IF_EXPR expr_index  [then]  ELSE  [else]  IF_END
```

`ELSE`/`IF_END`는 `IF`와 똑같이 쓴다. 다른 것은 조건을 어디서 얻느냐뿐이다.

**런타임이 `IF_EXPR`을 만나면 파생 칸(leaf) 하나를 잡는다.** 그 칸이 식의 결과를 담고, 분기는
그 칸 **하나만** 구독한다. 그래서 분기 쪽 구조는 `IF`와 달라지지 않는다.

1. 파생 칸을 하나 잡는다 - 지역(region)이 소유한다.
2. 식 바이트를 훑어 `LoadVar`/`LoadArrayLength`/`LoadStringLength`가 가리키는 칸을 모으고,
   그 칸들을 구독한다. 슬롯 kind가 CONST면 값이 안 변하니 구독하지 않는다.
3. 식을 세어 결과를 파생 칸에 넣는다.
4. 원본 칸 중 하나라도 바뀌면 식 전체를 다시 세어 파생 칸에 `set` 한다. 분기는 그 칸을 구독하고
   있으므로 평소의 값 변경과 똑같이 반응한다.

**파생 칸 번호는 바이트코드에 없다.** 런타임이 발급한다 - `@for`가 요소를 늘리고 줄이며 칸을
그때그때 잡고 푸는 이상 컴파일타임에 못 박는다(DECISIONS.md "이벤트 payload/context에 객체
전달"의 "컴파일타임 leafIndex 고정"). `IF_EXPR`의 operand가 `expr_index` 하나뿐인 이유다.

**길이 태그를 배열과 문자열로 나눈 것은 구독 대상이 달라서다.** 배열은 길이를 담은 칸을
구독하고, 문자열은 값 칸을 구독해 바뀔 때마다 길이를 다시 잰다.

**점프도 단락 평가(short-circuit)도 없다.** 값 자리에는 부수효과가 없어 `&&`의 오른쪽을 늘
세어도 결과가 같다. #5.1의 "왜 점프가 없어야 하는가"와 같은 이유다.

왜 후위 표기이고 왜 테이블을 컴포넌트가 소유하는지는 DECISIONS.md "표현식 테이블 - 컴포넌트
소유 + 후위 표기 채택".

---

## 6. 위 예시의 컴파일 결과 (개념)

내장 태그: `div=0, h1=3, p=2`
전역 상수풀(속성명): `class=0`
컴포넌트 상수풀:

```
0:"greeting" 1:"Hello" 2:"sub" 3:"world"
```

컴포넌트 테이블: `[ id 0: name_const_index=1("Hello"), code_off=0, code_len=... ]`
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
core/
  Cargo.toml            # workspace
  crates/
    bytecode/   # opcode, 내장 태그 테이블, 전역 상수풀(속성명), 컴포넌트 상수풀, 직렬화/역직렬화
    compiler/   # .qubc 소스 -> bytecode. 프론트엔드(lexer/parse->ast) + 백엔드(codegen)
    renderer/   # bytecode -> HTML 문자열 (SSR)
  src/bin/      # 실행 바이너리 - 컴파일, dev 서버
  web/          # JS 런타임 - qubb를 읽어 DOM 렌더
```

`bytecode` 크레이트가 포맷의 단일 정의처(내장 태그 테이블 포함). 컴파일러/렌더러가 공유해 계약
불일치를 컴파일타임에 막는다.

---

## 8. 진행 순서

1. `bytecode` - opcode enum, 내장 태그 테이블, ConstPool, 컴포넌트 테이블, 직렬화/역직렬화 + 라운드트립 테스트.
2. `renderer` - 손으로 만든 바이트코드 -> HTML. (컴파일러 없이 먼저 검증)
3. `compiler` - `.qubc` -> bytecode.
4. `main` - end-to-end: hello.qubc -> HTML. 출력 일치 테스트.

각 단계는 다음으로 넘어가기 전 테스트로 검증한다.

```

```
