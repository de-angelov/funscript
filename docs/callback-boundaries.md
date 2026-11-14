# Checked foreign callbacks

`funscript/callback` provides explicit adapters for functions supplied by JavaScript.
Callback-containing record schemas remain **compile-time contracts** for ordinary
use. A narrow subset also generates an explicit `NameDecodeChecked(input)` boundary;
see below. Other contract shapes need a separate data schema and explicit adapters.

Use a tuple schema for arguments and a schema for the result. In this direction,
the FunScript caller passes decoded values; the foreign callback receives encoded
values and returns an encoded value which is decoded. For example, a schema that maps
strings to numbers encodes a number to a string before the call.

```ts
import { Schema } from "effect";
import { checkedSync } from "funscript/callback";

const callback: unknown = (value: string) => String(Number(value) + 1);
const checked = checkedSync(callback, Schema.Tuple([Schema.FiniteFromString]), Schema.FiniteFromString);
checked(2); // 3; the foreign callback received "2"
```

The same entry point is usable from FunScript:

```funscript
import { Schema } from "effect"
import { checkedSync } from "funscript/callback"

export callback = checkedSync((value: String) => value, Schema.Tuple([Schema.String]), Schema.String)
export greeting = callback("hello")
```

`checkedSync` rejects non-functions immediately; it throws `CallbackBoundaryError`
with stage `arguments` or `result` for schema failures. A callback's own exception
propagates unchanged. The supplied schemas must work synchronously and need no Effect
services. The wrapper preserves the call receiver (`this`), but has a different identity:
retain it if adding and removing event listeners. This generic result decoder does not
special-case React's ignored return value; choose a compatible schema or adapter.

`checkedEffect` accepts a **statically typed** foreign function returning an Effect.
It invokes it lazily, keeps its typed failures and service requirements, and adds
`CallbackBoundaryError` to the failure type for argument encoding, synchronous throws,
non-Effect results, and result decoding. It does not validate that foreign failures or
service requirements match a forged TypeScript declaration. For genuinely untrusted
Effect values, establish a trusted adapter first. Neither helper validates arbitrary
function behavior ahead of invocation. Promise callbacks, asynchronous schemas with
services, lifetime management, wrapper caching and the opposite boundary direction
are not supported by this API.

```ts
import { Effect, Schema } from "effect";
import { checkedEffect } from "funscript/callback";

const foreign = (value: string) => Effect.succeed(String(Number(value) + 1));
const checked = checkedEffect(foreign, Schema.Tuple([Schema.FiniteFromString]), Schema.FiniteFromString);
const operation = checked(2); // Effect<number, CallbackBoundaryError>
```

Schemas with callbacks and a generated decoder require a separate design: changing the
existing contract to a wrapped runtime value affects identity, error types, and existing
React callers. See [the design exercise](design-interop-ergonomics.md).

For an untrusted object containing both ordinary data and required callbacks,
`decodeCheckedRecord` combines a data decoder with explicit callback adapters:

```ts
import { Schema } from "effect";
import { checkedSync, decodeCheckedRecord } from "funscript/callback";

const data = Schema.Struct({ label: Schema.String });
const props = decodeCheckedRecord(externalValue, data, {
  onChange: (value) => checkedSync(value, Schema.Tuple([Schema.String]), Schema.String),
});
```

The data schema validates and decodes the ordinary fields. An empty Effect Struct
normally passes extra properties through; this helper deliberately returns no data
fields for an empty Struct, retaining only explicitly adapted callbacks. Each adapter receives its
own callback property from the original object and must perform the necessary checks;
`checkedSync` rejects non-functions and validates calls. The function creates a new
plain object and the wrapper has a different identity. Callback properties must be
own properties, are required, and must not also appear in the decoded data schema.
The data schema must decode synchronously to a plain record. Extra fields are governed
by the data schema. Getter exceptions and adapter exceptions propagate. Optional
callback fields, generated schema methods, and generic untrusted Effect values are
not yet supported. This is an explicit building block, not `SchemaName.decodeChecked`.

## Generated checked decoder for simple contracts

For a non-generic schema whose data fields and synchronous callback arguments use
`String`, `Number`, `Boolean`, supported local data schemas, directly imported simple
data schemas, or local nullary tagged unions, and whose callback results use those
primitives or `Void`, the compiler generates
an explicit `NameDecodeChecked` function alongside the existing trusted type:

```funscript
schema Action = {
  label: String
  run: (value: String) => String
}

action = ActionDecodeChecked(externalValue)
result = action.run("hello")
```

Decoding checks data fields and that callbacks are callable. It creates a new object
and wraps each callback; the wrapper encodes arguments and decodes results at each call.
Schema failures and non-callable callbacks throw; the original callback's own thrown
errors propagate unchanged. Callback identity changes. Fields not described by the data
schema or callback adapters are dropped. These are in-memory boundaries, not JSON codecs.

A contract whose required callbacks all return Effects may also generate a decoder when
its data fields, arguments and success values use supported primitives, local nullary
tagged unions, or verified non-transforming local or directly imported data schemas. In this case `NameDecodeChecked` accepts an already
statically typed `Name`, not `unknown`, and returns `NameChecked`. Each checked Effect
adds `CallbackBoundaryError` to the declared failure type and preserves the declared
service requirements. The callback's original failure values and service requirements
are trusted from its static type; JavaScript cannot validate those requirements at the
boundary. Defects and interruptions retain normal Effect behavior.

Optional synchronous data fields and callback fields preserve omission versus an
explicit `undefined`; `null` is not treated as omission. `Void` callbacks ignore the
foreign return value, and the generated wrapper drops extra arguments beyond the declared
signature (for example, a React event passed to a zero-argument callback). Reuse the
same decoded wrapper to add and remove an event listener.

Defaulted fields, optional fields in Effect callback contracts, generic schemas, Promise
callbacks, mixed sync and Effect callbacks, rest or optional callback parameters, imported
schemas, and transforming data schemas are not supported by this generated decoder yet. For those shapes use a separate data schema and explicit
adapters. There is no `NameFromUnknown` decoder or `SchemaInput<Name>` for contracts.
