/**
 * The pipeline companion catalog is deliberately data, rather than resolver
 * logic.  It is generated from Effect's public declaration files and checked
 * against the installed Effect version in `pipeline-catalog.test.ts`.
 *
 * An entry means the export has a data-last overload whose final function
 * accepts the piped value as `self`. Constructors and exports without that
 * shape are absent. Predicate-only exports are also absent: a bare predicate
 * is an ordinary function unless it is explicitly namespaced.
 */
export const EFFECT_PIPELINE_CATALOG_VERSION = "4.1.2";

export type PipelineCompanionModule = "Array" | "Option" | "Result" | "Chunk" | "Effect" | "Schedule" | "Layer" | "Stream" | "Schema";

const entries = <const T extends readonly string[]>(...operations: T) => operations;

export const PIPELINE_COMPANION_CATALOG: Readonly<Record<PipelineCompanionModule, readonly string[]>> = {
  Array: entries(
    "ensure", "fromRecord", "fromOption", "match", "matchLeft", "matchRight", "prepend", "prependAll", "append", "appendAll", "scan", "scanRight", "length", "get", "getUnsafe", "unprepend", "unappend", "head", "headNonEmpty", "last", "lastNonEmpty", "tailNonEmpty", "initNonEmpty", "take", "takeRight", "takeWhile", "takeWhileFilter", "span", "drop", "dropRight", "dropWhile", "dropWhileFilter", "findFirstIndex", "findLastIndex", "findFirst", "findFirstWithIndex", "findLast", "insertAt", "replace", "modify", "remove", "reverse", "sort", "sortWith", "sortBy", "zip", "zipWith", "unzip", "intersperse", "modifyHeadNonEmpty", "setHeadNonEmpty", "modifyLastNonEmpty", "setLastNonEmpty", "rotate", "containsWith", "chop", "splitAt", "splitAtNonEmpty", "split", "splitWhere", "copy", "pad", "chunksOf", "window", "groupWith", "group", "groupBy", "unionWith", "union", "intersectionWith", "intersection", "differenceWith", "difference", "map", "flatMap", "flatten", "getSomes", "getFailures", "getSuccesses", "filterMap", "filter", "partition", "separate", "reduce", "reduceRight", "flatMapNullishOr", "extend", "min", "max", "forEach", "dedupeWith", "dedupe", "dedupeAdjacentWith", "dedupeAdjacent", "join", "mapAccum", "cartesianWith", "cartesian", "bind", "bindTo", "countBy",
  ),
  Option: entries(
    "match", "getSuccess", "getFailure", "getOrElse", "orElse", "orElseSome", "orElseResult", "getOrNull", "getOrUndefined", "getOrThrowWith", "getOrThrow", "map", "as", "asVoid", "flatMap", "andThen", "flatMapNullishOr", "flatten", "zipRight", "zipLeft", "tap", "product", "productMany", "zipWith", "reduceCompact", "toArray", "partitionMap", "filterMap", "filter", "lift2", "liftPredicate", "bindTo", "bind",
  ),
  Result: entries(
    "fromNullishOr", "fromOption", "getSuccess", "getFailure", "mapBoth", "mapError", "map", "match", "liftPredicate", "filterOrFail", "merge", "getOrElse", "getOrNull", "getOrUndefined", "getOrThrowWith", "getOrThrow", "orElse", "flatMap", "andThen", "flip", "bind", "bindTo", "transposeOption", "transposeMapOption", "tap",
  ),
  Chunk: entries(
    "fromIterable", "toArray", "toReadonlyArray", "reverse", "get", "fromArrayUnsafe", "fromNonEmptyArrayUnsafe", "getUnsafe", "append", "prepend", "take", "drop", "dropRight", "dropWhile", "prependAll", "appendAll", "filterMap", "filter", "filterMapWhile", "compact", "flatMap", "forEach", "flatten", "chunksOf", "intersection", "head", "headUnsafe", "headNonEmpty", "last", "lastUnsafe", "lastNonEmpty", "map", "mapAccum", "partition", "separate", "size", "sort", "sortWith", "splitAt", "splitNonEmptyAt", "split", "splitWhere", "tail", "tailNonEmpty", "takeRight", "takeWhile", "union", "dedupe", "dedupeAdjacent", "unzip", "zipWith", "zip", "remove", "modify", "replace", "containsWith", "findFirst", "findFirstIndex", "findLast", "findLastIndex", "join", "reduce", "reduceRight", "differenceWith", "difference",
  ),
  Effect: entries(
    "forEach", "head", "bindTo", "bind", "transposeOption", "flatMap", "flatten", "andThen", "tap", "result", "option", "exit", "map", "as", "asSome", "asVoid", "flip", "zip", "zipWith", "catchTag", "catchTags", "catchReason", "catchReasons", "unwrapReason", "catchCause", "catchDefect", "catchIf", "catchFilter", "catchNoSuchElement", "catchCauseIf", "catchCauseFilter", "mapError", "mapBoth", "orDie", "tapError", "tapErrorTag", "tapCause", "tapCauseIf", "tapCauseFilter", "tapDefect", "eventually", "retry", "retryOrElse", "sandbox", "ignore", "ignoreCause", "withErrorReporting", "orElseSucceed", "timeout", "timeoutOption", "timeoutOrElse", "delay", "timed", "race", "raceFirst", "filterOrElse", "filterMapOrElse", "filterOrFail", "filterMapOrFail", "when", "match", "matchEager", "matchCause", "matchCauseEager", "matchCauseEffectEager", "matchCauseEffect", "matchEffect", "provide", "provideContext", "setContext", "updateContext", "updateService", "provideService", "provideServiceEffect", "scoped", "ensuring", "onError", "onErrorIf", "onErrorFilter", "onExitPrimitive", "onExit", "onExitIf", "onExitFilter", "cached", "cachedWithTTL", "cachedInvalidateWithTTL", "interruptible", "onInterrupt", "uninterruptible", "forever", "repeat", "repeatOrElse", "replicate", "replicateEffect", "schedule", "scheduleFrom", "linkSpans", "withSpan", "withSpanScoped", "withParentSpan", "request", "requestUnsafe", "forkChild", "forkIn", "forkScoped", "forkDetach", "awaitAllChildren", "track", "trackSuccesses", "trackErrors", "trackDefects", "trackDuration", "mapEager", "mapErrorEager", "mapBothEager", "flatMapEager", "catchEager",
  ),
  // Schedule transforms recurrence decisions; only Schedule self transforms
  // participate in bare-stage resolution.
  Schedule: entries("addDelay", "concat", "concatResult", "map", "modifyDelay", "jittered", "passthrough", "tap", "upTo", "setInputType"),
  // Layer composition has environment semantics distinct from Effect.provide.
  Layer: entries("buildWithMemoMap", "build", "buildWithScope", "unwrap", "merge", "provide", "provideMerge", "flatMap", "tap", "tapError", "tapCause", "orDie", "catchTag", "catchCause", "fresh", "launch", "withSpan", "withParentSpan"),
  // Stream operations are self transforms only. Constructors and `run*` / `to*`
  // runners remain explicit because they terminate or escape the stream domain.
  Stream: entries(
    "transformPull", "transformPullBracket", "scoped", "map", "as", "mapBoth", "mapArray", "mapEffect", "flattenEffect", "mapArrayEffect", "result", "tap", "tapBoth", "tapSink", "flatMap", "switchMap", "flatten", "flattenArray", "drain", "drainFork", "repeat", "schedule", "timeout", "timeoutOrElse", "repeatElements", "forever", "flattenIterable", "flattenTake", "concat", "prepend", "merge", "mergeEffect", "mergeResult", "zip", "zipFlatten", "zipWithIndex", "zipWithNext", "zipWithPrevious", "zipWithPreviousAndNext", "filter", "filterMap", "filterEffect", "filterMapEffect", "partitionQueue", "partitionEffect", "partition", "when", "peel", "buffer", "bufferArray", "catchCause", "catchDefect", "tapCause", "tapError", "tapErrorTag", "tapDefect", "catchIf", "catchFilter", "catchTag", "catchTags", "catchReason", "catchReasons", "unwrapReason", "mapError", "catchCauseIf", "catchCauseFilter", "orElseIfEmpty", "orElseSucceed", "orDie", "ignore", "ignoreCause", "retry", "withExecutionPlan", "take", "limitBytes", "takeRight", "takeUntil", "takeUntilEffect", "takeWhile", "takeWhileFilter", "takeWhileEffect", "drop", "dropUntil", "dropUntilEffect", "dropWhile", "dropWhileFilter", "dropWhileEffect", "dropRight", "chunks", "rechunk", "sliding", "slidingSize", "split", "combine", "combineArray", "mapAccum", "mapAccumArray", "mapAccumEffect", "mapAccumArrayEffect", "scan", "scanEffect", "debounce", "throttleEffect", "throttle", "grouped", "groupedWithin", "groupBy", "groupByKey", "groupAdjacentBy", "transduce", "aggregate", "aggregateWithin", "broadcastN", "broadcast", "share", "pipeThroughChannel", "pipeThroughChannelOrFail", "pipeThrough", "collect", "accumulate", "changes", "changesWith", "changesWithEffect", "decodeText", "encodeText", "splitLines", "intersperse", "intersperseAffixes", "interleave", "interleaveWith", "interruptWhen", "haltWhen", "onExit", "onError", "onStart", "onFirst", "onEnd", "ensuring", "provide", "provideContext", "provideService", "provideServiceEffect", "updateContext", "updateService", "withSpan", "bind", "bindEffect", "bindTo",
  ),
  // Schema is intentionally limited to schema-to-schema combinators and
  // decode. Schema constructors and codecs remain explicit API calls.
  Schema: entries(
    "annotate", "annotateEncoded", "annotateKey", "optional", "optionalKey", "mutable", "mutableKey", "toType", "toEncoded", "encodeKeys", "decodeTo", "decode", "Array", "NonEmptyArray", "NullOr", "UndefinedOr", "NullishOr", "check", "brand", "catchDecoding", "catchDecodingWithContext", "catchEncoding", "catchEncodingWithContext", "withDecodingDefaultKey", "withDecodingDefaultTypeKey", "withDecodingDefault", "withDecodingDefaultType", "overrideToFormatter", "overrideToEquivalence",
  ),
};

/** FunScript spellings retained while Effect v4 uses a renamed export. */
export const EFFECT_PIPELINE_COMPATIBILITY_ALIASES: Readonly<Record<string, string>> = {
  catchAll: "catch",
};

export const pipelineCompanionCandidates = (operation: string): PipelineCompanionModule[] =>
  (Object.keys(PIPELINE_COMPANION_CATALOG) as PipelineCompanionModule[])
    .filter((module) =>
      PIPELINE_COMPANION_CATALOG[module].includes(operation) ||
      (module === "Effect" && operation in EFFECT_PIPELINE_COMPATIBILITY_ALIASES),
    );

/** Modules considered separately because their pipeline semantics are broader. */
export const DEFERRED_PIPELINE_COMPANION_MODULES = [] as const;

/** Effect 4 has no public Either module; Result is its supported equivalent. */
export const UNAVAILABLE_PIPELINE_COMPANION_MODULES = ["Either"] as const;
