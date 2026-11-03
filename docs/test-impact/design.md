# Sparse test execution with Graft

**Design specification**

Version 0.1   |   2 November 2026

**Decision.** Fork Graft to add conservative impact analysis, then provide a setup skill that generates a small test CLI for each repository. Other skills, developers and CI invoke that CLI with an explicit source comparison. Test selection and execution require no model reasoning during normal runs.

This design targets the repeated unit and integration test runs performed during agent development. It reduces unnecessary execution while preserving a clear account of the code analyzed, the tests required, the tests executed, and the results that can be reused.

The specification defines intended behavior for the fork, the setup skill and the generated CLI. Command flags, configuration fields and JSON schemas below are proposed interfaces.

## 1 Design decisions and scope

| Decision | Contract |
| --- | --- |
| Reuse Graft | Extend its existing parsing, extraction, caching, dependency graph and blast traversal. |
| Generate the repository adapter | The skill produces an executable CLI and configuration; the skill is not part of routine test execution. |
| Require explicit endpoints | Every plan or run supplies --from A and --to B, or the explicit target worktree. |
| Keep exclusion decisions in code | The generated CLI follows deterministic graph, mapping and fallback rules. |
| Broaden on uncertainty | Select a justified larger test scope; use the full configured suite when no narrower boundary is reliable. |
| Preserve the complete workflow | The original full test command remains independently runnable with required build and setup behavior. |

The initial product is a focused fork and an installation skill. It does not require a new graph service, a replacement test runner or a separately implemented multilingual parser. Individual test-case selection is supported only where the existing runner exposes a reliable selector; otherwise the execution unit is a file, package, binary, project or suite.

The framework identifies tests that may be affected. It does not predict which tests will fail, promise the mathematically smallest selection, or infer external integration state from Git alone.

## 2 Architecture and responsibilities

Graft supplies source impact. The generated adapter connects that impact to the repository's existing verification workflow. A small shared helper may live in the fork or its distribution to keep baseline checks, schema validation and fallback behavior consistent across generated adapters.

| Component | Responsibilities |
| --- | --- |
| Conservative Graft fork | Analyze exact snapshots; preserve ambiguity; report gaps; traverse dependencies; emit complete machine-readable impact. |
| Setup and maintenance skill | Inspect the repository; identify commands and dependencies; generate and validate the adapter; record its canonical invocation. |
| Generated repository CLI | Accept endpoints; obtain impact; discover and map runnable tests; apply fallbacks; execute; report results. |
| Repository configuration | Declare test profiles, target mappings, original full commands, fixture/resource dependencies and always-required checks. |
| Shared deterministic helper | Validate snapshot and configuration identity, interpret analysis status and maintain verification receipts. |
| Existing test runners | Perform discovery and execution, retaining their own assertions, fixtures, reports and failure behavior. |

### The setup skill

The skill reads the repository's manifests, test configuration, CI jobs, project instructions and established commands. It identifies workspaces and test profiles, including integration tests, shared fixtures, generated inputs and required preparatory steps. It uses existing runner discovery where available instead of assuming every test can be recognized by its filename.

It generates a small adapter in the repository's usual scripting location, a configuration file, and command documentation. Generated logic primarily describes repository-specific mappings. Common correctness rules are imported from a pinned helper or copied from a versioned, validated template rather than reinvented separately for each repository.

Setup records the original full command before changing any canonical test entry point, preventing recursive fallback. It validates execution selectors and fallback behavior and records the exact command template in the repository instructions used by other skills. Later maintenance preserves intentional user changes and regenerates only the affected integration.

No setup skill may silently decide that an unknown test suite is unnecessary. Unresolved setup assumptions must produce a broad configured target or an explicit configuration gap that blocks successful verification.

## 3 Command contract

The canonical interface requires both comparison endpoints. The example executable path is illustrative; the skill chooses a path that fits the repository.

