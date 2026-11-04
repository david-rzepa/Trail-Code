import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { tmpdir } from "node:os";
import { certifyNodeStatic } from "../src/impact/node-static.js";

const packageJson=JSON.stringify({name:"static-model-fixture",private:true,type:"module"});
const tsconfig=JSON.stringify({compilerOptions:{module:"NodeNext",moduleResolution:"NodeNext",target:"ES2022"}});
const safe = {
  "package.json":packageJson,"tsconfig.json":tsconfig,
  "src/a.ts":"export function a() { return 1; }\n",
  "src/b.ts":"export function b() { return 8; }\n",
  "tests/a.ts":"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.js';\ntest('a', () => { assert.strictEqual(a(), 1); });\n",
  "tests/b.ts":"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { b } from '../src/b.js';\ntest('b', () => { assert.strictEqual(b(), 8); });\n",
};
const map=(v:Record<string,string>)=>new Map(Object.entries(v).map(([p,s])=>[p,Buffer.from(s)]));

test("conditional model certifies simple Node builtin tests and static dependencies", async () => {
  const model=await certifyNodeStatic(map(safe));assert.ok(model);
  assert.deepEqual(model.imports.get("tests/a.ts"),["src/a.ts"]);
  assert.deepEqual(model.imports.get("tests/b.ts"),["src/b.ts"]);
  assert.deepEqual(model.builtins,["node:assert/strict","node:test"]);
});

test("uncertain syntax and execution hooks are never statically certified", async () => {
  const cases: Record<string,Record<string,string>> = {
    "dynamic import": {...safe,"src/a.ts":"export async function a() { return import('./b.js'); }\n"},
    "computed load": {...safe,"src/a.ts":"export function a() { return globalThis['a']; }\n"},
    "require": {...safe,"src/a.ts":"export function a() { return require('./b.js'); }\n"},
    "external package": {...safe,"src/a.ts":"import other from 'other'; export function a() { return other(); }\n"},
    "unknown relative import": {...safe,"src/a.ts":"import { missing } from './missing.js'; export function a() { return missing(); }\n"},
    "mutable module": {...safe,"src/a.ts":"let state = 1; export function a() { return state++; }\n"},
    "initializer side effect": {...safe,"src/a.ts":"console.log('side effect'); export function a() { return 1; }\n"},
    "dynamic registration": {...safe,"tests/a.ts":"import { test } from 'node:test'; test('a', () => globalThis.x());\n"},
    "test hooks": {...safe,"tests/a.ts":"import { before } from 'node:test'; before(() => {});\n"},
    "resource": {...safe,"data.json":"{}"},
    "loader config": {...safe,"tsconfig.json":JSON.stringify({compilerOptions:{module:"NodeNext",moduleResolution:"NodeNext",target:"ES2022",plugins:[{name:"custom"}]}})},
    "package scripts": {...safe,"package.json":JSON.stringify({name:"x",type:"module",scripts:{test:"node --require ./hook.js --test"}})},
    "import attributes": {...safe,"tests/a.ts":"import { a } from '../src/a.js' with { type: 'json' }; export function t() { return a(); }\n"},
    "syntax error": {...safe,"src/a.ts":"export function a( {\n"},
  };
  for (const [label,input] of Object.entries(cases)) assert.equal(await certifyNodeStatic(map(input)),null,label);
});

test("re-exports and side-effect imports carry whole-file dependencies", async () => {
  const input={...safe,"src/bridge.ts":"export { a } from './a.js';\n","tests/a.ts":"import '../src/bridge.js';\nexport function check() { return 1; }\n"};
  const model=await certifyNodeStatic(map(input));assert.ok(model);
  assert.deepEqual(model.imports.get("src/bridge.ts"),["src/a.ts"]);
  assert.deepEqual(model.imports.get("tests/a.ts"),["src/bridge.ts"]);
});

