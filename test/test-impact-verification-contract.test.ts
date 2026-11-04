/**
 * G2's private integration seam, not a public config/CLI contract.
 *
 * The helper under test supplies runVerificationForTest(request, hooks).  The
 * request's fixture profile describes real commands and target IDs without
 * imposing a published configuration schema.  Hooks only observe child argv,
 * redirect the private receipt-store root, or mutate analyzer output to test
 * rejection; they must not manufacture collector evidence.  The normal
 * production entry point must use the same planner, validators and execution
 * implementation without these test-only overrides.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';

const analyzer = resolve('src/cli.ts');
const tsx = import.meta.resolve('tsx');
const engineFile = pathToFileURL(resolve('src/test-impact/verification.ts')).href;
type Result = Record<string, any>;
type Model = 'node' | 'go';
function command(cwd: string, executable: string, args: string[]) {
  const result = spawnSync(executable, args, {cwd, encoding:'utf8', timeout:120_000});
  assert.equal(result.error, undefined, `${executable}: ${result.error}`);
  return result;
}
function git(cwd: string, ...args: string[]) {
  const result=command(cwd,'git',args);
  assert.equal(result.status,0,`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function put(cwd: string, name: string, body: string) {
  const path=join(cwd,name); mkdirSync(dirname(path),{recursive:true});writeFileSync(path,body);
}
function commit(cwd: string, message: string) {
  git(cwd,'add','-A');git(cwd,'-c','commit.gpgsign=false','commit','--allow-empty','-m',message);return git(cwd,'rev-parse','HEAD');
}
function nodeFiles() {
  return {
    'package.json':JSON.stringify({name:'fixture',private:true,type:'module'}),
    'tsconfig.json':JSON.stringify({compilerOptions:{module:'NodeNext',moduleResolution:'NodeNext',target:'ES2022'}}),
    'src/a.ts':'export function value() { return 1; }\n',
    'src/b.ts':'export function value() { return 8; }\n',
    'tests/a.test.ts':"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/a.js';\ntest('a', () => { assert.strictEqual(value(), 1); });\n",
    'tests/b.test.ts':"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/b.js';\ntest('b', () => { assert.strictEqual(value(), 8); });\n",
  };
}
function goFiles() {
  return {
    'go.mod':'module example.test/fixture\n\ngo 1.22\n',
    'a/a.go':'package a\nfunc Value() int { return 1 }\n',
    'a/a_test.go':'package a\nimport "testing"\nfunc TestA(t *testing.T) { if Value() != 1 { t.Fatal("a") } }\n',
    'consumer/consumer.go':'package consumer\nimport "example.test/fixture/a"\nfunc Value() int { return a.Value() }\n',
    'consumer/consumer_test.go':'package consumer\nimport "testing"\nfunc TestConsumer(t *testing.T) { if Value() != 1 { t.Fatal("consumer") } }\n',
    'b/b.go':'package b\nfunc Value() int { return 8 }\n',
    'b/b_test.go':'package b\nimport "testing"\nfunc TestB(t *testing.T) { if Value() != 8 { t.Fatal("b") } }\n',
  };
}
interface Fixture { dir:string; state:string; a:string; b:string; model:Model; all:string[]; impacted:string[]; independent:string }
function fixture(model:Model):Fixture {
  const dir=mkdtempSync(join(tmpdir(),'test-impact-g2-git-'));
  const state=mkdtempSync(join(tmpdir(),'test-impact-g2-state-'));
  git(dir,'init','-b','main');git(dir,'config','user.name','Impact Fixture');git(dir,'config','user.email','impact@example.invalid');
  for(const [name,body] of Object.entries(model==='node'?nodeFiles():goFiles())) put(dir,name,body);
  const a=commit(dir,'baseline');
  if(model==='node') put(dir,'src/a.ts','export function value() { return 1 + 0; }\n');
  else put(dir,'a/a.go','package a\nfunc Value() int { return 1 + 0 }\n');
  const b=commit(dir,'change one component');
  return {dir,state,a,b,model,all:model==='node'?['tests/a.test.ts','tests/b.test.ts']:['./a','./b','./consumer'],impacted:model==='node'?['tests/a.test.ts']:['./a','./consumer'],independent:model==='node'?'tests/b.test.ts':'./b'};
}
function cleanup(f:Fixture) {rmSync(f.dir,{recursive:true,force:true});rmSync(f.state,{recursive:true,force:true});}
function checkout(f:Fixture,rev:string) {git(f.dir,'checkout','--detach',rev);}
function goResourceFixture():Fixture {
  const f=fixture('go');checkout(f,f.a);
  put(f.dir,'a/a.go','package a\nimport _ "embed"\n//go:embed data.txt\nvar data string\nfunc Value() int { return 1 }\n');
  put(f.dir,'a/data.txt','before\n');f.a=commit(f.dir,'baseline embedded input');
  put(f.dir,'a/data.txt','after\n');f.b=commit(f.dir,'change embedded input');return f;
}
function analyze(f:Fixture,from=f.a,to=f.b):Result {
  const child=command(f.dir,process.execPath,['--import',tsx,analyzer,'impact','--from',from,'--to',to,'--schema-version','2','--json']);
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
}
function hasGo():boolean {const result=spawnSync('go',['version'],{encoding:'utf8'});return result.status===0;}
function realFullRun(f:Fixture) {
  const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
  const executable=f.model==='go'?'go':process.execPath;
  const argv=f.model==='go'?['test','./...']:['--import',tsx,'--test',...f.all];
  const result=spawnSync(executable,argv,{cwd:f.dir,encoding:'utf8',timeout:120_000,env:environment});
  assert.equal(result.error,undefined,`${executable}: ${result.error}`);
  return result;
}
/** This is deliberately private: config and hooks are injected only by tests. */
async function verify(f:Fixture,args:string[], options:{mutate?:(report:Result)=>void; seen?:string[][]}={}):Promise<Result> {
  const module=await import(engineFile);
  assert.equal(typeof module.runVerificationForTest,'function','private test seam must call production verification core');
  return module.runVerificationForTest({
    cwd:f.dir, argv:args, stateRoot:f.state,
    fixtureProfile:{name:'default',model:f.model,targets:f.all},
  },{
    // The real analyzer and independent real collectors still run.  This hook
    // can only alter the report AFTER analysis to simulate untrusted output.
    transformImpact:(report:Result)=>{const copy=structuredClone(report);options.mutate?.(copy);return copy;},
    observeCommand:(argv:string[])=>options.seen?.push([...argv]),
  });
}
function units(report:Result):string[] {assert.ok(Array.isArray(report.execution_units));return report.execution_units;}
function full(report:Result) {assert.equal(report.selection_strategy,'full');}
function checkoutBaseline(f:Fixture) {checkout(f,f.a);}
async function establishBaseline(f:Fixture) {
  checkoutBaseline(f);const result=await verify(f,['--from',f.a,'--to',f.a,'--all','--json']);
  assert.equal(result.execution_status,'passed');assert.equal(result.verification_status,'validated');assert.ok(result.receipt_id);
  checkout(f,f.b);return result;
}

