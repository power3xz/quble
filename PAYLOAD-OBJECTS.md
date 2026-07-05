# 이벤트 payload/context에 객체 전달

> 상태: proto 구현·검증 완료(컴파일러·런타임·브라우저). `payload-objects` 브랜치.
> 조립 명령 이름은 런타임 내부 `STEP_ENTER/LEAF/EXIT`으로 확정. 이 문서는 "어떻게
> 풀지"의 방향과 근거, 기각한 대안을 남긴다. 확정된 바이트코드 계약은 proto/BYTECODE.md.

## 문제

핸들러가 payload/context로 leaf 값 하나가 아니라 **객체를 통째로** 받게 하려는 것.
`events { SAVE({ user }) }`에서 `user`가 객체(`{ name: { short, long }, email }`)이면,
핸들러가 `data.user`를 그 중첩 객체로 받아야 한다. JS에서 핸들러에 객체를 넘기는 것은
일상적이다.

현재 payload/context 값 자리는 **leaf-only**다. field 하나가 scope index 하나로 풀려
스칼라만 담긴다(codegen `arg_to_field_value` → `var_ref_to_scope_index`, 객체면 `NotLeaf`).
그래서 `{ user }`는 컴파일되지 않는다.

## 도달한 방향 (요약)

바이트코드는 값(객체)을 담지 않는다 - **구조(타입)와 위치(leaf 인덱스)** 만 담고,
런타임이 발생 시점에 객체를 **조립**해 핸들러에 넘긴다. 핵심 부품 셋:

1. **타입 테이블 (모듈 전역, dedup)** - 객체의 구조를 담는 테이블. 엔트리는 재귀 참조
   (object 필드가 자식 타입을 인덱스로 가리킴). 같은 구조는 한 엔트리로 공유되므로
   전역에 둔다 - 컴포넌트별로 두면 같은 구조가 컴포넌트마다 중복돼 dedup이 깨진다.
   테이블에는 **payload/context가 실제로 담는 객체 타입만** 등록한다(props 전체 타입이
   아니라). 스칼라 field는 테이블을 쓰지 않는다(scope index 하나로 지금처럼 처리) -
   객체를 담는 field에서 그 도달 타입을 만날 때만 intern한다. 안 쓰는 타입은 인코딩하지
   않는다.
2. **field = (이름, type_ref, leaf 인덱스 목록)** - 컴포넌트별(각 CompDef의 event/context
   fields, 기존 위치). 어떤 이름으로, 어떤 구조(전역 테이블의 type_ref)로, 어느 leaf들을
   채울지. 인덱스 **목록**이라 leaf가 연속일 필요가 없다. 스칼라 field는 type_ref=scalar +
   leaf 하나라 지금 동작의 상위집합.
3. **런타임 조립 (eager)** - 타입 구조를 walk하며 leaf 인덱스를 순서대로 소비해 중첩
   객체를 즉시 만든다. 핸들러는 평범한 JS 객체를 받는다.

즉 **구조는 전역 테이블에, 참조와 leaf는 컴포넌트의 field에.** field는 `type_ref`로
전역 테이블을 가리킬 뿐이다.

이 방향은 **조립을 값 레이어에만** 둔다. store(leaf 평탄 배열)도 반응성(leaf 구독)도
paths(scope index → 경로)도 건드리지 않는다. 객체는 store에 실체가 없고 조립 결과로만
존재한다 - "빈 폼"(leaf가 undefined)도 leaf 값이 그대로 흘러 자연 처리된다.

## 데이터 흐름

`user: { name: { short, long }, email }`, `SAVE({ user })`, 상수풀
`0:user 1:name 2:email 3:short 4:long`, user의 leaf가 scope index `[0,1,2]`인 경우.

### 1) 컴파일 - 타입 dedup & 인덱스 발급 (전역 테이블)

자식부터 등록해 참조가 먼저 존재하게 한다. scalar는 한 번만(공유):

    #0  Scalar
    #1  Object { short:#0, long:#0 }
    #2  Object { name:#1,  email:#0 }      // user → type_ref 2

### 2) 직렬화 (u16, 개념)

    ── 타입 테이블 (모듈 전역 섹션) ──
    3      // 엔트리 개수
    0      // #0 tag=Scalar
    1 2    // #1 tag=Object, field_count=2
    3 0    //    (short, →#0)
    4 0    //    (long,  →#0)
    1 2    // #2 tag=Object, field_count=2
    1 1    //    (name,  →#1)
    2 0    //    (email, →#0)   ← #0 재사용(dedup)
    ── SAVE payload field: user (해당 컴포넌트의 EventDef 안) ──
    0      // name_const_index = user
    2      // type_ref = #2 (전역 테이블 참조)
    3      // leaf_count = 3
    0 1 2  // leaf 인덱스(scope index): user.name.short/long, user.email