```bash
node tools/test.mjs --from <commit-A> --to <commit-B>
node tools/test.mjs --from <commit-A> --to worktree
```

Omitting either endpoint is a usage error. The CLI must not silently substitute HEAD, a merge base, the last successful run or the working tree. Help and version commands are exempt.

| Option | Meaning |
| --- | --- |
| `--from <commit>` | Required comparison source. Resolve a commit-ish reference once to an immutable commit identity. |
| `--to <commit\|worktree>` | Required target. Analyze and execute the corresponding source state. |
| `--all` | Execute the complete configured profile at the target, while retaining the supplied comparison in the report. |
| `--plan` | Calculate and explain the execution plan without running tests or creating passing evidence. |
| `--json` | Emit a structured plan or result on stdout; route test and diagnostic logs separately. |
| `--profile <name>` | Select an explicitly configured verification profile. The default is the repository's recorded canonical profile. |

A and B mean their exact endpoint trees. The CLI does not substitute their merge base. A pull-request workflow may compute a merge-base commit explicitly and pass that commit as A. Symbolic refs are resolved at invocation so a branch moving during the run does not change the comparison.

A command template supplied to another skill is therefore:

```bash
node tools/test.mjs --from {base_commit} --to {target_snapshot}
```

All supplementary modes retain the required endpoint pair. A full run can establish a baseline for a commit by using the same commit for both endpoints and adding --all. A plan alone never marks tests as passed.

## 4 Snapshot and execution semantics

### Committed endpoints

The fork builds or loads analysis for the resolved trees at A and B. It may use detached temporary worktrees or equivalent tree materialization. Existing parser and extraction functions can be reused; the graph must identify the snapshot it represents.

A run targeting B executes B's code. The initial execution policy is strict: the current execution tree must match the target's relevant inputs or the run fails with a clear target-mismatch error. An isolated checkout mode can provide execution of historical targets without weakening that rule. The CLI never silently resets or changes the user's checkout.

For monorepos and repositories with submodules, target identity includes the pinned revision and visibility of required subprojects. Missing inputs cannot be interpreted as unchanged inputs. Dependency installation, generation and build steps remain part of each runner's declared preparation.

### Working tree targets

The worktree target is captured explicitly. It contains the actual relevant working-tree bytes: staged changes, unstaged changes, relevant untracked additions, deletions, paths and meaningful file metadata. It is not merely the index or a diff of tracked files. The snapshot receives a content fingerprint used by both analysis and execution.

Generated or ignored inputs that affect tests must be represented through declared inputs, generator dependencies or broader target rules. Git ignore rules are enumeration rules, not evidence that a file cannot affect a test. Documentation-only exclusions likewise require an explicit applicable policy.

Execution must protect the captured inputs: use an immutable source materialization with separate writable outputs, or reliable mutation detection and serialization for an in-place run. Before-and-after hashes alone are insufficient because an edit can be reverted during execution. Any relevant mutation or loss of reliable observation invalidates verification and prevents a passing receipt for the claimed snapshot. Build outputs are excluded only where configuration establishes them as derived outputs.

### Selection and execution are separate records

Every report records requested endpoints, resolved identities, snapshot fingerprints and the actual execution identity. If B cannot be materialized or matched, neither selective execution nor full fallback may be reported as validation of B.

The same principle applies to plan reuse: a plan may be executed only while its snapshot, runner configuration, inventory and policy identity remain valid. Editing the repository or changing a relevant configuration requires recalculation.

## 5 Correctness and baseline evidence

**Determinism** means identical snapshots, dependency configuration and analyzer versions produce the same impact. The execution plan also depends on baseline-evidence identity and availability, the execution context, discovered test inventory and runner policy. Identical values for all these inputs produce the same ordered plan and explanations. Runtime timing and process scheduling need not be deterministic.

**Conservative selection** means all tests that may be affected under the supported dependency and execution model are included. Extra tests are acceptable. Missing graph edges, absent coverage and a successful parser invocation do not by themselves justify excluding tests.

