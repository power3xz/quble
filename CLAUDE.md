# CLAUDE.md

## Communication Rules

응답, 문서, 주석, 커밋 메시지에 적용된다.

**한국어로 한다.** 응답만이 아니라 도구를 부르기 전에 적는 한 줄 설명, 생각, 작업 중간
보고까지 한국어다. 고유명사와 코드 식별자(`leafIndex`, `TLeafIndex<T>`, `@for`)는 원문
그대로 쓴다.

**핵심만 간략히.** 물은 것에 바로 답한다.

| O | X | 이유 |
|---|---|---|
| `안 됩니다. 세대는 removeAt이 런타임에 올려 컴파일러가 모릅니다.` | `안 됩니다. 방안이 셋 있습니다 - 1) 런타임 검사 2) 세대 필드 추가 3) 컴파일러 확장. 3을 권합니다.` | 고르지 않을 선택지까지 나열했다 |
| `컴파일타임에 걸립니다.` | `두 가지로 읽힙니다 - (a) 컴파일타임 (b) 런타임. (a)로 답하겠습니다.` | 답할 것 하나만 정해서 답하지 않았다 |
| `199개 통과, 실패 0.` | `테스트를 돌려 봤습니다. 결과를 정리하면 199개가 통과했고 실패는 없습니다.` | 답 앞에 서론을 붙였다 |
| `세대는 removeAt이 런타임에 올립니다.` | `세대는 removeAt이 런타임에 올립니다. 참고로 Rust 소유권 모델에서는 이런 경우를 선형 타입으로 다루는데...` | 필요하지 않은 설명까지 했다 |

**중의적으로 쓰지 않는다.** 한 문장이 두 가지로 읽히면 다시 쓴다.

- 부정문에서 무엇을 부정하는지 분명히 한다. "A거나 B는 아니다"처럼 걸치는 표현을 피한다.
- 열거는 항목 수와 경계를 분명히 한다. 뭉뚱그린 "등/같은"으로 끝내지 않는다.
- 이미 이 프로젝트에서 특정 뜻으로 쓰는 낱말(실물, 마디, 회차, 칸)을 다른 뜻으로 겹쳐
  쓰지 않는다.
- 기준을 말할 때는 그 기준이 어디서 판정되는지까지 적는다.

**은어로 줄이지 않는다.** 간결하게 쓰라는 것은 낱말을 은어로 바꾸라는 뜻이 아니다. 동작을
비유나 영어 직역으로 가리키면 짧아 보이지만 무엇이 무엇에 그랬는지가 빠져 읽는 쪽이 되묻게
된다. 주어와 대상을 갖춘 서술로 쓴다.

| O | X |
|---|---|
| `파서가 `.`을 읽어 소비한다` | `파서가 `.`을 먹는다` |
| `offset이 u8(255)를 넘는다` | `offset이 넘친다` |
| `cargo가 target/ 디렉터리를 잠근다` | `cargo가 락을 잡는다` |
| `프로세스가 cargo를 실행한다` | `cargo를 친다` |

### 표현 교정

한 번 지적된 표현은 여기 쌓는다. 응답, 문서, 주석 전부에 걸린다.

| O | X |
|---|---|
| `구별된다` / `나뉜다` / `달라진다` | `갈린다` |
| `leafIndex` | `칸` (leaf store 자리의 번호를 가리킬 때) |
| `leaf` | `칸` (leaf store의 자리나 그 값을 가리킬 때) |

## Read First (new session / after compact)

