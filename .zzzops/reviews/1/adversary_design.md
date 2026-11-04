# Adversary re-review

## Symlinks in committed snapshots

Committed Git trees can contain symbolic links. The portable design now allows materializing snapshot bytes to temporary directories while preserving modes, but does not say whether a materializer or analyzer may follow a link. A committed `src/x.ts` symlink to an absolute or upward path can cause a naive analyzer to read a file outside the snapshot and incorporate local private content into graph output or logs. A symlinked directory or output path can similarly redirect writes outside the temporary materialization. The same snapshot identity also fails to describe external target bytes, so following a link without a declared pinned input can cause unsound exclusion.

Define a no-follow/containment policy for reading and materializing committed tree entries, including symlinks, path traversal, and symlink replacement. Either treat links as link data and emit an unbounded gap where their target could affect analysis, or support only explicitly captured/pinned in-snapshot targets with proven containment. Ensure writes and cleanup cannot escape their private temporary root. Test absolute and parent-relative links, links through other links, and failure without reading or modifying an external sentinel.