test('v2 Node analyzer supplies a real conditional changed-tree fixture',()=>{
  const f=fixture('node');try {const out=analyze(f);assert.equal(out.analysis_status,'conditional',JSON.stringify(out.analysis_gaps));assert.ok(out.affected.some((x:Result)=>x.path==='tests/a.test.ts'));assert.ok(!out.affected.some((x:Result)=>x.path==='tests/b.test.ts'));}finally{cleanup(f);}
});

test('Node execution uses a successful full baseline, then runs the affected target only',async()=>{
  const f=fixture('node');try {
    assert.equal(analyze(f).analysis_status,'conditional');
    checkoutBaseline(f);const baseline=realFullRun(f);assert.equal(baseline.status,0,baseline.stderr);
    checkout(f,f.b);const changed=realFullRun(f);assert.equal(changed.status,0,changed.stderr);
    await establishBaseline(f);
    const seen:string[][]=[];const result=await verify(f,['--from',f.a,'--to',f.b,'--json'],{seen});
    assert.equal(result.selection_strategy,'selective');assert.equal(result.execution_status,'passed');
    assert.ok(result.receipt_id,'successful selective verification should chain a receipt');
    assert.ok(units(result).includes(f.impacted[0]));assert.ok(!units(result).includes(f.independent));
    assert.ok(seen.some(argv=>argv.includes(f.impacted[0])),'real runner argv must execute affected target');
    assert.ok(!seen.some(argv=>argv.includes(f.independent)),'independent target must not execute');
  }finally{cleanup(f);}
});

