# Storybook 실험

`.qubc` 컴포넌트를 qubb 런타임 그대로 Storybook(`@storybook/html-vite`)에 올리는 실험이다. React 산출을 거치지
않으므로 화면에 뜨는 것은 실제 qubb 런타임의 마운트와 갱신이다. 실험 코드라 `npm test`, 루트 typecheck, 머지
훅의 테스트에 들지 않는다(lint와 포맷은 루트 biome이 본다).

## 구조

| 자리 | 하는 일 |
|---|---|
| `qubc-plugin.ts` | vite 플러그인. `x.qubc?qubb` import를 quble 바이너리로 컴파일하고, 런타임 `compile` 결과를 default export한다. 스타일 리소스는 `?url`로 싣는다 |
| `stories/mount.ts` | story의 render. 컴포넌트를 마운트하고, 모든 fullname을 Actions 패널에 남긴 뒤 짝 핸들러를 부른다 |
| `stories/*.stories.ts` | story. `FileRow`는 playground 셸 컴포넌트를 Controls로, `Todo`는 짝 data와 핸들러로 띄운다 |
| `.storybook/main.ts` | 플러그인 등록과 레포 루트 파일 서빙 허용 |

의존 방향은 이 디렉터리에서 기존 코드 쪽으로만 난다. 생성물은 모두 `dist/`(gitignore)에 둔다. 걷어 낼 때는 이
디렉터리를 지우고 WORKSPACES.md experiments 목록에서 `storybook`을 빼면 된다.

## 실행

모두 레포 루트에서. `core/target/debug/quble`이 먼저 있어야 한다(`cargo build --manifest-path core/Cargo.toml --bin quble`).

- 의존: `npm install --prefix experiments/storybook`
- 개발 서버: `npm run storybook --prefix experiments/storybook` -> http://localhost:8151
- 정적 빌드: `npm run build --prefix experiments/storybook` -> `dist/storybook-static`
- 타입 검사: `npm run typecheck --prefix experiments/storybook`

## 쓰는 법

```ts
import TodoList from "../../../components/todo_list.qubc?qubb";
import { mount } from "./mount.ts";

export const Todo = { render: () => mount(TodoList, data, handlers) };
```

- `?qubb`를 붙인다. `.qubc` 옆에 생성되는 `.qubc.d.ts`(핸들러 타입)가 import 타입을 가리지 않게 하려는 것이다.
- args를 data로 넘기면 Controls로 props를 바꿀 때마다 다시 마운트한다. 이전 인스턴스는 `destroy`로 해체한다.
- 짝 핸들러는 ctx 타입을 직접 적은 것만 싣는다. ts-plugin이 타입을 주입해야 하는 핸들러 파일은 이 실험의 타입
  검사를 통과하지 못한다.

## 제약

- 감시는 그 `.qubc`와 그 파일이 `use`로 직접 부르는 파일까지다. 더 깊이 부르는 파일을 고치면 다시 컴파일하지
  않는다.

## 얻은 것

- **핸들러 표가 Actions 패널이 된다.** 어떤 fullname이 와도 받는 표를 넘기면 클릭마다 `[$0].DEL` 같은 경로와
  payload, context, 회차 번호가 남는다. 이벤트 경로가 맞는지를 눈으로 본다.
- **qubb 런타임이 Storybook의 html 렌더러와 바로 맞는다.** 마운트 결과가 DOM 노드라 render가 돌려주기만 하면
  된다. React 산출이나 별도 어댑터가 필요 없다.
