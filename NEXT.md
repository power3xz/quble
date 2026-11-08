# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

식 인스턴스의 첫 평가가 throw할 때 정리 (`core/web/expr-layer.ts`, `core/web/vm.ts`)
- 공유 맵에 고아 인스턴스가 남아 다음에 고르면 `undefined`를 값으로 받는다 - `evaluate`가 성공한 뒤 `markShared`
- 입력을 연결하던 중 throw하면 연결한 입력 인스턴스가 해제되지 않는다 - `inputInstances`를 미리 두고 연결하는 대로 채움
- 결과가 NaN이면 다시 셀 때마다 write와 notify가 일어난다 - `Object.is`로 비교

## 할 것

- 삼항 경로 최적화 두 가지 - 삼항 `readLeaves`를 [cond, 참 갈래, 거짓 갈래] 고정 자리로, 공유 이득이 없는 갈래를
  삼항 인스턴스 안에서 셈
