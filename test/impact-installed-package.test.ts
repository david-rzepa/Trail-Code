/** Exercise the packed distribution as a consumer installs it, not source-mode tsx. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const project = resolve(".");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 240_000, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(r.status, 0, `${command} ${args.join(" ")}: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, ent.name);
    if (ent.isDirectory()) out.push(...walk(path)); else if (ent.isFile()) out.push(path);
  }
  return out.sort();
}

test("packed installation has meaningful grammar identity and reuses extraction cache", { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "impact-packed-"));
  try {
    const pack = join(dir, "pack"), install = join(dir, "consumer"), repo = join(dir, "repo"), home = join(dir, "home");
    for (const d of [pack, install, repo, home]) mkdirSync(d, { recursive: true });
    run(npm, ["run", "build"], project);
    const manifest = JSON.parse(run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", pack], project));
    const tarball = join(pack, manifest[0].filename);
    writeFileSync(join(install, "package.json"), JSON.stringify({ name: "impact-packed-consumer", version: "1.0.0", private: true }));
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], install);
    const pkg = join(install, "node_modules", "@nanonets", "graft");
    assert.ok(existsSync(join(pkg, "dist", "bin", "graft.js")));
    run("git", ["init", "-b", "main"], repo);
    run("git", ["config", "user.name", "Impact Test"], repo);
    run("git", ["config", "user.email", "impact@example.invalid"], repo);
    writeFileSync(join(repo, "input.ts"), "export const input = 1;\n");
    run("git", ["add", "input.ts"], repo); run("git", ["commit", "-m", "one"], repo);
    const a = run("git", ["rev-parse", "HEAD"], repo).trim();
    const trace = join(dir, "trace.mjs"), readLog = join(dir, "cache-reads.log");
    writeFileSync(trace, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
const read=fs.readFileSync, append=fs.appendFileSync;
fs.readFileSync=function(p,...args){ if(typeof p==='string' && p.startsWith(process.env.IMPACT_CACHE_ROOT+path.sep) && p.endsWith('.json')) append(process.env.IMPACT_CACHE_LOG,p+'\\n'); return read.call(this,p,...args); };
syncBuiltinESMExports();
`);
    const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", IMPACT_CACHE_ROOT: join(home, ".cache", "trail-impact"), IMPACT_CACHE_LOG: readLog };
    const analyze = () => JSON.parse(run(process.execPath, ["--import", pathToFileURL(trace).href, join(pkg, "dist", "bin", "graft.js"), "impact", "--from", a, "--to", a, "--json"], repo, env));
    const cold = analyze();
    assert.equal(cold.schema_version, 1);
    assert.ok(typeof cold.analysis_identity.grammar_identity === "string" && cold.analysis_identity.grammar_identity.length > 0);
    assert.ok(!/^(unknown|unavailable|none|missing)$/i.test(cold.analysis_identity.grammar_identity), "installed package must report meaningful grammar identity");
    const cacheFiles = walk(join(home, ".cache", "trail-impact"));
    assert.ok(cacheFiles.length > 0, "installed package did not persist compatible extraction facts");
    const cacheBefore = cacheFiles.map(f => [f.slice(home.length), readFileSync(f).toString("base64")]);
    rmSync(readLog, { force: true });
    const warm = analyze();
    assert.ok(existsSync(readLog) && readFileSync(readLog, "utf8").trim().length > 0, "warm installed analysis must read persisted extraction facts");
    assert.deepEqual(warm, cold);
    const cacheAfter = walk(join(home, ".cache", "trail-impact")).map(f => [f.slice(home.length), readFileSync(f).toString("base64")]);
    assert.deepEqual(cacheAfter, cacheBefore, "warm analysis must retain compatible cache facts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
