# Adversary re-review

No new material adversarial findings in the commit-only redesign. The design rejects worktree endpoints, pins symbolic refs before invoking the analyzer, requires proof that execution uses B and retains it throughout the run, and refuses evidence after mutation or loss of protection. It separately constrains unsafe symlink materialization and retains the private receipt provenance boundary and forged-receipt tests. A full-suite fallback cannot turn unsafe execution into verification.
