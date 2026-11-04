import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runVerificationForTest } from '../src/test-impact/verification.js';

test('an analyzer-reported source file includes its independently discovered test dependents',async()=>{
  const cwd=mkdtempSync(join(tmpdir(),'impact-reported-source-'));
  const stateRoot=mkdtempSync(join(tmpdir(),'impact-reported-state-'));
  const git=(...args:string[])=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const put=(name:string,body:string)=>{const path=join(cwd,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,body);};
  const commit=(message:string)=>{git('add','-A');git('-c','commit.gpgsign=false','commit','-m',message);return git('rev-parse','HEAD');};
  try {
    git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');
    put('package.json',JSON.stringify({name:'fixture',private:true,type:'module'}));
    put('tsconfig.json',JSON.stringify({compilerOptions:{module:'NodeNext',moduleResolution:'NodeNext',target:'ES2022'}}));
    for(const name of ['a','b']){
      put(`src/${name}.ts`,'export function value() { return 1; }\n');
      put(`test/${name}.test.ts`,`import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/${name}.js';\ntest('${name}', () => { assert.strictEqual(value(), 1); });\n`);
    }
    const a=commit('baseline');
    const baseline=await runVerificationForTest({cwd,stateRoot,argv:['--from',a,'--to',a,'--all','--json'],fixtureProfile:{name:'default',model:'node'}});
    assert.equal(baseline.verification_status,'validated');
    put('src/a.ts','export function value() { return 1 + 0; }\n');const b=commit('change a');
    const result=await runVerificationForTest({cwd,stateRoot,argv:['--from',a,'--to',b,'--plan','--json'],fixtureProfile:{name:'default',model:'node'}},{
      transformImpact(report:any){report.affected.push({revision:'to',path:'src/b.ts',entity:null,reasons:[{kind:'dependency',detail:'additional reported source'}]});return report;},
    });
    assert.equal(result.selection_strategy,'selective');
    assert.deepEqual(result.execution_units,['test/a.test.ts','test/b.test.ts']);
  }finally{rmSync(cwd,{recursive:true,force:true});rmSync(stateRoot,{recursive:true,force:true});}
});