test("real CLI includes transitive static imports and emits mandatory builtin requirements", () => {
  const dir=mkdtempSync(join(tmpdir(),"impact-node-model-"));
  const git=(...args:string[]) => {const r=spawnSync("git",args,{cwd:dir,encoding:"utf8"});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const file=(p:string,s:string)=>{const target=join(dir,p);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,s);};
  try {
    git("init","-b","main");git("config","user.name","Test");git("config","user.email","test@example.invalid");
    for(const [p,s] of Object.entries(safe)) file(p,s);
    file("src/bridge.ts","export { a } from './a.js';\n");
    file("tests/a.ts",safe["tests/a.ts"].replace("../src/a.js","../src/bridge.js"));
    git("add",".");git("commit","-m","before");const from=git("rev-parse","HEAD");
    file("src/a.ts","export function a() { return 2; }\n");git("add",".");git("commit","-m","after");const to=git("rev-parse","HEAD");
    const r=spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),resolve("src/cli.ts"),"impact","--from",from,"--to",to,"--json","--schema-version","2"],{cwd:dir,encoding:"utf8",env:{...process.env,HOME:dir},timeout:120000});
    assert.equal(r.status,0,r.stderr);const report=JSON.parse(r.stdout);
    assert.equal(report.analysis_status,"conditional",JSON.stringify(report.analysis_gaps));
    for(const revision of ["from","to"]) {
      const paths=new Set(report.affected.filter((x:any)=>x.revision===revision).map((x:any)=>x.path));
      for(const p of ["src/a.ts","src/bridge.ts","tests/a.ts"]) assert.ok(paths.has(p),`${revision}: missing ${p}`);
      for(const p of ["src/b.ts","tests/b.ts"]) assert.ok(!paths.has(p),`${revision}: unexpectedly affected ${p}`);
    }
    assert.deepEqual(report.supported_model,{id:"node-typescript-static-esm",version:"1"});
    const req=report.context_requirements.map((x:any)=>x.id);
    assert.ok(req.includes("dependency:node:test"));assert.ok(req.includes("dependency:node:assert/strict"));
    assert.deepEqual(req,[...req].sort());
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test("selected target detects a deliberate failure while independent target passes", () => {
  const dir=mkdtempSync(join(tmpdir(),"impact-node-execution-"));
  const git=(...args:string[]) => {const r=spawnSync("git",args,{cwd:dir,encoding:"utf8"});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const file=(p:string,body:string)=>{const target=join(dir,p);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,body);};
  const output=mkdtempSync(join(tmpdir(),"impact-node-built-"));
  const compile=(a:string)=>{
    mkdirSync(output,{recursive:true});writeFileSync(join(output,"package.json"),JSON.stringify({type:"module"}));
    for(const [p,source] of Object.entries({...safe,"src/a.ts":a})) if(p.endsWith(".ts")) {
      const target=join(output,p.replace(/\.ts$/,".js"));mkdirSync(dirname(target),{recursive:true});
      const result=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
      writeFileSync(target,result.outputText);
    }
  };
  const run=(...tests:string[])=>{
    const env={...process.env}; delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath,["--test",...tests.map(x=>join(output,"tests",`${x}.js`))],{cwd:output,encoding:"utf8",timeout:120000,env});
  };
  try {
    git("init","-b","main");git("config","user.name","Test");git("config","user.email","test@example.invalid");
    for(const [p,s] of Object.entries(safe)) file(p,s);
    git("add",".");git("commit","-m","before");const from=git("rev-parse","HEAD");
    compile(safe["src/a.ts"]);assert.equal(run("a","b").status,0,"full baseline must pass");
    file("src/a.ts","export function a() { return 2; }\n");git("add",".");git("commit","-m","after");const to=git("rev-parse","HEAD");
    compile("export function a() { return 2; }\n");
    const impact=spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),resolve("src/cli.ts"),"impact","--from",from,"--to",to,"--json","--schema-version","2"],{cwd:dir,encoding:"utf8",env:{...process.env,HOME:dir},timeout:120000});
    assert.equal(impact.status,0,impact.stderr);const out=JSON.parse(impact.stdout);assert.equal(out.analysis_status,"conditional");
    const targets=new Set(out.affected.filter((x:any)=>x.revision==="to").map((x:any)=>x.path));
    assert.ok(targets.has("tests/a.ts"));assert.ok(!targets.has("tests/b.ts"));
    const selected=run("a");assert.notEqual(selected.status,0,`the selected test must detect the deliberate regression: ${selected.stdout} ${selected.stderr}`);
    assert.equal(run("b").status,0,"the independent test remains passing");
    assert.notEqual(run("a","b").status,0,"the full target must also detect the deliberate regression");
  } finally {rmSync(output,{recursive:true,force:true});rmSync(dir,{recursive:true,force:true});}
});
