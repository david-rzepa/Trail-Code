import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, fsyncSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface Receipt {
  version: 1;
  id: string;
  commit: string;
  tree: string;
  context: string;
  profile: string;
  predecessor: string | null;
  stable_inputs_assumed: true;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const filename = (id: string) => `${id}.json`;
const ID = /^[0-9a-f]{48}$/;
const USER = typeof process.getuid === 'function' ? process.getuid() : undefined;

/** Ask the OS to inspect DACLs, rather than relying on Windows' synthetic POSIX mode bits. */
function windowsAcl(path: string, privatePath: boolean): void {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $p = $env:TRAIL_IMPACT_ACL_PATH
    $acl = Get-Acl -LiteralPath $p
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($env:TRAIL_IMPACT_PRIVATE -eq '1' -and $owner -ne $user) { exit 1 }
    foreach ($rule in $acl.Access) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($sid -in @($user, 'S-1-5-18', 'S-1-5-32-544')) { continue }
      if ($env:TRAIL_IMPACT_PRIVATE -eq '1') { exit 1 }
      # Write, deletion, permission or ownership grants may replace a child.
      if (([int64]$rule.FileSystemRights -band 0x000d0040) -ne 0) { exit 1 }
    }
  `;
  const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,TRAIL_IMPACT_ACL_PATH:path,TRAIL_IMPACT_PRIVATE:privatePath?'1':'0'},encoding:'utf8'});
  if(r.status!==0)throw Error('Windows receipt ACL could not be verified');
}
function protectNewWindowsRoot(path:string):void {
  const script=String.raw`
    $ErrorActionPreference='Stop'
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $env:TRAIL_IMPACT_ACL_PATH -AclObject $acl
  `;
  const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,TRAIL_IMPACT_ACL_PATH:path},encoding:'utf8'});
  if(r.status!==0)throw Error('Windows receipt ACL could not be established');
}
function privateDirectory(path:string):void {
  const stat=lstatSync(path);
  if(!stat.isDirectory() || stat.isSymbolicLink())throw Error('Untrusted state directory');
  if(process.platform==='win32') windowsAcl(path,true);
  else if((USER!==undefined && stat.uid!==USER) || (stat.mode&0o077)!==0)throw Error('Untrusted state directory');
}
/** Protect every ancestor against replacement by another local user. Sticky
 * directories such as /tmp protect entries owned by this user. Same-user
 * interference is explicitly outside this store's trust boundary. */
function trustedAncestors(path:string):void {
  let current=resolve(path);
  for (;;) {
    const stat=lstatSync(current);
    if(!stat.isDirectory() || stat.isSymbolicLink())throw Error('Untrusted state parent');
    if(process.platform==='win32') windowsAcl(current,false);
    else {
      if(USER!==undefined && stat.uid!==0 && stat.uid!==USER)throw Error('Untrusted state parent owner');
      if((stat.mode&0o022)!==0 && (stat.mode&0o1000)===0)throw Error('Writable state parent');
    }
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
}
interface Store {root:string; namespace:string; rootIdentity:string; namespaceIdentity:string; fd?:number}
function identity(path:string):string {const stat=lstatSync(path);return `${stat.dev}:${stat.ino}`;}
function checkStore(store:Store):void {
  privateDirectory(store.root);privateDirectory(store.namespace);
  if(identity(store.root)!==store.rootIdentity || identity(store.namespace)!==store.namespaceIdentity)throw Error('Receipt store replaced');
  if(store.fd===undefined)trustedAncestors(dirname(store.root));
}
function storePath(store:Store):string {checkStore(store);return store.fd===undefined?store.namespace:`/proc/self/fd/${store.fd}`;}
function openStore(root:string,repository:string):Store {
  // Reject a symlinked final component before canonicalizing parents.
  privateDirectory(root);
  root=realpathSync(root);trustedAncestors(dirname(root));privateDirectory(root);
  let rootFd:number|undefined,namespaceFd:number|undefined;
  try {
    if(process.platform==='linux') {
      rootFd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      const stat=fstatSync(rootFd);if(!stat.isDirectory()||(USER!==undefined&&stat.uid!==USER)||(stat.mode&0o077)!==0)throw Error('Untrusted receipt root');
    }
    const rootIdentity=identity(root),path=join(rootFd===undefined?root:`/proc/self/fd/${rootFd}`,digest(repository));
    try{mkdirSync(path,{mode:0o700});}catch(error:any){if(error.code!=='EEXIST')throw error;}
    const namespace=join(root,digest(repository));privateDirectory(namespace);
    const namespaceIdentity=identity(namespace);
    if(rootFd!==undefined) {
      namespaceFd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      const stat=fstatSync(namespaceFd);if(!stat.isDirectory()||(USER!==undefined&&stat.uid!==USER)||(stat.mode&0o077)!==0 || `${stat.dev}:${stat.ino}`!==namespaceIdentity)throw Error('Untrusted receipt namespace');
    }
    const store={root,namespace,rootIdentity,namespaceIdentity,fd:namespaceFd};checkStore(store);namespaceFd=undefined;return store;
  } finally {if(rootFd!==undefined)closeSync(rootFd);if(namespaceFd!==undefined)closeSync(namespaceFd);}
}
function closeStore(store:Store):void {if(store.fd!==undefined)closeSync(store.fd);}

/** Create the default private root below the user's protected home directory. */
export function defaultStateRoot(checkout?:string):string {
  const home=realpathSync(userInfo().homedir);
  const root=join(home,'.trail-test-impact-state');
  if(checkout) {const rel=relative(checkout,root);if(!rel || (rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel)))throw Error('Receipt storage is inside the checkout');}
  trustedAncestors(home);
  let created=false;
  try{mkdirSync(root,{mode:0o700});created=true;}catch(error:any){if(error.code!=='EEXIST')throw error;}
  if(created && process.platform==='win32')protectNewWindowsRoot(root);
  privateDirectory(root);return root;
}
function readPrivateFile(path:string):string|null {
  let fd=-1;
  try {
    const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink())return null;
    if(process.platform==='win32')windowsAcl(path,true);
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const stat=fstatSync(fd);
    if(!stat.isFile()||(USER!==undefined&&stat.uid!==USER)||(process.platform!=='win32'&&(stat.mode&0o077)!==0)||stat.size>128*1024||stat.dev!==before.dev||stat.ino!==before.ino)return null;
    return readFileSync(fd,'utf8');
  }catch{return null;}finally{if(fd!==-1)closeSync(fd);}
}
function readReceipt(store:Store,id:string):Receipt|null {
  if(!ID.test(id))return null;
  try {
    const dir=join(storePath(store),id);privateDirectory(dir);
    if(readPrivateFile(join(dir,'complete'))!=='complete\n')return null;
    const contents=readPrivateFile(join(dir,'receipt.json'));if(contents===null)return null;
    const item:Receipt=JSON.parse(contents);
    if(item.version!==1||item.id!==id||!/^[0-9a-f]{40,64}$/.test(item.commit)||!/^[0-9a-f]{40,64}$/.test(item.tree)||typeof item.context!=='string'||typeof item.profile!=='string'||item.stable_inputs_assumed!==true||(item.predecessor!==null&&(typeof item.predecessor!=='string'||!ID.test(item.predecessor))))return null;
    return item;
  }catch{return null;}
}
function validChain(store:Store,receipt:Receipt):boolean {
  const visited=new Set<string>();let current:Receipt|null=receipt;
  while(current){if(visited.has(current.id))return false;visited.add(current.id);if(!current.predecessor)return true;
    const parent:Receipt|null=readReceipt(store,current.predecessor);
    if(!parent||parent.profile!==current.profile||parent.context!==current.context)return false;current=parent;}
  return false;
}
export function findReceipt(root:string,repository:string,key:{commit:string;tree:string;context:string;profile:string},beforeRead?:()=>void):Receipt|null {
  let store:Store|undefined;
  try {store=openStore(root,repository);beforeRead?.();
    for(const name of readdirSync(storePath(store)).sort()) {if(!ID.test(name))continue;
      const receipt=readReceipt(store,name);
      if(receipt&&receipt.commit===key.commit&&receipt.tree===key.tree&&receipt.context===key.context&&receipt.profile===key.profile&&validChain(store,receipt))return receipt;}
  }catch{/* No trustworthy evidence. */}finally{if(store)closeStore(store);}
  return null;
}
export async function publishReceipt(root:string,repository:string,data:Omit<Receipt,'version'|'id'|'stable_inputs_assumed'>,beforePublish?:()=>Promise<void>,failPublish?:()=>void):Promise<Receipt> {
  const store=openStore(root,repository);
  try {
    if(data.predecessor){const predecessor=readReceipt(store,data.predecessor);if(!predecessor||predecessor.context!==data.context||predecessor.profile!==data.profile||!validChain(store,predecessor))throw Error('Missing receipt predecessor');}
    await beforePublish?.();
    const id=randomBytes(24).toString('hex'),receipt:Receipt={version:1,id,...data,stable_inputs_assumed:true};
    const directory=join(storePath(store),id);
    // mkdir is exclusive, including on filesystems without hard links. Readers
    // ignore this directory until the separately created completion marker exists.
    mkdirSync(directory,{mode:0o700});privateDirectory(directory);
    const writeDurably=(path:string,contents:string)=>{const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);try{writeFileSync(fd,contents);fsyncSync(fd);}finally{closeSync(fd);}};
    writeDurably(join(directory,'receipt.json'),JSON.stringify(receipt));
    failPublish?.();
    storePath(store); // Recheck the namespace after the publication hook.
    writeDurably(join(directory,'complete'),'complete\n');
    return receipt;
  }finally{closeStore(store);}
}
