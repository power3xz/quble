# Quble for VSCode

Quble 컴포넌트 언어(`.qubc`) 신택스 하이라이팅.

## 지원 문법

- 키워드 `component` `props` `contexts` `events` `template` `use` `from`
- 디렉티브 `@with` `@if` `@else`
- DOM 이벤트 위임 `@click` `@input` `@change` `@submit` `@focus` `@blur` `@keydown` `@keyup` `@mousedown` `@mouseup` `@mouseenter` `@mouseleave` `@scroll`
- 합성/별칭 `Alias: Comp(...)`, 이벤트명(대문자 스네이크), 태그(소문자), 속성, 문자열, `{var}` 보간

## 핸들러 타입 생성

`*.qubc.handlers.ts`를 열거나 짝 `.qubc`를 저장하면, 확장이 짝 `x.qubc.d.ts`(`Handlers`
인터페이스)를 생성한다. handlers.ts가 이를 `import type`으로 받으면 TS가 fullname/payload/props/
context를 타입으로 강제한다 - 잘못된 이벤트명은 컴파일 에러, payload 필드는 정확한 타입(리터럴은
그 값으로 좁힘), `params.context.<이름>.<필드>`/`params.props.<이름>`까지 잡힌다. `props`는 값이
아니라 leafIndex(`LeafIndex<T>`)라 `get`/`set`으로 읽고 쓰고, 배열은 `push`/`removeAt`/`replace`로
다룬다(배열이 아닌 것을 넘기면 타입에서 걸린다). 객체 prop은 통째로가 아니라 필드마다 주소가
있어서 `set(props.ghost.style, ...)`처럼 마지막 필드까지 적어야 한다.

```ts
// card.qubc.handlers.ts
import type { Handlers } from "./card.qubc";

const handlers: Handlers = {
  // 키를 치면 fullname 후보가 뜨고, 빠진 핸들러/없는 이벤트명을 TS가 잡는다.
  'MainThumb.CLICK_THUMBNAIL': (data, { props, context, get, set }) => {
    data.avatar;                    // string (payload 값)
    context.HoverArea.title;        // 리터럴이면 그 값으로 좁혀짐
    set(props.avatar, get(props.name)); // props는 leafIndex - get/set으로 읽고 쓴다
  },
};
export default handlers;
```

일부 이벤트만 처리하려면 `Partial<Handlers>`를 쓴다.

동작: 짝 `.qubc`를 wasm 컴파일러가 AST에서 걸어 `.d.ts` 텍스트로 낸다(합성 트리로 fullname을
누적하고, props 이름은 바이트코드에 없어 소스에서 뽑는다). `use` 그래프는 확장이 읽어 함께
넘긴다 - wasm은 디스크를 안 보고 소스만 받는다. 생성된 `.d.ts`는 빌드 산출물이다
(gitignore - `.qubc`에서 언제든 재생성).

## 빌드와 설치

wasm 컴파일러를 만들고(한 번), 확장을 포장해 설치한다:

```
npm run build:wasm -w quble-wasm-compiler
npm run install-local -w quble-vscode
```

`install-local`은 번들(`dist/extension.js`)과 wasm을 묶어 `.vsix`로 포장한 뒤 `code
--install-extension`으로 설치한다. 배포될 모양 그대로라, 레포 밖에서도 도는지가 함께 확인된다.

고치고 다시 볼 때도 같은 명령을 쓴다(`--force`로 덮어쓴다). VSCode 창은 재시작해야 새
확장이 뜬다.
