# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

This is a **design-stage project** - there is no code, build system, or tests yet. The
repository currently contains only `DESIGN.md` (written in Korean), which records the
agreed-upon design of the language. Before doing implementation work, read `DESIGN.md`
in full; it is the authoritative source and documents not just decisions but the
rejected alternatives and their rationale (§4). Do not contradict a recorded decision
without surfacing the tradeoff first.

## What This Project Is

A **frontend compile-to-JS language** for declaring UI components where the compiler
statically analyzes the *composition context* (where a component is used and under what
alias) to auto-generate fully-qualified event identifiers.

The core idea: a component declares abstract events without knowing its own name in the
tree. Its concrete identity is fixed at the point of use. The compiler walks the
composition tree and produces a **fullname** event id by accumulating alias/type-name
path segments from the outside (use-site) inward.

```
CompleteButton: Button(@click:TOGGLE)   // alias at use-site
  → 'MyTodoCard.TodoItem.CompleteButton.TOGGLE'   // handler catches this fullname
```

The motivating justification for a new language (vs. TypeScript types) is eliminating
the manual path-accumulation boilerplate that explodes as the composition tree deepens
(§1.4).

## Architecture Concepts (from DESIGN.md)

These are the load-bearing invariants any implementation must preserve:

- **Two orthogonal axes - never mix them.** *Path* (who fired the event) accumulates
  aliases/type-names into the fullname identifier. *Context* (`@with` blocks) injects
  metadata that is delivered via `provided` keyed by context name - it is **never** part
  of the path (§1.2, §4.2).
- **Fullnames only, no tail-matching.** Event ids always reflect the complete tree
  position. Short-name matching was explicitly rejected because it makes the same
  handler name valid in one tree state and invalid in another, breaking compile-time
  predictability (§4.1). DX of long names is solved by tooling (autocomplete, event
  catalog, unhandled-event warnings), not by language rules.
- **Same fullname = intentional sharing.** Reusing the same un-aliased type as siblings
  produces the same fullname on purpose - a declaration to handle them with one handler.
  Adding an alias is the explicit act of separating; omitting it is the explicit act of
  grouping (§1.3, §3.2).
- **Instance identity lives in `provided`.** `@for` items, duplicated un-aliased
  siblings, and any other instances sharing a fullname are all the *same problem* and are
  distinguished only through `provided`, never through handler names (§3.3).
- **Handlers are a single entry point** for state change (`get`/`set`) and navigation
  (`goTo`) - not plain callbacks. `data` and `provided` types are compiler-generated from
  the `events` schema bound to the fullname (§2.5).

## Anticipated Change Points (quble)

For the global *Anticipated Change Points* exception (in `~/.claude/CLAUDE.md`), DESIGN.md
is this project's "committed design source": a change recorded there counts as committed,
not hypothetical. The typical seam here is the **bytecode contract** - opcodes and their
operands (opcode.rs ↔ runtime.js ↔ disasm.js ↔ renderer). When DESIGN.md commits to a
feature whose only clean landing spot is a new opcode or operand, adding that opcode now -
even before the feature fully lands - localizes the future edit and avoids re-touching the
operand format and every decoder later. That is allowed; speculative flexibility for
undesigned features is not.

## Language Surface

Component blocks: `props`, `contexts`, `events` (name + payload schema), `template`.
Template directives: `Alias: Component(...)` (compose + alias), `@with Context { }`,
`@if/@else`, `@for`, `@click:EVENT` (delegate DOM → component event), `>>` (slot),
`{expr}` (interpolation). See §2 and Appendices A–C for worked examples.

## Open Questions (do not assume these are decided)

`DESIGN.md` §5 lists unresolved areas - settle these *with the user* before building on
them: the structure of `provided` (§5.1, top priority), the reactivity model
(`get`/`set`/`TStore`, §5.2), and the serialization/execution format (VM vs. JS
codegen - JS codegen is favored but undecided, §5.3).
