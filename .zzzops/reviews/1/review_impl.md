# G1 implementation re-review

Approved. The implementation rejects parser recovery before claiming conditional completeness, and the regression tests exercise malformed committed source on both sides of the comparison.

`certifyNodeStatic` checks `root.hasError` and `root.isMissing` before interpreting a syntax tree. Its path-specific callback records an unbounded `parse_error` for the corresponding revision, and the analyzer requires full-profile fallback when certification fails. The implementation evaluates both endpoint trees so a bad old or new input is not silently accepted.

The added real-CLI tests cover missing closing braces and missing parentheses separately at `from` and `to`, checking an unbounded gap, `incomplete` status and full fallback. I independently reran these four cases: all passed in 2.45 seconds. The submitted exact-tree checks record 4,195+ upstream tests in a 772.9-second full suite, all passed except the suite's declared skips; four targeted commands and build also passed. The changed-test cost and exact scope are recorded separately by the workflow; there is no eligible timing baseline.

The v2 model remains intentionally narrow and conditional. Actual execution-context validation belongs to the dependent runner goal. The recorded checks ran on Linux; the Windows-specific ACL path and its native-only test were not exercised by this review, so Windows runtime behavior remains a validation limitation.
