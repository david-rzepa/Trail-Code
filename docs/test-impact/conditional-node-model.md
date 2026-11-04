# Conditional Node/TypeScript impact model

`trail impact --from A --to B --json --schema-version 2` can return
`analysis_status: "conditional"` for model `node-typescript-static-esm`,
version `3`. This is a tracked-source result, not proof that tests passed or
that its execution context is safe. Schema v1 remains the default and retains
full fallback for changed trees.

The first model deliberately accepts a limited ESM subset. Both trees must
contain a root `package.json` with `type: "module"` and only `name`, `version`,
`private`, and `type` fields; it can also declare the supported `tsx --test` script and `tsx`/`typescript` dev dependencies, plus a root `tsconfig.json` with NodeNext module
and resolution and an ES2022 target; only `strict`, `noEmit`, and
`skipLibCheck` boolean compiler options may be added. Other tracked paths must be `.ts` source files, without declaration files, or explicitly classified README.md/LICENSE documentation. Changes to either
configuration file require full fallback. No custom aliases, loaders,
plugins, package exports, resources, generated input, package subprojects or
unrecognized file formats are certified by this model.

Supported source uses explicit relative `.js` or `.ts` imports and re-exports
resolving unambiguously to tracked `.ts` files. Functions may use simple
primitive or plain-interface parameters, local constants, object literals, template strings and return expressions; module constants have literal
initializers, and top-level code may use a constrained `node:test` registration
with assertions from `node:assert/strict`. Calls must resolve to local functions
or explicit imports; dynamic imports, `require`, computed members, mutation,
classes, hooks, decorators, arbitrary global calls and any syntax outside the
whitelist force full-profile fallback. Imported files are related as whole
files, including side-effect-only imports; their reverse closure is computed in
both trees. An imported module with an unsupported initializer or other
unmodeled behavior forces full fallback instead of assuming it is pure. This is
not a general JavaScript or TypeScript dependency analyzer.

A conditional report's `supported_model` is `{ "id":
"node-typescript-static-esm", "version": "3" }`. Its `context_requirements`
are sorted and mandatory. Their singleton registry entries are:

| ID and kind | Predicate `op` | Evidence kind |
| --- | --- | --- |
| `baseline` | `compatible_passing_receipt_for_from_and_profile` | `receipt_validation` |
| `environment` | `complete_relevant_environment_for_execution` | `environment_observation` |
| `inputs` | `complete_inputs_for_target_and_profile` | `input_discovery` |
| `inventory` | `complete_inventory_for_target_and_profile` | `runner_discovery` |
| `resolver` | `supported_node_typescript_resolver` | `resolver_observation` |
| `runner` | `supported_runner_for_target_and_profile` | `runner_observation` |
| `runtime` | `supported_node_runtime` | `runtime_observation` |

A permitted explicit builtin import adds an entry whose ID is
`dependency:<specifier>`, kind is `dependency`, evidence kind is
`dependency_observation`, and predicate is `{ "op":
"node_builtin_matches_runtime", "specifier": "<specifier>" }`. The current
allowlist is `node:test` and `node:assert/strict`. Each declared `tsx` or `typescript` development dependency adds `dependency:npm:<name>` with predicate `node_external_dependency_matches_execution` and dependency observation; the consumer must identify and fingerprint the actual installed dependency and loader.

The consumer must maintain an independent allowlisted registry for this exact
model/version, derive the complete singleton and triggered requirement set
from actual runner, loader, plugin, resource, fixture, service, environment and
input discovery, and validate each predicate using independently collected
and bound evidence. It must ensure the actual resolver reproduces these
tracked relative-import mappings and that no external mechanism adds hidden
project dependencies. Unknown, missing, substituted, unverified or additional
requirements, incomplete discovery, an incompatible baseline, or a changed
context require the full configured profile. Requirements are predicates, not
analyzer-supplied claims about the future runner, profile, inventory or receipt.
The adapter must perform the approved practical target preflight and report its stable-input assumption; these requirements do not prove uninterrupted snapshot identity during execution.
