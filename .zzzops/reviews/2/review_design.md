# Re-review: analyzer integration and receipt trust

## Truth

The proposed integration sends immutable IDs to `trail impact`, but requires its `comparison` to match the requested endpoints. The G1 schema defines `comparison.*.requested` as the literal analyzer argument. When the user supplies `--from main` or `--to feature`, the analyzer therefore reports the resolved SHA in `requested`, not the user's symbolic reference. A validator that requires literal equality to the user request rejects otherwise valid runs. Specify that analyzer requested values match the arguments actually submitted to the analyzer, and validate commit/tree identities against the helper's once-resolved identities; separately retain the user's original values in the execution report. Add symbolic-ref and moving-ref tests. This preserves the requirement to resolve refs exactly once and makes both records truthful.

The receipt trust changes otherwise establish a clearly bounded trusted local store, reject checkout-controlled receipts and cover no-follow/path-replacement and predecessor validation.
