# Quble for VSCode

Quble 컴포넌트 언어(`.qubc`) 신택스 하이라이팅.

## 지원 문법

- 키워드 `component` `props` `contexts` `events` `template` `use` `from`
- 디렉티브 `@with` `@if` `@else`
- DOM 이벤트 위임 `@click` `@input` `@change` `@submit` `@focus` `@blur` `@keydown` `@keyup` `@mousedown` `@mouseup` `@mouseenter` `@mouseleave` `@scroll`
- 합성·별칭 `Alias: Comp(...)`, 이벤트명(대문자 스네이크), 태그(소문자), 속성, 문자열, `{var}` 보간

## 핸들러 이벤트 자동완성

`*.qubc.handlers.ts` 파일의 문자열 키 자리에서, 짝 `.qubc`가 발사하는 이벤트 fullname을
자동완성으로 제안한다(예: `card.qubc.handlers.ts` -> `card.qubc`).

```ts
// card.qubc.handlers.ts
const handlers = {
  'MainThumb.CLICK_THUMBNAIL': () => {},  // <- 문자열 안에서 후보가 뜬다
};
```

동작: 짝 `.qubc`를 컴파일러(`quble-bytecode`)로 qubb 바이트코드로 만들고, `disasm.js`로
합성 트리를 걸어 fullname을 산출한다. 따옴표 입력 또는 `Trigger Suggest`(Ctrl+Space)로 뜬다.

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
