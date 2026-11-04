# G2 test design re-review

Decision: approved.

- review_tests:1:2 resolved. The new tests reject a different receipt profile and corrupted predecessor and inject replacement of the state root before a read. Existing tests cover missing chains, tracked copies, unsafe roots, failure, cancellation and publication. The replacement test observes that the external directory is not modified; implementation review should also verify that reads are securely anchored because an unchanged sentinel alone does not prove no read occurred.
- review_tests:1:3 resolved. New subprocess tests exercise the production CLI with the repository's full runner, a real gate, JSON isolation, failure and cancellation, complementing the existing order and preflight tests. The copied runner avoids recursing through this test suite.

The recorded 5.1-second red run measured the exact checkpoint but stopped 26 cases at the unimplemented verification module. It does not demonstrate passing behavior or completed-suite cost. Re-run and assess actual cost once the implementation exists; the real runner integration is justified.
