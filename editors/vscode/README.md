# Quble for VSCode

Quble 컴포넌트 언어(`.qubc`) 신택스 하이라이팅.

## 지원 문법

- 키워드 `component` `props` `contexts` `events` `template` `use` `from`
- 디렉티브 `@with` `@if` `@else`
- DOM 이벤트 위임 `@click` `@input` `@change` `@submit` `@focus` `@blur` `@keydown` `@keyup` `@mousedown` `@mouseup` `@mouseenter` `@mouseleave` `@scroll`
- 합성/별칭 `Alias: Comp(...)`, 이벤트명(대문자 스네이크), 태그(소문자), 속성, 문자열, `{var}` 보간

## 핸들러 타입

`*.qubc.handlers.ts`에서 `export const handlers`를 선언하면 타입이 저절로 붙는다 - 파일에
`import`를 적지 않고, 디스크에 d.ts도 안 생긴다. TS가 fullname/payload/props/context를 타입으로
강제한다 - 잘못된 이벤트명은 컴파일 에러, payload 필드는 정확한 타입(리터럴은 그 값으로 좁힘),
`params.context.<이름>.<필드>`/`params.props.<이름>`까지 잡힌다. `props`는 값이 아니라
leafIndex(`LeafIndex<T>`)라 `get`/`set`으로 읽고 쓰고, 배열은 `push`/`removeAt`/`replace`로
다룬다(배열이 아닌 것을 넘기면 타입에서 걸린다). 객체 prop은 통째로가 아니라 필드마다 주소가
있어서 `set(props.ghost.style, ...)`처럼 마지막 필드까지 적어야 한다.

```ts
// card.qubc.handlers.ts - import 없음. 이름이 handlers면 짝 card.qubc의 타입이 붙는다.
export const handlers = {
  // 키를 치면 fullname 후보가 뜨고, 없는 이벤트명을 TS가 잡는다.
  'MainThumb.CLICK_THUMBNAIL': (data, { props, context, get, set }) => {
    data.avatar;                    // string (payload 값)
    context.HoverArea.title;        // 리터럴이면 그 값으로 좁혀짐
    set(props.avatar, get(props.name)); // props는 leafIndex - get/set으로 읽고 쓴다
  },
};
```

이벤트를 다 구현할 필요는 없다 - 쓰는 것만 적으면 된다.

동작: `editors/ts-plugin`이 TS Language Service plugin으로 tsserver 안에서 돈다. 짝 `.qubc`를
wasm 컴파일러가 AST에서 걸어 낸 d.ts를, 편집 중인 handlers.ts 스냅샷 앞에 얹고 `handlers`에
타입을 표기한다. tsserver만 그 스냅샷을 보고 디스크와 화면은 원본 그대로다. 확장이 하는 일은
plugin 등록과 wasm 경로 전달뿐이다.

에디터 밖(`tsc`, CI)에서는 타입이 안 붙는다 - plugin은 tsserver 안에서만 돈다.

## 빌드와 설치

확장은 워크스페이스 멤버가 아니다(포장이 루트 트리를 통째로 훑는 것을 막기 위해) - 이
디렉토리에서 따로 설치한다. wasm 컴파일러는 한 번만 만들면 된다:

```
npm run build:wasm -w quble-wasm-compiler   # 레포 루트에서
cd editors/vscode && npm install && npm run install-local
```

`install-local`은 번들(`dist/extension.js`), wasm, ts-plugin을 묶어 `.vsix`로 포장한 뒤 `code
--install-extension`으로 설치한다. 배포될 모양 그대로라, 레포 밖에서도 도는지가 함께 확인된다.

ts-plugin은 번들에 못 들어간다 - tsserver가 확장 루트의 `node_modules`에서 이름으로 찾아
`require`하므로 실물이 그 자리에 있어야 한다. `npm run build`가 거기에 놓는다.

고치고 다시 볼 때도 같은 명령을 쓴다(`--force`로 덮어쓴다). VSCode 창은 재시작해야 새
확장이 뜬다.
