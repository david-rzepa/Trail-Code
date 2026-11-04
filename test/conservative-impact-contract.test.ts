/** Black-box contract for conservative impact; real Git endpoints and the actual CLI. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cli = resolve("src/cli.ts");
const tsx = import.meta.resolve("tsx");
const oid = /^[0-9a-f]{40,64}$/;

type Json = Record<string, any>;
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "impact-contract-"));
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
  git(dir, "add", "-A");
  git(dir, "commit", "--allow-empty", "-m", label);
  return git(dir, "rev-parse", "HEAD");
}
function invoke(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsx, cli, "impact", ...args], {
    cwd: dir, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, NO_COLOR: "1" },
  });
}
/** Independently validate the safety relation between gaps, status and fallback. */
function assertGapFallback(out: Json): void {
  assert.ok(["complete", "bounded", "incomplete"].includes(out.analysis_status));
  assert.ok(Array.isArray(out.analysis_gaps));
  assert.ok(Array.isArray(out.required_fallback_scopes));
  const gaps: Json[] = out.analysis_gaps;
  const fallbacks: Json[] = out.required_fallback_scopes;
  const full = fallbacks.some(s => s.kind === "full_profile" && s.scope === null);
  for (const gap of gaps) {
    if (gap.scope === null) {
      assert.ok(full, "unbounded gap requires full-profile fallback");
    } else {
      assert.ok(typeof gap.scope === "string" && gap.scope.length > 0);
      assert.ok(full || fallbacks.some(s => s.kind === "scope" && s.scope === gap.scope),
        `bounded gap ${gap.scope} requires a matching dependent scope or full fallback`);
    }
  }
  const unbounded = gaps.some(g => g.scope === null);
  if (out.analysis_status === "complete") assert.equal(gaps.length, 0, "complete status cannot contain a gap");
  if (out.analysis_status === "bounded") {
    assert.ok(gaps.length > 0, "bounded status requires a gap");
    assert.equal(unbounded, false, "unbounded gaps require incomplete status");
  }
  if (out.analysis_status === "incomplete") {
    assert.ok(unbounded, "incomplete status requires an unbounded gap");
    assert.ok(full, "incomplete status requires full-profile fallback");
  }
}

function report(dir: string, from: string, to: string): Json {
  const r = invoke(dir, "--from", from, "--to", to, "--json");
  assert.equal(r.status, 0, `impact failed: ${r.stderr}\n${r.stdout}`);
  let out: Json;
  try { out = JSON.parse(r.stdout); } catch { assert.fail(`not a single JSON report: ${r.stdout}`); }
  assert.equal(out.schema_version, 1);
  const identity = out.analysis_identity;
  assert.equal(identity.mode, "conservative");
  for (const key of ["analyzer_version", "grammar_identity", "extractor_identity", "resolver_identity", "policy_identity"])
    assert.ok(typeof identity[key] === "string" && identity[key].length > 0, key);
  for (const key of ["from", "to"]) {
    const ep = out.comparison[key];
    assert.equal(ep.requested, key === "from" ? from : to);
    assert.ok(typeof ep.fingerprint === "string" && ep.fingerprint.length > 0);
    if (ep.kind === "commit") { assert.match(ep.commit, oid); assert.match(ep.tree, oid); }
    else assert.equal(ep.kind, "worktree");
  }
  assert.equal(out.comparison.from.kind, "commit");
  for (const key of ["changes", "affected", "analysis_gaps", "required_fallback_scopes"]) assert.ok(Array.isArray(out[key]), key);
  for (const c of out.changes) {
    assert.ok(["added", "modified", "removed", "renamed"].includes(c.kind));
    assert.ok(Array.isArray(c.old_entities)); assert.ok(Array.isArray(c.new_entities));
    assert.ok(c.old_path === null || typeof c.old_path === "string");
    assert.ok(c.new_path === null || typeof c.new_path === "string");
  }
  for (const a of out.affected) {
    assert.ok(["from", "to"].includes(a.revision));
    assert.equal(typeof a.path, "string");
    assert.ok(a.entity === null || typeof a.entity === "string");
    assert.ok(Array.isArray(a.reasons) && a.reasons.length > 0);
    for (const reason of a.reasons) {
      assert.ok(["changed", "dependency", "fallback"].includes(reason.kind));
      assert.ok(typeof reason.detail === "string" && reason.detail.length > 0);
    }
  }
  for (const gap of out.analysis_gaps) {
    assert.ok(["from", "to"].includes(gap.revision));
    assert.ok(typeof gap.kind === "string" && gap.kind.length > 0);
    assert.ok(typeof gap.detail === "string" && gap.detail.length > 0);
    assert.ok(gap.scope === null || (typeof gap.scope === "string" && gap.scope.length > 0));
    if (gap.scope === null) assert.ok(out.required_fallback_scopes.some((s: Json) => s.kind === "full_profile" && s.scope === null));
  }
  for (const scope of out.required_fallback_scopes) {
    assert.ok(["scope", "full_profile"].includes(scope.kind));
    assert.ok(typeof scope.reason === "string" && scope.reason.length > 0);
    assert.ok(scope.kind === "full_profile" ? scope.scope === null : typeof scope.scope === "string" && scope.scope.length > 0);
  }
  assertGapFallback(out);
  return out;
}

