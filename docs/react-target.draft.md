# React 컴파일 타겟 (draft)

ROADMAP "컴파일 타겟"의 React 판. 같은 `.qubc`를 qubb 대신 React 컴포넌트(TSX)로 낸다.
동기는 ROADMAP 그대로다 - 작성은 quble로 하고 산출은 React로 내보내 실무에서 쓰며 검증한다.

구조는 React context로 경로 마디와 컨텍스트를 쌓아 내려보내는 방식이다.

## 대응

| quble | React 산출 |
|---|---|
| 합성 `First: Toggle(...)` - 경로 마디 | `<Segment name="First">` |
| `@with Area { ... }` | `<With name="Area" value={{...}}>` |
| `@click:TOGGLE` + events payload | `onClick={(e) => q.emit("TOGGLE", {...}, e)}` |
| 핸들러 표 `"First.TOGGLE"` | `<QubleRoot handlers>`가 같은 표를 받는다 |

경로 규칙은 quble 것이다 - 쓰는 쪽에서 바깥->안쪽으로 별칭(없으면 타입명)을 쌓고, 루트는
마디를 안 만든다. `@with`는 경로에 안 끼고 컴포넌트 경계를 넘어 산다. 같은 이름 `@with`가
겹치면 안쪽이 통째로 덮는다.

## 컴파일러

- 검증은 qubb codegen이 한다. React 산출기는 codegen을 통과한 FlatComp만 받으므로 에러를 안 낸다.
- `pub fn react_tsx(entry_path: &str, src: &str, loader: &impl SourceLoader) -> Result<String, CompileError>`
- `pub fn react_tsx_from_path(path: &str) -> Result<String, CompileError>`
- `react.rs`: `pub fn generate(comps: &[FlatComp]) -> String`
- 바이너리 `quble-react <component.qubc>` - TSX를 stdout으로 낸다(`quble-dts`와 같은 꼴).

산출 예:

```tsx
import { Segment, With, useQ } from "quble-react";

export const Toggle = (p: { label: string; on: string }) => {
  const q = useQ();
  return <button onClick={(e) => q.emit("TOGGLE", { label: p.label, on: p.on }, e)}>{String(p.label)}</button>;
};

export const Page = (p: { a: string; b: string }) => {
  const q = useQ();
  return (
    <Segment name="First" props={{ label: q.at("a"), on: q.lit("x") }}>
      <Toggle label={p.a} on={"x"} />
    </Segment>
  );
};
```

- props는 `p.이름`으로 읽는다 - prop 이름이 JS 예약어여도 부딪히지 않는다.
- 보간과 식 속성값은 `String(...)`으로 감싼다 - React는 boolean을 안 찍지만 qubb는 `"true"`를 찍는다.
- `class`는 `className`으로 낸다. 배열 class는 컴파일타임에 이어 붙인다(qubb와 같다).
- `==`/`!=`는 `===`/`!==`로 낸다(양쪽 타입이 같음을 codegen이 보장).

## 런타임 `quble-react` (`core/react`)

```ts
type TAddr                       // 주소. 루트 store 경로 또는 리터럴 값
type TQ = {
  emit(event: string, data: Record<string, unknown>, domEvent: Event): void;
  at(name: string, ...fields: string[]): TAddr;   // 내 prop 주소에서 내려간 주소
  lit(value: unknown): TAddr;                     // 리터럴 인자의 주소
};
useQ(): TQ
Segment({ name, props, children })   // 경로 마디 하나 + 자식 props 주소표
With({ name, value, children })      // context.<name> = value (같은 이름은 통째로 덮음)
QubleRoot({ component, initial, handlers })
```

- 상태는 루트 store 객체 하나다. `useSyncExternalStore`로 묶고, `set`은 경로를 따라 불변 갱신해
  루트부터 다시 그린다.
- 핸들러 ctx는 qubb와 같은 이름을 쓴다 - `get`, `set`, `props`, `store`, `context`, `event`.
  주소가 leafIndex 대신 경로라는 것만 다르다. `props.user.name`처럼 필드로 내려간다.
- 리터럴 인자의 주소는 `get`이 그 값을 내주고 `set`은 에러다.

## 검증

같은 fixture를 qubb 런타임과 React로 각각 jsdom에 그리고, 같은 클릭 순서와 같은 핸들러를 건 뒤
DOM(`innerHTML`)과 핸들러가 받은 인자(fullname, data, context)가 같은지 본다. React 산출 TSX는
테스트가 `typescript`의 `transpileModule`로 JS로 바꿔 싣는다.

## 범위

1. props, 텍스트/속성 식, events, `@with`, 합성, `@if`
2. `@for`(회차 마디 `[$N]`, `$N`), 배열 조작(`push`/`removeAt`/`setArray`/`swapAt`), `setObject`
3. 슬롯 - 슬롯 콘텐츠는 쓰는 쪽 경로로 해석되므로 쓰는 쪽의 `q`를 다시 깔아 준다
