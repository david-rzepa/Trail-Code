# Impact model coverage

The model versions below apply to schema v2 only. Conditional analysis requires independent validation of every model requirement and any bounded scope; unsupported inputs produce an unbounded gap and full-profile fallback. Schema v1 remains conservative.

| Model and version | Covered dependency boundaries | Uncovered examples |
| --- | --- | --- |
| `node-typescript-static-esm` 2 | Explicit tracked relative TypeScript ESM imports and re-exports; file initialization; restricted functions, plain data interfaces and built-in Node tests | Dynamic loading, arbitrary global effects, custom loaders or aliases, unsupported test hooks, resources and mixed-language edges |
| `go-static-packages` 1 | A single module, tracked local Go package imports, package initialization, package tests and exact single-file embeds; opaque changed embeds use package-and-dependents fallback | External modules, cgo, platform-specific source or build tags, generated sources, other directives, unmatched resources, other standard imports and mixed-language edges |
| Python and all other languages | No conditional adapter | Import, build, fixture and execution dependencies are not certified; changed comparisons require full-profile fallback |

The [Node model](conditional-node-model.md) and [Go model](conditional-go-model.md) define exact syntax, manifest, resource and context boundaries. Both adapters rebuild their raw file facts from pinned source bytes and retain import provenance; the older navigation extraction cache is not accepted as evidence of complete imports. An unknown model, missing requirement or unsupported context cannot authorize sparse execution.
