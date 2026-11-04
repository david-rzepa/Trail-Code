# Adversary re-review

## Execution contract conflicts with the owner's stable-input decision

The new multilingual section says the execution layer must validate and protect execution identity. It leaves the surrounding language requiring target identity and mutation protection and acceptance requiring execution-time mutation protection. The owner has since expressly chosen ordinary test-runner behavior assuming stable inputs, without requiring proof that a checkout remained unchanged. Because this design is a G2 dependency, its conflicting text can make workers and acceptance gates reject the owner-approved implementation or falsely claim mutation protection.

Align these cross-goal references to the recorded decision: require the ordinary initial target checks and honest stable-input assumption, but do not require continuous mutation protection, isolation or edit-and-revert detection. Retain independent context validation and the analyzer's immutable committed-object safety. This is an instruction conflict, not a request to revisit the owner's decision.

The new multilingual and bounded-scope design otherwise retains unbounded fallback and calls for cross-boundary dependent tests and independent scope evidence.
