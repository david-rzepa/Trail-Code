import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs, { mkdtempSync, chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grammarIdentity } from "../src/impact/analyze.js";
import { secureNewWindowsCacheDirectory, trustedCacheDirectory } from "../src/impact/cache-security.js";

test("grammar identity includes the actual dynamically imported ESM runtime", () => {
  const runtime = fileURLToPath(import.meta.resolve("web-tree-sitter"));
  const before = grammarIdentity();
  const original = fs.readFileSync;
  try {
    fs.readFileSync = function(path: fs.PathOrFileDescriptor, ...args: any[]): any {
      const value = (original as any).call(this,path,...args);
      if (path === runtime) return Buffer.concat([Buffer.from(value), Buffer.from("\n// changed runtime\n")]);
      return value;
    } as typeof fs.readFileSync;
    syncBuiltinESMExports();
    assert.notEqual(grammarIdentity(),before,"ESM runtime changes must invalidate the identity");
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  assert.equal(grammarIdentity(),before);
});

test("cache trust rejects symlinks and untrusted POSIX directory modes", {skip:process.platform === "win32"}, () => {
  const root=mkdtempSync(join(tmpdir(),"impact-acl-"));
  try {
    const dir=join(root,"dir"), link=join(root,"link");mkdirSync(dir,{mode:0o700});symlinkSync(dir,link,"dir");
    assert.ok(trustedCacheDirectory(dir,"private"));
    assert.equal(trustedCacheDirectory(link,"private"),false);
    chmodSync(dir,0o750);assert.equal(trustedCacheDirectory(dir,"private"),false);
    chmodSync(dir,0o770);assert.equal(trustedCacheDirectory(dir,"parent"),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("Windows ACL verification fails closed when the native checker is unavailable", {skip:process.platform === "win32"}, () => {
  const root=mkdtempSync(join(tmpdir(),"impact-acl-no-windows-"));
  const before=process.env.SystemRoot;
  try { delete process.env.SystemRoot; assert.equal(trustedCacheDirectory(root,"private","win32"),false); }
  finally {if (before !== undefined) process.env.SystemRoot=before;rmSync(root,{recursive:true,force:true});}
});


test("Windows cache ACL accepts a private directory and rejects an Everyone grant", {skip:process.platform !== "win32"}, () => {
  const root=mkdtempSync(join(tmpdir(),"impact-windows-acl-"));
  try {
    const dir=join(root,"private"); mkdirSync(dir);
    assert.ok(secureNewWindowsCacheDirectory(dir),"could not create private ACL");
    assert.ok(trustedCacheDirectory(dir,"private"),"private ACL was not recognized");
    const systemRoot=process.env.SystemRoot;
    assert.ok(systemRoot,"Windows must provide SystemRoot");
    const icacls=join(systemRoot,"System32","icacls.exe");
    const grant=spawnSync(icacls,[dir,"/grant","*S-1-1-0:(OI)(CI)F"],{encoding:"utf8",windowsHide:true});
    assert.equal(grant.status,0,grant.stderr);
    assert.equal(trustedCacheDirectory(dir,"private"),false,"Everyone must not be trusted with cache content");
  } finally {rmSync(root,{recursive:true,force:true});}
});
