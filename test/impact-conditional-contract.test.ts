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
function run(dir: string, a: string, b: string, version?: number): Json {
  const r = invoke(dir, "--from", a, "--to", b, "--json", ...(version === undefined ? [] : ["--schema-version", String(version)]));
  assert.equal(r.status, 0, `impact failed: ${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout);
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
