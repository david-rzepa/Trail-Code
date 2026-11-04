import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeV1 } from "../src/graph/types.js";
import type { RawEdge } from "../src/graph/extract.js";
import { preserveCandidates } from "../src/impact/facts.js";

function n(id: string, name: string, kind: NodeV1["kind"], path: string, owner?: string): NodeV1 {
  return {id,name,kind,path,owner,span:"L1-L1",signature:null,exported:false,origin:"ast",body_hash:"x",summary_state:"pending",summary:null,crux:null};
}

test("retains cross-file inherited and overridden receiver methods without a hop limit", () => {
  const nodes = [n("app.ts#caller","caller","function","app.ts"),n("base.ts#Base","Base","class","base.ts"),
    n("child.ts#Child","Child","class","child.ts"),n("grand.ts#Grand","Grand","class","grand.ts"),
    n("base.ts#Base.run","run","method","base.ts","Base"),n("child.ts#Child.run","run","method","child.ts","Child"),
    n("grand.ts#Grand.run","run","method","grand.ts","Grand"),n("other.ts#Other.run","run","method","other.ts","Other")];
  const raw: RawEdge[] = [
    {source:"child.ts#Child",file:"child.ts",relation:"extends",name:"Base"},
    {source:"grand.ts#Grand",file:"grand.ts",relation:"extends",name:"Child"},
    {source:"app.ts#caller",file:"app.ts",relation:"calls",name:"run",viaMember:true,recvType:"Base"},
  ];
  const result = preserveCandidates(nodes,raw);
  const call = result.facts.find(f => f.relation === "calls")!;
  assert.equal(call.basis,"receiver-hierarchy");
  assert.deepEqual(call.candidates,["base.ts#Base.run","child.ts#Child.run","grand.ts#Grand.run"]);
  assert.deepEqual(result.edges.filter(e => e.source === "app.ts#caller").map(e => e.target),call.candidates);
  assert.deepEqual(preserveCandidates([...nodes].reverse(),[...raw].reverse()),result);
});

test("ambiguous class identities retain each plausible receiver target", () => {
  const nodes = [n("caller","caller","function","a.py"),n("x.py#Service","Service","class","x.py"),
    n("y.py#Service","Service","class","y.py"),n("x.py#Service.run","run","method","x.py","Service"),
    n("y.py#Service.run","run","method","y.py","Service")];
  const raw: RawEdge[] = [{source:"caller",file:"a.py",relation:"calls",name:"run",viaMember:true,recvType:"Service"}];
  assert.deepEqual(preserveCandidates(nodes,raw).facts[0].candidates,["x.py#Service.run","y.py#Service.run"]);
});

test("real CLI preserves cross-file inherited candidates and unresolved provenance", async () => {
  const {mkdtempSync, rmSync, writeFileSync} = await import("node:fs");
  const {spawnSync} = await import("node:child_process");
  const {join, resolve} = await import("node:path");
  const {tmpdir} = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(),"impact-hierarchy-"));
  const git = (...args:string[]) => {
    const r = spawnSync("git",args,{cwd:dir,encoding:"utf8"});
    assert.equal(r.status,0,r.stderr); return r.stdout.trim();
  };
  try {
    git("init","-b","main"); git("config","user.name","Test"); git("config","user.email","test@example.invalid");
    writeFileSync(join(dir,"base.ts"),"export class Base { run() { return 1; } }\n");
    writeFileSync(join(dir,"child.ts"),"import { Base } from './base.js'; export class Child extends Base { run() { return 2; } }\n");
    writeFileSync(join(dir,"caller.ts"),"import { Base } from './base.js'; export function caller(b: Base) { b.run(); }\n");
    git("add","."); git("commit","-m","before"); const from = git("rev-parse","HEAD");
    writeFileSync(join(dir,"base.ts"),"export class Base { run() { return 3; } }\n");
    git("add","."); git("commit","-m","after"); const to = git("rev-parse","HEAD");
    const r = spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),resolve("src/cli.ts"),"impact","--from",from,"--to",to,"--json"],{cwd:dir,encoding:"utf8",env:{...process.env,HOME:dir},timeout:120000});
    assert.equal(r.status,0,r.stderr);
    const report = JSON.parse(r.stdout);
    const fact = report.analysis_gaps.find((g:any) => g.revision === "to" && g.kind === "unresolved_call" && g.name === "run" && g.path === "caller.ts");
    assert.ok(fact, "the raw call remains visible as an unresolved gap");
    assert.equal(fact.candidate_basis,"receiver-hierarchy");
    assert.ok(fact.candidates.some((id:string) => id.startsWith("base.ts#")));
    assert.ok(fact.candidates.some((id:string) => id.startsWith("child.ts#")));
    assert.equal(report.analysis_status,"incomplete");
    assert.ok(report.required_fallback_scopes.some((s:any) => s.kind === "full_profile"));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
