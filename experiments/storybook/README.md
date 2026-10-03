# Storybook 실험

`.qubc` 컴포넌트를 qubb 런타임 그대로 Storybook(`@storybook/html-vite`)에 올리는 실험이다. React 산출을 거치지
않으므로 화면에 뜨는 것은 실제 qubb 런타임의 마운트와 갱신이다. 실험 코드라 `npm test`, 루트 typecheck, 머지
훅의 테스트에 들지 않는다(lint와 포맷은 루트 biome이 본다).

## 구조

| 자리 | 하는 일 |
|---|---|
| `qubc-plugin.ts` | vite 플러그인. `x.qubc?qubb`는 컴파일된 컴포넌트로, `x.qubc`는 story 모듈로 바꾼다 |
| `stories/mount.ts` | story의 render. 컴포넌트를 마운트하고, 모든 fullname을 Actions 패널에 남긴 뒤 짝 핸들러를 부른다 |
| `.storybook/main.ts` | 지정 디렉터리의 `.qubc`를 story로 싣는 indexer, 플러그인 등록, 레포 루트 파일 서빙 허용 |
| `.storybook/preview.ts` | 전역 스타일(`core/web/styles`의 reset, global)을 싣고, Storybook 기본 여백(padded)을 뺀다 |

의존 방향은 이 디렉터리에서 기존 코드 쪽으로만 난다. 생성물은 모두 `dist/`(gitignore)에 둔다. 걷어 낼 때는 이
디렉터리를 지우고 WORKSPACES.md experiments 목록에서 `storybook`을 빼면 된다.

## 실행

모두 레포 루트에서. `core/target/debug/quble`이 먼저 있어야 한다(`cargo build --manifest-path core/Cargo.toml --bin quble`).

- 의존: `npm install --prefix experiments/storybook`
- 개발 서버: `npm run storybook --prefix experiments/storybook` -> http://localhost:8151
  - 띄울 디렉터리: `QUBLE_STORY_DIRS=components,core/playground npm run storybook --prefix experiments/storybook`.
    레포 루트 기준이고 쉼표로 나눈다. 안 주면 `components`다.
- 정적 빌드: `npm run build --prefix experiments/storybook` -> `dist/storybook-static`
- 타입 검사: `npm run typecheck --prefix experiments/storybook`

## 디렉터리의 .qubc를 story로

`QUBLE_STORY_DIRS`의 디렉터리에서 짝 data와 핸들러가 둘 다 있는 `*.qubc` 하나가 story 하나(`Default`)가 된다.
story 파일을 쓰지 않는다.

- 루트 컴포넌트는 그 파일의 첫 컴포넌트다(qubb ID 0).
- 짝 `x.data.json`을 args로 쓴다. Controls에서 고치면 이전 인스턴스를 `destroy`로 해체하고 다시 마운트한다.
- 짝 `x.qubc.handlers.ts`(또는 `.js`)를 싣는다. 생성된 story 모듈은 이 실험의 타입 검사 대상이 아니라, ts-plugin이
  타입을 주입하는 핸들러 파일도 실린다.
- 짝이 하나라도 없으면 싣지 않는다. data 없이 마운트하면 `@for`가 0회로 돌거나 빈 배열 인덱스 접근이 RangeError를
  내, 동작을 보여 주는 story가 되지 못한다.

## 제약

- 감시는 그 `.qubc`와 그 파일이 `use`로 직접 부르는 파일까지다. 더 깊이 부르는 파일을 고치면 다시 컴파일하지
  않는다.

## 얻은 것

- **핸들러 표가 Actions 패널이 된다.** 어떤 fullname이 와도 받는 표를 넘기면 클릭마다 `[$0].DEL` 같은 경로와
  payload, context, 회차 번호가 남는다. 이벤트 경로가 맞는지를 눈으로 본다.
- **qubb 런타임이 Storybook의 html 렌더러와 바로 맞는다.** 마운트 결과가 DOM 노드라 render가 돌려주기만 하면
  된다. React 산출이나 별도 어댑터가 필요 없다.
