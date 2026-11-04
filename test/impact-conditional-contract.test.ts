/** Black-box coverage of v2's conditional model; no runner or receipt claims. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cli = resolve("src/cli.ts");
const tsx = import.meta.resolve("tsx");
type Json = Record<string, any>;
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "impact-conditional-"));
  try {
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.name", "Impact Test");
    git(dir, "config", "user.email", "impact@example.invalid");
    fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function file(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}
function commit(dir: string, label: string): string {
  git(dir, "add", "-A"); git(dir, "commit", "--allow-empty", "-m", label);
  return git(dir, "rev-parse", "HEAD");
}
function invoke(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsx, cli, "impact", ...args], {
    cwd: dir, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, NO_COLOR: "1" },
  });
}
function validateV2(out: Json, dir: string, a: string, b: string): void {
  assert.equal(out.schema_version, 2);
  assert.ok(out.analysis_identity && typeof out.analysis_identity === "object");
  assert.equal(out.analysis_identity.mode, "conservative");
  for (const key of ["analyzer_version", "grammar_identity", "extractor_identity", "resolver_identity", "policy_identity"]) {
    assert.ok(typeof out.analysis_identity[key] === "string" && out.analysis_identity[key].length > 0, `missing ${key}`);
  }
  for (const [key, expected] of [["from", a], ["to", b]] as const) {
    const ep = out.comparison?.[key];
    assert.ok(ep && typeof ep === "object", `missing ${key} endpoint`);
    assert.equal(ep.kind, "commit");
    assert.equal(ep.requested, expected);
    assert.equal(ep.commit, expected);
    assert.match(ep.commit, /^[0-9a-f]{40,64}$/);
    assert.match(ep.tree, /^[0-9a-f]{40,64}$/);
    assert.equal(ep.tree, git(dir, "rev-parse", `${expected}^{tree}`));
    assert.ok(typeof ep.fingerprint === "string" && ep.fingerprint.length > 0);
  }
  for (const key of ["changes", "affected", "analysis_gaps", "required_fallback_scopes", "context_requirements"]) {
    assert.ok(Array.isArray(out[key]), `${key} must be an array`);
  }
  assert.ok(typeof out.supported_model?.id === "string" && out.supported_model.id.length > 0);
  assert.ok(typeof out.supported_model?.version === "string" && out.supported_model.version.length > 0);
  for (const change of out.changes) {
    assert.ok(["added", "modified", "removed", "renamed"].includes(change.kind));
    assert.ok(change.old_path === null || typeof change.old_path === "string");
    assert.ok(change.new_path === null || typeof change.new_path === "string");
    assert.ok(Array.isArray(change.old_entities) && change.old_entities.every((x: unknown) => typeof x === "string"));
    assert.ok(Array.isArray(change.new_entities) && change.new_entities.every((x: unknown) => typeof x === "string"));
    if (change.kind === "added") assert.ok(change.old_path === null && typeof change.new_path === "string");
    if (change.kind === "removed") assert.ok(typeof change.old_path === "string" && change.new_path === null);
    if (change.kind === "modified") assert.ok(typeof change.old_path === "string" && change.old_path === change.new_path);
    if (change.kind === "renamed") assert.ok(typeof change.old_path === "string" && typeof change.new_path === "string" && change.old_path !== change.new_path);
  }
  for (const item of out.affected) {
    assert.ok(["from", "to"].includes(item.revision));
    assert.ok(typeof item.path === "string" && item.path.length > 0 && !item.path.includes("\\"));
    assert.ok(item.entity === null || typeof item.entity === "string");
    assert.ok(Array.isArray(item.reasons) && item.reasons.length > 0);
    for (const reason of item.reasons) {
      assert.ok(["changed", "dependency", "fallback"].includes(reason.kind));
      assert.ok(typeof reason.detail === "string" && reason.detail.length > 0);
    }
  }
  for (const gap of out.analysis_gaps) {
    assert.ok(["from", "to"].includes(gap.revision));
    assert.ok(gap.path === null || typeof gap.path === "string");
    assert.ok(typeof gap.kind === "string" && gap.kind.length > 0);
    assert.ok(typeof gap.detail === "string" && gap.detail.length > 0);
    assert.ok(gap.scope === null || (typeof gap.scope === "string" && gap.scope.length > 0));
  }
  for (const fallback of out.required_fallback_scopes) {
    assert.ok(["scope", "full_profile"].includes(fallback.kind));
    assert.ok(typeof fallback.reason === "string" && fallback.reason.length > 0);
    assert.ok(fallback.kind === "full_profile" ? fallback.scope === null : typeof fallback.scope === "string" && fallback.scope.length > 0);
  }
  const ids = new Set<string>();
  for (const req of out.context_requirements) {
    assert.ok(typeof req.id === "string" && req.id.length > 0 && !ids.has(req.id));
    ids.add(req.id);
    assert.ok(typeof req.kind === "string" && req.kind.length > 0);
    assert.ok(typeof req.evidence_kind === "string" && req.evidence_kind.length > 0);
    assert.ok(req.predicate && typeof req.predicate === "object" && !Array.isArray(req.predicate));
    assert.ok(typeof req.predicate.op === "string" && req.predicate.op.length > 0);
  }
  assert.ok(["complete", "bounded", "incomplete", "conditional"].includes(out.analysis_status));
  const unbounded = out.analysis_gaps.some((g: Json) => g.scope === null);
  const hasFull = out.required_fallback_scopes.some((f: Json) => f.kind === "full_profile" && f.scope === null);
  for (const gap of out.analysis_gaps) {
    if (gap.scope === null) assert.ok(hasFull, "unbounded gap needs full fallback");
    else assert.ok(hasFull || out.required_fallback_scopes.some((f: Json) => f.kind === "scope" && f.scope === gap.scope), "bounded gap needs its scope or full fallback");
  }
  if (out.analysis_status === "complete") assert.equal(out.analysis_gaps.length, 0);
  if (out.analysis_status === "bounded") assert.ok(out.analysis_gaps.length > 0 && !unbounded);
  if (out.analysis_status === "incomplete") assert.ok(unbounded && hasFull);
  if (out.analysis_status === "conditional") assert.ok(!unbounded && out.context_requirements.length > 0);
}
function run(dir: string, a: string, b: string, version?: number): Json {
  const r = invoke(dir, "--from", a, "--to", b, "--json", ...(version === undefined ? [] : ["--schema-version", String(version)]));
  assert.equal(r.status, 0, `impact failed: ${r.stderr}\n${r.stdout}`);
  const out = JSON.parse(r.stdout);
  if (version === 2) validateV2(out, dir, a, b);
  return out;
}
function repo(dir: string): { a: string; b: string } {
  file(dir, "package.json", JSON.stringify({ name: "independent-targets", private: true, type: "module" }));
  file(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" } }));
  file(dir, "src/a.ts", "export function a() { return 1; }\n");
  file(dir, "src/b.ts", "export function b() { return 1; }\n");
  file(dir, "tests/a.ts", "import { a } from '../src/a.js';\nexport function testA() { return a(); }\n");
  file(dir, "tests/b.ts", "import { b } from '../src/b.js';\nexport function testB() { return b(); }\n");
  const a = commit(dir, "two independent static test chains");
  file(dir, "src/a.ts", "export function a() { return 2; }\n");
  const b = commit(dir, "change only A");
  return { a, b };
}
function full(out: Json): boolean {
  return out.required_fallback_scopes.some((x: Json) => x.kind === "full_profile" && x.scope === null);
}

test("schema versions are explicit, supported and commit-only", () => fixture(dir => {
  const { a, b } = repo(dir);
  const v1 = run(dir, a, b), explicit = run(dir, a, b, 1);
  assert.equal(v1.schema_version, 1);
  assert.deepEqual(explicit, v1, "explicit v1 must preserve the default report");
  assert.notEqual(v1.analysis_status, "conditional");
  assert.ok(full(v1), "v1 cannot omit runtime dependencies using v2-only conditions");
  for (const version of ["0", "3", "unknown"]) {
    const r = invoke(dir, "--from", a, "--to", b, "--json", "--schema-version", version);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.length > 0);
    assert.throws(() => JSON.parse(r.stdout));
  }
  const worktree = invoke(dir, "--from", a, "--to", "worktree", "--json", "--schema-version", "2");
  assert.equal(worktree.status, 2, worktree.stderr);
  assert.ok(worktree.stderr.length > 0);
  assert.throws(() => JSON.parse(worktree.stdout));
}));

test("v2 reports conditional static impact and all independent evidence predicates", () => fixture(dir => {
  const { a, b } = repo(dir);
  const out = run(dir, a, b, 2);
  assert.equal(out.schema_version, 2);
  assert.equal(out.analysis_status, "conditional", "the supported static case should be useful without claiming unconditional completeness");
  assert.equal(out.comparison.from.kind, "commit");
  assert.equal(out.comparison.from.commit, a);
  assert.equal(out.comparison.to.kind, "commit");
  assert.equal(out.comparison.to.commit, b);
  assert.ok(typeof out.supported_model?.id === "string" && out.supported_model.id.length > 0);
  assert.ok(typeof out.supported_model?.version === "string" && out.supported_model.version.length > 0);
  assert.ok(Array.isArray(out.context_requirements) && out.context_requirements.length > 0);
  const requirements = out.context_requirements as Json[];
  const ids = requirements.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length, "requirement IDs must be unique");
  for (const id of ["runtime", "runner", "inventory", "resolver", "inputs", "environment", "baseline"]) {
    const entries = requirements.filter(x => x.id === id);
    assert.equal(entries.length, 1, `missing or duplicated ${id}`);
    const item = entries[0];
    assert.ok(typeof item.kind === "string" && item.kind.length > 0);
    assert.equal(typeof item.evidence_kind, "string"); assert.ok(item.evidence_kind.length > 0);
    assert.ok(item.predicate && typeof item.predicate === "object" && !Array.isArray(item.predicate));
    assert.ok(typeof item.predicate.op === "string" && item.predicate.op.length > 0);
  }
  const inventory = requirements.find(x => x.id === "inventory")!;
  assert.equal(inventory.kind, "inventory");
  assert.equal(inventory.evidence_kind, "runner_discovery");
  assert.deepEqual(inventory.predicate, { op: "complete_inventory_for_target_and_profile" });
  const baseline = requirements.find(x => x.id === "baseline")!;
  assert.equal(baseline.kind, "baseline");
  assert.equal(baseline.evidence_kind, "receipt_validation");
  assert.deepEqual(baseline.predicate, { op: "compatible_passing_receipt_for_from_and_profile" });
  assert.ok(out.changes.some((x: Json) => x.old_path === "src/a.ts" && x.new_path === "src/a.ts"));
  assert.ok(out.affected.some((x: Json) => x.path === "tests/a.ts"), "reverse closure must include A's dependent target");
  assert.ok(!out.affected.some((x: Json) => x.path === "tests/b.ts"), "the independent B target should not be in A's static impact");
  assert.ok(!full(out), "a supported conditional report cannot silently always force the full profile");
  assert.ok(!out.analysis_gaps.some((x: Json) => x.scope === null), "unbounded gaps cannot be conditional");
  assert.deepEqual(run(dir, a, b, 2), out, "model, requirements and impact must be reproducible");
}));

test("v2 does not hide dynamic module-loading gaps behind conditional status", () => fixture(dir => {
  file(dir, "package.json", JSON.stringify({ name: "dynamic-loader", private: true, type: "module" }));
  file(dir, "src/load.ts", "export async function load(name: string) { return import(name); }\n");
  const a = commit(dir, "dynamic import");
  file(dir, "src/load.ts", "export async function load(name: string) { return import('./' + name); }\n");
  const b = commit(dir, "change dynamic import");
  const out = run(dir, a, b, 2);
  assert.equal(out.schema_version, 2);
  assert.equal(out.analysis_status, "incomplete");
  assert.ok(Array.isArray(out.analysis_gaps) && out.analysis_gaps.some((g: Json) => g.scope === null));
  assert.ok(full(out), "unbounded loader gap must force the full profile");
}));

test("v2 includes file-level import-time effects even with no symbol call", () => fixture(dir => {
  file(dir, "package.json", JSON.stringify({ name: "side-effect", private: true, type: "module" }));
  file(dir, "src/effect.ts", "(globalThis as any).registration = 1;\n");
  file(dir, "tests/side-effect.ts", "import '../src/effect.js';\nexport const ready = true;\n");
  const a = commit(dir, "side-effect chain");
  file(dir, "src/effect.ts", "(globalThis as any).registration = 2;\n");
  const b = commit(dir, "change imported module");
  const out = run(dir, a, b, 2);
  assert.ok(out.affected.some((x: Json) => x.path === "tests/side-effect.ts") || full(out), "import-time dependency must reach the target or force full fallback");
  if (out.analysis_gaps.some((x: Json) => x.scope === null)) {
    assert.equal(out.analysis_status, "incomplete");
    assert.ok(full(out));
  }
}));


test("v2 unresolved imports cannot be declared conditionally complete", () => fixture(dir => {
  file(dir, "package.json", JSON.stringify({ name: "missing-import", private: true, type: "module" }));
  file(dir, "src/entry.ts", "export const value = 1;\n");
  const a = commit(dir, "no unresolved imports");
  file(dir, "src/entry.ts", "import { missing } from './missing.js';\nexport const value = missing;\n");
  const b = commit(dir, "unresolved import");
  const out = run(dir, a, b, 2);
  assert.equal(out.analysis_status, "incomplete");
  assert.ok(out.analysis_gaps.some((g: Json) => g.scope === null));
  assert.ok(full(out));
}));

test("v2 contract checks detect malformed identity, provenance and fallback", () => fixture(dir => {
  const a = commit(dir, "tree"), tree = git(dir, "rev-parse", `${a}^{tree}`);
  const endpoint = { requested: a, kind: "commit", commit: a, tree, fingerprint: `git-tree:${tree}` };
  const valid: Json = {
    schema_version: 2,
    analysis_identity: { mode: "conservative", analyzer_version: "1", grammar_identity: "1", extractor_identity: "1", resolver_identity: "1", policy_identity: "1" },
    supported_model: { id: "node-static", version: "1" },
    comparison: { from: endpoint, to: endpoint },
    changes: [], affected: [], analysis_gaps: [], required_fallback_scopes: [],
    context_requirements: [{ id: "runtime", kind: "runtime", predicate: { op: "supported_runtime" }, evidence_kind: "runtime_observation" }],
    analysis_status: "conditional",
  };
  assert.doesNotThrow(() => validateV2(valid, dir, a, a));
  assert.throws(() => validateV2({ ...valid, analysis_identity: {} }, dir, a, a));
  assert.throws(() => validateV2({ ...valid, comparison: { from: { ...endpoint, tree: "0".repeat(40) }, to: endpoint } }, dir, a, a));
  assert.throws(() => validateV2({ ...valid, affected: [{ revision: "to", path: "test.ts", entity: null, reasons: [] }] }, dir, a, a));
  assert.throws(() => validateV2({ ...valid, analysis_gaps: [{ revision: "to", path: null, kind: "unknown", detail: "unknown", scope: null }] }, dir, a, a));
  assert.throws(() => validateV2({ ...valid, context_requirements: [] }, dir, a, a));
}));

for (const [description, malformed] of [
  ["missing closing brace", "export function read() { return 1;\n"],
  ["missing closing parenthesis", "export const value = (1 + 2;\n"],
] as const) {
  for (const revision of ["from", "to"] as const) {
    test(`v2 reports parser recovery for ${description} on ${revision}`, () => fixture(dir => {
      file(dir, "package.json", JSON.stringify({ name: "parser-recovery", private: true, type: "module" }));
      file(dir, "src/input.ts", "export function read() { return 1; }\n");
      const good = commit(dir, "valid input");
      file(dir, "src/input.ts", malformed);
      const bad = commit(dir, "malformed input");
      const out = revision === "to" ? run(dir, good, bad, 2) : run(dir, bad, good, 2);
      assert.equal(out.analysis_status, "incomplete", `parser recovery at ${revision} must not be conditional`);
      assert.ok(out.analysis_gaps.some((g: Json) => g.revision === revision && g.path === "src/input.ts" && g.scope === null), `missing unbounded ${revision} parse gap`);
      assert.ok(full(out), `parser recovery at ${revision} requires full-profile fallback`);
    }));
  }
}

/** A conventional Go module with independent packages and a cross-package caller.
 * It is analyzed as committed source; executing go test belongs to the runner goal. */
