# Agent instructions

## Keep language documentation in sync

Every change to FunScript syntax, semantics, typing, diagnostics, formatting, emitted
TypeScript, or language-server behavior must update the relevant language documentation
and examples in the same change. Documentation updates are required work, not a follow-up
cleanup task.

Before finishing a language change:

1. Update `docs/syntax.md` for syntax or semantic changes.
2. Update `docs/proposal.md` when the design rationale, supported model, or examples
   change; update `docs/rejected-syntax.md` when a form becomes supported or rejected.
3. Update `docs/grammar.ebnf` and `docs/ast-spec.md` when grammar or AST behavior changes.
4. Update `docs/tooling.md` or editor documentation when CLI, formatter, diagnostics, or
   language-server behavior changes.
5. Update the affected canonical examples and fixtures.
6. Search the docs and examples for older statements or examples that now contradict the
   change, and remove or label superseded design notes.

Treat the implementation and one canonical language decision as the source of truth. Do
not leave docs describing a proposed behavior as implemented, or conflicting documents
presenting different syntax as canonical. If the intended behavior is unclear, record the
open decision and do not silently choose a new language rule.
