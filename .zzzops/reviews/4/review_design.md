# Re-review: multilingual end-to-end validation

The updated release gates require completed sparse execution with independent full comparisons for real Node/TypeScript and Go targets, not just plans or fallbacks. They exercise language/build boundaries, external dependents, context validation, build tags and unsupported inputs, and measure both real adapters. Prior receipt distinctions and the owner's normal-runner stable-input scope remain intact. No material issue in this change.