The docs below are authoritative and out-rank any conversation summary - when a summary and
a doc disagree, the doc wins. After a compact, re-check the relevant doc before acting on a
remembered claim (a past summary once mislabeled a DESIGN section - verify, don't inherit).

- **DESIGN.md** (Korean) - the agreed design as it stands now. Top authority. #4 is the live
  list of unresolved areas (no section numbers - entries come and go; cite them by title, and
  don't link to them from other docs). Read before contradicting any recorded decision -
  surface the tradeoff first.
- **DECISIONS.md** (Korean) - why each decision was made and what was rejected. No section
  numbers; cite by title. Read before re-proposing an approach - it may already be there with
  the reason it was dropped.
- **SYNTAX.md** - surface-syntax reference. The single source for grammar/directives; do not
  re-document syntax elsewhere.
- **REACTIVITY.md** - reactivity + handler model (store, `get`/`set`) - the settled conclusion.
- **ROADMAP.md** - feature progress by domain (what is done / in-flight / not started).
- **ISSUES.md** - known problems (symptom + repro; fix filled in once decided).
- **NEXT.md** - what is in flight, what to do next, and what is still undecided
  ("하는 중 / 할 것 / 정할 것"). Entries are removed once done. See _코드 작업에 착수할 때_ below.
- **WORKSPACES.md** - cargo/npm 워크스페이스 멤버와 의존, 빌드 산출물, 명령별 선행 조건.
- **COMMIT-RULES.md** - 커밋 메시지 규칙(타이틀만, 명사형 종결, 대시 뒤) - O/X 예시 표.
  커밋하기 전에 읽는다.
- **WRITING-CODE-RULES.md** - 코드 작성 순서(시그니처 합의, 확인 후 작성, 테스트까지가
  한 스텝). 코드를 쓰기 전에 읽는다.
- **COMMENT-GUIDELINES.md** - 주석 작성 가이드라인. 주석을 쓰기 전에 읽는다.
- **core/BYTECODE.md** - bytecode (qubb) format and opcode contract.
- **core/web/LEAF-STORE-LAYOUT.md** - 런타임 데이터 스토어 레이아웃 - 값이 store에 어떻게
  놓이고 요소가 늘고 줄 때 어떻게 변하는지. 계약이 아니라 현재 구현 설명이라 코드가 바뀌면
  따라 고친다.
- **PROCESS.md / IDEAS.md** - execution-model decisions / explored-and-parked ideas.

### 코드 작업에 착수할 때

착수 전에 아래를 정한다. 브랜치 판단과 NEXT.md 교체 둘 다 내가(Claude) 먼저 챙긴다 -
사용자가 시켜야 하는 일이 아니다. 단 **고치기 전에 무엇을 어떻게 바꿀지 말하고 승인을
받는다** - 알아서 고쳐 놓고 알리지 않는다.

- **브랜치를 딸지 main에서 작업할지 먼저 정한다.** 예상되는 작업을 나열해 세고, 커밋이
  3개 이상으로 예상되면 브랜치를 딴다(여러 파일/레이어를 순차로 고치거나 중간 커밋이
  미완결을 거치는 것). 나열한 수는 추정이라 해 보면 늘거나 준다 - 단정하지 않는다.
  규칙이 강제하는 것(NEXT.md 단독, 문서 정리 단독)부터 세면 최소치가 나온다.
  NEXT.md "하는 중" 교체는 그 브랜치의 첫 커밋이다.
- **NEXT.md는 단독으로 커밋한다.** 작업 커밋이나 다른 문서 정리에 묻어 보내지 않는다.
- 같은 일이 이어지는 동안은 건드리지 않는다 - 일의 종류가 바뀔 때만 고친다.
- "없음"으로 바꾸는 기준은 **내 확인이 끝나고 사용자의 확인까지 완료됐을 때**다. 둘 다여야
  한다 - 하나만으로는 안 바꾼다.
  - 내 확인: 그 작업이 노리던 곳에서 실제로 도는 걸 본다. 로컬 통과는 그 근거가 되지 못한다 -
    CI에 넣었으면 CI에서, 브라우저용이면 브라우저에서 본다.
  - 사용자 확인: 무엇을 어떻게 보면 되는지 적어 부탁하고, 됐다는 답을 받는다.
  확인이 남았으면 무엇이 남았는지 항목에 적고 그때까지 둔다.

### 주석을 작성할 때

COMMENT-GUIDELINES.md를 읽고 따른다.

### 사용자가 quble 변경점을 IDE나 브라우저에서 확인할 때

부탁하기 전에 **WORKSPACES.md의 "명령별 선행 조건" 표를 본다.** 컴파일러를 고쳤으면 그
산출물을 싣는 쪽이 먼저 최신이어야 한다 - 확장은 자기 wasm을, playground/preview는 자기
빌드를 쓴다. 안 챙기면 사용자가 옛 컴파일러의 결과를 보므로 확인 자체가 헛일이 된다.

사용자가 명령을 시켜서 실행할 때도 같다 - 시킨 명령을 그대로 치기 전에 그 명령의 선행 조건을
본다.

### 피처 브랜치를 main에 머지할 때

머지 훅이 `npm run lint`, `cargo test --workspace`, `cargo build --bin quble`, `build:wasm`,
`npm run typecheck`, `npm test`를 돌린다. 그중 포맷은 고치면 커밋이 생기므로 머지 전에
브랜치에서 돌리고 커밋한다.

- `.ts`/`.css`/`.json`을 만졌으면 `npm run format`.
- `.rs`를 만졌으면 `cargo fmt`.

## 커맨드 실행 규칙

논리적으로 나뉘는 작업은 커맨드도 따로 실행한다 - `&&`로 이어 붙이지 않는다. 이으면
어디서 실패했는지 흐려지고 중간에 결과를 보고 판단할 여지가 사라진다.

| O                                                       | X                                                 | 이유                                 |
| ------------------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| `git commit -m A` 실행 후 `git add x` `git commit -m B` | `git commit -m A && git add x && git commit -m B` | 나눈 커밋을 커맨드로 도로 묶음       |
| `git checkout -b foo` 실행 후 `git add x` `git commit`  | `git checkout -b foo && git add x && git commit`  | 브랜치 생성과 커밋은 별개 판단       |
| `cargo fmt` 결과 확인 후 `git add`                      | `cargo fmt && git add -A`                         | fmt가 무엇을 고쳤는지 안 보고 넘어감 |
| `git status && git log --oneline -3`                    | -                                                 | 조회는 이어도 된다                   |

**`cd`를 쓰지 않는다.** Bash 도구의 작업 디렉터리는 호출 사이에 유지되므로, `cd` 한 번이 그
뒤 모든 커맨드의 기준을 바꿔 놓는다. 커맨드는 레포 루트에서 실행하고, 다른 디렉터리를 봐야
하면 `cd` 대신 그 커맨드가 가진 경로 옵션으로 짚는다.

| O | X |
|---|---|
| `cargo test --workspace --manifest-path core/Cargo.toml` | `cd core && cargo test --workspace` |
| `npm test --prefix core/web` | `cd core/web && npm test` |
| `git -C editors/vscode status` | `cd editors/vscode && git status` |

cargo는 현재 디렉터리에서 위로 올라가며 `Cargo.toml`을 찾는데, 이 레포는 워크스페이스 루트가
`core/`라 레포 루트에서는 못 찾는다. `--manifest-path`가 없으면 "could not find `Cargo.toml`"로
실패한다.

**파일은 Edit 도구로 고친다.** `sed`, `python`, 셸 리다이렉트로 고치면 무엇이 어떻게
바뀌는지가 사용자에게 diff로 보이지 않아 한 줄씩 확인하고 거절할 수 없다. 여러 곳을 한 번에
바꿔야 해 스크립트가 필요하면, 먼저 무엇을 몇 곳 바꿀지 말하고 동의를 받는다.

| O | X |
|---|---|
| Edit로 블록을 지우고, Edit로 import 한 줄을 더한다 | `python3`로 블록을 잘라 내고 import를 끼워 넣는다 |
| `식별자 셋을 바꾸는데 12곳입니다. sed로 한 번에 바꿀까요?` 동의 후 `sed` | 묻지 않고 `sed -i`로 이름을 바꾼다 |

**`*`, `?`, `[]`가 든 인자는 따옴표로 감싼다.** 셸이 zsh다. bash와 달리 맞는 파일이 없으면
글롭을 그대로 넘기지 않고 `no matches found`로 커맨드 자체를 실행하지 않는다. 파일을 고르려는
글롭이 아니라 커맨드에 넘길 문자열이면 따옴표가 필요하다.

| O | X |
|---|---|
| `esbuild --external:svelte "--external:svelte/*"` | `esbuild --external:svelte --external:svelte/*` |
| `grep -rn "Expr::*" src` | `grep -rn Expr::* src` |
| `find . -name "*.qubc"` | `find . -name *.qubc` |

## 메모리 저장할 때

**스스로 저장하지 않는다.** 사용자가 저장하라고 할 때만 저장한다.

## Project Status

Past design-stage; implementation now lives in `core/`: a Rust compiler
(`core/crates/compiler`, `core/crates/bytecode`) that emits qubb bytecode, and a JS
runtime (`core/web/`) that decodes and renders it. DESIGN.md remains authoritative for
intent - `core/` is the tool that validates the design, not the source of truth. The
renderer (SSR) crate is parked (ISSUES.md).

## What This Project Is

A **frontend compile-to-bytecode language** for declaring UI components where the compiler
statically analyzes the _composition context_ (where a component is used and under what
alias) to auto-generate fully-qualified event identifiers.

The core idea: a component declares abstract events without knowing its own name in the
tree. Its concrete identity is fixed at the point of use. The compiler walks the
composition tree and produces a **fullname** event id by accumulating alias/type-name path
segments from the outside (use-site) inward. A handler catches that fullname. The
motivation (vs. TypeScript types) is eliminating the manual path-accumulation boilerplate
that explodes as the tree deepens (#1.4).
