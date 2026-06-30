# Quble for VSCode

Quble 컴포넌트 언어(`.qubc`) 신택스 하이라이팅.

## 지원 문법

- 키워드 `component` `props` `contexts` `events` `template` `use` `from`
- 디렉티브 `@with` `@if` `@else`
- DOM 이벤트 위임 `@click` `@input` `@change` `@submit` `@focus` `@blur` `@keydown` `@keyup` `@mousedown` `@mouseup` `@mouseenter` `@mouseleave` `@scroll`
- 합성·별칭 `Alias: Comp(...)`, 이벤트명(대문자 스네이크), 태그(소문자), 속성, 문자열, `{var}` 보간

## 핸들러 타입 생성

`*.qubc.handlers.ts`를 열거나 짝 `.qubc`를 저장하면, 확장이 짝 `x.qubc.d.ts`(`Handlers`
인터페이스)를 생성한다. handlers.ts가 이를 `import type`으로 받으면 TS가 키·payload·context를
타입으로 강제한다 - 잘못된 이벤트명은 컴파일 에러, payload 필드는 정확한 타입(리터럴은 그 값으로
좁힘), `params.context.<이름>.<필드>`까지 잡힌다.

```ts
// card.qubc.handlers.ts
import type { Handlers } from "./card.qubc";

const handlers: Handlers = {
  // 키를 치면 fullname 후보가 뜨고, 빠진 핸들러·없는 이벤트명을 TS가 잡는다.
  'MainThumb.CLICK_THUMBNAIL': (data, params) => {
    data.avatar;                    // string
    params.context.HoverArea.title; // 리터럴이면 그 값으로 좁혀짐
  },
};
export default handlers;
```

일부 이벤트만 처리하려면 `Partial<Handlers>`를 쓴다.

동작: 짝 `.qubc`를 컴파일러(`quble-bytecode`)로 qubb 바이트코드로 만들고, `disasm.js`의
`handlersDts`로 합성 트리를 걸어 `.d.ts` 텍스트를 산출한다. 생성된 `.d.ts`는 빌드 산출물이다
(gitignore - `.qubc`에서 언제든 재생성).

전제: 확장이 호출하는 컴파일러 바이너리가 빌드돼 있어야 한다.

```
cd proto && cargo build --bin quble-bytecode
```

개발 호스트로 띄워 시험하려면 레포 루트의 `run-extension.sh`를 쓴다(바이너리 빌드까지 함께 한다).

## 로컬 설치

확장 폴더에 심볼릭 링크를 건다:

```
ln -s "$(pwd)" ~/.vscode/extensions/quble
```

VSCode를 재시작하면 `.qubc` 파일에 하이라이팅이 적용된다.
