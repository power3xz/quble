# Issues

알려진 문제를 추적한다. 증상·재현만 적고 해결책은 정해지면 채운다(방법 미정이면 비워 둔다).

## 미해결

- **안 쓰는 `use`가 트리셰이킹 안 됨** — `use`로 import했지만 template에서 합성(RENDER)하지
  않는 컴포넌트가 qubb에 def로 포함된다. (재현: `bench/components/profilecard.qubc`의 `Tag`는
  use만 하고 미사용인데, 컴파일 결과 qubb에 def로 들어간다.) 컴파일러가 도달성 분석 없이 use된
  컴포넌트를 전부 방출하는 것으로 보인다.
