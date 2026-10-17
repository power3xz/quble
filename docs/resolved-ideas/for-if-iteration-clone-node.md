# `@for`/`@if` 회차 뼈대 cloneNode

-> **구현 완료.** 구현은 `core/web/runtime-interpreter.ts`의 `templatePlanOf`/`cloneTemplate`(뼈대와 값 자리 목록)이고
별도 확정 설계 문서는 없다. 아래는 도입 당시 설계 메모(기록 보존).

경계(if/for) 사이 구간은 요소 구조가 회차 불변이고 값(TextVar)만 바뀐다. 회차마다
opcode를 재해석해 노드를 새로 조립하는 대신, 뼈대를 한 번 만들어 cloneNode로 복제하고
가변 지점만 채우는 여지. 대량 반복에서 DOM 생성(create+append)이 지배적이라 그 부분을
겨냥. 가변 지점 추적/중첩 경계 분리/구독 배선 유지가 얽혀 기본 기능 완성 후 검토.
[[정적-서브트리-innerHTML]]과 겨루는 대안.
