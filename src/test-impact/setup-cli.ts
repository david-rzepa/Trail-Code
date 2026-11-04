import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const adapter = `.test-impact/verify.mjs`;
const config = `.test-impact.json`;
const owner = `.test-impact/ownership.json`;
const docs = `.test-impact/README.md`;
// The adapter delegates all planning, execution and receipt decisions to the
// version-pinned production helper. It treats malformed configuration as an
// error, rather than letting the helper's legacy default silently take over.
const adapterSource = `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=x=>createHash('sha256').update(x).digest('hex');
try {
 const raw=readFileSync(resolve(root,'.test-impact.json'));
 const cfg=JSON.parse(raw);
 const ownership=JSON.parse(readFileSync(resolve(root,'.test-impact/ownership.json'),'utf8'));
 if(ownership.version!==1 || ownership.config!==sha(raw) || cfg.version!==1 || !['go','node','full'].includes(cfg.setupModel)) throw Error('Invalid or modified test impact configuration');
 const helper=process.env.TRAIL_IMPACT_HELPER || cfg.helper;
 if(typeof helper!=='string'||sha(readFileSync(helper))!==cfg.helperDigest) throw Error('Missing or incompatible test impact helper');
 const args=process.argv.slice(2);
 if(args.includes('--profile')) throw Error('Profile is fixed by the reviewed setup configuration');
 const invoke=helper.endsWith('.ts')?['--import',cfg.loader,helper]:[helper];
 const child=spawnSync(process.execPath,[...invoke,...args],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,env:process.env});
 if(child.stderr)process.stderr.write(child.stderr);
 if(child.stdout)process.stdout.write(child.stdout);
 if(child.error||child.signal||child.status===null)throw Error('Unable to execute test impact helper');
 process.exitCode=child.status;
} catch(e) { process.stdout.write(JSON.stringify({execution_status:'not_run',verification_status:'incomplete',exit_code:1,fallback_reasons:[String(e.message||e)]})+'\\n'); process.exitCode=1; }
`;
const documentation = `# Test impact verification\n\nCommit the changes to test before running. Both endpoints must name commits:\n\n    node .test-impact/verify.mjs --from {base_commit} --to {target_commit} --json\n\nUse --plan to inspect without running or --all for the independent full workflow. A passing baseline is needed for selective execution. The ordinary test-runner assumption is that relevant inputs stay stable while tests run.\n\nThe adapter requires the version-pinned Trail-code verification helper recorded in .test-impact.json. Install the same package version in each environment and set TRAIL_IMPACT_HELPER to its dist/test-impact/verification-cli.js if its installation path differs. Re-run setup after inspecting changes to test commands, projects or toolchains. Review generated changes before committing them.\n`;
function fail(message:string):never {throw Error(message);}
function options() {
  let target='',profile='',helper='';
  const args=process.argv.slice(2);
  if(args.includes('--help')) {process.stdout.write('Usage: setup-cli --target REPOSITORY --profile go|node --json\n');process.exit(0);}
  for(let i=0;i<args.length;i++) {
    const a=args[i]; if(a==='--json')continue;
    if(a==='--target'||a==='--profile'||a==='--helper') {const v=args[++i];if(!v||v.startsWith('--'))fail(`Missing value for ${a}`);if(a==='--target')target=v;else if(a==='--profile')profile=v;else helper=v;}
    else fail(`Unknown argument: ${a}`);
  }
  if(!target||!['go','node'].includes(profile))fail('Provide --target and --profile go|node');
  if(helper)fail('Custom helper is not supported: use the installed version-pinned helper');
  return {target:resolve(target),profile};
}
function safeFile(root:string,path:string) {
  const parts=path.split('/'); let current=root;
  for(const part of parts) {current=join(current,part);try {if(lstatSync(current).isSymbolicLink())fail(`Unsafe symlink: ${path}`);}catch(e:any){if(e?.code!=='ENOENT')throw e;}}
}
function main() {
  const {target,profile}=options();
  if(realpathSync(target)!==target)fail('Target must be a real repository path without symlinks');
  const git=spawnSync('git',['rev-parse','--show-toplevel'],{cwd:target,encoding:'utf8'});
  if(git.status!==0||realpathSync(git.stdout.trim())!==target)fail('Target must be a repository root');
  for(const path of [adapter,config,owner,docs])safeFile(target,path);
  const listed=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:target,encoding:'utf8',maxBuffer:64*1024*1024});
  if(listed.status!==0)fail('Repository discovery incomplete');
  const paths=listed.stdout.split('\0').filter(Boolean);
  const foreign=paths.some(p=>profile==='node' ? /(^|\/)(go\.mod|Cargo\.toml|pyproject\.toml)$|\.(go|py|rs)$/.test(p) : /(^|\/)(package\.json|go\.work)$|\.(py|ts|tsx|js|jsx)$/.test(p));
  let setupModel=profile, fullCommand:string[]|undefined;
  let gates: {argv:string[]}[]|undefined;
  if(profile==='go') {
    if(foreign || !existsSync(join(target,'go.mod')))fail('Unsupported mixed-language or incomplete Go project boundary');
    const go=spawnSync('go',['list','./...'],{cwd:target,encoding:'utf8',env:{...process.env,GOPROXY:'off',GOTOOLCHAIN:'local'},timeout:30000});
    if(go.status!==0||!go.stdout.trim())fail('Go package discovery incomplete or dependency unavailable');
  } else {
    let pkg:any;try{pkg=JSON.parse(readFileSync(join(target,'package.json'),'utf8'));}catch{fail('Node package discovery incomplete');}
    const test=pkg?.scripts?.test;
    if(test==='node scripts/run-tests.mjs' && pkg?.name==='@nanonets/graft') {
      setupModel='full';fullCommand=['npm','test'];gates=[{argv:['npm','run','build']}];
    } else {
      if(foreign)fail('Unsupported mixed-language project boundary');
      if(test!=='node --import tsx --test test/*.test.ts'||pkg?.scripts?.pretest||pkg?.scripts?.posttest)fail('Unsupported Node runner or incomplete test workflow');
      if(!paths.some(p=>/^test\/[^/]+\.test\.ts$/.test(p)))fail('Node test discovery incomplete');
      fullCommand=['npm','test'];
    }
  }
  const source=import.meta.url.endsWith('.ts');
  const helper=fileURLToPath(new URL(source?'./verification-cli.ts':'./verification-cli.js',import.meta.url));
  const loader=source?import.meta.resolve('tsx'):'';
  const cfg={version:1,name:setupModel==='full'?'default':profile,...(setupModel==='full'?{}:{model:profile}),...(fullCommand?{fullCommand}:{}),...(gates?{gates}:{}),setupModel,helper,helperDigest:digest(readFileSync(helper)),loader};
  const raw=JSON.stringify(cfg,null,2)+'\n';
  const ownership={version:1,adapter:digest(adapterSource),config:digest(raw),docs:digest(documentation)};
  const ownerRaw=JSON.stringify(ownership,null,2)+'\n';
  const outputs:[[string,string],...[string,string][]]=[[adapter,adapterSource],[config,raw],[docs,documentation],[owner,ownerRaw]];
  if(existsSync(join(target,owner))) {
    const previous=JSON.parse(readFileSync(join(target,owner),'utf8'));
    for(const [path,key] of [[adapter,'adapter'],[config,'config'],[docs,'docs']] as const) {
      if(!existsSync(join(target,path))||digest(readFileSync(join(target,path)))!==previous[key])fail(`Maintenance conflict: ${path} was changed`);
    }
    if(JSON.stringify(previous)!==JSON.stringify(ownership))fail('Maintenance conflict: generated setup inputs or helper changed; review required');
  } else if(outputs.some(([path])=>existsSync(join(target,path))))fail('Setup destination already exists without ownership metadata');
  mkdirSync(join(target,'.test-impact'),{recursive:true});
  for(const [path,data] of outputs)if(!existsSync(join(target,path)))writeFileSync(join(target,path),data,{flag:'wx'});
  process.stdout.write(JSON.stringify({adapter,config,documentation:docs,profile:setupModel,validation:'not_run',gaps:['Run an authorized full verification before relying on selective results.']})+'\n');
}
try {main();} catch(e:any) {process.stderr.write(`${e?.message??e}\n`);process.exitCode=1;}