### 3) 런타임 - 타입 구조 → 조립 프로그램

컴파일 대상은 **type_ref가 가리키는 타입 구조**다(field가 아니라). 그 구조를 walk해
평탄한 조립 명령열로 만든다:

    ENTER, ENTER(name), LEAF(short), LEAF(long), EXIT, LEAF(email), EXIT

- 컴파일 단위가 type_ref라, 같은 type_ref는 같은 프로그램이다 - **type_ref별로 한 번**
  만들어 캐싱/공유할 수 있다(테이블 dedup의 이득이 조립 프로그램까지 이어진다).
- field는 이 프로그램에 leaf 인덱스 목록만 공급한다: 프로그램=구조, field=인스턴스.
- ENTER/LEAF/EXIT 명령은 **바이트코드에 없는 런타임 내부 표현**이다(§왜 이렇게).

### 4) 런타임 - 실행 (발생마다)

명령열을 훑으며 스택으로 객체를 쌓고, LEAF에서 field의 leaf 인덱스를 커서로 소비해
`store.get`으로 값을 채운다. 결과:

    { name: { short, long }, email }

같은 프로그램에 `leaves`만 갈아끼우면 재사용된다(구조=프로그램, 인스턴스=leaves).

## 왜 이렇게

- **구조는 데이터로, 값 레이어에만 손댐.** 조립은 leaf 값을 읽어 객체로 모으는 일이라
  store·반응성·paths와 독립. 경로 표현(paths)을 바꿀 필요가 없다(세그먼트 불필요).
- **타입 테이블은 dedup, 조립 프로그램은 런타임 전용.** 배포 표현(작고 공유되는 타입
  테이블)과 실행 표현(평탄한 조립 명령)을 나눈다 - 목적이 달라 하나로 합치면 한쪽이
  손해다(조립 명령을 바이트코드에 실으면 같은 구조가 payload마다 중복돼 파일이 커진다).
- **eager 조립으로 충분.** 벤치상 필드 100/깊이 5 객체 조립이 마이크로초 수준이라
  최적화가 불필요하다. 비용의 대부분은 JS 객체 생성 자체다.

## 기각한 대안

- **세그먼트 opcode로 경로 조립** - leaf 참조는 컴파일타임에 scope index로 이미 확정돼,
  경로를 런타임 opcode로 다시 쌓는 건 껍데기(정보가 늘지 않음). 합성 자식은 세그먼트를
  잇지 못하고(자기 store가 없음) 받은 것을 relay할 뿐이라 이득이 없다.
- **base 하나(연속 구간)만 전달** - "객체 = 연속 leaf 구간"으로 base+타입만 넘김. 크기는
  최소지만 leaf가 항상 연속이어야 하는 숨은 계약을 진다(재조합·`@for`에서 깨짐).
  인덱스 목록이 이 제약을 없애고 컴파일러 현 출력(`Vec<u16>`)과도 맞는다.
- **조립 프로그램(ENTER/LEAF/EXIT)을 바이트코드에 인코딩** - 런타임 컴파일을 없애지만,
  타입 테이블의 dedup을 잃어 같은 구조가 payload마다 중복된다. 배포 크기 불리.
- **Proxy 지연 조립** - 일부 필드만 읽을 때만 이득인데 eager 비용이 이미 무시 가능하고,
  전체 사용(직렬화 등) 시 트랩 오버헤드로 오히려 느리다(벤치상 수 배). 복잡도만 는다.
- **재귀 조립(콜스택)** - 단순하지만 깊은 타입에서 콜스택 오버플로로 터진다(통제 불가 실패).
  조립·컴파일 모두 반복(명시적 스택)으로 하면 깊이에 견고하다. 얕음이 보장되는 UI props면
  재귀도 안전하나, 견고성을 위해 반복을 기본으로 본다.
- **컴파일타임 leafIndex 고정** - `@for` 동적 슬롯 때문에 leafIndex는 컴파일타임에 못 박는다
  (별도 결론). 조립은 scope index만 쓰고 store 연결은 런타임 발급을 유지한다.

## 미해결

- **manifest.props(사이드카 점경로) 대체 여부.** 타입 테이블이 있으면 경로(scope index →
  store 경로)를 트리 walk로 파생할 수 있어 문자열 사이드카를 없앨 여지가 있다. 이번 조립과는
  독립 - 별개로 볼지, 함께 할지 미정. (묶으면 BYTECODE 계약 + manifest 포맷 동시 변경.)
- **타입 깊이 상한.** 병리적으로 깊은 타입 입력에 대한 한계/에러 처리.
- **`@for` 배열.** 배열 요소의 leaf가 런타임에 늘 때 인덱스 목록/조립이 어떻게 맞물리는지
  (반응성의 동적 leaf 발급과 직결, §5.1과 연관).
