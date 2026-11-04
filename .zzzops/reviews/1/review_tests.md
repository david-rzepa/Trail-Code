# Conditional schema test re-review

Approved. Every real v2 report now goes through checks for the conservative analysis identities, exact commit and Git tree IDs, endpoint fingerprints, retained change/affected/gap/fallback structures, requirement structure, and status/fallback consistency. The malformed-report fixture exercises the checker; the practical two-target sparse case and repeated-report determinism remain. The previous finding is resolved.

At checkpoint b26dee4 the three existing suites passed (27.6 seconds, 0.12 seconds and 8.3 seconds). The conditional suite took 3.0 seconds: its synthetic checker passed and its five real CLI cases remain red because schema v2 is not implemented. This is not yet evidence of working conditional analysis.