The claim applies within the declared execution context. External services, environment values, database state, native components and other inputs must be pinned, fingerprinted, explicitly related to a target or covered by an always-run rule. A Git comparison alone cannot establish that those inputs are unchanged.

### Comparison does not establish a passing baseline

The CLI can calculate impact for A to B even when no test evidence exists for A. However, it may reuse unaffected results only if there is compatible successful verification evidence for A. With no such evidence, the execution plan expands to the full configured profile at B.

A verification receipt records the source identity, profile and target coverage, test inventory, runner and dependency configuration, relevant environment fingerprint, analyzer/helper policy identity and successful completion. Sensitive environment values are not included in reports; identity can use appropriate hashes or stable non-secret descriptors.

A receipt from a different profile or incompatible environment cannot validate skipped tests. Imported CI evidence is a future integration; the first implementation can rely on locally produced receipts. An optional caller assertion of trust should not be added implicitly.

A successful full run at B creates a receipt for B. A successful selective run can also validate B when the reused A receipt is compatible and every target required by the conservative plan completes. The new receipt records its dependency on the prior receipt. The next invocation still requires explicit --from and --to; receipts never choose the user's comparison range.

Failures, cancellation, incomplete execution and arbitrary user-filtered subsets do not create a receipt for the full requested profile. This prevents an interrupted A to B run from disappearing when the next request compares B to C.

## 6 Conservative analysis in the fork

Tree-sitter remains Graft's parsing foundation. Graft adds language-specific extraction and resolution above that parser. Reusing those layers is the main reason for the fork. The inspected resolver intentionally omits some ambiguous or unresolved calls, so conservative behavior must extend extraction and resolution as well as traversal. [1, 2]

| Analysis outcome | Required representation and effect |
| --- | --- |
| Resolved target | Record the dependency and its evidence. |
| Multiple plausible targets | Retain all justified candidates; do not select one merely to reduce graph noise. |
| Unresolved target with a bounded scope | Record the uncertainty and include dependencies on the defensible scope. |
| Unsupported or unmodeled behavior | Emit a limitation with provenance; select dependent test scopes or all configured tests when unbounded. |
| Parsing or indexing failure | Report affected paths and incomplete analysis. Broaden execution or block if no valid fallback is available. |

Edge provenance and analysis completeness are separate properties. A graph may contain accurate edges while omitting important relationships. The schema therefore describes both evidence for relationships and gaps in the coverage of language constructs and inputs.

Connecting every function with the same name is insufficient. Reflection, callbacks, dynamic registration, subprocesses and resource loading may never produce ordinary call edges. Initial support may conservatively map these patterns to a package or suite rather than implementing precise semantics.

### Both revisions and changed resolution

Changes are mapped on both sides of the comparison. Old entities and dependencies remain available for deleted functions, files, imports and fixtures. New relationships cover additions, changed interfaces, changed dispatch and current test inventory. When rename matching is uncertain, treat the change conservatively as removal plus addition.

Reusing an unchanged file's syntax does not establish that its bindings are unchanged. New overloads, overrides, import paths, registrations or shadowing definitions can change dependencies in an unchanged caller. The initial fork may retain Graft's whole-graph resolution after cached per-file extraction rather than introducing a more complex resolution cache. [6, 8]

Compute the relevant reverse dependency closure in both revisions and combine the resulting live test impacts. Retain revision provenance; do not infer semantic equivalence from identical line numbers or symbol names. Combining both graphs is an implementation pattern, not a proof that missing dependency kinds have been covered.

### Traversal and fallback scopes

Conservative traversal has no arbitrary hop limit and no result-count truncation. Where symbol-level analysis is incomplete, file, import, build-target or declared scope relationships provide a broader route. A containing directory alone is not a trustworthy dependency boundary.

A fallback selects tests that depend on the affected scope, including tests outside it. If the boundary itself is uncertain, select the full configured profile. Default navigation behavior may remain unchanged in the fork, but its output must not be confused with conservative output.

