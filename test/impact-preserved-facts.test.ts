import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RawEdge } from "../src/graph/extract.js";
import type { NodeV1 } from "../src/graph/types.js";
import { preserveCandidates } from "../src/impact/facts.js";

function node(id: string, name: string, kind: NodeV1["kind"], path: string, owner?: string): NodeV1 {
  return {id,name,kind,path,owner,span:"L1-L1",signature:null,exported:false,origin:"ast",body_hash:"x",summary_state:"pending",summary:null,crux:null};
}
const caller = node("a.ts#caller", "caller", "function", "a.ts");

test("preserves every local ambiguous callable with call-site provenance", () => {
  const nodes = [caller,node("a.ts#f~2","f","function","a.ts"),node("a.ts#f","f","function","a.ts"),node("b.ts#f","f","function","b.ts")];
  const raw: RawEdge[] = [{source:caller.id,file:"a.ts",relation:"calls",name:"f"}];
  const result = preserveCandidates(nodes,raw);
  assert.deepEqual(result.facts[0],{path:"a.ts",source:caller.id,relation:"calls",name:"f",basis:"local-name",candidates:["a.ts#f","a.ts#f~2"]});
  assert.deepEqual(result.edges.map(e => e.target),["a.ts#f","a.ts#f~2"]);
  assert.ok(result.edges.every(e => e.confidence === "inferred"));
});

test("receiver-qualified overloads are retained without unrelated names", () => {
  const nodes = [caller,node("a.ts#A.run","run","method","a.ts","A"),node("a.ts#A.run~2","run","method","a.ts","A"),node("a.ts#B.run","run","method","a.ts","B")];
  const result = preserveCandidates(nodes,[{source:caller.id,file:"a.ts",relation:"calls",name:"run",viaMember:true,recvType:"A"}]);
  assert.deepEqual(result.facts[0].candidates,["a.ts#A.run","a.ts#A.run~2"]);
  assert.equal(result.facts[0].basis,"receiver-owner");
});

test("unknown calls remain explicit even when no defensible candidate exists", () => {
  const raw: RawEdge[] = [{source:caller.id,file:"a.ts",relation:"calls",name:"missing",viaMember:true}];
  const result = preserveCandidates([caller],raw);
  assert.deepEqual(result.facts,[{path:"a.ts",source:caller.id,relation:"calls",name:"missing",basis:"unknown",candidates:[]}]);
  assert.deepEqual(result.edges,[]);
});

test("relative named references retain all matching extension variants", () => {
  const nodes = [caller,node("lib.ts#Thing","Thing","class","lib.ts"),node("lib.tsx#Thing","Thing","class","lib.tsx"),node("other.ts#Thing","Thing","class","other.ts")];
  const raw: RawEdge[] = [{source:caller.id,file:"a.ts",relation:"references",name:"Thing",specifier:"./lib.js"}];
  const result = preserveCandidates(nodes,raw);
  assert.deepEqual(result.facts[0].candidates,["lib.ts#Thing","lib.tsx#Thing"]);
  assert.equal(result.facts[0].basis,"module-specifier");
  assert.ok(result.edges.every(e => e.relation === "references"));
});

test("real impact report retains ambiguous and unresolved call facts after warm cache", () => {
  const dir = mkdtempSync(join(tmpdir(),"impact-facts-"));
  const git = (...args:string[]) => {
    const r = spawnSync("git",args,{cwd:dir,encoding:"utf8"});
    assert.equal(r.status,0,r.stderr); return r.stdout.trim();
  };
  try {
    git("init","-b","main"); git("config","user.name","Test"); git("config","user.email","test@example.invalid");
    writeFileSync(join(dir,"a.ts"),"function same() {}\nfunction same() {}\nexport function caller() { same(); missing(); }\n");
    writeFileSync(join(dir,"bad.ts"),Buffer.from([0xfe,0xff,0x00,0x66]));
    writeFileSync(join(dir,".gitignore"),"excluded.ts\n");
    writeFileSync(join(dir,"excluded.ts"),"export const overlooked = 1;\n");
    git("add","."); git("add","-f","excluded.ts"); git("commit","-m","before"); const from = git("rev-parse","HEAD");
    writeFileSync(join(dir,"a.ts"),"function same() { return 1; }\nfunction same() {}\nexport function caller() { same(); missing(); }\n");
    git("add","."); git("commit","-m","after"); const to = git("rev-parse","HEAD");
    const invoke = () => {
      const r = spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),resolve("src/cli.ts"),"impact","--from",from,"--to",to,"--json"],{cwd:dir,encoding:"utf8",env:{...process.env,HOME:dir},timeout:120000});
      assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout);
    };
    const first = invoke(); const second = invoke();
    assert.deepEqual(second,first);
    const same = first.analysis_gaps.find((g:any) => g.revision === "to" && g.kind === "unresolved_call" && g.name === "same");
    assert.ok(same, "ambiguous raw call must remain visible");
    assert.equal(same.candidates.length,2);
    const missing = first.analysis_gaps.find((g:any) => g.revision === "to" && g.kind === "unresolved_call" && g.name === "missing");
    assert.deepEqual(missing.candidates,[]);
    assert.ok(first.analysis_gaps.some((g:any) => g.kind === "unsupported_encoding" && g.path === "bad.ts"));
    assert.ok(first.analysis_gaps.some((g:any) => g.kind === "unindexed_source" && g.path === "bad.ts"));
    assert.equal(first.analysis_status,"incomplete");
    assert.ok(first.required_fallback_scopes.some((s:any) => s.kind === "full_profile"));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
