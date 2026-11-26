---
title: Pipelines
description: Data-last pipelines, catch, and deferred thunk pipelines in FunScript.
---

FunScript pipelines follow Effect's data-last convention.

## Basic pipeline

```funscript
export incremented = [1, 2, 3] |> map((x) => x + 1)
```

## Catch pipeline

Recover selected tagged Effect failures:

```funscript
effectValue |> catch
  | NotFound(id) => Effect.succeed("missing")
  | ValidationFailed(field, message) => Effect.fail(new Error(message))
```

Unmatched failures propagate. Defects and interruptions are not caught.

## Deferred (thunk) pipeline

`|>>` passes `() => expression` to the receiving function. The expression is evaluated when the function calls the thunk; it is not memoized.

```funscript
export program = next() |> addOne |>> sync |> map((value) => value * 2)
```

Useful for `try`, `promise`, `sync`, and user-defined thunk functions:

```funscript
applyThunk = (f: () => Number) => f()
export result = 21 |>> applyThunk
```

`|>>` does not execute an Effect or catch errors; the receiving function decides when (and whether) to run the thunk.