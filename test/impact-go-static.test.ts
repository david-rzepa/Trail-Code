import assert from "node:assert/strict";
import {test} from "node:test";
import {certifyGoStatic} from "../src/impact/go-static.js";
const base:Record<string,string>={
  "go.mod":"module example.test/p\n\ngo 1.22\n",
  "a/a.go":"package a\nfunc Value() int { return 1 }\n",
  "a/a_test.go":"package a\nimport \"testing\"\nfunc TestValue(t *testing.T) { if Value() != 1 { t.Fatal(\"bad\") } }\n",
  "consumer/c.go":"package consumer\nimport \"example.test/p/a\"\nfunc Read() int { return a.Value() }\n",
};
const map=(v:Record<string,string>)=>new Map(Object.entries(v).map(([p,s])=>[p,Buffer.from(s)]));
test("Go package facts preserve import and package provenance",async()=>{
  const issues:unknown[]=[];const model=await certifyGoStatic(map({...base,"README.md":"docs"}),x=>issues.push(x));assert.ok(model);assert.deepEqual(issues,[]);
  assert.ok(model.imports.get("a/a_test.go")?.includes("a/a.go"));
  assert.deepEqual(model.provenance.get("consumer/c.go")?.get("a/a.go"),["Go import example.test/p/a"]);
});
test("Go unknown inputs and unbounded source constructs fail closed",async()=>{
  for(const [name,extra] of Object.entries({
    unresolved:{"consumer/c.go":"package consumer\nimport \"example.test/p/missing\"\n"},
    external:{"a/a.go":"package a\nimport \"os\"\n"},
    cgo:{"a/a.go":"package a\nimport \"C\"\n"},
    buildTag:{"a/a.go":"//go:build linux\n\npackage a\n"},
    generated:{"a/a.go":"package a\n//go:generate run\n"},
    unknownResource:{"a/input.txt":"value"},
    embedGlob:{"a/a.go":"package a\nimport _ \"embed\"\n//go:embed *.txt\nvar value string\n","a/input.txt":"value"},
    parseError:{"a/a.go":"package a\nfunc Broken() {\n"},
  })) {const issues:unknown[]=[];assert.equal(await certifyGoStatic(map({...base,...extra}),x=>issues.push(x)),null,name);assert.ok(issues.length,name);}
});

test("embedded input reports a bounded package scope and cross-package dependents",async()=>{
  const {spawnSync}=await import("node:child_process"); const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import("node:fs");const {join,dirname,resolve}=await import("node:path");const {tmpdir}=await import("node:os");
  const dir=mkdtempSync(join(tmpdir(),"impact-go-boundary-"));
  const run=(cmd:string,args:string[])=>{const r=spawnSync(cmd,args,{cwd:dir,encoding:"utf8"});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const put=(p:string,s:string)=>{const f=join(dir,p);mkdirSync(dirname(f),{recursive:true});writeFileSync(f,s);};
  try {
    run("git",["init","-b","main"]);run("git",["config","user.name","test"]);run("git",["config","user.email","test@example.invalid"]);
    for(const [p,s] of Object.entries({...base,"a/a.go":"package a\nimport _ \"embed\"\n//go:embed data.txt\nvar data string\nfunc Value() int { return 1 }\n","a/data.txt":"before"})) put(p,s);
    run("git",["add","."]);run("git",["commit","-m","before"]);const from=run("git",["rev-parse","HEAD"]);
    put("a/data.txt","after");run("git",["add","."]);run("git",["commit","-m","after"]);const to=run("git",["rev-parse","HEAD"]);
    const cli=resolve("src/cli.ts");const r=spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),cli,"impact","--from",from,"--to",to,"--json","--schema-version","2"],{cwd:dir,encoding:"utf8"});assert.equal(r.status,0,r.stderr);
    const report=JSON.parse(r.stdout);assert.equal(report.analysis_status,"conditional");
    const gaps=report.analysis_gaps.filter((g:{kind:string})=>g.kind==="opaque_embedded_resource");assert.equal(gaps.length,2);
    for(const gap of gaps) {assert.equal(gap.scope,"go-package:example.test/p:a");assert.deepEqual(gap.boundary.model,{id:"go-static-packages",version:"1"});assert.equal(gap.boundary.package_path,"a");assert.ok(report.required_fallback_scopes.some((s:{kind:string;scope:string})=>s.kind==="scope"&&s.scope===gap.scope));}
    assert.ok(report.affected.some((a:{path:string})=>a.path==="consumer/c.go"));assert.ok(!report.required_fallback_scopes.some((s:{kind:string})=>s.kind==="full_profile"));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
