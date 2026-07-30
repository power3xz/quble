# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Response Style

핵심만 간략히. 서론/중복/안 할 선택지 나열 금지.

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
- **core/BYTECODE.md** - bytecode (qubb) format and opcode contract.
- **PROCESS.md / IDEAS.md** - execution-model decisions / explored-and-parked ideas.

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
