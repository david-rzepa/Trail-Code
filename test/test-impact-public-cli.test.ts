import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const cli=resolve('src/cli.ts');
const tsx=import.meta.resolve('tsx');
const goAvailable=spawnSync('go',['version'],{encoding:'utf8'}).status===0;

test('public Go profile executes only affected packages after a full baseline',{skip:!goAvailable,timeout:120_000},()=>{
  const dir=mkdtempSync(join(tmpdir(),'trail-public-impact-'));
  const run=(cmd:string,args:string[])=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const r=spawnSync(cmd,args,{cwd:dir,encoding:'utf8',env,timeout:100_000});assert.equal(r.status,0,`${cmd} ${r.stderr}`);return r.stdout.trim();};
  const git=(...args:string[])=>run('git',args);
  const put=(name:string,contents:string)=>{const path=join(dir,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,contents);};
  try {
    git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');
    put('go.mod','module example.test/publicfixture\n\ngo 1.22\n');
    for(const name of ['a','b']) {
      put(`${name}/${name}.go`,`package ${name}\nfunc Value() int { return 1 }\n`);
      put(`${name}/${name}_test.go`,`package ${name}\nimport "testing"\nfunc TestValue(t *testing.T) { if Value()!=1 { t.Fatal("bad") } }\n`);
    }
    put('plain/plain.go','package plain\nfunc Value() int { return 1 }\n');
    const commit=(message:string)=>{git('add','-A');git('-c','commit.gpgsign=false','commit','-m',message);return git('rev-parse','HEAD');};
    const a=commit('baseline');
    const verify=(from:string,to:string,extra:string[]=[])=>JSON.parse(run(process.execPath,['--import',tsx,cli,'verify','--profile','go','--from',from,'--to',to,...extra,'--json']));
    const baseline=verify(a,a,['--all']);assert.equal(baseline.verification_status,'validated');
    put('a/a.go','package a\nfunc Value() int { return 1 + 0 }\n');const b=commit('change A');
    const result=verify(a,b);assert.equal(result.selection_strategy,'selective');assert.equal(result.verification_status,'validated');
    assert.deepEqual(result.execution_units,['./a']);assert.ok(result.receipt_id);
    // A package without test files still participates in `go test ./...`:
    // its compilation must not be silently skipped when that package changes.
    put('plain/plain.go','package plain\nfunc Value() int { return 1 + 0 }\n');const c=commit('change package without tests');
    const plain=verify(b,c);assert.equal(plain.selection_strategy,'selective');assert.equal(plain.verification_status,'validated');
    assert.deepEqual(plain.execution_units,['./plain']);
    put('.git/info/exclude','plain/testdata/\n');
    put('plain/testdata/fuzz/FuzzValue/corpus','go test fuzz v1\nstring(\"uncommitted\")\n');
    const unsafe=spawnSync(process.execPath,['--import',tsx,cli,'verify','--profile','go','--from',b,'--to',c,'--json'],{cwd:dir,encoding:'utf8'});
    assert.notEqual(unsafe.status,0);const unsafeReport=JSON.parse(unsafe.stdout);
    assert.ok(unsafeReport.checkout.go_runner_inputs.uncommitted.includes('plain/testdata/fuzz/FuzzValue/corpus'));
    assert.ok(!unsafeReport.receipt_id,'ignored Go testdata must not establish committed evidence');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('public command rejects repeated endpoint flags',()=>{
  const child=spawnSync(process.execPath,['--import',tsx,cli,'verify','--from','one','--from','two','--to','three','--plan','--json'],{cwd:resolve('.'),encoding:'utf8'});
  assert.equal(child.status,2,child.stderr);
  assert.match(JSON.stringify(JSON.parse(child.stdout)),/duplicate.*endpoint/i);
});

test('Node plan reports the full runner argv including its loader',async()=>{
  const {runVerificationForTest}=await import('../src/test-impact/verification.js');
  const cwd=resolve('.');const git=spawnSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'});assert.equal(git.status,0);
  const head=git.stdout.trim();
  const report=await runVerificationForTest({cwd,argv:['--from',head,'--to',head,'--plan','--json'],fixtureProfile:{name:'node',model:'node'}});
  assert.ok(report.workflow.full.includes('--import'));assert.ok(report.workflow.full.includes('--test'));
});
