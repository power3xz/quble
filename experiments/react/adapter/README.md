# React 어댑터 (실험)

`.qubc`를 컴파일한 바이트코드(qubb)를 React 컴포넌트로 그린다. 프레임워크별 코드 생성 대신 바이트코드
하나를 낳고, 프레임워크마다 얇은 어댑터가 그것을 mount한다. 이 디렉터리는 React 어댑터다.

## 설정

Vite 플러그인을 등록한다. `.qubc` import를 `TQubleBytecode` 모듈로 바꾸고, `use`한 CSS는 번들러 import로 넘긴다.

```ts
// vite.config.ts
import { quble } from "./adapter/vite-plugin.ts";

export default defineConfig({ plugins: [react(), quble()] });
```

`.qubc` 모듈의 타입은 `qubc.d.ts`(`declare module "*.qubc"`)가 선언한다.

## 사용

```tsx
import { createComponent } from "quble/react";
import OrdersBytecode from "./orders.qubc";

// 모듈 최상위에서 한 번만 만든다. 렌더마다 만들면 컴포넌트 타입이 바뀌어 매번 다시 mount한다.
const Orders = createComponent(OrdersBytecode);

<Orders {...data} handlers={{ RATE: (payload, { update }) => update({ rate: payload.nextRate }) }} />;
```

- props는 루트 props 데이터다. 직렬화할 수 있는 값이어야 한다(바뀌었는지를 JSON으로 견준다).
- 같은 import를 React 없이 `mount(OrdersBytecode, container, { data, handlers })`로도 그릴 수 있다.
- `<div>` 하나를 렌더해 그 안에 mount한다.

## props 변경

처음 렌더에서 한 번 mount하고, 이후 props 내용이 바뀌면 바뀐 최상위 prop만 `inst.update(changed, "replace")`로
갱신한다. 다시 mount하지 않으므로 DOM은 유지된다. 이전 렌더에 있던 prop이 빠져도 갱신하지 않는다
(루트 props는 모두 필수다).

## 핸들러

- 예약 prop `handlers`로 받는다. 키는 fullname이다(예: `RATE`, `[$0].INC`).
- 마운트할 때의 맵을 쓴다. 맵 객체가 바뀌어도 반영하지 않는다.
- 컨텍스트의 `update(values, mode = "merge")`로 루트 prop을 갱신한다.
  - 스칼라는 값을 기록하고, 배열은 통째로 교체한다.
  - 객체는 `"merge"`면 준 필드만 바꾸고, `"replace"`면 안 준 필드를 `undefined`로 만든다.
  - 루트에 없는 이름은 이름을 담은 예외를 throw한다.
- 배열 요소 안의 필드는 루트 prop이 아니므로 `update`로 못 바꾼다. `set`/`setObject` 등 기존 컨텍스트를 쓴다.
- 핸들러가 store를 직접 고친 값은 React props에 반영되지 않는다. React의 props가 바뀔 때까지 quble 쪽
  값이 유지된다.

## 타입

플러그인이 `.qubc`를 불러올 때 그 옆에 `x.qubc.d.ts`를 쓴다(내용이 같으면 다시 쓰지 않는다. `.gitignore` 대상).
컴파일러가 낸 핸들러 맵 타입(`THandlers`)을 `TQubleBytecode<THandlers>`로 싣고, `createComponent`가 거기서
다음을 추론한다.

- props 이름과 값 타입
- `handlers`의 키와 payload, 컨텍스트 타입, 컨텍스트에 더해지는 `update`의 값 타입

제약:

- 핸들러가 하나도 없는 컴포넌트는 루트 props를 알 수 없어 props가 `Record<string, unknown>`으로 느슨하다.
- 순수 `mount`의 `handlers`에는 이 추론이 붙지 않는다.
- `update` 타입은 이 어댑터에만 있다. 컴파일러가 내는 d.ts에는 아직 없다.

## 정해지지 않음

- 래퍼 `<div>` 없이 부모 바로 아래에 그리는 방법
- 핸들러 규약(콜백 props, 최신 `handlers` 위임)
- `update`의 컴파일러 d.ts 타입

## 실행

```
npm run adapter-demo --prefix experiments/react   # http://localhost:8153
npm test --prefix experiments/react               # adapter/*.test.ts 포함
```

`npm test`는 `runtime/parity.test.ts`의 SSR 케이스 28개가 어댑터와 무관하게 실패한다.