function goProject(dir: string): void {
  file(dir, "go.mod", "module example.test/prices\n\ngo 1.22\n");
  file(dir, "a/a.go", "package a\n\nfunc Price(x int) int { return x * 2 }\n");
  file(dir, "a/a_test.go", "package a\n\nimport \"testing\"\n\nfunc TestPrice(t *testing.T) { if Price(2) != 4 { t.Fatal(\"bad price\") } }\n");
  file(dir, "b/b.go", "package b\n\nfunc Name() string { return \"b\" }\n");
  file(dir, "b/b_test.go", "package b\n\nimport \"testing\"\n\nfunc TestName(t *testing.T) { if Name() != \"b\" { t.Fatal(\"bad name\") } }\n");
  file(dir, "consumer/consumer.go", "package consumer\n\nimport \"example.test/prices/a\"\n\nfunc Total() int { return a.Price(2) }\n");
  file(dir, "consumer/consumer_test.go", "package consumer\n\nimport \"testing\"\n\nfunc TestTotal(t *testing.T) { if Total() != 4 { t.Fatal(\"bad total\") } }\n");
}
function affected(out: Json, path: string, revision?: "from" | "to"): boolean {
  return out.affected.some((x: Json) => x.path === path && (!revision || x.revision === revision));
}

test("v2 Go model selects a changed package and cross-package dependents without B", () => fixture(dir => {
  goProject(dir);
  const a = commit(dir, "baseline Go module");
  file(dir, "a/a.go", "package a\n\nfunc Price(x int) int { return x + x }\n");
  const b = commit(dir, "change package a");
  const out = run(dir, a, b, 2);
  assert.equal(out.analysis_status, "conditional", "a conventional static Go module must have a working conditional slice");
  assert.ok(!full(out), "the Go acceptance slice cannot be met by full-profile fallback");
  assert.ok(affected(out, "a/a_test.go"), "same-package tests depend on changed Go source");
  assert.ok(affected(out, "consumer/consumer.go"), "the importing package depends on A");
  assert.ok(affected(out, "consumer/consumer_test.go"), "tests in a dependent package must be included");
  assert.ok(!affected(out, "b/b_test.go"), "unrelated B package must remain outside the calculated impact");
  assert.deepEqual(run(dir, a, b, 2), out, "Go model and requirement identities must be deterministic");
}));

