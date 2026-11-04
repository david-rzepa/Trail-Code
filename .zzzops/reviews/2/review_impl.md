# G2 implementation review

Changes requested. Linux verification passed the recorded suite, but two independent safety failures remain.

1. `git status --untracked-files=no` and package-only Go inventory omit untracked test files inside existing packages. A real fixture reproduced a validated selective receipt while `go test ./...` fails on an untracked test in the omitted package. The initial checkout check and runner-input discovery need to account for relevant untracked and ignored Go inputs. This concerns inputs already present at run start, not proving immutability during execution.
2. Analyzer-reported affected paths are checked only for inclusion of independently discovered targets; extra reported affected units never enter the selected set. An injected otherwise-valid v2 report naming an extra test was accepted and the unit omitted. Preserve every mapped affected unit or broaden when it cannot be mapped, and reject malformed affected entries.
3. Add the corresponding regression assertions to the contract tests, which currently exercise committed fixtures but do not cover these cases.

The successful recorded Linux verification ran 27 contract cases (213 s), a build (13 s), and the repository suite (1,529 s, 4,262 passing and 9 skipped). The earlier 5 s red contract measurement exited at missing implementation and is not comparable. Native Windows and macOS behavior was not tested in this review. Receipt permissions, scoped context, endpoint pinning, and the ordinary stable-checkout assumption were reviewed; no additional material finding is asserted here.
