# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

해석기가 `vm.regionPool`/`vm.branchPool`을 직접 읽고 쓰지 않게 정리 (브랜치 `vm-region-access`).
`regionAt`/`branchAt` 접근자를 더하고, 두 해석기의 `buildIfRegion`에서 공통부를 VM의
`openIfRegion`으로 옮긴다. 초기 가지를 만드는 부분만 해석기에 남는다.

## 할 것

없음
