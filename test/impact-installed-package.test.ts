/** Exercise the real npm tarball in an offline consumer layout, not source-mode tsx. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { x as extractTar } from "tar";
import { pathToFileURL } from "node:url";

const project = resolve(".");
// Run npm's JS entry point with Node: Windows .cmd shims cannot be spawned
// directly without a shell. npm exposes npm_execpath when running npm test.
function npmCli(node: string, override: string | undefined, windows: boolean, exists: (path: string) => boolean): string {
  const paths = windows ? win32 : { dirname, join, resolve };
  const candidates = [override, paths.resolve(paths.dirname(node), "node_modules/npm/bin/npm-cli.js"), paths.resolve(paths.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js")];
  const cli = candidates.find((p): p is string => !!p && exists(p));
  assert.ok(cli, "npm CLI was not found; set npm_execpath to npm-cli.js");
  return cli;
}
function npmRun(args: string[], cwd: string): string {
  const cli = npmCli(process.execPath, process.env.npm_execpath, process.platform === "win32", existsSync);
  return run(process.execPath, [cli, ...args], cwd, { ...process.env, npm_config_offline: "true" });
}
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

test("npm CLI discovery uses Node-compatible paths for Windows", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const expected = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.equal(npmCli(node, undefined, true, path => path === expected), expected);
  assert.equal(npmCli(node, "C:\\custom\\npm-cli.js", true, path => path === "C:\\custom\\npm-cli.js"), "C:\\custom\\npm-cli.js");
});

test("packed distribution has meaningful grammar identity and reuses extraction cache offline", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "impact-packed-"));
  try {
    const pack = join(dir, "pack"), install = join(dir, "consumer"), repo = join(dir, "repo"), home = join(dir, "home"), source = join(dir, "source");
    for (const d of [pack, install, repo, home, source]) mkdirSync(d, { recursive: true });
    // The normal test runner executes files concurrently. Build an isolated copy
    // of the committed source so this check cannot rewrite their shared dist/.
    const archive = join(dir, "source.tar");
    run("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"], project);
    await extractTar({ file: archive, cwd: source, strict: true });
    symlinkSync(join(project, "node_modules"), join(source, "node_modules"), "junction");
    npmRun(["run", "build"], source);
    const manifest = JSON.parse(npmRun(["pack", "--ignore-scripts", "--json", "--pack-destination", pack], source));
    const tarball = join(pack, manifest[0].filename);
    // Put the unmodified packed tarball under an isolated consumer's node_modules.
    // Link the already installed, lockfile-pinned dependencies as directory
    // junctions; resolution stays offline and avoids copying the entire tree.
    const modules = join(install, "node_modules"), sourceModules = join(project, "node_modules");
    mkdirSync(modules, { recursive: true });
    for (const ent of readdirSync(sourceModules, { withFileTypes: true })) {
      if (ent.name === ".bin" || ent.name === "@nanonets" || !ent.isDirectory()) continue;
      symlinkSync(join(sourceModules, ent.name), join(modules, ent.name), "junction");
    }
    const pkg = join(modules, "@nanonets", "graft");
    mkdirSync(pkg, { recursive: true });
    await extractTar({ file: tarball, cwd: pkg, strip: 1, strict: true });
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
