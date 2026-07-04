# 메모리 측정 노트

leaf-store의 배열 처리 논의 중, "배열 요소 많고 중첩 깊으면 pathCache 문자열 키가
메모리를 많이 먹지 않나"를 실측한 기록. 결론은 ISSUES.md("pathCache 문자열 키 메모리")에
정리했고, 여기엔 재실행법과 수치만 남긴다.

## pathcache-mem.mjs — pathCache(Map<path-string, leafIndex>) 비용

```
node --expose-gc bench/pathcache-mem.mjs
```

경로 개수를 키우며 세 방식을 비교한다:
- A. `Map<string, int>` (현재 방식)
- B. 문자열 키 배열만 (Map 오버헤드 제외)
- C. `Int32Array` (정수 leafIndex만 — 하한)

측정값 (Node 22):

| 경로 수 | A. pathCache | C. 정수만 |
|---|---|---|
| 50,000 | 1.75 MB | ~0 |
| 120,000 | 3.5 MB | ~0 |
| 1,200,000 | 56 MB | ~0 |

지배 요인은 문자열 길이가 아니라 **경로 개수**. 경로당 ~47B.

## dom-mem.mjs — 실제 DOM 노드 메모리 (headless Chrome renderer RSS)

```
node bench/dom-mem.mjs
```

Chrome.app을 `--headless=new`로 띄워 CDP(내장 WebSocket)로 div+텍스트 노드를 N개
붙이고, 렌더러 프로세스 RSS 증가를 잰다. `performance.memory`(JS 힙)엔 C++ DOM이 안
잡혀 RSS를 봐야 한다. macOS Chrome 경로가 스크립트 상단에 하드코딩돼 있다.

측정값:

| 요소 수 | 빈 페이지 대비 증가 | 요소당 |
|---|---|---|
| 10,000 | +27 MB | ~2.8 KB |
| 120,000 | +347 MB | ~3.0 KB |
| 500,000 | +1199 MB | ~2.5 KB |

## 결론

같은 규모에서 DOM이 leaf당 ~2.5KB로 pathCache(~47B)의 ~100배. 이만한 leaf를 실제로
렌더하면 DOM이 GB대가 되어 가상 스크롤이 강제되고, 그러면 살아있는 leaf는 화면분뿐이라
pathCache도 작다. pathCache 문자열 키 자체는 병목이 아니며, 진짜 문제는 회수 없는
누적(free-list 미구현)이다. — ISSUES.md 참고.
