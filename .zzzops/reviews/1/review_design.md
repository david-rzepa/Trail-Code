# Re-review: committed symlinks and materialization

The updated design binds symlink interpretation to entries of the pinned tree, broadens or stops for unproven targets, and requires no-follow, root-contained materialization and cleanup. Tests cover contained and escaping links, chains, loops and external sentinels. No new material issue in the change.
