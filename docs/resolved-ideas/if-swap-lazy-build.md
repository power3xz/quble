# @if swap 시 비활성 가지 lazy build (클라 region)

-> **구현 완료. 확정 설계는 REACTIVITY.md #8.** 아래는 도입 당시 설계 메모(기록 보존).

클라 런타임에서 `@if`는 한 자리(Region)에서 두 가지 중 하나만 보인다. 비활성 가지는 "안 보이는
노드 0 비용"을 위해 build(노드/구독)를 미뤄야 한다(skip). 그러면 나중에 cond가 바뀌어 swap할 때
그 가지를 처음 build해야 하는데 - **최초 인스턴스화 루프는 끝나 스택 문맥이 사라진 상태**다.

**핵심:** swap build에는 전체 스택 복원이 필요 없다. 그 가지부터 아래로만 새로 자라므로,
**시작 Branch + 코드 범위(startPc~endPc)** 두 가지만 있으면 된다. 인스턴스화 루프를 재사용
가능하게 만든다:

```
interpret(startPc, endPc, regionIndex, branchIndex)
  // 시작 가지를 받아 start~end 해석. 한 호출 = 한 가지.
  // 최초 인스턴스화: interpret(0, len, 0, THEN_INDEX)
  // swap build:     interpret(가지start, 가지end, regionIndex, branchIndex)
  // 중첩 if는 재귀 호출 - JS 호출 스택이 수동 region/branch 스택을 대신한다.
```

**코드 범위는 마커로 이미 표시돼 있다** - then = IF다음~ELSE, else = ELSE다음~IF_END. 추가 마커
불필요(점프/길이 operand는 우리가 거부한 것). 단 IF 진입 시점엔 ELSE/IF_END 위치를 아직 모르므로,
비활성 가지를 **skip_branch(depth 카운팅, SSR renderer와 같은 패턴)로 건너뛰면서 경계 위치를
구한다**.

비활성 가지 안의 **중첩 if**는 skip돼 region이 안 생긴다 -> 그 가지를 swap으로 처음 build할 때
비로소 생성된다("런타임 생성 + 제거 없음, append만"과 일관).

검증 순서: (1) 스킵 없는 버전(양쪽 다 build, IF_END에서 비활성 구독 해제)으로 뼈대 확인 ->
(2) cond 변경 swap 동작 확인 -> (3) skip + lazy build 도입. **(1)/(2)/(3) 모두 완료**
(`core/web/runtime-interpreter.ts` 해석, `region.ts`, 테스트는 `if-integration.test.ts`로 이관).
