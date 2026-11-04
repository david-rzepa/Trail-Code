# Adversary re-review

The symlink containment finding is resolved. The design requires treating committed symlinks as metadata unless resolution is proven entirely within the pinned tree, reporting unbounded gaps for unsupported or escaping links, and no-follow, root-contained materialization and cleanup. Sentinel tests cover absolute, relative, chained and path-component escapes, loops and missing targets. No new material adversarial findings.