## 7 Planning and execution algorithm

1. Validate arguments and configuration. Require both endpoints, resolve the selected profile and locate its original full commands.

2. Resolve and capture inputs. Record immutable commit identities or a worktree fingerprint and establish the execution target.

3. Discover the target's runnable test inventory. Include dynamically generated cases through runner discovery or choose a coarser supported execution unit.

4. Obtain conservative impact for both snapshots. Validate graph mode, snapshot identity, schema, policy and completeness.

5. Map all impacted entities and scopes to runner targets. Independently add surviving new and modified tests. Exclude deleted tests from execution while preserving their old graph information.

6. Apply fixture, discovery-hook, build, configuration, resource and service invalidation rules. Retain required preparation and independent verification gates.

7. Apply evidence rules. Separate the calculated impact set from the execution set. Expand to full execution when A lacks compatible passing evidence.

8. Normalize the plan. Deduplicate compatible units, preserve required runner ordering and resource constraints, and record selection and fallback reasons.

9. Execute the plan using configured command argument arrays or existing intentional scripts. Graph output supplies data, never arbitrary executable shell text.

10. Aggregate results, recheck input identity and write a receipt only after complete successful verification. Return the defined exit status and structured outcome.

The adapter must not use Graft's current testModules presentation grouping as its executable inventory. The inspected grouping can omit paths already in the diff and depends on test-name patterns. The complete impact data plus actual runner inventory is the selection input. [3]

Test discovery failures and mapping gaps are distinct from a valid empty selection. If a runner cannot select a test file reliably, run the containing package, binary, project or suite. Shared fixtures and discovery hooks may affect an entire target even when no ordinary call edge connects them.

The original workflow may include compilation, type checks, coverage gates or global setup. Their behavior must be retained explicitly. For example, a global coverage threshold cannot silently be reinterpreted as a threshold for only the selected tests; the profile must retain the full gate or provide an independently validated alternative.

## 8 Machine readable contracts

Use versioned schemas and reject unsupported versions. Graft's impact report and the repository CLI's execution report are separate records: the fork need not know how every test runner is invoked.

| Impact report field | Required meaning |
| --- | --- |
| schema_version and analysis_identity | Schema, fork version, grammar/extractor/resolver identity and conservative policy. |
| comparison | Requested and resolved source/target identities; worktree fingerprint where applicable. |
| changes | Added, modified, removed and renamed paths and relevant old/new entities. |
| affected | Complete impacted entities/files, with revision and dependency reasons. |
| analysis_gaps | Unsupported constructs, unresolved scopes, parse failures and other limitations. |
| required_fallback_scopes | Scopes whose dependent tests must be included; an unbounded gap requires full-profile fallback. |
| analysis_status | Complete for the supported model, bounded by explicit fallback, or incomplete. |

The generated CLI validates that report, then produces an execution plan containing runner units, commands, preparation, reasons, evidence status and the final selection strategy. The following is an illustrative abbreviated result, not a JSON Schema:

```json
{
  "schema_version": 1,
  "comparison": {
    "from_commit": "<resolved A>",
    "to": {"kind": "worktree", "fingerprint": "<digest>"}
  },
  "profile": "default",
  "baseline_evidence": "missing",
  "selection_strategy": "full",
  "calculated_affected_units": ["unit:payments"],
  "execution_units": ["unit:all", "integration:all"],
  "fallbacks": [
    {"reason": "unverified_baseline", "scope": "default"}
  ],
  "execution_status": "passed",
  "verification_status": "validated",
  "input_identity_unchanged": true,
  "receipt_id": "<receipt identifier>"
}
```

A missing receipt at A can expand a sparse calculated impact into full execution, as shown. This distinction remains visible rather than overwriting the impact explanation. Plans include execution_status set to not_run and verification_status set to not_performed.

