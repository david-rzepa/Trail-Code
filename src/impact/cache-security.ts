/** Conservative cache trust checks; never treat synthetic POSIX mode bits as NTFS ACLs. */
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

// The path and mode are passed in the environment, never interpolated into
// PowerShell source. Administrators and SYSTEM have machine-level authority;
// all other principals must lack write access (or all access for private data).
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$p = $env:TRAIL_IMPACT_CACHE_PATH
$uid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $p
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $uid.Value) { exit 1 }
if ($env:TRAIL_IMPACT_CACHE_MODE -eq 'create') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($r) }
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($uid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $p -AclObject $acl
  $acl = Get-Acl -LiteralPath $p
}
$trusted = @($uid.Value, 'S-1-5-18', 'S-1-5-32-544')
$danger = [int][System.Security.AccessControl.FileSystemRights]::Write -bor [int][System.Security.AccessControl.FileSystemRights]::Delete -bor [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor 0x40000000 -bor 0x10000000
foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  if ($trusted -contains $r.IdentityReference.Value) { continue }
  if ($env:TRAIL_IMPACT_CACHE_MODE -ne 'parent' -or (([int]$r.FileSystemRights -band $danger) -ne 0)) { exit 1 }
}
exit 0
`;
function windowsAcl(path: string, mode: "parent" | "private" | "create"): boolean {
  const root = process.env.SystemRoot;
  if (!root) return false;
  const exe = join(root,"System32","WindowsPowerShell","v1.0","powershell.exe");
  const result = spawnSync(exe,["-NoLogo","-NoProfile","-NonInteractive","-Command",WINDOWS_ACL],{
    encoding:"utf8",timeout:15000,windowsHide:true,
    env:{...process.env,TRAIL_IMPACT_CACHE_PATH:path,TRAIL_IMPACT_CACHE_MODE:mode},
  });
  return !result.error && result.status === 0;
}
export function trustedCacheDirectory(path: string, mode: "parent" | "private", platform = process.platform): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (platform === "win32") return windowsAcl(path,mode);
    if (process.getuid && st.uid !== process.getuid()) return false;
    return (st.mode & (mode === "parent" ? 0o022 : 0o077)) === 0;
  } catch { return false; }
}
/** Only call for a newly created directory under a verified safe parent. */
export function secureNewWindowsCacheDirectory(path: string, platform = process.platform): boolean {
  return platform !== "win32" || windowsAcl(path,"create");
}
