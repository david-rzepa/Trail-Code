/** Internal fault-injection contract. This module is not a package export or user API. */
import { test } from "node:test";
import assert from "node:assert/strict";

// Import per test so the red baseline exercises every case even before the internal
// coordinator exists. Tests and implementation share this deliberately small seam.
async function coordinator(): Promise<any> {
  return import("../src/impact/coordinator.js");
}

type Files = Record<string, string>;
type Event = { kind: "change" | "add" | "remove" | "rename" | "overflow" | "lost"; path?: string };
type Mutation = "edit" | "addition" | "rename" | "edit-and-revert" | "overflow" | "lost";
type Phase = "enumerate" | "read" | "seal";

/** A deterministic backend; a phase callback acts as a barrier without sleeps. */
function backend(options: { strategy?: "immutable" | "observed"; mutation?: Mutation; phase?: Phase; covered?: boolean } = {}) {
  let live: Files = { "a.ts": "before-a", "b.ts": "before-b" };
  let snapshot: Files | undefined;
  let fired = false;
  const events: Event[] = [];
  const stages: string[] = [];
  function at(phase: Phase) {
    stages.push(phase);
    if (phase !== options.phase || fired || !options.mutation) return;
    fired = true;
    switch (options.mutation) {
      case "edit": live["a.ts"] = "after-a"; events.push({ kind: "change", path: "a.ts" }); break;
      case "addition": live["new.ts"] = "added"; events.push({ kind: "add", path: "new.ts" }); break;
      case "rename": live["moved.ts"] = live["b.ts"]; delete live["b.ts"]; events.push({ kind: "rename", path: "b.ts" }); break;
      case "edit-and-revert": live["a.ts"] = "temporary"; events.push({ kind: "change", path: "a.ts" }); live["a.ts"] = "before-a"; events.push({ kind: "change", path: "a.ts" }); break;
      case "overflow": events.push({ kind: "overflow" }); break;
      case "lost": events.push({ kind: "lost" }); break;
    }
  }
  return {
    stages,
    get live() { return { ...live }; },
    strategy: options.strategy ?? "observed",
    async acquire() {
      stages.push("acquire");
      if (options.strategy === "immutable") snapshot = { ...live };
      return { strategy: options.strategy ?? "observed", identity: "snapshot-1" };
    },
    async observe() { stages.push("observe"); return { covered: options.covered !== false }; },
    async enumerate() { at("enumerate"); return Object.keys(snapshot ?? live).sort(); },
    async read(path: string) { at("read"); return (snapshot ?? live)[path]; },
    async seal() { at("seal"); return { events: [...events], covered: options.covered !== false }; },
    async cleanup() { stages.push("cleanup"); },
  };
}

for (const phase of ["enumerate", "read", "seal"] as const) {
  for (const mutation of ["edit", "addition", "rename", "edit-and-revert", "overflow", "lost"] as const) {
    test(`observed capture invalidates ${mutation} at ${phase}`, async () => {
      const fake = backend({ phase, mutation });
      const { captureWorktree } = await coordinator();
      const out = await captureWorktree({ backend: fake, maxAttempts: 1 });
      assert.equal(out.status, "unavailable", `must not return a fingerprint for ${mutation} at ${phase}`);
      assert.ok(!out.fingerprint);
      assert.ok(fake.stages.indexOf("observe") < fake.stages.indexOf("enumerate"));
      assert.ok(fake.stages.includes("cleanup"));
    });
  }
}

test("observed capture refuses incomplete observation coverage", async () => {
  const fake = backend({ covered: false });
  const { captureWorktree } = await coordinator();
  const out = await captureWorktree({ backend: fake, maxAttempts: 1 });
  assert.equal(out.status, "unavailable");
  assert.ok(!out.fingerprint);
  assert.ok(fake.stages.includes("cleanup"));
});

test("observed capture seals stable contents with observation established before enumeration", async () => {
  const fake = backend();
  const { captureWorktree } = await coordinator();
  const out = await captureWorktree({ backend: fake, maxAttempts: 1 });
  assert.equal(out.status, "captured");
  assert.ok(typeof out.fingerprint === "string" && out.fingerprint.length > 0);
  assert.deepEqual(out.files, { "a.ts": "before-a", "b.ts": "before-b" });
  assert.ok(fake.stages.indexOf("observe") < fake.stages.indexOf("enumerate"));
  assert.ok(fake.stages.includes("cleanup"));
});

test("immutable acquisition keeps a coherent inventory and bytes despite later live edits", async () => {
  const fake = backend({ strategy: "immutable", phase: "enumerate", mutation: "rename" });
  const { captureWorktree } = await coordinator();
  const out = await captureWorktree({ backend: fake, maxAttempts: 1 });
  assert.equal(out.status, "captured");
  assert.deepEqual(out.files, { "a.ts": "before-a", "b.ts": "before-b" });
  assert.deepEqual(fake.live, { "a.ts": "before-a", "moved.ts": "before-b" });
  assert.equal(out.snapshotIdentity, "snapshot-1");
  assert.ok(out.fingerprint);
  assert.ok(fake.stages.includes("cleanup"));
});

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
