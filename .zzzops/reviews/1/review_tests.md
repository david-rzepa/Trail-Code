# Multilingual test re-review

Approved. The new B-only case requires selective inclusion of B tests while excluding A and its consumer. The deleted A source case requires old-revision cross-package consumer tests and A tests or an explicit full-profile fallback. The original finding is resolved; both run through real committed Git endpoints.

At checkpoint 608c26f the two new cases took 1.45 seconds: inverse selection failed because the model still falls back fully, while the deletion case passed via its permitted full fallback. Across the four targeted suites, the v2 suite remains red with five failures; the other three passed. This verifies the tests expose missing selectivity, not that the implementation is complete.
