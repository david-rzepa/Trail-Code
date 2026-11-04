import { spawn, spawnSync } from 'node:child_process';
import { grammarIdentity } from '../impact/analyze.js';
import { extractorStamp } from '../graph/extract-cache.js';
import { readCurrentVersion } from '../cli-meta.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverComparison } from './discovery.js';
import { validateModelRequirements } from './model-registry.js';
import { defaultStateRoot, findReceipt, publishReceipt } from './receipts.js';

type Command = { argv: string[] };
type Profile = { name: string; model?: 'node'|'go'; fullCommand?: string[]; preparation?: Command[]; gates?: Command[]; classifications?: unknown };
type Hooks = {
  transformImpact?: (report: any) => any;
  transformEvidence?: (id: string, evidence: any) => any;
  observeCommand?: (argv: string[]) => void;
  onChildOutput?: (stream: string, text: string) => void;
  signal?: AbortSignal;
  beforeReceiptPublish?: () => Promise<void>;
  beforeReceiptRead?: () => void;
  failReceiptPublish?: () => void;
};
type Request = {cwd:string; argv:string[]; stateRoot?:string; fixtureProfile?:Profile};
const tsx = (()=>{try{return import.meta.resolve('tsx');}catch{return '';}})();
const analyzer = fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../cli.ts':'../cli.js', import.meta.url));
const analyzerCommand = () => [process.execPath,...(analyzer.endsWith('.ts')?['--import',tsx]:[]),analyzer];
const analyzerVersion=readCurrentVersion(new URL('../cli.js',import.meta.url).href);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['--no-replace-objects', ...args], {cwd, encoding:'utf8', maxBuffer:64*1024*1024});
  if (r.status !== 0) throw Error('Git could not resolve the requested endpoint');
  return r.stdout.trim();
}
function endpoint(cwd: string, ref: string) {
  if (!ref || ref === 'worktree' || ref.startsWith('-')) throw Error('Both endpoints must name commits; worktree is unsupported');
  const commit = git(cwd, 'rev-parse','--verify','--end-of-options',`${ref}^{commit}`);
  const tree = git(cwd, 'rev-parse','--verify','--end-of-options',`${commit}^{tree}`);
  if (!/^[0-9a-f]{40,64}$/.test(commit) || !/^[0-9a-f]{40,64}$/.test(tree)) throw Error('Invalid commit identity');
  return {requested:ref, commit, tree};
}
function platformArgv(argv:string[]):string[] {
  if(process.platform!=='win32'||argv[0].toLowerCase()!=='npm')return argv;
  // npm is distributed as a cmd shim on Windows, which cannot be spawned as
  // an executable without a shell. Execute npm's JavaScript entry directly.
  const where=spawnSync('where.exe',['npm.cmd'],{encoding:'utf8',windowsHide:true});
  const candidates=[join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),...(where.status===0?where.stdout.trim().split(/\r?\n/).map(path=>join(dirname(path),'node_modules','npm','bin','npm-cli.js')):[])];
  const cli=candidates.find(existsSync);if(!cli)throw Error('Cannot locate npm on Windows');
  return [process.execPath,cli,...argv.slice(1)];
}
async function child(cwd:string, argv:string[], hooks:Hooks, capture=false): Promise<{code:number; stdout:string; signal:string|null}> {
  hooks.observeCommand?.(argv);
  if (hooks.signal?.aborted) return {code:1,stdout:'',signal:'aborted'};
  return await new Promise(resolveChild=>{
    const env={...process.env}; delete env.NODE_TEST_CONTEXT;
    let stdout='', signal:string|null=null, done=false;
    const finish=(code:number)=>{if(done)return;done=true;hooks.signal?.removeEventListener('abort',abort);resolveChild({code,stdout,signal});};
    let proc: ReturnType<typeof spawn> | undefined;
    let actual:string[];try{actual=platformArgv(argv);}catch{resolveChild({code:1,stdout:'',signal:null});return;}
    const abort=()=>{signal='aborted';try { if (process.platform !== 'win32' && proc?.pid) process.kill(-proc.pid,'SIGTERM'); else if(proc?.pid) spawnSync('taskkill.exe',['/pid',String(proc.pid),'/T','/F'],{windowsHide:true}); else proc?.kill('SIGTERM'); } catch { /* already exited */ }};
    try { proc=spawn(actual[0],actual.slice(1),{cwd,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'}); } catch {finish(1);return;}
    hooks.signal?.addEventListener('abort',abort,{once:true});
    if(hooks.signal?.aborted) abort();
    proc.stdout?.on('data',(data:Buffer)=>{const text=data.toString();if(capture)stdout+=text;else hooks.onChildOutput?.('stdout',text);});
    proc.stderr?.on('data',(data:Buffer)=>hooks.onChildOutput?.('stderr',data.toString()));
    proc.on('error',()=>finish(1));
    proc.on('close',(code,sig)=>{signal=signal??sig;finish(code??1);});
  });
}
function actualInventory(cwd:string, model:'node'|'go'):string[] {
  if(model==='node') return readdirSync(join(cwd,'test')).filter(f=>f.endsWith('.test.ts')).sort().map(f=>`test/${f}`);
  const result=spawnSync('go',['list','-f','{{.Dir}}','./...'],{cwd,encoding:'utf8'});
  if(result.status!==0) throw Error('Go target discovery failed');
  return result.stdout.trim().split('\n').filter(Boolean).map(p=>p===cwd?'.':`./${p.slice(cwd.length+1).replaceAll('\\','/')}`).sort();
}
function fileDigest(path:string):string|null {try{return hash(readFileSync(path).toString('base64'));}catch{return null;}}
const require=createRequire(import.meta.url);
function packageDigest(name:string, resolver:NodeRequire=require):string|null {
  try {
    const root=realpathSync(resolve(resolver.resolve(`${name}/package.json`),'..'));
    const collected:Array<[string,string]>=[];
    const visit=(directory:string,relative:string)=>{for(const entry of readdirSync(directory).sort()) {
      const path=join(directory,entry),name=relative?`${relative}/${entry}`:entry,stat=lstatSync(path);
      if(stat.isSymbolicLink())throw Error('Unverified loader link');
      if(stat.isDirectory())visit(path,name);else if(stat.isFile()) {const d=fileDigest(path);if(!d)throw Error('Unreadable loader');collected.push([name,d]);} else throw Error('Unsupported loader input');
    }};
    visit(root,'');return hash(collected);
  }catch{return null;}
}
function loaderResolver(cwd:string):NodeRequire {
  const local=createRequire(join(cwd,'package.json'));
  try {local.resolve('tsx/package.json');return local;}catch{return require;}
}
function loaderFor(cwd:string):string {
  try {return pathToFileURL(loaderResolver(cwd).resolve('tsx')).href;}catch{return '';}
}
function loaderIdentity(cwd:string):string|null {
  try {
    const resolver=loaderResolver(cwd),tsxPackage=resolver.resolve('tsx/package.json');
    const tsxRequire=createRequire(tsxPackage),esbuildPackage=tsxRequire.resolve('esbuild/package.json');
    const esbuildRequire=createRequire(esbuildPackage),platform=process.platform==='win32'?'win32':process.platform;
    const identities=[packageDigest('tsx',resolver),packageDigest('esbuild',tsxRequire),packageDigest(`@esbuild/${platform}-${process.arch}`,esbuildRequire)];
    return identities.every(Boolean)?hash(identities):null;
  }catch{return null;}
}
function satisfiesVersion(version:string,range:string):boolean {
  const match=/^(\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(range),actual=/^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if(range==='*')return !!actual;if(!match||!actual)return false;
  const wanted=match.slice(2).map(Number),got=actual.slice(1).map(Number);
  if(got[0]<wanted[0] || got[0]===wanted[0] && (got[1]<wanted[1] || got[1]===wanted[1]&&got[2]<wanted[2]))return false;
  if(!match[1])return got.every((part,i)=>part===wanted[i]);
  if(match[1]==='~')return got[0]===wanted[0]&&got[1]===wanted[1];
  if(wanted[0])return got[0]===wanted[0];
  if(wanted[1])return got[0]===0&&got[1]===wanted[1];
  return got[0]===0&&got[1]===0&&got[2]===wanted[2];
}
function projectDependencyEvidence(cwd:string):Record<string,string>|null {
  try {
    const pkg=JSON.parse(readFileSync(join(cwd,'package.json'),'utf8'));
    const deps=pkg.devDependencies??{},resolver=createRequire(join(cwd,'package.json')),result:Record<string,string>={};
    for(const name of ['tsx','typescript'])if(Object.hasOwn(deps,name)) {
      const path=resolver.resolve(`${name}/package.json`),installed=JSON.parse(readFileSync(path,'utf8'));
      if(typeof deps[name]!=='string'||!satisfiesVersion(installed.version,deps[name]))return null;
      // The selected runner really uses the observed tsx package.
      if(name==='tsx'&&realpathSync(path)!==realpathSync(loaderResolver(cwd).resolve('tsx/package.json')))return null;
      const fingerprint=packageDigest(name,resolver);if(!fingerprint)return null;result[`npm:${name}`]=fingerprint;
    }
    return result;
  }catch{return null;}
}
function goContext(cwd:string):string|null {
  try {const result=spawnSync('go',['env','-json'],{cwd,encoding:'utf8'});if(result.status!==0)return null;
    const value=JSON.parse(result.stdout);delete value.GOGCCFLAGS;return hash(value);
  }catch{return null;}
}
/** Fingerprint the actual Go tool binaries and standard-library source files
 * that Go resolves for this module, rather than trusting a version string. */
function goToolchainIdentity(cwd:string):string|null {
  try {
    const env=spawnSync('go',['env','-json','GOROOT','GOTOOLDIR'],{cwd,encoding:'utf8'});
    if(env.status!==0)return null;const values=JSON.parse(env.stdout);
    const list=spawnSync('go',['list','-deps','-test','-f','{{if .Standard}}{{.Dir}}{{end}}','./...'],{cwd,encoding:'utf8',maxBuffer:16*1024*1024});
    if(list.status!==0)return null;
    const rows:Array<[string,string]>=[];
    const bin=join(values.GOROOT,'bin',process.platform==='win32'?'go.exe':'go');
    const goBin=fileDigest(bin);if(!goBin)return null;rows.push(['go',goBin]);
    for(const name of readdirSync(values.GOTOOLDIR).sort()) {
      const path=join(values.GOTOOLDIR,name),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())return null;
      const value=fileDigest(path);if(!value)return null;rows.push([`tool:${name}`,value]);
    }
    for(const dir of [...new Set(list.stdout.split(/\r?\n/).filter(Boolean))].sort()) {
      const resolved=realpathSync(dir),root=realpathSync(join(values.GOROOT,'src'));
      const rel=relative(root,resolved);if(!rel||rel==='..'||rel.startsWith(`..${process.platform==='win32'?'\\':'/'}`)||isAbsolute(rel))return null;
      for(const name of readdirSync(resolved).sort()) {
        if(!/\.(?:go|s|h|c|syso)$/.test(name)||name.endsWith('_test.go'))continue;
        const path=join(resolved,name),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())return null;
        const bytes=readFileSync(path);if(name.endsWith('.go')&&/^\s*\/\/go:embed\b/m.test(bytes.toString('utf8')))return null;
        rows.push([`${rel}/${name}`,hash(bytes.toString('base64'))]);
      }
    }
    return hash(rows);
  }catch{return null;}
}
function contextFor(cwd:string, profile:Profile, inventory:string[]):string {
  const environment=Object.fromEntries(['NODE_OPTIONS','NODE_PATH','GOFLAGS','GOOS','GOARCH','CGO_ENABLED','GOWORK','GOPROXY','GOPATH','PATH'].map(k=>[k,process.env[k]??'']));
  const go=profile.model==='go'?spawnSync('go',['version'],{cwd,encoding:'utf8'}).stdout?.trim():null;
  const config=(path:string)=>{try{return hash(readFileSync(join(cwd,path)).toString('base64'));}catch{return null;}};
  return hash({policy:'g2-context-1', analyzerVersion, grammar:grammarIdentity(), extractor:extractorStamp(), implementation:['./verification','./discovery','./model-registry','./receipts','../impact/analyze'].map(path=>fileDigest(fileURLToPath(new URL(`${path}.${import.meta.url.endsWith('.ts')?'ts':'js'}`,import.meta.url)))), profile, inventory, runtime:process.version, platform:process.platform, arch:process.arch, executable:process.execPath, executable_digest:fileDigest(process.execPath), tsx, tsx_digest:loaderFor(cwd)?loaderIdentity(cwd):null, project_dependencies:profile.model==='node'?projectDependencyEvidence(cwd):null, go, go_env:profile.model==='go'?goContext(cwd):null, go_toolchain:profile.model==='go'?goToolchainIdentity(cwd):null, environment, package:config('package.json'), tsconfig:config('tsconfig.json'), gomod:config('go.mod'), gosum:config('go.sum')});
}
function loadProfile(cwd:string):Profile {
  try {const p=JSON.parse(readFileSync(join(cwd,'.test-impact.json'),'utf8'));if(typeof p.name==='string' && ((['node','go'].includes(p.model) && p.fullCommand===undefined)||Array.isArray(p.fullCommand)) && (p.gates===undefined||Array.isArray(p.gates)))return p;}catch{}
  return {name:'default',fullCommand:['npm','test'],gates:[{argv:['npm','run','build']}]};
}
function argumentsOf(argv:string[]) {
  let from='',to='',plan=false,all=false,profile:''|'node'|'go'='';
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--from' || argv[i]==='--to') {const key=argv[i];const value=argv[++i];if(!value||value.startsWith('--'))throw Error('Missing endpoint');if(key==='--from'){if(from)throw Error('Duplicate from endpoint');from=value;}else{if(to)throw Error('Duplicate to endpoint');to=value;}}
    else if(argv[i]==='--profile') {const value=argv[++i];if(value!=='node' && value!=='go')throw Error('Unknown profile argument');profile=value;}
    else if(argv[i]==='--plan')plan=true;else if(argv[i]==='--all')all=true;else if(argv[i]!=='--json')throw Error('Unknown argument');
  }
  if(!from||!to)throw Error('Both endpoint arguments --from and --to are required');
  return {from,to,plan,all,profile};
}
export async function runVerificationForTest(request:Request,hooks:Hooks={}) { return verify(request,hooks); }
export async function verify(request:Request,hooks:Hooks={}) {
  const report:any={schema_version:1,selection_strategy:'full',execution_units:[],calculated_affected_units:[],execution_status:'not_run',verification_status:'not_performed',exit_code:0,stable_input_assumption:'Relevant checkout inputs stay stable during the run, as assumed by ordinary test runners.',fallback_reasons:[]};
  try {
    const args=argumentsOf(request.argv),cwd=resolve(request.cwd), profile=request.fixtureProfile??(args.profile?{name:args.profile,model:args.profile}:loadProfile(cwd));
    const from=endpoint(cwd,args.from),to=endpoint(cwd,args.to);
    const head=git(cwd,'rev-parse','--verify','HEAD^{commit}');
    const dirty=git(cwd,'status','--porcelain','--untracked-files=no');
    report.comparison={from,to};report.checkout={commit:head,dirty:!!dirty};report.profile=profile.name;
    report.workflow={preparation:profile.preparation??[],full:profile.fullCommand??(profile.model==='go'?['go','test','./...']:['node','--test']),gates:profile.gates??[]};
    if(!args.plan && (head!==to.commit || dirty)) {report.exit_code=1;report.verification_status='incomplete';report.fallback_reasons.push('Checkout does not match the clean target commit');return report;}
    let inventory:string[]=[];let inventoryComplete=false;
    if(profile.model) try {inventory=actualInventory(cwd,profile.model);inventoryComplete=true;} catch { report.fallback_reasons.push('Runner target discovery incomplete'); }
    report.inventory=inventory;report.execution_units=inventory;
    if(profile.model==='node'&&!profile.fullCommand) {const loader=loaderFor(cwd);report.workflow.full=loader?[process.execPath,'--import',loader,'--test',...inventory]:null;}
    const repo=realpathSync(git(cwd,'rev-parse','--git-common-dir').startsWith('/')?git(cwd,'rev-parse','--git-common-dir'):resolve(cwd,git(cwd,'rev-parse','--git-common-dir')));
    let stateRoot=request.stateRoot;
    try {
      const checkout=realpathSync(git(cwd,'rev-parse','--show-toplevel'));
      stateRoot??=defaultStateRoot(checkout);
      const state=realpathSync(stateRoot);
      const rel=relative(checkout,state);
      if(!rel || (!rel.startsWith('..'+(process.platform==='win32'?'\\':'/')) && rel!=='..' && !isAbsolute(rel)))throw Error('Receipt storage is inside the checkout');
    }catch{stateRoot=undefined;report.fallback_reasons.push('Private receipt storage is unavailable or inside the checkout');}

    const context=contextFor(cwd,profile,inventory);
    const baseline=stateRoot?findReceipt(stateRoot,repo,{commit:from.commit,tree:from.tree,profile:profile.name,context},hooks.beforeReceiptRead):null;
    report.baseline=baseline?.id??null;
    if(!baseline)report.fallback_reasons.push('No compatible passing baseline receipt');
    if(profile.model && from.commit!==to.commit) {
      const analysis=await child(cwd,[...analyzerCommand(),'impact','--from',from.commit,'--to',to.commit,'--schema-version','2','--json'],hooks,true);
      let impact:any;try{impact=JSON.parse(analysis.stdout);impact=hooks.transformImpact?.(impact)??impact;}catch{}
      const discovered=await discoverComparison(cwd,from.commit,to.commit,profile.model);
      report.calculated_affected_units=discovered?.affected??[];
      const identity=impact?.comparison?.from?.requested===from.commit && impact?.comparison?.from?.commit===from.commit && impact?.comparison?.from?.tree===from.tree && impact?.comparison?.to?.requested===to.commit && impact?.comparison?.to?.commit===to.commit && impact?.comparison?.to?.tree===to.tree;
      const aid=impact?.analysis_identity;
      const analyzerIdentity=aid?.analyzer_version===analyzerVersion && aid.grammar_identity===grammarIdentity() && aid.extractor_identity===(extractorStamp()??'unavailable') && aid.resolver_identity===(extractorStamp()??'unavailable') && aid.policy_identity===(profile.model==='go'?'conditional-go-static-v2':'conditional-node-static-v3') && aid.mode==='conservative';
      let valid=analysis.code===0 && identity && analyzerIdentity && impact?.schema_version===2 && impact.analysis_status==='conditional' && discovered!==null && validateModelRequirements(impact.supported_model,impact.context_requirements,discovered.model) && JSON.stringify(inventory)===JSON.stringify(discovered.inventory);
      if(valid && (!Array.isArray(impact.analysis_gaps)||!Array.isArray(impact.required_fallback_scopes)||!Array.isArray(impact.affected)||!Array.isArray(impact.changes))) valid=false;
      if(valid) {
        if(discovered!.requiredScopes.some(scope=>!impact.analysis_gaps.some((gap:any)=>gap.scope===scope)))valid=false;
        const scopes=impact.required_fallback_scopes.map((entry:any)=>entry.scope).sort();
        if(JSON.stringify(scopes)!==JSON.stringify(discovered!.requiredScopes))valid=false;
        for(const entry of impact.required_fallback_scopes) if(entry.kind!=='scope'||!discovered!.scopes.has(entry.scope))valid=false;
        for(const gap of impact.analysis_gaps) {
          const expectedTree=gap.revision==='from'?from.tree:gap.revision==='to'?to.tree:null;
          const boundary=gap.boundary;
          if(!expectedTree||gap.kind!=='opaque_embedded_resource'||!discovered!.requiredScopes.includes(gap.scope)||!boundary||boundary.kind!=='go_package'||boundary.tree!==expectedTree||`go-package:${boundary.module}:${boundary.package_path}`!==gap.scope||JSON.stringify(boundary.model)!==JSON.stringify({id:'go-static-packages',version:'2'}))valid=false;
        }
        const named=new Set(impact.affected.filter((item:any)=>typeof item?.path==='string').map((item:any)=>profile.model==='go' && item.path.endsWith('.go') ? (item.path.includes('/') ? `./${item.path.slice(0,item.path.lastIndexOf('/'))}` : '.') : item.path));
        if(discovered!.affected.some(unit=>!named.has(unit)))valid=false;
      }
      const binding={target_commit:to.commit,target_tree:to.tree,profile:profile.name,inventory:hash(inventory)};
      const nodeVersion=Number(process.versions.node.split('.')[0]);
      const goInfo=profile.model==='go'?spawnSync('go',['env','-json','GOVERSION','GOOS','GOARCH','GOFLAGS','GOWORK','CGO_ENABLED','GOMOD'],{cwd,encoding:'utf8'}):null;
      let goEnvironment:any=null;try{if(goInfo?.status===0)goEnvironment=JSON.parse(goInfo.stdout);}catch{}
      const declaredGo=discovered?.model.id==='go-static-packages'?Number(discovered.model.goVersion.split('.')[1]):Infinity;
      const actualGo=Number(/^go1\.(\d+)/.exec(goEnvironment?.GOVERSION??'')?.[1]);
      const actualRuntime=profile.model==='node' ? nodeVersion>=20 && !!fileDigest(process.execPath) : !!goEnvironment && Number.isFinite(actualGo) && actualGo>=declaredGo && !!goToolchainIdentity(cwd);
      const simpleEnvironment=!process.env.NODE_OPTIONS && !process.env.NODE_PATH && (profile.model!=='go' || (!!goEnvironment && !goEnvironment.GOFLAGS && !process.env.GOOS && !process.env.GOARCH && !process.env.GOWORK && !goEnvironment.GOWORK && resolve(goEnvironment.GOMOD??'')===join(cwd,'go.mod')));
      const nodeLoader=loaderFor(cwd);
      const simpleRunner=!!profile.model && !profile.fullCommand && !(profile.preparation?.length) && !(profile.gates?.length) && (profile.model==='go'||!!nodeLoader && !!loaderIdentity(cwd));
      const projectDependencies=profile.model==='node'?projectDependencyEvidence(cwd):{};
      const noExternal=(discovered?.model.dependencies??[]).every(d=>!d.startsWith('npm:')||!!projectDependencies?.[d]);
      const observations:Record<string,any>={
        runtime:{complete:actualRuntime,observed:hash({node:process.version,platform:process.platform,arch:process.arch,go:goEnvironment?.GOVERSION})},
        runner:{complete:simpleRunner,observed:hash({model:profile.model,loader:nodeLoader,executable:process.execPath})},
        inventory:{complete:inventoryComplete && !!discovered && JSON.stringify(inventory)===JSON.stringify(discovered.inventory),observed:hash(inventory)},
        resolver:{complete:!!discovered && simpleEnvironment && noExternal,observed:hash({model:discovered?.model,go:goEnvironment})},
        inputs:{complete:!!discovered,observed:hash({from:from.tree,to:to.tree})},
        environment:{complete:simpleEnvironment,observed:hash({nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??'',go:goEnvironment})},
        baseline:{complete:!!baseline,observed:baseline?.id??null},
      };
      report.requirements=[];
      for(const id of ['runtime','runner','inventory','resolver','inputs','environment','baseline']) {
        const raw={binding,...observations[id]};const observation=hooks.transformEvidence?hooks.transformEvidence(id,raw):raw;
        const pass=!!observation && observation.complete===true && JSON.stringify(observation.binding)===JSON.stringify(binding) && observation.observed===raw.observed;
        report.requirements.push({id,valid:pass,collector_version:1,observed_digest:raw.observed});if(!pass)valid=false;
      }
      for(const dependency of discovered?.model.dependencies??[]) {
        const raw={binding,complete:dependency.startsWith('npm:')?!!projectDependencies?.[dependency]:actualRuntime,observed:dependency.startsWith('npm:')?projectDependencies?.[dependency]??null:hash({dependency,runtime:process.version,go:goEnvironment?.GOVERSION})};
        const observation=hooks.transformEvidence?hooks.transformEvidence(`dependency:${dependency}`,raw):raw;
        const pass=!!observation && observation.complete===true && JSON.stringify(observation.binding)===JSON.stringify(binding) && observation.observed===raw.observed;
        report.requirements.push({id:`dependency:${dependency}`,valid:pass,collector_version:1,observed_digest:raw.observed});if(!pass)valid=false;
      }
      if(valid && baseline && !args.all) {
        const selected=new Set(discovered!.affected);
        for(const scope of impact.required_fallback_scopes) for(const unit of discovered!.scopes.get(scope.scope)??[])selected.add(unit);
        report.execution_units=inventory.filter(unit=>selected.has(unit));report.selection_strategy='selective';
      } else report.fallback_reasons.push('Conditional model or execution evidence did not establish a safe sparse selection');
    }
    if(args.plan)return report;
    if(contextFor(cwd,profile,inventory)!==context) {report.exit_code=1;report.verification_status='incomplete';report.fallback_reasons.push('Execution context changed before execution');return report;}
    let commands: string[][]=[];
    commands.push(...(profile.preparation??[]).map(c=>c.argv));
    if(report.selection_strategy==='selective') {
      if(report.execution_units.length) commands.push(profile.model==='go'?['go','test',...report.execution_units]:[process.execPath,'--import',loaderFor(cwd),'--test',...report.execution_units]);
    } else if(profile.fullCommand)commands.push(profile.fullCommand);
    else if(profile.model==='go')commands.push(['go','test','./...']);
    else if(profile.model==='node' && loaderFor(cwd))commands.push([process.execPath,'--import',loaderFor(cwd),'--test',...inventory]);
    else throw Error('No full workflow is configured');
    commands.push(...(profile.gates??[]).map(c=>c.argv));
    for(const argv of commands) {const result=await child(cwd,argv,hooks);if(result.code!==0||result.signal){report.exit_code=result.code||1;report.execution_status='failed';report.verification_status='failed';report.child_signal=result.signal;return report;}}
    report.execution_status='passed';
    if(!stateRoot)throw Error('Private receipt storage is unavailable');
    if(profile.model && (!inventoryComplete || JSON.stringify(actualInventory(cwd,profile.model))!==JSON.stringify(inventory)))throw Error('Runner inventory could not be revalidated');
    if(contextFor(cwd,profile,inventory)!==context)throw Error('Execution context changed before receipt publication');
    const receipt=await publishReceipt(stateRoot,repo,{commit:to.commit,tree:to.tree,context,profile:profile.name,predecessor:report.selection_strategy==='selective'?baseline!.id:null},hooks.beforeReceiptPublish,hooks.failReceiptPublish);
    report.receipt_id=receipt.id;report.verification_status='validated';return report;
  } catch(error:any) {report.exit_code=error?.message?.includes('endpoint')||error?.message?.includes('worktree')||error?.message?.includes('argument')?2:1;report.verification_status='incomplete';report.fallback_reasons.push(String(error?.message??error));return report;}
}
export async function productionCommandForTest() {const source=import.meta.url.endsWith('.ts');return [process.execPath,...(source?['--import',tsx]:[]),fileURLToPath(new URL(source?'./verification-cli.ts':'./verification-cli.js',import.meta.url))];}
export async function installProductionFixtureProfileForTest(input:{cwd:string;fullCommand:string[];gates:string[][]}) {writeFileSync(join(input.cwd,'.test-impact.json'),JSON.stringify({name:'default',fullCommand:input.fullCommand,gates:input.gates.map(argv=>({argv}))}));}
