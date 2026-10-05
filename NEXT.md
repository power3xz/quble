# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

통지 배치 1단계 (브랜치 `notify-batch`) - `leaf-store.ts`에 `batch(fn)` 경계와 통지 지연을 넣고,
핸들러 호출과 여러 칸을 쓰는 조작(`setObject`, `push`, `removeAt`)을 `batch`로 감싼다. 문제는
ISSUES.md "여러 칸을 쓰는 조작이 중간 상태를 통지한다", 식 쪽 설명은 core/web/EXPR-EVAL.md 8절.
구독 함수(`TSubscriber`)는 이번에 바꾸지 않는다.

측정 (core/web/EXPR-EVAL.md 7절, bench-expr/README.md):
- 변경 전 기준값을 구현 전에 먼저 재서 `bench-results/`에 남긴다(`./bench-expr-quick.sh`).
- 변경 후 같은 방법으로 재고 `node bench-compare.mjs expr <ref> <ref>`로 견준다.
- 배치를 쓰지 않는 경로(배치 밖의 `set`)에 `set` 안의 깊이 검사가 얹는 비용이 없는지 본다.
  mount와, 핸들러를 거치지 않는 `set` 반복을 재는 노드 미세 측정으로.
- 배치가 이득을 내는 장면(핸들러 하나가 여러 칸을 바꾸는 시나리오)이 기존 시나리오에 있는지 확인하고,
  없으면 하나 더한다.

남은 확인:
- 사용자 확인 - 브라우저에서 핸들러가 여러 칸을 바꾸는 화면이 이전처럼 도는지.

## 할 것

없음
