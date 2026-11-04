# Verify a committed change

`trail verify` compares two explicit commits and runs the configured test
workflow against the checked-out target. Start with a full passing baseline:

```sh
trail verify --profile go --from BASE --to BASE --all --json
# Check out and commit the target, then:
trail verify --profile go --from BASE --to TARGET --json
```

The built-in `go` profile runs `go test ./...` in full mode and individual Go
packages when the model and prior evidence support selection. The built-in
`node` profile discovers sorted `test/*.test.ts` files and runs Node with the
installed tsx loader. Its full and selective modes use the same file runner.
These profiles cover the supported static models; other constructs, unknown
inputs, missing baseline evidence or unavailable context checks cause a full
profile run. `--plan` reports a selection without running tests or recording a
receipt. The result separates calculated impact, final execution units,
requirement observations and fallback reasons.

For the repository's existing workflow, `trail verify --from BASE --to TARGET`
uses the full `npm test` command followed by `npm run build`; the original
commands remain available directly. A project may supply an explicit
`.test-impact.json` full-workflow profile with a `name`, `fullCommand` argv
array and `gates` list of `{ "argv": [...] }` objects. Preparation commands
use the same object format under `preparation`. Commands are executed as argv,
not interpreted from analyzer output. A project profile is responsible for
identifying its complete workflow.

The target must be the checked-out commit for a run, with no known tracked
changes. As with an ordinary test runner, relevant inputs are assumed stable
during execution. Successful complete runs record private local evidence for
later runs; selective runs can extend a compatible chain. Evidence is scoped to
the repository, profile, test inventory, runtime, resolver and toolchain.
Unavailable or untrusted evidence causes a full run. Reports never claim that
concurrent edits were ruled out.
