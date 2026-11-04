/**
 * G2's private integration seam, not a public config/CLI contract.
 *
 * The helper under test supplies runVerificationForTest(request, hooks).  The
 * request's fixture profile chooses a real runner without injecting a target
 * inventory or imposing a published configuration schema. Hooks observe child argv,
 * redirect the private receipt-store root, or corrupt analyzer/collector output
 * after real collection to test rejection; they must not manufacture passing
 * collector evidence. The normal
 * production entry point must use the same planner, validators and execution
 * implementation without these test-only overrides.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
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
    'test/a.test.ts':"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/a.js';\ntest('a', () => { assert.strictEqual(value(), 1); });\n",
    'test/b.test.ts':"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/b.js';\ntest('b', () => { assert.strictEqual(value(), 8); });\n",
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
  return {dir,state,a,b,model,all:model==='node'?['test/a.test.ts','test/b.test.ts']:['./a','./b','./consumer'],impacted:model==='node'?['test/a.test.ts']:['./a','./consumer'],independent:model==='node'?'test/b.test.ts':'./b'};
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
interface VerifyOptions {
  mutate?:(report:Result)=>void;
  seen?:string[][];
  mutateEvidence?:(id:string,evidence:Result)=>Result|null;
  collected?:string[];
  profile?:Result;
  onCommand?:(argv:string[])=>void;
  onChildOutput?:(stream:string,text:string)=>void;
  signal?:AbortSignal;
  beforeReceiptPublish?:()=>Promise<void>;
  failReceiptPublish?:()=>void;
}
async function verify(f:Fixture,args:string[], options:VerifyOptions={}):Promise<Result> {
  const module=await import(engineFile);
  assert.equal(typeof module.runVerificationForTest,'function','private test seam must call production verification core');
  return module.runVerificationForTest({
    cwd:f.dir, argv:args, stateRoot:f.state,
    fixtureProfile:{name:'default',model:f.model,...options.profile},
  },{
    // The real analyzer and independent real collectors still run.  This hook
    // can only alter the report AFTER analysis to simulate untrusted output.
    transformImpact:(report:Result)=>{const copy=structuredClone(report);options.mutate?.(copy);return copy;},
    // Corruption happens only after the production collector has run. The hook
    // cannot supply a missing successful observation or bypass collection.
    transformEvidence:(id:string,observed:Result)=>{
      options.collected?.push(id);
      return options.mutateEvidence ? options.mutateEvidence(id,structuredClone(observed)) : observed;
    },
    observeCommand:(argv:string[])=>{options.seen?.push([...argv]);options.onCommand?.(argv);},
    signal:options.signal,
    beforeReceiptPublish:options.beforeReceiptPublish,
    onChildOutput:options.onChildOutput,
    failReceiptPublish:options.failReceiptPublish,
  });
}
function units(report:Result):string[] {assert.ok(Array.isArray(report.execution_units));return report.execution_units;}
function full(report:Result) {assert.equal(report.selection_strategy,'full');}
function cannotNarrow(report:Result,label:string) {
  assert.notEqual(report.selection_strategy,'selective',`${label} must not allow sparse execution`);
  assert.ok(!report.receipt_id,`${label} must not create a receipt during planning`);
}
function regularFiles(root:string):string[] {
  if(!existsSync(root)) return [];
  const found:string[]=[];
  for(const name of readdirSync(root)) {
    const path=join(root,name), stat=lstatSync(path);
    if(stat.isDirectory() && !stat.isSymbolicLink()) found.push(...regularFiles(path));
    else if(stat.isFile()) found.push(path);
  }
  return found.sort();
}
function checkoutBaseline(f:Fixture) {checkout(f,f.a);}
async function establishBaseline(f:Fixture) {
  checkoutBaseline(f);const result=await verify(f,['--from',f.a,'--to',f.a,'--all','--json']);
  assert.equal(result.execution_status,'passed');assert.equal(result.verification_status,'validated');assert.ok(result.receipt_id);
  checkout(f,f.b);return result;
}

test('v2 Node analyzer supplies a real conditional changed-tree fixture',()=>{
  const f=fixture('node');try {const out=analyze(f);assert.equal(out.analysis_status,'conditional',JSON.stringify(out.analysis_gaps));assert.ok(out.affected.some((x:Result)=>x.path==='test/a.test.ts'));assert.ok(!out.affected.some((x:Result)=>x.path==='test/b.test.ts'));}finally{cleanup(f);}
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

test('independently collected requirements must be present, complete and bound to this target and profile',async()=>{
  const f=fixture('node');try {
    await establishBaseline(f);
    for(const id of ['runtime','runner','inventory','resolver','inputs','environment','baseline']) {
      const collected:string[]=[];
      const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json'],{
        collected,mutateEvidence:(name,evidence)=>name===id?null:evidence,
      });
      assert.ok(collected.includes(id),`production collector ${id} must actually run`);
      cannotNarrow(report,`missing independently collected ${id}`);
    }
    for(const field of ['target_commit','profile','inventory']) {
      let intercepted=false;
      const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json'],{
        mutateEvidence:(id,evidence)=>{
          if(id!=='inventory') return evidence;
          intercepted=true;return {...evidence,binding:{...evidence.binding,[field]:'wrong-fixture-binding'}};
        },
      });
      assert.ok(intercepted,'inventory collector must run before test corruption');
      cannotNarrow(report,`inventory evidence bound to another ${field}`);
    }
    let discoveryObserved=false;
    const incomplete=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json'],{
      mutateEvidence:(id,evidence)=>{if(id!=='inventory') return evidence;discoveryObserved=true;return {...evidence,complete:false};},
    });
    assert.ok(discoveryObserved);cannotNarrow(incomplete,'incomplete runner discovery');
  }finally{cleanup(f);}
});

test('Go build context changes cannot reuse otherwise compatible sparse evidence', {skip:!hasGo()},async()=>{
  const f=fixture('go');const oldFlags=process.env.GOFLAGS;const oldOs=process.env.GOOS;const oldArch=process.env.GOARCH;
  try {
    await establishBaseline(f);
    for(const [key,value] of [
      ['GOFLAGS','-tags=integration'],
      ['GOOS',process.platform==='win32'?'linux':'windows'],
      ['GOARCH',process.arch==='arm64'?'amd64':'arm64'],
    ] as const) {
      const previous=process.env[key];process.env[key]=value;
      try {const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json']);cannotNarrow(report,`changed ${key}`);}
      finally {if(previous===undefined) delete process.env[key];else process.env[key]=previous;}
    }
  }finally {
    if(oldFlags===undefined) delete process.env.GOFLAGS;else process.env.GOFLAGS=oldFlags;
    if(oldOs===undefined) delete process.env.GOOS;else process.env.GOOS=oldOs;
    if(oldArch===undefined) delete process.env.GOARCH;else process.env.GOARCH=oldArch;
    cleanup(f);
  }
});

test('a selective receipt cannot be reused after its full-baseline predecessor disappears',async()=>{
  const f=fixture('node');try {
    checkoutBaseline(f);const before=new Set(regularFiles(f.state));
    const a=await verify(f,['--from',f.a,'--to',f.a,'--all','--json']);
    assert.equal(a.execution_status,'passed');assert.ok(a.receipt_id);
    const afterA=new Set(regularFiles(f.state));const baselineFiles=[...afterA].filter(p=>!before.has(p));
    assert.ok(baselineFiles.length,'a full run should persist a baseline record outside the checkout');
    checkout(f,f.b);const b=await verify(f,['--from',f.a,'--to',f.b,'--json']);
    assert.equal(b.selection_strategy,'selective');assert.equal(b.execution_status,'passed');assert.ok(b.receipt_id);
    const bFiles=regularFiles(f.state).filter(p=>!afterA.has(p));assert.ok(bFiles.length,'selective receipt should be durably recorded');
    for(const p of baselineFiles) rmSync(p,{force:true});
    assert.ok(bFiles.some(existsSync),'the selective receipt remains while its predecessor is missing');
    put(f.dir,'src/a.ts','export function value() { return 1 + 0 + 0; }\n');const c=commit(f.dir,'follow-up');
    const report=await verify(f,['--from',f.b,'--to',c,'--plan','--json']);
    cannotNarrow(report,'missing prior receipt in the chain');
  }finally{cleanup(f);}
});

test('failed or interrupted test execution does not produce reusable passing evidence',async()=>{
  const f=fixture('node');try {
    put(f.dir,'src/a.ts','export function value() { return 2; }\n');const failing=commit(f.dir,'introduce failure');
    const failure=await verify(f,['--from',failing,'--to',failing,'--all','--json']);
    assert.notEqual(failure.execution_status,'passed');assert.notEqual(failure.verification_status,'validated');assert.ok(!failure.receipt_id);
    put(f.dir,'src/a.ts','export function value() { return 1; }\n');const fixed=commit(f.dir,'fix failure');
    const plan=await verify(f,['--from',failing,'--to',fixed,'--plan','--json']);cannotNarrow(plan,'failed predecessor');
    const controller=new AbortController();let signalled=false;
    const interrupted=await verify(f,['--from',fixed,'--to',fixed,'--all','--json'],{
      signal:controller.signal,onCommand:argv=>{if(argv.includes('--test')){signalled=true;controller.abort();}},
    });
    assert.ok(signalled,'cancellation must be injected into actual runner execution');
    assert.notEqual(interrupted.execution_status,'passed');assert.notEqual(interrupted.verification_status,'validated');assert.ok(!interrupted.receipt_id);
  }finally{cleanup(f);}
});

test('tracked or checkout-controlled copies of a receipt cannot serve as a baseline',async()=>{
  const f=fixture('node');try {
    await establishBaseline(f);const files=regularFiles(f.state);assert.ok(files.length,'trusted receipt must exist');
    const forgedDir=join(f.dir,'.test-impact','receipts');mkdirSync(forgedDir,{recursive:true});
    for(let i=0;i<files.length;i++) copyFileSync(files[i],join(forgedDir,`receipt-${i}.json`));
    rmSync(f.state,{recursive:true,force:true});mkdirSync(f.state,{mode:0o700});
    // The copied data is untrusted even if byte-for-byte identical to a real
    // receipt. A clean trusted store must never consult a checkout copy.
    const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json']);cannotNarrow(report,'checkout-controlled receipt');
  }finally{cleanup(f);}
});

test('a symlinked receipt-store root cannot read or publish through an external path',async()=>{
  const f=fixture('node');const outside=mkdtempSync(join(tmpdir(),'test-impact-outside-'));
  try {
    const sentinel=join(outside,'sentinel');writeFileSync(sentinel,'unchanged');
    rmSync(f.state,{recursive:true,force:true});
    try {symlinkSync(outside,f.state,process.platform==='win32'?'junction':'dir');}
    catch(error:any) {if(process.platform==='win32' && ['EPERM','EACCES','ENOTSUP'].includes(error?.code)) return;throw error;}
    const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json']);cannotNarrow(report,'symlinked state root');
    assert.equal(readFileSync(sentinel,'utf8'),'unchanged');assert.deepEqual(readdirSync(outside),['sentinel']);
  }finally{cleanup(f);rmSync(outside,{recursive:true,force:true});}
});

test('an interrupted receipt publication leaves no reusable passing evidence',async()=>{
  const f=fixture('node');try {
    checkoutBaseline(f);let injected=false;
    const failed=await verify(f,['--from',f.a,'--to',f.a,'--all','--json'],{
      failReceiptPublish:()=>{injected=true;throw new Error('injected publication failure');},
    });
    assert.ok(injected,'publication fault must occur after successful test execution');
    assert.notEqual(failed.verification_status,'validated');assert.ok(!failed.receipt_id);
    checkout(f,f.b);const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json']);cannotNarrow(report,'incomplete receipt publication');
  }finally{cleanup(f);}
});

test('concurrent full-run receipt publication cannot expose incomplete records',async()=>{
  const f=fixture('node');try {
    checkoutBaseline(f);let reached=0;let release!:()=>void;
    const barrier=new Promise<void>(resolveBarrier=>{release=resolveBarrier;});
    const beforeReceiptPublish=async()=>{reached++;if(reached===2) release();await Promise.race([barrier,new Promise(resolve=>setTimeout(resolve,1000))]);};
    const pair=await Promise.all([
      verify(f,['--from',f.a,'--to',f.a,'--all','--json'],{beforeReceiptPublish}),
      verify(f,['--from',f.a,'--to',f.a,'--all','--json'],{beforeReceiptPublish}),
    ]);
    assert.equal(reached,2,'both runs must overlap before receipt publication');
    assert.ok(pair.some(r=>r.verification_status==='validated' && r.receipt_id),'at least one full receipt must publish');
    for(const result of pair) if(result.verification_status==='validated') assert.ok(result.receipt_id);
    checkout(f,f.b);const report=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json']);
    assert.equal(report.selection_strategy,'selective','a successfully published baseline remains usable');
  }finally{cleanup(f);}
});

test('inverse source changes and newly discovered tests follow their actual dependencies',async()=>{
  const f=fixture('node');try {
    checkout(f,f.a);put(f.dir,'src/b.ts','export function value() { return 8 + 0; }\n');f.b=commit(f.dir,'change the other component');
    await establishBaseline(f);
    const inverse=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json']);
    assert.equal(inverse.selection_strategy,'selective');assert.ok(units(inverse).includes('test/b.test.ts'));
    assert.ok(!units(inverse).includes('test/a.test.ts'),'old A dependency must not contaminate an independent B change');
    checkout(f,f.a);put(f.dir,'test/c.test.ts',"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/a.js';\ntest('c', () => { assert.strictEqual(value(), 1); });\n");
    f.b=commit(f.dir,'add independently discovered test');
    const added=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json']);
    if(added.selection_strategy!=='full') assert.ok(units(added).includes('test/c.test.ts'),'new surviving test must be scheduled');
  }finally{cleanup(f);}
});

test('removed production files and import rebinding include surviving old or new dependents',{skip:!hasGo()},async()=>{
  const f=fixture('go');try {
    await establishBaseline(f);
    git(f.dir,'rm','a/a.go');const removed=commit(f.dir,'remove imported production source');
    const deletion=await verify(f,['--from',f.a,'--to',removed,'--plan','--json']);
    if(deletion.selection_strategy!=='full' && deletion.verification_status!=='incomplete') {
      assert.ok(units(deletion).includes('./a'));assert.ok(units(deletion).includes('./consumer'));
    }
    checkout(f,f.a);
    put(f.dir,'consumer/consumer.go','package consumer\nimport "example.test/fixture/b"\nfunc Value() int { return b.Value() }\n');
    const rebound=commit(f.dir,'rebind importer');
    const report=await verify(f,['--from',f.a,'--to',rebound,'--plan','--json']);
    if(report.selection_strategy!=='full' && report.verification_status!=='incomplete') assert.ok(units(report).includes('./consumer'));
  }finally{cleanup(f);}
});

test('unverified bounded scopes and mixed-language changes cannot exclude dependent tests',async()=>{
  const f=fixture('node');try {
    await establishBaseline(f);
    const fakeBoundary=await verify(f,['--from',f.a,'--to',f.b,'--plan','--json'],{mutate:r=>{
      r.analysis_gaps.push({revision:'to',path:'src/a.ts',kind:'opaque',detail:'unverified package boundary',scope:'unknown:scope'});
      r.required_fallback_scopes.push({kind:'scope',scope:'unknown:scope',reason:'untrusted scope'});
    }});
    cannotNarrow(fakeBoundary,'unverified bounded scope');
    put(f.dir,'go.mod','module example.test/mixed\n\ngo 1.22\n');put(f.dir,'native/native.go','package native\nfunc Value() int { return 1 }\n');
    const mixed=commit(f.dir,'introduce mixed-language boundary');
    const report=await verify(f,['--from',f.a,'--to',mixed,'--plan','--json']);
    cannotNarrow(report,'unmodeled mixed-language build relationship');
  }finally{cleanup(f);}
});

test('declared documentation-only inputs can be excluded, while unknown resources broaden',async()=>{
  const f=fixture('node');try {
    const profile={classifications:[{paths:['README.md'],kind:'documentation_only'}]};
    checkout(f,f.a);const base=await verify(f,['--from',f.a,'--to',f.a,'--all','--json'],{profile});assert.ok(base.receipt_id);
    put(f.dir,'README.md','# Fixture documentation\n');const docs=commit(f.dir,'add docs');
    const declared=await verify(f,['--from',f.a,'--to',docs,'--plan','--json'],{profile});
    assert.equal(units(declared).length,0,'an explicitly classified irrelevant document should not demand tests');
    checkout(f,f.a);put(f.dir,'data.json','{"value":1}\n');const resource=commit(f.dir,'add undeclared resource');
    const unknown=await verify(f,['--from',f.a,'--to',resource,'--plan','--json'],{profile});cannotNarrow(unknown,'unknown resource');
  }finally{cleanup(f);}
});

test('the actual repository adapter exposes a subprocess command and preserves the full workflow',async()=>{
  const module=await import(engineFile);
  assert.equal(typeof module.productionCommandForTest,'function','private seam must locate the real project entry point');
  const root=resolve('.');const argv=await module.productionCommandForTest({cwd:root});
  assert.ok(Array.isArray(argv) && argv.length>0 && argv.every((x:unknown)=>typeof x==='string'));
  const head=git(root,'rev-parse','HEAD');
  const child=command(root,argv[0],[...argv.slice(1),'--from',head,'--to',head,'--all','--plan','--json']);
  assert.equal(child.status,0,child.stderr);const report=JSON.parse(child.stdout);
  assert.equal(report.execution_status,'not_run');assert.equal(report.verification_status,'not_performed');assert.ok(!report.receipt_id);
  assert.match(JSON.stringify(report),/stable.{0,80}input|input.{0,80}stable/i,'report should state the normal stable-input assumption');
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.equal(pkg.scripts.test,'node scripts/run-tests.mjs','original full command must remain independent of its wrapper');
  const serialized=JSON.stringify(report);assert.match(serialized,/npm/);assert.match(serialized,/test/);assert.match(serialized,/build/);
});

test('full fallback preserves preparation, runner and gate order with child logs separate',async()=>{
  const f=fixture('node');try {
    const seen:string[][]=[];const emitted:Array<{stream:string;text:string}>=[];
    const prep=[process.execPath,'-e','console.error("G2_PREPARATION")'];
    const gate=[process.execPath,'-e','console.error("G2_GLOBAL_GATE")'];
    const result=await verify(f,['--from',f.a,'--to',f.b,'--all','--json'],{
      seen,
      profile:{preparation:[{argv:prep}],gates:[{argv:gate}]},
      // The seam observes child streams; production CLI must route these away
      // from its single JSON stdout object.
      onChildOutput:(stream:string,text:string)=>emitted.push({stream,text}),
    } as VerifyOptions);
    assert.equal(result.execution_status,'passed');
    const pre=seen.findIndex(argv=>argv.includes('console.error("G2_PREPARATION")'));
    const run=seen.findIndex(argv=>argv.includes('--test'));
    const after=seen.findIndex(argv=>argv.includes('console.error("G2_GLOBAL_GATE")'));
    assert.ok(pre>=0 && run>pre && after>run,'required setup, real runner and gate must run in order');
    assert.ok(emitted.some(x=>x.stream==='stderr' && x.text.includes('G2_PREPARATION')));
    assert.ok(emitted.some(x=>x.stream==='stderr' && x.text.includes('G2_GLOBAL_GATE')));
    assert.match(JSON.stringify(result),/stable.{0,80}input|input.{0,80}stable/i);
  }finally{cleanup(f);}
});
