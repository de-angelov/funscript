# Package entry point migration

The package exposes one import path per implementation. Update imports and tool
configuration using the following replacements when upgrading from a version
that exposed the redundant paths:

| Removed path                          | Replacement             |
| ------------------------------------- | ----------------------- |
| `funscript/prettier-plugin-funscript` | `funscript/prettier`    |
| `funscript/interop/zod`               | `funscript/zod`         |
| `funscript/interop/valibot`           | `funscript/valibot`     |
| `funscript/plugins/vite`              | `funscript/vite`        |
| `funscript/plugins/bun`               | `funscript/bun`         |
| `funscript/plugins/bun-preload`       | `funscript/bun/preload` |
| `funscript/plugins/esbuild`           | `funscript/esbuild`     |
| `funscript/testing`                   | `funscript/test`        |

These are breaking changes to package imports; the exported functionality is
unchanged. The current entry points are listed in the [package reference](reference/api.md).