test('Go execution runs changed package and dependents but excludes an independent package', {skip:!hasGo()},async()=>{
  const f=fixture('go');try {
    const impact=analyze(f);assert.equal(impact.analysis_status,'conditional',JSON.stringify(impact.analysis_gaps));
    assert.ok(impact.affected.some((x:Result)=>x.path==='consumer/consumer_test.go'));
    assert.ok(!impact.affected.some((x:Result)=>x.path==='b/b_test.go'));
    checkoutBaseline(f);const baseline=realFullRun(f);assert.equal(baseline.status,0,baseline.stderr);
    checkout(f,f.b);const changed=realFullRun(f);assert.equal(changed.status,0,changed.stderr);
    await establishBaseline(f);const seen:string[][]=[];const result=await verify(f,['--from',f.a,'--to',f.b,'--json'],{seen});
    assert.equal(result.selection_strategy,'selective');assert.equal(result.execution_status,'passed');
    for(const target of f.impacted) assert.ok(units(result).includes(target),`missing ${target}`);
    assert.ok(!units(result).includes(f.independent));
    assert.ok(seen.some(argv=>argv.some(x=>x===f.impacted[0])),'go test must execute the changed package');
    assert.ok(seen.some(argv=>argv.some(x=>x===f.impacted[1])),'go test must execute a dependent package');
    assert.ok(!seen.some(argv=>argv.includes(f.independent)),'unrelated package must not execute');
  }finally{cleanup(f);}
});

test('a bounded Go resource gap selects dependents outside its package without forcing all packages', {skip:!hasGo()},async()=>{
  const f=goResourceFixture();try {
    const impact=analyze(f);assert.equal(impact.analysis_status,'conditional',JSON.stringify(impact.analysis_gaps));
    assert.ok(impact.required_fallback_scopes.some((x:Result)=>x.kind==='scope' && x.scope==='go-package:example.test/fixture:a'));
    assert.ok(!impact.required_fallback_scopes.some((x:Result)=>x.kind==='full_profile'));
    assert.ok(impact.affected.some((x:Result)=>x.path==='consumer/consumer_test.go'));
    await establishBaseline(f);const seen:string[][]=[];
    const result=await verify(f,['--from',f.a,'--to',f.b,'--json'],{seen});
    assert.equal(result.selection_strategy,'selective');assert.equal(result.execution_status,'passed');
    for(const target of f.impacted) assert.ok(units(result).includes(target),`missing bounded dependent ${target}`);
    assert.ok(!units(result).includes(f.independent));
    assert.ok(!seen.some(argv=>argv.includes(f.independent)),'bounded fallback must not execute unrelated packages');
  }finally{cleanup(f);}
});

test('a missing compatible baseline expands impact to a complete execution',async()=>{
  const f=fixture('node');try {assert.equal(analyze(f).analysis_status,'conditional');
    const result=await verify(f,['--from',f.a,'--to',f.b,'--json']);full(result);
    assert.equal(result.execution_status,'passed');assert.equal(result.verification_status,'validated');assert.ok(result.receipt_id);
    assert.ok(result.calculated_affected_units.includes(f.impacted[0]));
  }finally{cleanup(f);}
});

