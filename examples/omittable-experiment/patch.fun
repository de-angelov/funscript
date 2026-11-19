import { Option } from "effect"
import { nullValue, undefinedValue, optionalProperties, propertyPresence } from "funscript/interop"

// None omits the key; Some(null) clears it; Some(name) updates it.
export makeNamePatch = (name: Option<NullOr<String>>) =>
  optionalProperties({ name: name })

export clearName = () => makeNamePatch(Option.some(nullValue()))
export leaveName = () => makeNamePatch(Option.none())
export setName = (name: String) => makeNamePatch(Option.some(name))

// Some(undefined) creates an own property whose value is undefined.
export explicitUndefined = () => optionalProperties({ name: Option.some(undefinedValue()) })
export inspectName = (value: { name: UndefinedOr<NullOr<String>> }) => propertyPresence(value, "name")

export normalizeName = (value: NullOr<String>) => Option.fromNullOr(value)
export toJavaScript = (value: Option<String>): NullOr<String> => Option.getOrNull(value)
