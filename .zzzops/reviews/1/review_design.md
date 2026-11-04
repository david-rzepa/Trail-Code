# Re-review: portable committed endpoints

The revised design follows the owner's committed-endpoint scope: both refs are resolved once, committed objects are analyzed by immutable IDs, `worktree` is rejected explicitly, and missing objects or unsupported inputs cannot be treated as unchanged. It removes reliance on filesystem snapshots or privileged operations for analysis while retaining execution-time identity protection as a separate requirement. The updated tests cover live checkout and ref changes without weakening exact-tree comparison. No material finding in this change.
