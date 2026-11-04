/** Coherent read-only Btrfs snapshots. Other filesystems fail closed. */
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { captureWorktree } from "./coordinator.js";

export interface CapturedFile { mode: string; bytes: Buffer }
export interface CapturedTree { fingerprint: string; files: Map<string, CapturedFile> }
function run(command: string, args: string[]): string {
  const p = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  if (p.error || p.status !== 0) throw new Error(`${command}: ${p.error?.message ?? p.stderr?.trim() ?? "failed"}`);
  return p.stdout;
}
/**
 * Snapshot only when the repository itself is a Btrfs subvolume. A read-only
 * snapshot captures inputs atomically; nested subvolume placeholders are refused.
 * Use the same coordinator validity decisions as the deterministic fault tests.
 */
export async function captureBtrfsWorktree(repo: string): Promise<CapturedTree> {
  const root = realpathSync(repo);
  try {
    if (run("stat", ["-f", "-c", "%T", "--", root]).trim() !== "btrfs") throw new Error("repository is not on Btrfs");
    const mountOptions = run("findmnt", ["-n", "-o", "OPTIONS", "-T", root]).trim().split(",");
    if (process.geteuid?.() !== 0 && !mountOptions.includes("user_subvol_rm_allowed")) throw new Error("Btrfs snapshot cleanup is not permitted for this user");
  } catch (error) { throw new Error(`worktree snapshot capture unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  let container = "", snapshot = "", created = false;
  const paths = new Map<string, { path: string; isDirectory: boolean }>();
  const backend = {
    async acquire(): Promise<{ strategy:"immutable"; identity:string }> {
      container = mkdtempSync(join(dirname(root), `.${basename(root)}-impact-`));
      snapshot = join(container, "snapshot");
      run("btrfs", ["subvolume", "snapshot", "-r", root, snapshot]);
      created = true;
      if (!/ro=true\s*$/.test(run("btrfs", ["property", "get", "-ts", snapshot, "ro"]).trim())) throw new Error("snapshot is not read-only");
      return {strategy:"immutable", identity:"btrfs-read-only"};
    },
    async observe() { return {covered:false}; },
    async enumerate(): Promise<string[]> {
      paths.clear();
      const walk = (dir: string, prefix: string) => {
        for (const raw of readdirSync(dir, {encoding:"buffer"}).sort(Buffer.compare)) {
          const name = raw.toString("utf8");
          if (!Buffer.from(name,"utf8").equals(raw)) throw new Error("unsupported filename encoding");
          if (prefix === "" && name === ".git") continue;
          const path = prefix ? `${prefix}/${name}` : name;
          if (name === ".git") throw new Error(`nested repository metadata needs explicit input policy: ${path}`);
          const abs = join(dir,name), st = lstatSync(abs);
          if (st.ino === 2) throw new Error(`nested subvolume unavailable in snapshot: ${path}`);
          if (st.isDirectory()) { paths.set(`D:${path}`,{path,isDirectory:true}); walk(abs,path); }
          else if (st.isFile() || st.isSymbolicLink()) paths.set(`F:${path}`,{path,isDirectory:false});
          else throw new Error(`unsupported worktree input: ${path}`);
        }
      };
      walk(snapshot, "");
      return [...paths.keys()];
    },
    async read(key: string): Promise<string> {
      const entry = paths.get(key); if (!entry) throw new Error("snapshot input disappeared");
      const abs = join(snapshot,...entry.path.split("/")), st = lstatSync(abs);
      if (entry.isDirectory) {
        if (!st.isDirectory()) throw new Error("snapshot directory changed");
        return JSON.stringify({mode:st.mode & 0o7777});
      }
      const mode = st.isSymbolicLink() ? "120000" : st.isFile() ? ((st.mode & 0o111) ? "100755" : "100644") : "";
      if (!mode) throw new Error("snapshot file changed");
      const bytes = st.isSymbolicLink() ? readlinkSync(abs,{encoding:"buffer"}) : readFileSync(abs);
      return JSON.stringify({mode,permissions:st.mode & 0o7777,bytes:bytes.toString("base64")});
    },
    async seal() {
      if (!/ro=true\s*$/.test(run("btrfs", ["property", "get", "-ts", snapshot, "ro"]).trim())) throw new Error("snapshot lost read-only protection");
      return {covered:true, events:[]};
    },
    async cleanup() {
      if (created) run("btrfs", ["subvolume", "delete", snapshot]);
      if (container) rmSync(container, {recursive:true,force:true});
    },
  };
  try {
    const result = await captureWorktree({backend,maxAttempts:1});
    if (result.status !== "captured") throw new Error("capture backend failed or lost protection");
    const files = new Map<string,CapturedFile>();
    for (const [key, encoded] of Object.entries(result.files)) if (key.startsWith("F:")) {
      const value = JSON.parse(encoded) as { mode:string; bytes:string };
      files.set(key.slice(2),{mode:value.mode,bytes:Buffer.from(value.bytes,"base64")});
    }
    return {fingerprint:`sha256:${result.fingerprint}`,files};
  } catch (error) { throw new Error(`worktree snapshot capture unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}