test("v2 Go import deletion retains old package dependents", () => fixture(dir => {
  goProject(dir);
  const a = commit(dir, "before import removal");
  file(dir, "consumer/consumer.go", "package consumer\n\nfunc Total() int { return 4 }\n");
  const b = commit(dir, "remove package import");
  const out = run(dir, a, b, 2);
  assert.ok(affected(out, "consumer/consumer_test.go", "from") || affected(out, "consumer/consumer_test.go", "to") || full(out), "both endpoint graphs must preserve surviving dependent tests");
  assert.ok(out.changes.some((c: Json) => c.old_path === "consumer/consumer.go" && c.new_path === "consumer/consumer.go"));
}));

test("v2 keeps unresolved Go import provenance and cannot silently narrow", () => fixture(dir => {
  goProject(dir);
  const a = commit(dir, "resolvable module");
  file(dir, "consumer/consumer.go", "package consumer\n\nimport \"example.test/prices/missing\"\n\nfunc Total() int { return missing.Price(2) }\n");
  const b = commit(dir, "introduce missing package");
  const out = run(dir, a, b, 2);
  const gaps = out.analysis_gaps.filter((g: Json) => g.path === "consumer/consumer.go" && g.revision === "to");
  assert.ok(gaps.some((g: Json) => JSON.stringify(g).includes("example.test/prices/missing")), "retain the unresolved raw import and source revision");
  assert.ok(gaps.some((g: Json) => g.scope === null && full(out)) || gaps.some((g: Json) => typeof g.scope === "string" && out.required_fallback_scopes.some((f: Json) => f.kind === "scope" && f.scope === g.scope)), "unknown import needs an unbounded or justified bounded fallback");
  assert.notEqual(out.analysis_status, "complete");
}));