test("impact requires explicit endpoints, rejects duplicate endpoints and unknown refs", () => fixture(dir => {
  const id = commit(dir, "base");
  for (const args of [[], ["--from", id], ["--to", id], ["--from", id, "--to", "does-not-exist"], ["--from", id, "--from", id, "--to", id], ["--from", "worktree", "--to", id]]) {
    const r = invoke(dir, ...args, "--json");
    assert.equal(r.status, 2, `expected input error for ${args.join(" ")}; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stderr, /unknown command/i);
    assert.ok(r.stderr.length > 0, `missing diagnostics for ${args.join(" ")}`);
    assert.throws(() => JSON.parse(r.stdout), `failure emitted a valid-looking JSON report for ${args.join(" ")}`);
  }
}));

test("equal empty commits produce a valid empty report and immutable identities", () => fixture(dir => {
  const id = commit(dir, "empty");
  const out = report(dir, id, id);
  assert.equal(out.comparison.from.commit, id);
  assert.equal(out.comparison.to.commit, id);
  assert.equal(out.comparison.from.tree, git(dir, "rev-parse", `${id}^{tree}`));
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.affected, []);
  assert.deepEqual(out.analysis_gaps, []);
  assert.equal(out.analysis_status, "complete");
}));

test("diverged endpoints compare exact trees rather than only the merge base", () => fixture(dir => {
  file(dir, "root.ts", "export const root = 1;\n");
  const root = commit(dir, "root");
  file(dir, "only-a.ts", "export const a = 1;\n");
  const a = commit(dir, "A");
  git(dir, "checkout", "--detach", root);
  file(dir, "only-b.ts", "export const b = 1;\n");
  const b = commit(dir, "B");
  const out = report(dir, a, b);
  assert.ok(out.changes.some((c: Json) => c.kind === "removed" && c.old_path === "only-a.ts" && c.new_path === null));
  assert.ok(out.changes.some((c: Json) => c.kind === "added" && c.new_path === "only-b.ts" && c.old_path === null));
  assert.equal(out.comparison.from.commit, a); assert.equal(out.comparison.to.commit, b);
}));

test("deletions and dependency chains retain old revision impact beyond default navigation depth", () => fixture(dir => {
  file(dir, "src/base.ts", "export function base() { return 1; }\n");
  for (let n = 1; n <= 7; n++) file(dir, `src/c${n}.ts`, `import { ${n === 1 ? "base" : `c${n-1}`} } from './${n === 1 ? "base" : `c${n-1}`}.js';\nexport function c${n}() { return ${n === 1 ? "base" : `c${n-1}`}(); }\n`);
  const a = commit(dir, "base chain");
  rmSync(join(dir, "src/base.ts"));
  const b = commit(dir, "remove dependency");
  const out = report(dir, a, b);
  assert.ok(out.changes.some((c: Json) => c.kind === "removed" && c.old_path === "src/base.ts"));
  assert.ok(out.affected.some((x: Json) => x.revision === "from" && x.path === "src/c7.ts") || out.required_fallback_scopes.some((x: Json) => x.kind === "full_profile"), "old dependency or full fallback must cover surviving caller");
}));

test("unbounded dynamic lookup requires a global gap and full fallback", () => fixture(dir => {
  file(dir, "src/registry.ts", "export function dispatch(name: string) { return (globalThis as any)[name](); }\n");
  file(dir, "src/target.ts", "export function target() { return 1; }\n");
  file(dir, "src/caller.ts", "import { dispatch } from './registry.js';\nexport function caller() { return dispatch('target'); }\n");
  const a = commit(dir, "dynamic call");
  file(dir, "src/registry.ts", "export function dispatch(name: string) { return (globalThis as any)[name](42); }\n");
  const b = commit(dir, "modify dynamic call");
  const out = report(dir, a, b);
  assert.ok(out.analysis_gaps.some((g: Json) => g.scope === null && g.revision === "to"), "unbounded global lookup requires an explicit unbounded gap");
  assert.equal(out.analysis_status, "incomplete");
  assert.ok(out.required_fallback_scopes.some((s: Json) => s.kind === "full_profile" && s.scope === null));
}));

test("cold and warm analyses have deterministic reports and do not modify source", () => fixture(dir => {
  file(dir, "src/x.ts", "export const x = 1;\n");
  const a = commit(dir, "first");
  file(dir, "src/x.ts", "export const x = 2;\n");
  const b = commit(dir, "second");
  const before = readFileSync(join(dir, "src/x.ts"), "utf8");
  const cold = report(dir, a, b); const warm = report(dir, a, b);
  assert.deepEqual(warm, cold);
  assert.equal(readFileSync(join(dir, "src/x.ts"), "utf8"), before);
  assert.equal(git(dir, "rev-parse", "HEAD"), b);
}));

test("worktree target includes staged, unstaged, untracked and deleted paths when capture is available", () => fixture(dir => {
  file(dir, "staged.ts", "export const a = 1;\n"); file(dir, "unstaged.ts", "export const b = 1;\n"); file(dir, "deleted.ts", "export const c = 1;\n");
  const a = commit(dir, "baseline");
  file(dir, "staged.ts", "export const a = 2;\n"); git(dir, "add", "staged.ts");
  file(dir, "unstaged.ts", "export const b = 2;\n"); file(dir, "new.ts", "export const d = 1;\n"); rmSync(join(dir, "deleted.ts"));
  const r = invoke(dir, "--from", a, "--to", "worktree", "--json");
  if (r.status !== 0) { assert.match(r.stderr, /capture|snapshot|observ/i, "unavailable coherent capture needs a specific diagnostic"); assert.throws(() => JSON.parse(r.stdout)); return; }
  const out = JSON.parse(r.stdout);
  assert.equal(out.comparison.to.kind, "worktree");
  for (const p of ["staged.ts", "unstaged.ts", "new.ts", "deleted.ts"]) assert.ok(out.changes.some((c: Json) => c.old_path === p || c.new_path === p), `missing ${p}`);
}));

test("old and new sides of a changed file are both represented", () => fixture(dir => {
  file(dir, "src/change.ts", "export function f() { return 1; }\n");
  const a = commit(dir, "old");
  file(dir, "src/change.ts", "export function f() { return 2; }\n");
  const b = commit(dir, "new");
  const out = report(dir, a, b);
  const change = out.changes.find((c: Json) => c.kind === "modified" && c.old_path === "src/change.ts" && c.new_path === "src/change.ts");
  assert.ok(change, "modified file must retain both paths");
  for (const revision of ["from", "to"]) assert.ok(out.affected.some((x: Json) => x.revision === revision && x.path === "src/change.ts"));
}));

test("renamed sources preserve removal and addition or explicit old and new paths", () => fixture(dir => {
  file(dir, "src/old.ts", "export const relocated = 1;\n");
  const a = commit(dir, "old name");
  git(dir, "mv", "src/old.ts", "src/new.ts");
  const b = commit(dir, "new name");
  const out = report(dir, a, b);
  const rename = out.changes.some((c: Json) => c.kind === "renamed" && c.old_path === "src/old.ts" && c.new_path === "src/new.ts");
  const separate = out.changes.some((c: Json) => c.kind === "removed" && c.old_path === "src/old.ts") && out.changes.some((c: Json) => c.kind === "added" && c.new_path === "src/new.ts");
  assert.ok(rename || separate, "a rename must not disappear");
  assert.ok(out.affected.some((x: Json) => x.revision === "from" && x.path === "src/old.ts"));
  assert.ok(out.affected.some((x: Json) => x.revision === "to" && x.path === "src/new.ts"));
}));

test("adding a shadowing symbol cannot silently exclude an unchanged caller", () => fixture(dir => {
  file(dir, "src/lib.ts", "export function choose(x: number): number { return x; }\n");
  file(dir, "src/caller.ts", "import { choose } from './lib.js';\nexport function caller() { return choose(1); }\n");
  const a = commit(dir, "caller and original");
  file(dir, "src/lib.ts", "export function choose(x: string): string;\nexport function choose(x: number): number;\nexport function choose(x: string | number) { return x; }\n");
  const b = commit(dir, "new overload");
  const out = report(dir, a, b);
  assert.ok(out.affected.some((x: Json) => x.path === "src/caller.ts") || out.required_fallback_scopes.some((x: Json) => x.kind === "full_profile"), "rebinding must reach caller or force full fallback");
}));

test("a failed parse or unsupported input is never a gap-free exclusion", () => fixture(dir => {
  file(dir, "src/broken.ts", "export function valid() { return 1; }\n");
  const a = commit(dir, "valid");
  file(dir, "src/broken.ts", "export function broken( { /* unfinished\n");
  const b = commit(dir, "invalid syntax");
  const out = report(dir, a, b);
  assert.ok(out.analysis_gaps.some((g: Json) => g.revision === "to") && out.required_fallback_scopes.length > 0, "a parse failure must be reported and broaden selection");
}));


test("cache reuse honors snapshot identities after warming a different comparison", () => fixture(dir => {
  file(dir, "src/changed.ts", "export const a = 1;\n");
  const a = commit(dir, "A");
  file(dir, "src/changed.ts", "export const a = 2;\n");
  const b = commit(dir, "B");
  const same = report(dir, b, b);
  assert.deepEqual(same.changes, []);
  const changed = report(dir, a, b);
  assert.equal(changed.comparison.from.commit, a);
  assert.equal(changed.comparison.to.commit, b);
  assert.ok(changed.changes.some((c: Json) => c.kind === "modified" && c.old_path === "src/changed.ts" && c.new_path === "src/changed.ts"));
  assert.ok(changed.affected.some((x: Json) => x.path === "src/changed.ts") || changed.required_fallback_scopes.some((x: Json) => x.kind === "full_profile"));
  const warmAgain = report(dir, b, b);
  assert.deepEqual(warmAgain, same);
}));

test("an unavailable target cannot reuse a previously valid cached report", () => fixture(dir => {
  file(dir, "src/known.ts", "export const a = 1;\n");
  const a = commit(dir, "known target");
  report(dir, a, a);
  const r = invoke(dir, "--from", a, "--to", "missing-target-ref", "--json");
  assert.notEqual(r.status, 0, "an unavailable target must not succeed from cache");
  assert.ok(r.stderr.length > 0);
  assert.throws(() => JSON.parse(r.stdout), "an unavailable target must not emit the prior valid report");
}));

test("navigation graph and later refresh cannot substitute for the conservative comparison", () => fixture(dir => {
  file(dir, "src/nav.ts", "export function source() { return 1; }\n");
  file(dir, "src/caller.ts", "import { source } from './nav.js';\nexport function caller() { return source(); }\n");
  const a = commit(dir, "before");
  const nav = spawnSync(process.execPath, ["--import", tsx, cli, "build", dir], { cwd: dir, encoding: "utf8", timeout: 120_000, env: { ...process.env, HOME: dir, USERPROFILE: dir } });
  assert.equal(nav.status, 0, `navigation build failed: ${nav.stderr}`);
  file(dir, "src/nav.ts", "export function source() { return 2; }\n");
  git(dir, "add", "src/nav.ts");
  git(dir, "commit", "-m", "after");
  const b = git(dir, "rev-parse", "HEAD");
  const out = report(dir, a, b);
  assert.equal(out.analysis_identity.mode, "conservative");
  assert.equal(out.comparison.from.commit, a);
  assert.equal(out.comparison.to.commit, b);
  assert.ok(out.changes.some((c: Json) => c.kind === "modified" && c.old_path === "src/nav.ts"));
  assert.ok(out.affected.some((x: Json) => x.path === "src/caller.ts") || out.required_fallback_scopes.some((x: Json) => x.kind === "full_profile"));
}));


test("gap/fallback consistency rejects missing or contradictory bounded scopes", () => {
  const bounded = { analysis_status: "bounded", analysis_gaps: [{ scope: "package:payments" }], required_fallback_scopes: [{ kind: "scope", scope: "package:payments" }] };
  assert.doesNotThrow(() => assertGapFallback(bounded));
  assert.throws(() => assertGapFallback({ ...bounded, required_fallback_scopes: [] }), /bounded gap/);
  assert.throws(() => assertGapFallback({ ...bounded, required_fallback_scopes: [{ kind: "scope", scope: "package:unrelated" }] }), /bounded gap/);
  assert.doesNotThrow(() => assertGapFallback({ ...bounded, required_fallback_scopes: [{ kind: "full_profile", scope: null }] }));
  assert.throws(() => assertGapFallback({ ...bounded, analysis_status: "complete" }), /complete status/);
  assert.throws(() => assertGapFallback({ ...bounded, analysis_gaps: [{ scope: null }], required_fallback_scopes: [{ kind: "full_profile", scope: null }] }), /unbounded gaps/);
  assert.throws(() => assertGapFallback({ ...bounded, analysis_status: "incomplete" }), /unbounded gap/);
  assert.throws(() => assertGapFallback({ analysis_status: "incomplete", analysis_gaps: [{ scope: null }], required_fallback_scopes: [] }), /unbounded gap/);
  assert.doesNotThrow(() => assertGapFallback({ analysis_status: "incomplete", analysis_gaps: [{ scope: null }], required_fallback_scopes: [{ kind: "full_profile", scope: null }] }));
});