test('a plan never executes or creates a receipt and rejects unsupported endpoints',async()=>{
  const f=fixture('node');try {
    const seen:string[][]=[];const result=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json'],{seen});
    assert.equal(result.execution_status,'not_run');assert.equal(result.verification_status,'not_performed');assert.ok(!result.receipt_id);
    assert.ok(!seen.some(a=>a.includes('--test')),'planning must not execute test commands');
    for(const args of [[],['--from',f.a],['--to',f.b],['--from',f.a,'--to','worktree']]) {
      const invalid=await verify(f,[...args,'--plan','--json']);assert.equal(invalid.exit_code,2);assert.ok(!invalid.receipt_id);
    }
  }finally{cleanup(f);}
});

test('missing, duplicate, forged or unknown conditional requirements cannot exclude tests',async()=>{
  const f=fixture('node');try {await establishBaseline(f);
    const pristine=analyze(f);const ids=['runtime','runner','inventory','resolver','inputs','environment','baseline'];
    assert.deepEqual(ids.filter(id=>pristine.context_requirements.some((r:Result)=>r.id===id)),ids);
    const mutations:Array<[string,(r:Result)=>void]> = ids.map(id=>[`omit ${id}`,r=>{r.context_requirements=r.context_requirements.filter((x:Result)=>x.id!==id);}]);
    mutations.push(['duplicate requirement',r=>{r.context_requirements.push(structuredClone(r.context_requirements[0]));}],
      ['omit triggered node dependency',r=>{r.context_requirements=r.context_requirements.filter((x:Result)=>x.id!=='dependency:node:test');}],
      ['unknown model',r=>{r.supported_model.version='unknown';}],
      ['weaker collector',r=>{r.context_requirements[0].evidence_kind='analyzer_assertion';}],
      ['weakened predicate',r=>{r.context_requirements[0].predicate={op:'always_true'};}],
      ['unknown requirement',r=>{r.context_requirements.push({id:'unrecognized',kind:'plugin',evidence_kind:'unknown',predicate:{op:'accept'}});}],
      ['wrong target identity',r=>{r.comparison.to.commit=f.a;}]);
    for(const [label,mutate] of mutations){const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json'],{mutate});
      assert.equal(report.selection_strategy,'full',`${label} must not justify sparse execution`);assert.ok(!report.receipt_id);}
  }finally{cleanup(f);}
});

test('target mismatch cannot run tests or claim a passing receipt',async()=>{
  const f=fixture('node');try {const seen:string[][]=[];
    const report=await verify(f,['--from',f.a,'--to',f.a,'--all','--json'],{seen});
    assert.notEqual(report.verification_status,'validated');assert.ok(!report.receipt_id);assert.ok(!seen.some(a=>a.includes('--test')));
  }finally{cleanup(f);}
});

test('an unbounded analyzer gap or a conservative v1 report cannot justify a sparse plan',async()=>{
  const f=fixture('node');try {await establishBaseline(f);
    const transforms:Array<(r:Result)=>void>=[
      r=>{r.analysis_gaps.push({revision:'to',path:'src/a.ts',kind:'dynamic_load',scope:null,detail:'unbounded'});r.required_fallback_scopes=[{kind:'full_profile',scope:null,reason:'unbounded'}];r.analysis_status='incomplete';},
      r=>{r.schema_version=1;delete r.supported_model;delete r.context_requirements;r.analysis_status='incomplete';r.analysis_gaps=[{revision:'to',path:null,kind:'unmodeled_dependencies',scope:null,detail:'unknown'}];r.required_fallback_scopes=[{kind:'full_profile',scope:null,reason:'unknown'}];},
    ];
    for(const mutate of transforms){const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json'],{mutate});full(report);assert.ok(!report.receipt_id);}
  }finally{cleanup(f);}
});
