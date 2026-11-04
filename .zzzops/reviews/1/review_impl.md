# G1 implementation review

Changes requested. The controlled full build and suite passed, but the current implementation has three material problems affecting exact snapshot identity, useful selection, and the installed distribution. The test-design checkpoint also does not exercise these cases.

## Exact commit identity can be replaced by Git configuration

`src/impact/analyze.ts:16-25`, `:65-66`, and `:109-111` call Git without disabling replacement objects. Git honors local `refs/replace` when resolving a commit's tree and reading blobs. In a temporary repository, I created base A, target B, a replacement commit C with a different tree, and ran `git replace B C`. The actual tree of B obtained with `git --no-replace-objects show -s --format=%T B` was `6021aff2ca9982e786abcf4f18bba53b56cdc885`, but `trail impact --from A --to B --json` exited 0 and paired B's ID with C's tree `b0c4663110316c66f90092459fa36099311a5991`. Thus the report can claim to analyze B while its paths and bytes come from a different object, violating the exact-endpoint and cache identity contract. Disable replacement/graft effects or otherwise verify object contents against the real object IDs throughout all Git reads; account for tree and blob replacements as well as commit replacements.

## Every nonempty repository forces full-profile fallback

`src/impact/analyze.ts:197-208` unconditionally adds an unbounded gap for every changed comparison and for an unchanged nonempty tree. Therefore a normal repository has no situation in which a compatible baseline can reuse unaffected results: even `--from A --to A` returns `incomplete` with `full_profile`. This makes sparse test execution impossible regardless of actual supported constructs and fails the approved valid-empty/no-gaps contract. Implement the approved conservative completeness/bounded-scope rules for justified supported cases; keep full fallback for genuinely unmodeled inputs. In particular, an identical committed tree with no changes must not manufacture an unrelated global impact gap without analyzing whether one applies.

## Installed package loses grammar identity and all extraction-cache reuse

`src/impact/analyze.ts:43-50` requires `../../package-lock.json` to construct the extraction cache key, and `:210-214` uses it as the only grammar identity. The package's `files` list in `package.json` excludes this file; `npm pack --dry-run --ignore-scripts --json` at the reviewed tree confirms `package-lock.json` is absent. Every normal published installation therefore silently disables the extraction cache and reports grammar identity `unavailable`. Different actual grammar sets can be reported as the same identity, and repeated runs pay for re-extraction instead of the required cache reuse. Derive identity from artifacts that ship (including the actual parser/grammar dependencies) and make cache use work in the packaged installation.

## Test coverage

`test/conservative-impact-contract.test.ts:135-140` tests valid-empty only for an empty repository, and the other impact assertions allow unconditional full fallback; there is no test for an unchanged populated commit, replaced Git objects, or an installed npm package without a lockfile. Add regression cases for exact commit/tree/blob identity under replacement refs, a meaningful supported/no-change case that does not require full fallback, and packaged analyzer identity/cache reuse. Otherwise all three defects can pass the current green suite.

## Other review notes

The symlink materializer skips link entries and uses no-follow exclusive creation for regular files. The Node-level external-read traps pass; I did not find an independently demonstrated external read via its `git cat-file` subprocess. Cross-platform success beyond this Linux host was not established by the recorded checks. The submitted changed-test timing was 24.1 seconds including intentionally red seam tests; the green recorded verification was about 25.7 seconds for goal tests versus 741 seconds for repository checks. There is no matching prior baseline, so these numbers do not establish a regression.
