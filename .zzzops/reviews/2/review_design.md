# Review of deterministic planning, execution and evidence design

The design preserves exact endpoint and execution identity, distinguishes impact from execution and evidence, and defaults to full execution or incomplete verification when the required guarantees are unavailable. It retains the independently callable full test workflow, including the actual test runner's discovery, Git overrides and temporary-directory handling, and records only successful compatible evidence. The design covers concurrent snapshot changes, invalidation, dependent resources, incomplete receipts, supported selector boundaries and schema version rejection.

Intent, simplicity, truth, adversary, concurrency, rollout and experience passes found no material issue. The receipt storage format is recorded as an owner decision. The initial adapter must prove selector and workflow equivalence before enabling file selection, and broad fallback remains acceptable where that proof is unavailable.
