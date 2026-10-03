# canvas 렌더 실험

quble 런타임을 고치지 않고 DOM 대신 canvas에 그릴 수 있는지 본 실험이다. 결론과 얻은 것을 남긴다. 실험
코드라 `npm test`, 루트 typecheck, 머지 훅의 테스트에 들지 않는다(lint와 포맷은 루트 biome이 본다). 자기
`package.json`과 `node_modules`(jsdom, vite)를 갖는다. 의존 방향은 이 디렉터리에서 기존 코드 쪽으로만 나므로,
걷어 낼 때는 이 디렉터리를 지우고 WORKSPACES.md experiments 목록에서 `canvas`를 빼면 된다.

## 구조

런타임은 전역 `document`로 노드를 만들고 붙인다. 그 자리에 DOM API 일부만 흉내 낸 장면 트리를 넣으면 런타임이
그 트리를 짓고 갱신한다. 렌더러가 트리를 레이아웃해 canvas에 그린다.

| 파일 | 하는 일 |
|---|---|
| `scene.ts` | 장면 트리. 런타임이 쓰는 DOM API(노드 생성, 붙이고 떼기, 속성과 텍스트, document 리스너)만 흉내 낸다 |
| `css.ts` | CSS 부분 해석. 선택자를 트리 요소에 맞추고 선언을 레이아웃 스타일로 옮긴다 |
| `layout.ts` | block, inline, flex(row), grid 배치. 바뀐 상자만 다시 잰다 |
| `render.ts` | 바뀐 프레임에 레이아웃하고 보이는 상자만 그린다. 클릭은 hit test 뒤 document로 보낸다 |

데모는 `demo/`다. bench-expr의 주문 목록을 런타임을 Worker에서 돌려 OffscreenCanvas에 그린다. bench-expr DOM
페이지와 같은 `.qubb`, 핸들러, `style.css`를 쓴다. 브라우저의 `document`는 바꿔 끼울 수 없어 Worker에서 돌린다.

## 실행

모두 레포 루트에서.

- 의존: `npm install --prefix experiments/canvas`
- 테스트: `npm test --prefix experiments/canvas`. `scene.test.ts`는 같은 컴포넌트를 jsdom과 장면 트리에서 지어
  결과를 견준다(`core/target/debug/quble`이 필요하다).
- 타입 검사: `npm run typecheck --prefix experiments/canvas`
- 데모: `experiments/canvas/demo.sh` -> http://localhost:8149/?n=10000

## 얻은 것

- **런타임이 화면에 기대는 범위가 작다.** 흉내 낸 DOM API 몇 가지만으로 런타임이 그대로 돈다. 암묵적인 이
  경계를 호스트 인터페이스로 꺼낼 수 있다.
- **대량 목록 메모리의 대부분은 DOM과 브라우저 레이아웃 몫이다.** canvas 버전은 그 몫이 사라져 힙이 크게
  줄었고, 대신 장면 트리와 레이아웃 상자가 JS 객체로 는다. 런타임 자신의 배열과 객체를 줄이는 일보다 DOM 노드
  수를 줄이는 일(가상 스크롤 등)이 이 규모에서는 이득이 크다.
- **세밀한 변경 알림이 아래 단계까지 이득을 준다.** 런타임이 텍스트 노드 하나, 속성 하나 단위로 바꾸므로
  레이아웃도 바뀐 상자만 다시 재고 스타일도 바뀐 요소만 다시 구한다.
- **이벤트 위임이 호스트 교체를 막지 않는다.** 런타임이 document 하나에서 이벤트를 받아 parentNode로 바인딩을
  찾으므로, 이벤트 출처를 hit test로 바꿔도 런타임은 그대로다.
- **결합 지점 셋이 드러났다.** 런타임이 전역 `document`를 직접 쓴다(주입할 길이 없다). 핸들러에 DOM 이벤트
  객체가 `ctx.event`로 넘어간다. 스타일 리소스(`LOAD_RES`)가 `<link>`를 head에 넣는다.

## 속도

그리기는 보이는 상자만 해서 싸다. 비용은 레이아웃이고, 모든 행이 바뀌는 갱신에서는 DOM 버전보다 느리거나
비슷했다. 브라우저 레이아웃은 C++로 다듬은 것이라 JS 레이아웃이 따라가기 어렵다. 한 행만 바뀌는 갱신은 바뀐
행과 그 조상만 다시 재서 빠르다.

## 한계

- CSS는 이 데모가 쓰는 속성만 구현했다(`css.ts` 머리 주석). 글꼴과 줄 높이는 CSS에서 읽지 않고 데모가 준다.
- 한 줄 텍스트만 그린다. 줄바꿈, 입력과 IME, 텍스트 선택, 포커스, 접근성이 없다.
- 이벤트는 click만 전하고, 이벤트 객체는 `{ type, target }`뿐이다.
- 조상의 속성에 따라 달라지는 스타일(`.a[x] .b`)은 조상이 바뀌어도 다시 구하지 않는다.

## 이어 볼 것

- 장면 트리 위에서 런타임을 돌리고 `toHTML`로 직렬화하면 클라이언트와 같은 코드로 서버 렌더가 된다. 보류 중인
  SSR renderer(ISSUES.md)의 대안이다. hydration은 따로다.
- 단위 테스트가 jsdom 대신 장면 트리를 쓰면 빨라질 수 있다. 테스트가 쓰는 조회 API를 더 흉내 내야 한다.
