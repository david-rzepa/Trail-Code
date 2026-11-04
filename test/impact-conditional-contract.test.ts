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
  test(`v2 reports parser recovery for ${description} on both endpoint revisions`, () => fixture(dir => {
    file(dir, "package.json", JSON.stringify({ name: "parser-recovery", private: true, type: "module" }));
    file(dir, "src/input.ts", "export function read() { return 1; }\n");
    const good = commit(dir, "valid input");
    file(dir, "src/input.ts", malformed);
    const bad = commit(dir, "malformed input");
    for (const [from, to, revision] of [[good, bad, "to"], [bad, good, "from"]] as const) {
      const out = run(dir, from, to, 2);
      assert.equal(out.analysis_status, "incomplete", `parser recovery at ${revision} must not be conditional`);
      assert.ok(out.analysis_gaps.some((g: Json) => g.revision === revision && g.path === "src/input.ts" && g.scope === null), `missing unbounded ${revision} parse gap`);
      assert.ok(full(out), `parser recovery at ${revision} requires full-profile fallback`);
    }
  }));
}
