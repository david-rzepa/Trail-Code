# G1 v2 implementation re-review

Changes requested. The revised v2 static model demonstrates file-level sparse impact on independent Node/TypeScript test chains, and the previous ESM-runtime identity and Windows POSIX-mode issues have been addressed in code. One material v2 correctness issue remains: the certifier can classify a syntactically invalid committed source tree as conditionally complete.

## Recovered TypeScript syntax errors are accepted as complete

`src/impact/node-static.ts:177-189` passes each parsed root to `sourceFile`, which checks node shapes but never checks whether the parser recovered from syntax errors or inserted missing nodes. `parseDepth` likewise does not reject a tree with parse errors. A closing brace missing from a function can be represented as a missing anonymous token without adding an `ERROR` named child, so the whitelist at `sourceFile` and `pureFunction` accepts the incomplete program.

I reproduced this with a root `package.json` (`type: module`), a valid NodeNext `tsconfig.json`, a test importing `src/a.js`, and two commits. A contained `export function a() { return 1; }`; B contained `export function a() { return 2;` followed by a newline, without the closing brace. `trail impact --from A --to B --schema-version 2 --json` exited 0 with `analysis_status: conditional`, `analysis_gaps: []`, and no fallback. Running the TypeScript compiler against the same B source returned TS1005 (`'}' expected`). The approved design says parse/index failures or unsupported syntax require an explicit gap and conservative fallback. Recovered malformed syntax can also alter which relationships the parsed AST represents, so the report cannot certify the dependency graph from such a tree.

Before certifying, explicitly reject syntax trees with error or missing nodes, including missing anonymous punctuation, or use an equivalently reliable syntax validation method. Apply it to both endpoints. The v2 test file should cover incomplete delimiters and other parser recovery shapes, not just the current `export function a( {` example, and assert the report is incomplete with a full fallback.

## Previous findings

- Git replacement objects were already fixed and remain covered.
- The universal fallback finding is resolved for the approved v2 scope: the real Node test fixture demonstrates a changed `src/a.ts` reaches `tests/a.ts` and excludes `tests/b.ts`, and the deliberate-failure fixture verifies selected and full test behavior. The default v1 remains conservatively incomplete by explicit owner decision. Equal v2 trees containing ordinary calls can still fall back because the no-change path does not use the static certifier; this is an efficiency limitation, not a missed-test condition.
- The grammar identity now hashes `import.meta.resolve('web-tree-sitter')` in addition to the CommonJS entry and has an identity mutation test.
- Windows cache trust no longer uses POSIX mode bits as ACLs. The implementation has a Windows-specific ACL path and a native Windows test. The recorded run was Linux; actual Windows execution has not been demonstrated in the supplied evidence, so portability remains a validation limitation.

## Test cost

The recorded targeted commands took 33.8 s, 0.1 s, 10.8 s and 7.1 s; repository build and full suite took 7.4 s and 768.6 s. No eligible prior comparison is recorded. The test cost is not the reason for the requested changes.