test("Go embedded resource changes retain cross-package dependents without unjustified global fallback", () => fixture(dir => {
  goProject(dir);
  file(dir, "a/a.go", "package a\n\nimport _ \"embed\"\n\n//go:embed price.txt\nvar priceData string\n\nfunc Price(x int) int { return x * 2 }\n");
  file(dir, "a/price.txt", "first\n");
  const a = commit(dir, "tracked embedded resource");
  file(dir, "a/price.txt", "second\n");
  const b = commit(dir, "change embedded resource");
  const out = run(dir, a, b, 2);
  assert.equal(out.analysis_status, "conditional", "a proven package boundary should support conditional scoped impact");
  assert.ok(!full(out), "an embedded resource constrained to A's package cannot justify an unbounded global fallback");
  assert.ok(affected(out, "a/a_test.go"), "A tests consume the resource-owning package");
  assert.ok(affected(out, "consumer/consumer_test.go"), "a bounded package impact must include tests outside its scope");
  assert.ok(!affected(out, "b/b_test.go"), "unrelated package B should not be selected");
  for (const gap of out.analysis_gaps) {
    assert.ok(typeof gap.scope === "string" && gap.scope.length > 0, "remaining uncertainty must have a justified bounded scope");
    assert.ok(out.required_fallback_scopes.some((f: Json) => f.kind === "scope" && f.scope === gap.scope));
    assert.ok(typeof gap.detail === "string" && gap.detail.length > 0);
  }
}));

