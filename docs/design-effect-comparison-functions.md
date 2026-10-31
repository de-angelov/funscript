# Design: Effect comparison functions

## Recommendation

Use typed, pure comparison functions supplied by the value type's Effect companion
module. Give every comparison a direct two argument form and a data-last pipeline
form, both backed by the same operation. This follows the existing call and pipeline
rules while keeping ordering semantics explicit for types such as `DateTime` and
`BigDecimal`.

The small vocabulary is `lessThan`, `lessThanOrEqualTo`, `greaterThan`,
`greaterThanOrEqualTo`, and `between`. Each comparison returns `Boolean`; `between`
includes both endpoints. The ordered type defines what its ordering means and which
values it accepts. Comparison functions are total over their declared domain; invalid
domain values should be rejected when constructed/decoded, not reported through an
Effect error channel.

Conceptual signatures for a type `A` with an ordering instance:

```text
lessThan: (left: A, right: A) => Boolean
greaterThan: (left: A, right: A) => Boolean
between: (value: A, lower: A, upper: A) => Boolean
```

The same operation also has a data-last partial form for pipelines, consistent with
the documented rule that `value |> f(argument)` means `f(argument)(value)`:

```text
lessThan: (right: A) => (left: A) => Boolean
greaterThan: (right: A) => (left: A) => Boolean
```

The visible module supplies the type: `Number.greaterThan`,
`DateTime.greaterThan`, or `BigDecimal.greaterThan`.

## Examples

```funscript
# Ordinary calls: readable at boundaries and in nested expressions.
isOverLimit = Number.greaterThan(score, 80)
isExpired = DateTime.greaterThan(now, token.expiresAt)

# Pipeline: compare the incoming value with the supplied bound.
isValid = score |> Number.greaterThanOrEqualTo(0)
isSmall = score |> Number.lessThan(10)
isInRange = Number.between(score, 0, 100)
```

Comparisons are pure booleans. In an `effect` block, bind effectful work with `<-`,
then use a comparison directly in a `when` condition; it does not need to be yielded
or wrapped in `Effect.succeed`:

```funscript
checkScore = (id: String) =>
  effect
    score <- ScoreRepo.get(id)
    when (score |> Number.greaterThan(100)) => Effect.fail(ScoreTooHigh(id))
    score
```

The same boolean expression works in a match guard:

```funscript
match score
  | n when n |> Number.greaterThan(90) => "high"
  | _ => "ordinary"
```

## Alternatives considered

- **Pipeline-only comparisons** keep the API data-last, but make direct calls and
  nested expressions less natural, and conflict with existing direct-call conventions.
- **Direct-only comparisons** work everywhere but miss the established Effect pipeline
  form and require temporary lambdas for common filtering and validation pipelines.
- **Comparison operators** (`<`, `>`, and friends) are concise for primitive numbers,
  but hide which ordering applies to non-primitive types and contradict the documented
  rejected-operator policy.

## Approval choice

Should implementation expose **both** `Type.lessThan(a, b)` direct calls and
`a |> Type.lessThan(b)` data-last pipeline use, with one typed operation behind both
forms? Approved by the user on 2026-10-30. All comparisons use the typed comparison
methods supplied by Effect TS companion modules; do not add comparison-operator
syntax. Arrows keep their established yield/return meaning.
