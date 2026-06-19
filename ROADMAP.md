# ROADMAP

Quble의 피처 진행 상황을 도메인별로 묶었다. 각 피처의 상세 설계는 해결 과정에서
`docs/`에 문서로 생성하고 여기서 링크한다. (일상 리팩토링·네이밍 정리 등 개발 사이클에서
반복되는 작업은 로드맵에 넣지 않는다.)

확정 설계는 DESIGN.md, 바이트코드 명세는 proto/BYTECODE.md, 보류 아이디어는 IDEAS.md.

## 바이트코드 / 실행

- [x] 바이트코드 + VM 파이프라인 (compile → qubb → render)
- [x] SSR 렌더러 / 클라이언트 런타임 (같은 qubb 계약을 Rust·JS가 각각 해석)
- [x] 전역 상수풀 (흔한 속성명을 스펙 상수로 분리)

## 템플릿 / 렌더링

- [ ] `@for` — 반복. 지금 컴포넌트가 펼쳐지는 근본 원인 제거.
- [ ] `@if` / `@else` — 조건 분기.
- [ ] `{expr}` — 표현식 (JS 위임 여부 포함).

## 데이터

- [ ] 데이터 흐름 — provided/props, 반응성. 다른 피처의 전제. 모델: [REACTIVITY.md](REACTIVITY.md) (leafIndex·fullname으로 §5.1·§5.2·events를 꿴 결론).
  - [x] props 문자열 변수 1개 보간 (`{name}` → `TEXT_VAR`, `render(qubb, comp_id, scope)`)
  - [ ] props 객체 (여러 필드)
  - [ ] 반응성 (값 변경 시 DOM 갱신) — pub/sub, `set(leafIndex, v)`, Proxy 없는 정적 연결
  - [ ] 링킹 (전역 leafIndex 부여 — 페이지 단위)

## 합성 / 이벤트

- [ ] 합성 / 별칭 / 슬롯 — 컴포넌트 조합, fullname 경로 누적.
- [ ] contexts / events — 핸들러(fullname에 묶임), 이벤트 위임 (`action(EVENT, data)`). 모델: [REACTIVITY.md](REACTIVITY.md) §6·§7.

## 전송 / 보안

- [ ] 변조 감지 — SRI식 콘텐츠 해시 (전송 계층, 후순위).

## 개발 환경

- [x] 컴파일 바이너리 (`quble <qubc>` → dist/qubb)
- [x] bench 비교 환경 (qubb vs React lazy chunk 네트워크 비용)