test("v2 practical TypeScript project handles ordinary functions and built-in test imports", () => fixture(dir => {
  file(dir, "package.json", JSON.stringify({ name: "practical-ts", private: true, type: "module", scripts: { test: "tsx --test test/*.test.ts" }, devDependencies: { tsx: "^4.22.4", typescript: "^6.0.3" } }));
  file(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true } }));
  file(dir, "src/a.ts", "export interface Order { amount: number }\nexport function total(order: Order): number { const tax = 2; return order.amount + tax; }\n");
  file(dir, "src/b.ts", "export function greeting(name: string): string { return `hello ${name}`; }\n");
  file(dir, "test/a.test.ts", "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/a.js';\ntest('total', () => assert.equal(total({ amount: 2 }), 4));\n");
  file(dir, "test/b.test.ts", "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greeting } from '../src/b.js';\ntest('greeting', () => assert.equal(greeting('Ada'), 'hello Ada'));\n");
  const a = commit(dir, "ordinary TypeScript project");
  file(dir, "src/a.ts", "export interface Order { amount: number }\nexport function total(order: Order): number { const tax = 2; return tax + order.amount; }\n");
  const b = commit(dir, "change first target dependency");
  const out = run(dir, a, b, 2);
  assert.equal(out.analysis_status, "conditional");
  assert.ok(!full(out));
  assert.ok(affected(out, "test/a.test.ts"));
  assert.ok(!affected(out, "test/b.test.ts"));
}));

