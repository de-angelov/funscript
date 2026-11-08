# Interop examples

`funscript/record` exports a small immutable omission helper for typed records. Its distributive
return type retains discriminated union members. It copies enumerable own string and
symbol keys; it does not make open object types exact.

```funscript
import { omit } from "funscript/record"
export buttonProps = omit(props, ["internal"])
```

`cache-success.ts` demonstrates a caller-owned Effect cache. A successful result is
retained indefinitely and a failure has zero TTL, so the next call can retry. Calling
`cacheSuccess` twice creates two independent caches. The outer effect creates the
cache and returns the effect that callers run; it does not itself produce the client.

This helper does not manage a connection's lifetime. For a shared connection that
must close, acquire it in a scoped Layer and release it when the layer's scope closes.
See `tests/cache-spike.test.ts` for both patterns. These examples use an in-memory
stand-in, not a Redis server, and do not establish production interruption or reconnection
behavior.