Use separate status fields rather than a single ambiguous success flag. A completed full fallback can validate the target even when sparse analysis was incomplete. A completed plan only confirms that a plan was calculated; it never asserts that tests ran.

## 9 Generated repository configuration

Configuration records repository knowledge as inspectable data. It is committed with the adapter. Verification receipts, graph caches and run logs are local or CI artifacts and are not committed as source configuration.

At minimum, configuration identifies the canonical profile, runner projects, working directories, preparation commands, discovery and selection adapters, full commands, invalidation rules and always-required gates. Commands are stored as argument arrays or stable references to existing scripts.

This abbreviated example illustrates a Node repository with two existing scripts. Runner adapter names are proposed helper interfaces and require implementation and validation:

```json
{
  "schema_version": 1,
  "profile": "default",
  "runners": [
    {
      "id": "unit",
      "cwd": ".",
      "full_argv": ["npm", "run", "test:unit:full"],
      "adapter": "configured-unit-runner",
      "test_scope": "tests/unit"
    },
    {
      "id": "integration",
      "cwd": ".",
      "full_argv": ["npm", "run", "test:integration:full"],
      "adapter": "suite"
    }
  ],
  "invalidation_rules": [
    {
      "paths": ["test.config.*", "tests/setup/**"],
      "targets": ["unit:all", "integration:all"]
    },
    {
      "paths": ["db/migrations/**"],
      "targets": ["integration:all"]
    }
  ],
  "unknown_mapping": "full_profile"
}
```

Test-scope paths guide inventory and mapping; they are not proof that dependencies stay inside those directories. Runner-specific discovery supplies actual targets. Unknown newly introduced projects or runner configuration changes trigger full fallback or a setup-maintenance requirement, never quiet omission.

The generated adapter retains the runner's preparation, environment, ordering constraints and reporting behavior. A user may choose a separate explicit profile, but a passing unit-only profile cannot stand in for a profile that also requires integration tests.

## 10 Failure handling and process behavior

| Condition | Required outcome |
| --- | --- |
| Missing endpoints or invalid configuration | Usage or configuration failure. No implicit range and no passing receipt. |
| Target does not match execution inputs | Stop with a target-mismatch result or use an explicitly supported isolated checkout. |
| Graph stale or incomplete | Run the required broader targets or full profile. Stop if a valid fallback cannot be established. |
| No passing evidence for A | Calculate impact if useful, then execute the full profile at the requested target. |
| No selected tests | Reuse results only when the analysis, inventory and baseline evidence justify it. |
| Test failure or interrupted run | Return nonzero and preserve diagnostics. Do not record complete successful verification. |
| Relevant inputs change during execution | Mark the result invalidated; require a new plan and run for the newer state. |

Proposed exit codes are 0 for successful verification, 1 for completed test execution with failures, 2 for invalid input or incomplete verification, and 130 for interruption. A successful --plan operation returns 0 for plan generation only; its structured report explicitly states that verification was not performed.

Child process errors, signals and original exit statuses remain available in the report. In JSON mode, stdout contains one structured result; child logs and progress go to stderr or referenced log files. Empty discovery is an error unless the profile explicitly permits an empty suite.

Selection must include modeled test-to-test prerequisites or the complete dependent group or runner target. When the dependency boundary is unknown, select the full profile. Sequential scheduling alone cannot make a subset of order-dependent tests safe. Execution preserves required ordering and resource constraints; concurrency must not change the selected set.

## 11 Caching and performance

Retain per-file extraction caching. Reuse raw facts across modes only when their extraction contract is identical. Resolved graphs and fingerprints include the source snapshot, analysis mode, relevant configuration and analyzer identity. Conservative outputs are isolated so ordinary navigation hooks cannot overwrite them.

A failed refresh cannot silently turn an older graph into the current answer. This is an intentional change from the inspected navigation-oriented refresh behavior, which can continue using the graph already on disk. [5]