test("v2 inverse Go change selects B and leaves A and A's consumer alone", () => fixture(dir => {
  goProject(dir);
  const a = commit(dir, "baseline independent Go packages");
  file(dir, "b/b.go", "package b\n\nfunc Name() string { return \"b\" + \"\" }\n");
  const b = commit(dir, "change only B");
  const out = run(dir, a, b, 2);
  assert.equal(out.analysis_status, "conditional", "a supported B-only change should be selective");
  assert.ok(!full(out));
  assert.ok(affected(out, "b/b_test.go"), "B package tests must be included");
  assert.ok(!affected(out, "a/a_test.go"), "unrelated A tests must not be included");
  assert.ok(!affected(out, "consumer/consumer_test.go"), "A's dependent tests do not depend on B");
}));

test("v2 Go deletion reaches surviving tests through old cross-package imports or falls back fully", () => fixture(dir => {
  goProject(dir);
  const a = commit(dir, "before deletion of imported A");
  rmSync(join(dir, "a/a.go"));
  const b = commit(dir, "remove A source but retain tests and importing consumer");
  const out = run(dir, a, b, 2);
  assert.ok(out.changes.some((c: Json) => c.kind === "removed" && c.old_path === "a/a.go" && c.new_path === null));
  assert.ok(affected(out, "consumer/consumer_test.go", "from") || full(out), "old A-to-consumer graph must cover the surviving consumer tests or require full fallback");
  assert.ok(affected(out, "a/a_test.go", "from") || full(out), "surviving package tests must be selected or covered by full fallback");
}));
