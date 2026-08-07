# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Writing Style

응답, 문서, 주석, 커밋 메시지 - 내가 쓰는 모든 글에 적용된다.

핵심만 간략히. 서론/중복/안 할 선택지 나열 금지.

**중의적으로 쓰지 않는다.** 한 문장이 두 가지로 읽히면 다시 쓴다.

- 부정문에서 무엇을 부정하는지 분명히 한다. "A거나 B는 아니다"처럼 걸치는 표현을 피한다.
- 열거는 항목 수와 경계를 분명히 한다. 뭉뚱그린 "등/같은"으로 끝내지 않는다.
- 이미 이 프로젝트에서 특정 뜻으로 쓰는 낱말(실물, 마디, 회차, 칸)을 다른 뜻으로 겹쳐
  쓰지 않는다.
- 기준을 말할 때는 그 기준이 어디서 판정되는지까지 적는다.

## Read First (new session / after compact)

The docs below are authoritative and out-rank any conversation summary - when a summary and
a doc disagree, the doc wins. After a compact, re-check the relevant doc before acting on a
remembered claim (a past summary once mislabeled DESIGN #5.1 - verify, don't inherit).

- **DESIGN.md** (Korean) - the agreed design: decisions, rejected alternatives, and their
  rationale (#4). Top authority. #5 is the live list of unresolved areas - read it there,
  don't rely on a summary. Read before contradicting any recorded decision - surface the
  tradeoff first.
- **SYNTAX.md** - surface-syntax reference. The single source for grammar/directives; do not
  re-document syntax elsewhere.
- **REACTIVITY.md** - reactivity + handler model (store, `get`/`set`) - the settled conclusion.
- **ROADMAP.md** - feature progress by domain (what is done / in-flight / not started).
- **ISSUES.md** - known problems (symptom + repro; fix filled in once decided).
- **NEXT.md** - what is in flight, what to do next, and what is still undecided
  ("하는 중 / 할 것 / 정할 것"). Entries are removed once done. See *NEXT.md 갱신* below.
- **WORKSPACES.md** - cargo/npm 워크스페이스 멤버와 의존, 빌드 산출물, 명령별 선행 조건.
- **core/BYTECODE.md** - bytecode (qubb) format and opcode contract.
- **core/web/LEAF-STORE-LAYOUT.md** - 런타임 데이터 스토어 레이아웃 - 값이 store에 어떻게
  놓이고 요소가 늘고 줄 때 어떻게 변하는지. 계약이 아니라 현재 구현 설명이라 코드가 바뀌면
  따라 고친다.
- **PROCESS.md / IDEAS.md** - execution-model decisions / explored-and-parked ideas.

### NEXT.md 갱신

NEXT.md는 "하는 중 / 할 것 / 정할 것" 세 섹션이고, 항목은 섹션 사이를 옮겨 다닌다.
갱신은 내가(Claude) 먼저 챙긴다 - 사용자가 시켜야 하는 일이 아니다. 단 **고치기 전에
무엇을 어떻게 바꿀지 말하고 승인을 받는다** - 알아서 고쳐 놓고 알리지 않는다.

- **NEXT.md는 단독으로 커밋한다.** 작업 커밋이나 다른 문서 정리에 묻어 보내지 않는다 -
  항목을 옮기고 지우는 건 완료를 확인한 뒤의 별도 행위다.
- 작업에 착수하면 그 항목을 "할 것"에서 "하는 중"으로 옮긴다. 같은 일이 이어지는 동안은
  건드리지 않는다 - 일의 종류가 바뀔 때만 고친다.
- 작업이 끝나면 "하는 중"에서 지운다. 완료 표시를 남기지 않는다(진행 기록은 ROADMAP,
  문제는 ISSUES 소관). 지우는 기준은 **그 작업이 노리던 곳에서 실제로 도는 걸 봤을 때**다.
  로컬 통과는 그 근거가 되지 못한다 - CI에 넣었으면 CI에서, 브라우저용이면 브라우저에서
  본다. 확인이 남았으면 무엇이 남았는지 항목에 적고 그때까지 둔다.
- 새 항목은 착수 조건이 다 됐으면 "할 것", 지금 정할 수 없으면 "정할 것"에 넣는다.
- 본문을 옮겨 적지 말고 원문(ISSUES/ROADMAP/DESIGN)을 가리킨다. 아직 안 들어간 영역은
  "무엇을 정해야 하는지"까지만 - 방법을 미리 적으면 방향을 가둔다.

## Project Status

Past design-stage; implementation now lives in `core/`: a Rust compiler
(`core/crates/compiler`, `core/crates/bytecode`) that emits qubb bytecode, and a JS
runtime (`core/web/`) that decodes and renders it. DESIGN.md remains authoritative for
intent - `core/` is the tool that validates the design, not the source of truth. The
renderer (SSR) crate is parked (ISSUES.md).

## What This Project Is

A **frontend compile-to-bytecode language** for declaring UI components where the compiler
statically analyzes the *composition context* (where a component is used and under what
alias) to auto-generate fully-qualified event identifiers.

The core idea: a component declares abstract events without knowing its own name in the
tree. Its concrete identity is fixed at the point of use. The compiler walks the
composition tree and produces a **fullname** event id by accumulating alias/type-name path
segments from the outside (use-site) inward. A handler catches that fullname. The
motivation (vs. TypeScript types) is eliminating the manual path-accumulation boilerplate
that explodes as the tree deepens (#1.4).

## Architecture Concepts (from DESIGN.md)

Load-bearing invariants any implementation must preserve:

- **Two orthogonal axes - never mix them.** *Path* (who fired the event) accumulates
  aliases/type-names into the fullname identifier. *Context* (`@with` blocks) injects
  metadata delivered to handlers keyed by context name - it is **never** part of the path
  (#1.2, #4.2). (Context delivery to handlers is implemented; see the `context` handler arg.)
- **Fullnames only, no tail-matching.** Event ids always reflect the complete tree
  position. Short-name matching was rejected because it makes the same handler name valid
  in one tree state and invalid in another, breaking compile-time predictability (#4.1). DX
  of long names is solved by tooling, not by language rules.
- **Same fullname = intentional sharing.** Reusing the same un-aliased type as siblings
  produces the same fullname on purpose. Adding an alias is the explicit act of separating;
  omitting it is the explicit act of grouping (#1.3, #3.2).
- **Handlers are a single entry point** for state change (`get`/`set`) and navigation
  (`goTo`) - not plain callbacks (#2.5). What a handler may `set` is still being settled
  (ISSUES.md, tied to the reactivity model).

## Anticipated Change Points (quble)

For the global *Anticipated Change Points* exception (in `~/.claude/CLAUDE.md`), DESIGN.md
is this project's "committed design source": a change recorded there counts as committed,
not hypothetical. The typical seam is the **bytecode contract** - opcodes and their
operands (opcode.rs <-> runtime.js <-> disasm.js). When DESIGN.md commits to a feature whose
only clean landing spot is a new opcode or operand, adding that opcode now - even before
the feature fully lands - localizes the future edit and avoids re-touching the operand
format and every decoder later. Speculative flexibility for undesigned features is not.
