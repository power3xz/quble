# ROADMAP

Quble의 피처 진행 상황을 도메인별로 묶었다. 각 피처의 상세 설계는 해결 과정에서
`docs/`에 문서로 생성하고 여기서 링크한다. (일상 리팩토링·네이밍 정리 등 개발 사이클에서
반복되는 작업은 로드맵에 넣지 않는다.)

확정 설계는 DESIGN.md, 바이트코드 명세는 proto/BYTECODE.md, 보류 아이디어는 IDEAS.md.

## 바이트코드 / 실행

- [x] 바이트코드 + VM 파이프라인 (compile -> qubb -> render)
- [x] SSR 렌더러 / 클라이언트 런타임 (같은 qubb 계약을 Rust·JS가 각각 해석)
- [ ] 실행 재개 (resume, ≈hydration) — 클라가 SSR이 만든 HTML을 새로 만들지 않고, 기존
  노드에 구독·핸들러만 붙여 SSR이 멈춘 실행을 이어받는다. region anchor 주석(`<!--qb:region#N-->`)이
  결합 지점 단서일 수 있다(방법 미정).
- [x] 전역 상수풀 (흔한 속성명을 스펙 상수로 분리)

## 템플릿 / 렌더링

- [ ] `@for` — 반복. 지금 컴포넌트가 펼쳐지는 근본 원인 제거.
- [x] `@if` / `@else` — 조건 분기. 클라 region/branch swap + 비활성 가지 lazy build(REACTIVITY.md §8).
  중첩·형제·else 없는 if, 합성 경계를 넘는 if(RENDER 인라인 재진입으로 자식 if가 부모 region 트리에 합류)까지. (SSR은 분기 평가 후 활성 가지만 렌더.)
- [ ] `{expr}` — 표현식 (JS 위임 여부 포함). 지금은 단순 변수 참조만.
- [ ] 컴포넌트 스타일링 — 외부 CSS를 어떻게 표현·격리할지(DESIGN.md 부록 B가 `import styles
  from "...module.css"` + `class=[...]`를 예시). 선결: 외부 CSS 파일을 qubb에 어떻게 담을지
  (밖에 두고 클래스명만 / 인라인 / 둘 다), 격리 방식, 동적 class 배열의 바이트코드 표현. 방법 미정.

## 데이터

- [ ] 데이터 흐름 — provided/props, 반응성. 다른 피처의 전제. 모델: [REACTIVITY.md](REACTIVITY.md) (leafIndex·fullname으로 §5.1·§5.2·events를 꿴 결론).
  - [x] props 변수 보간 — 텍스트(`{name}` -> `TEXT_VAR`)·속성(`class={x}` -> `ATTR_*_VAR`). 같은 scope offset 공간.
  - [x] 반응성 (값 변경 시 DOM 갱신) — pub/sub, `set(leafIndex, v)`, 구독자=함수, Proxy 없음. 텍스트·속성·공유 검증.
  - [ ] props 객체 (여러 필드 — store 객체를 path로 lazy resolve, 부분 적용)
  - [ ] leafIndex 할당기 / free list (지금은 증가만 — `@for`에서 회수 필요)

## 합성 / 이벤트

- [x] 합성 — 컴포넌트 호출(`Comp(p={var})`), 다중 정의, use-site 바인딩(`PUSH_ARG`+`RENDER`로 부모->자식 path 전달). 공유 검증.
- [ ] 별칭 / 슬롯 / fullname — 별칭 붙여 분리, `{}` 슬롯, 경로 누적 식별자.
- [ ] contexts / events — 핸들러(fullname에 묶임), 이벤트 위임 (`action(EVENT, data)`). 모델: [REACTIVITY.md](REACTIVITY.md) §6·§7.

## 전송 / 보안

- [ ] 변조 감지 — SRI식 콘텐츠 해시 (전송 계층, 후순위).

## 개발 환경

- [x] 컴파일 바이너리 (`quble <qubc>` → dist/qubb)
- [x] bench 비교 환경 (qubb vs React lazy chunk 네트워크 비용)
- [x] qubb 인스펙터 — qubb를 qubc로 디컴파일 + 컴포넌트 선택·arg 입력으로 실시간 렌더 (IDEAS.md 컴포넌트 뷰어)
