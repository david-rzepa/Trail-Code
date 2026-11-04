# G1 implementation review

Changes requested. A Go fuzz corpus file can change a real passing test into a failing test while the report calls the analysis conditional, with no gaps or fallback and no affected owning test. Go's implicit corpus lookup invalidates the filename-based documentation exemption. Reproduced with a tracked `a/testdata/fuzz/FuzzValue/README.md`, changing `int(1)` to `int(2)` and running `go test ./a`; the new test fails but the CLI only lists the corpus path.

The approved design also calls for shared multilingual import facts and conservative reverse graph selection. The current Go conditional path discards the built upstream graph and uses an independent Go-specific parser, while fact preservation drops import intents. This needs integration rather than treating the generic graph as incidental. A simple standard-library `fmt` import also forces global fallback and produces a Node-specific explanation, preventing useful selection for a routine Go module.

The contract tests should exercise the demonstrated corpus behavior, realistic standard imports, and representative Python and mixed-language import/provenance cases.