The initial implementation favors cached parsing with a full resolution pass. Finer resolution invalidation, persistent per-test histories and runtime coverage are later optimizations. They should be introduced only when measured workload costs justify their complexity.

Measure end-to-end time: snapshot preparation, graph work, test discovery, mapping, build/setup and execution. Report the selected unit count, fallback frequency, analysis time and total elapsed time against the full command. A smaller test count does not establish a speed improvement when indexing or setup dominates.

For small suites or expensive uncertain analysis, selecting the full profile can be the better execution policy. Any policy that affects selection is versioned and explicit; benchmark-driven changes do not silently alter the contract of a stored plan.

## 12 Upstream implementation changes

The source locations below refer to the inspected upstream Trail-Code repository, which contains Graft. They are starting points for a focused fork and should be pinned to a chosen upstream revision when implementation begins. [1-8]

| Area | Source locations | Change |
| --- | --- | --- |
| Endpoints | `src/blast/diff.ts`<br>`src/blast/blast-cli.ts`<br>`src/cli.ts` | Add explicit exact endpoint handling and snapshot identities. |
| Analysis validity | `src/graph/build.ts`<br>`src/graph/refresh.ts`<br>`src/graph/types.ts` | Report skipped/failed inputs and require current conservative analysis. |
| Conservative facts | `src/graph/extract.ts`<br>`src/graph/generic.ts`<br>`src/graph/resolve.ts` | Retain candidates and uncertainty; emit limitations for unmodeled behavior. |
| Impact traversal | `src/blast/blast.ts`<br>`src/graph/traverse.ts`<br>`src/graph/relations.ts` | Use both revisions, full closure and justified broader dependencies. |
| Cache identity | `src/graph/extract-cache.ts`<br>`src/graph/fingerprint.ts`<br>`src/graph/write.ts` | Version and isolate resolved conservative results; reuse compatible raw facts. |
| Executable data | `src/blast/blast.ts`<br>`src/blast/blast-cli.ts` | Expose complete impact and fallback information independently of display groups. |
| Repository integration | New setup skill<br>New generated CLI/configuration | Generate deterministic mapping to existing runners and the canonical command template. |

The inspected blast command already supports full JSON output and unlimited traversal when requested. Its current default depth, deleted-file handling and presentation-oriented grouping must not be carried into conservative execution unchanged. The existing --base merge-base behavior remains distinct from the proposed --from/--to contract. [3, 4]

## 13 Acceptance criteria

These checks are release gates for the fork/helper and generated adapters. They validate selection behavior directly; formatting or normal-path unit tests alone are insufficient.

| Case | Required result |
| --- | --- |
| 1 Explicit range | Missing --from or --to fails; no implicit HEAD, merge base, last run or worktree. |
| 2 Exact endpoints | Diverged A and B compare their endpoint trees, including changes outside a merge-base-only comparison. |
| 3 Repeatability | Equivalent snapshots, evidence, inventory, context, configuration and versions produce the same ordered plan and reasons. |
| 4 Executed snapshot | The code executed matches B or the captured worktree; mismatch cannot validate B. |
| 5 Worktree inputs | Relevant staged, unstaged and untracked changes are included; mid-run edits, including edit-and-revert, invalidate the result. |
| 6 Test changes | New and modified tests are included. Deleted tests are not scheduled. |
| 7 Deletions and renames | Surviving dependent tests remain selected when production entities are removed, moved or ambiguously renamed. |
| 8 Rebinding | An added overload, override or registration can select tests through unchanged callers. |
| 9 Unknown dependencies | Unsupported constructs, parse failures and unbounded relationships broaden selection instead of disappearing. |
| 10 Runner mapping | Unreliable fine-grained selectors broaden to a supported containing target. |
| 11 Baseline evidence | Missing or incompatible evidence expands execution to the full requested profile. |
| 12 Result completeness | Failures, interruption and arbitrary subsets cannot establish a full passing receipt. |
| 13 Empty results | Zero selection is distinguished from failed discovery or incomplete analysis. |
| 14 Full fallback | Original setup, build, checks and error behavior remain intact; fallback cannot recurse into the wrapper. |
| 15 Generated boundary | A generated CLI works without skill/model invocation and uses shared correctness rules. |
| 16 Cache isolation | Ordinary Graft refreshes and incompatible cached graphs cannot satisfy conservative analysis. |
| 17 Test dependencies | Select modeled prerequisites or the full dependent group; preserve required order and resource constraints. |

