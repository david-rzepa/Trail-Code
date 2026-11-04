/** Internal fault-injection contract. This module is not a package export or user API. */
import { test } from "node:test";
import assert from "node:assert/strict";

// Import per test so the red baseline exercises every case even before the internal
// coordinator exists. Tests and implementation share this deliberately small seam.
async function coordinator(): Promise<any> {
  return import("../src/impact/coordinator.js");
}

const identity = { snapshot: "tree-B", mode: "conservative", policy: "v1", version: "v1" };
function store(entry: any, opts: { refreshFails?: boolean; publishFails?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async read() { calls.push("read"); return entry; },
    async refresh(key: any) {
      calls.push("refresh");
      if (opts.refreshFails) throw new Error("injected refresh failure");
      return { identity: key, value: { files: ["current.ts"] } };
    },
    async publish(value: any) {
      calls.push("publish");
      if (opts.publishFails) throw new Error("injected atomic publish failure");
      entry = value;
    },
  };
}
for (const [label, old] of [
  ["wrong snapshot", { ...identity, snapshot: "tree-A" }],
  ["navigation mode", { ...identity, mode: "navigation" }],
  ["wrong policy", { ...identity, policy: "old" }],
  ["incompatible version", { ...identity, version: "v0" }],
] as const) {
  test(`cache rejects ${label} and returns only rebuilt current identity`, async () => {
    const fake = store({ identity: old, value: { files: ["stale.ts"] } });
    const { loadConservativeGraph } = await coordinator();
    const out = await loadConservativeGraph({ cache: fake, identity });
    assert.equal(out.status, "current");
    assert.deepEqual(out.identity, identity);
    assert.deepEqual(out.value, { files: ["current.ts"] });
    assert.ok(fake.calls.includes("refresh"));
  });
}
for (const fault of ["refreshFails", "publishFails"] as const) {
  test(`cache ${fault} cannot promote stale data to current`, async () => {
    const fake = store({ identity: { ...identity, snapshot: "tree-A" }, value: { files: ["stale.ts"] } }, { [fault]: true });
    const { loadConservativeGraph } = await coordinator();
    const out = await loadConservativeGraph({ cache: fake, identity });
    assert.notEqual(out.status, "current");
    assert.notDeepEqual(out.value, { files: ["stale.ts"] });
  });
}

/** Internal boundary accepts injected Git and materializer to expose exact-tree failures. */
function treeBackend(fault?: "resolve" | "tree" | "blob" | "materialize") {
  const calls: string[] = [];
  let branch = "commit-A";
  const git = {
    async resolve(ref: string) {
      calls.push(`resolve:${ref}`);
      if (fault === "resolve") throw new Error("missing commit");
      const result = { commit: branch, tree: "tree-A" };
      branch = "commit-B"; // branch moves immediately after it is resolved
      return result;
    },
    async readTree(tree: string) {
      calls.push(`tree:${tree}`);
      if (fault === "tree") throw new Error("missing tree object");
      return [{ path: "source.ts", mode: "100644", oid: "blob-A" }];
    },
    async readBlob(oid: string) {
      calls.push(`blob:${oid}`);
      if (fault === "blob") throw new Error("corrupt blob");
      return "export const a = 1;";
    },
  };
  const materializer = {
    async writeTree(entries: unknown) {
      calls.push("materialize");
      if (fault === "materialize") throw new Error("containment or materialization failure");
      return entries;
    },
    async cleanup() { calls.push("cleanup"); },
  };
  return { calls, git, materializer };
}

test("committed analysis binds a moved ref to the originally resolved tree", async () => {
  const { readCommittedSnapshot } = await coordinator();
  const fake = treeBackend();
  const result = await readCommittedSnapshot({ git: fake.git, materializer: fake.materializer, ref: "branch" });
  assert.equal(result.status, "captured");
  assert.equal(result.commit, "commit-A");
  assert.equal(result.tree, "tree-A");
  assert.equal(fake.calls.filter(x => x.startsWith("resolve:")).length, 1);
  assert.ok(fake.calls.includes("tree:tree-A"));
  assert.ok(fake.calls.includes("blob:blob-A"));
  assert.ok(fake.calls.includes("cleanup"));
});
for (const fault of ["resolve", "tree", "blob", "materialize"] as const) {
  test(`unavailable committed ${fault} cannot become a valid snapshot`, async () => {
    const { readCommittedSnapshot } = await coordinator();
    const fake = treeBackend(fault);
    const result = await readCommittedSnapshot({ git: fake.git, materializer: fake.materializer, ref: "branch" });
    assert.notEqual(result.status, "captured");
    assert.ok(!result.fingerprint);
    if (fake.calls.includes("materialize")) assert.ok(fake.calls.includes("cleanup"));
  });
}