Add targeted fixtures for callbacks, reflection, shared fixtures, generated code, resource changes and cross-project dependencies in every supported ecosystem. Compare proposed selection with full-suite runs on representative histories and deliberately introduced failures. Such comparison detects defects; it does not prove all language features are modeled.

## 14 Delivery sequence and open decisions

1. Pin the upstream revision and define schema version 1, exact endpoint semantics, conservative gaps and fallback behavior.

2. Implement snapshot analysis, conservative fact preservation, two-revision impact and strict cache/freshness validation in the fork.

3. Implement the shared CLI contract and a repository adapter for a real project, using reliable runner targets and an independently callable full command.

4. Create the setup skill to generate that adapter and configuration reproducibly, validate the integration and record the canonical command template.

5. Exercise the acceptance matrix, compare with full runs and measure total time. Extend runner/language precision without weakening fallback behavior.

Required behavior is settled by this document. The following implementation choices remain open: fork/package naming and distribution; the first representative repositories and runner adapters; the storage format for local receipts; and the packaging of optional isolated-checkout execution. These choices do not change the required endpoint pair or the separation between impact calculation and verification evidence.

Later capabilities may include imported CI evidence, finer per-test selection, runtime dependency observations and richer integration-service metadata. The initial skill and generated CLI remain useful with broader reliable targets.

## 15 Sources

Source inspection date: 2 November 2026. Upstream links identify the implementation reviewed during design; main-branch content may change. The proposed interfaces in this document are design decisions, not claims that those interfaces already exist.

[1] Tree-sitter introduction and Graft package dependencies. [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)  |  [Graft package manifest](https://github.com/trailhq/Trail-Code/blob/main/package.json)

[2] Graft dependency resolution. [resolve.ts](https://github.com/trailhq/Trail-Code/blob/main/src/graph/resolve.ts)

[3] Changeset impact and test presentation grouping. [blast.ts](https://github.com/trailhq/Trail-Code/blob/main/src/blast/blast.ts)

[4] Git comparison semantics and blast command output. [diff.ts](https://github.com/trailhq/Trail-Code/blob/main/src/blast/diff.ts)  |  [blast-cli.ts](https://github.com/trailhq/Trail-Code/blob/main/src/blast/blast-cli.ts)

[5] Graph refresh and stale-result behavior. [refresh.ts](https://github.com/trailhq/Trail-Code/blob/main/src/graph/refresh.ts)

[6] Graph construction and cached extraction. [build.ts](https://github.com/trailhq/Trail-Code/blob/main/src/graph/build.ts)  |  [extract-cache.ts](https://github.com/trailhq/Trail-Code/blob/main/src/graph/extract-cache.ts)

[7] Graph schema and traversal. [types.ts](https://github.com/trailhq/Trail-Code/blob/main/src/graph/types.ts)  |  [traverse.ts](https://github.com/trailhq/Trail-Code/blob/main/src/graph/traverse.ts)

[8] Fingerprint and extraction cache identity. [fingerprint.ts](https://github.com/trailhq/Trail-Code/blob/main/src/graph/fingerprint.ts)

[9] Related work on static regression test selection. [STARTS research paper](https://mir.cs.illinois.edu/awshi2/publications/ASEDEMO2017.pdf)

[10] Related work on observed dependencies and test input contracts. [Testmon algorithm](https://www.testmon.org/blog/determining-affected-tests/)  |  [Bazel test specification](https://bazel.build/reference/test-encyclopedia)
