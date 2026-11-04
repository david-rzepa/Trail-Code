/** Conservative exact-endpoint impact. Unmodeled constructs always require full fallback. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, tierOf } from "../graph/build.js";
import { readGraph } from "../graph/write.js";
import { extractorStamp, readExtractCache, writeExtractCache } from "../graph/extract-cache.js";
import type { GraphV1 } from "../graph/types.js";
import { loadConservativeGraph, readCommittedSnapshot } from "./coordinator.js";
import { preserveCandidates, type CandidateFact } from "./facts.js";

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function git(dir: string, args: string[]): Buffer {
  const p = spawnSync("git", ["-C", dir, ...args], { encoding: null, maxBuffer: 256 * 1024 * 1024 });
  if (p.error || p.status !== 0) throw new Error(`git ${args[0]} failed: ${p.error?.message ?? p.stderr?.toString().trim() ?? "unknown error"}`);
  return p.stdout;
}
interface Endpoint { requested: string; kind: "commit"; commit: string; tree: string; fingerprint: string }
function endpoint(dir: string, requested: string): Endpoint {
  if (!requested || requested === "worktree") throw new Error("worktree endpoints are unsupported; provide a commit");
  const commit = git(dir, ["rev-parse", "--verify", "--end-of-options", `${requested}^{commit}`]).toString().trim();
  const tree = git(dir, ["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]).toString().trim();
  if (!OID.test(commit) || !OID.test(tree)) throw new Error("invalid resolved commit or tree identity");
  return { requested, kind: "commit", commit, tree, fingerprint: `git-tree:${tree}` };
}
interface Change { kind: "added" | "removed" | "modified"; old_path: string | null; new_path: string | null; old_entities: string[]; new_entities: string[] }
interface Affected { revision: "from" | "to"; path: string; entity: string | null; reasons: {kind: "changed" | "dependency"; detail: string}[] }
interface Gap { revision: "from" | "to"; path: string | null; kind: string; detail: string; scope: null; source?: string; relation?: string; name?: string; candidates?: string[]; candidate_basis?: string }
/** Raw per-file facts only. Navigation and resolved graph caches are never read. */
function extractionCache(repo: string, version: string): string | null {
  try {
    const stamp = extractorStamp(); if (!stamp) return null;
    const home = realpathSync(homedir());
    const parent = join(home, ".cache"); mkdirSync(parent, {mode:0o700,recursive:true});
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (process.getuid && parentStat.uid !== process.getuid()) || (parentStat.mode & 0o022) !== 0) return null;
    const base = join(parent, "trail-impact"); mkdirSync(base, {mode:0o700,recursive:true});
    const st = lstatSync(base);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) return null;
    const lock = readFileSync(fileURLToPath(new URL("../../package-lock.json", import.meta.url)));
    const key = createHash("sha256").update(realpathSync(repo)).update("\0").update(stamp).update("\0").update(version)
      .update("\0").update(process.platform).update("\0").update(process.arch).update("\0").update(process.versions.node).update(lock).digest("hex");
    const out = join(base, key); mkdirSync(out, {mode:0o700,recursive:true});
    const outStat = lstatSync(out);
    if (!outStat.isDirectory() || outStat.isSymbolicLink() || (process.getuid && outStat.uid !== process.getuid()) || (outStat.mode & 0o077) !== 0) return null;
    return out;
  } catch { return null; }
}
function compare(dir: string, from: Endpoint, to: Endpoint): Change[] {
  const fields = git(dir, ["diff-tree", "--no-commit-id", "--no-ext-diff", "--no-renames", "--name-status", "-r", "-z", from.tree, to.tree]).toString("utf8").split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i], path = fields[i + 1];
    if (!path || path.includes("\ufffd")) throw new Error("unsupported Git path encoding");
    const kind = status === "A" ? "added" : status === "D" ? "removed" : "modified";
    changes.push({ kind, old_path: kind === "added" ? null : path, new_path: kind === "removed" ? null : path, old_entities: [], new_entities: [] });
  }
  return changes.sort((a,b) => (a.old_path ?? a.new_path ?? "").localeCompare(b.old_path ?? b.new_path ?? ""));
}
type CommittedEntry = { path: string; mode: string; oid: string };
/** Git trees are the sole source of paths and bytes; link targets are never read. */
function treeEntries(repo: string, tree: string): CommittedEntry[] {
  const records = git(repo, ["ls-tree", "-r", "-z", "--full-tree", tree]).toString("utf8").split("\0");
  return records.filter(Boolean).map(record => {
    const tab = record.indexOf("\t");
    const match = /^(\d+) (blob|commit) ([0-9a-f]+)$/.exec(record.slice(0, tab));
    const path = record.slice(tab + 1);
    if (!match || !path || path.includes("\ufffd") || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git") || (process.platform === "win32" && (path.includes("\\") || path.includes(":")))) throw new Error("snapshot contains an unsupported path");
    if (match[2] === "commit") throw new Error(`required submodule snapshot is unavailable: ${path}`);
    if (!OID.test(match[3])) throw new Error("invalid blob identity");
    if (!["100644", "100755", "120000"].includes(match[1])) throw new Error(`unsupported file mode for ${path}`);
    return {path, mode:match[1], oid:match[3]};
  });
}
/** Create only regular files beneath a private root; never create or follow links. */
function materializeEntries(root: string, entries: Array<CommittedEntry & {bytes: unknown}>, revision: "from" | "to", gaps: Gap[], paths: string[]): void {
  const rootPath = realpathSync(root);
  for (const {path, mode, bytes} of entries) {
    if (!Buffer.isBuffer(bytes)) throw new Error("invalid snapshot blob");
    if (mode === "120000") { gaps.push({revision,path,kind:"symbolic_link",detail:"symbolic-link targets are not modeled",scope:null}); continue; }
    const components = path.split("/"); let dir = rootPath;
    for (const part of components.slice(0,-1)) {
      dir = join(dir,part);
      try { mkdirSync(dir, {mode:0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("snapshot materialization encountered an unsafe path component");
      const resolved = realpathSync(dir), rel = relative(rootPath,resolved);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("snapshot materialization escaped its root");
    }
    const target = join(dir,components[components.length-1]);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    const fd = openSync(target, flags, mode === "100755" ? 0o700 : 0o600);
    try { writeFileSync(fd,bytes); } finally { closeSync(fd); }
    paths.push(path);
  }
}
async function graphFor(repo: string, endpointValue: Endpoint, revision: "from" | "to", gaps: Gap[], version: string): Promise<GraphV1 | null> {
  const temp = mkdtempSync(join(tmpdir(), "trail-impact-"));
  try {
    const root = join(temp, "tree"), out = join(temp, "graph");
    const inputPaths: string[] = [];
    mkdirSync(root);
    const snapshot = await readCommittedSnapshot({
      ref: endpointValue.commit,
      git: {
        async resolve() { return {commit:endpointValue.commit, tree:endpointValue.tree}; },
        async readTree(tree) { return treeEntries(repo,tree); },
        async readBlob(oid) { return git(repo,["cat-file","blob",oid]); },
      },
      materializer: {
        async writeTree(entries) { materializeEntries(root,entries,revision,gaps,inputPaths); },
        async cleanup() { /* graph needs the temporary root until its build finishes */ },
      },
    });
    if (snapshot.status !== "captured" || snapshot.commit !== endpointValue.commit || snapshot.tree !== endpointValue.tree) throw new Error("committed snapshot materialization failed");
    try {
      const rawCache = extractionCache(repo, version);
      if (rawCache) writeExtractCache(out, readExtractCache(rawCache));
      let candidateFacts: CandidateFact[] = [];
      let undecodable: string[] = [];
      const identity = {snapshot:endpointValue.fingerprint,mode:"conservative",policy:"conservative-v1",version:`${version}:${extractorStamp() ?? "uncached"}`};
      const loaded = await loadConservativeGraph({identity, cache:{
        // Resolution is deliberately rerun: only raw facts are reused.
        async read() { return null; },
        async refresh(key) {
          let candidateEdges: GraphV1["edges"] = [];
          const result = await buildGraph(root, {contextDir:out,graphOnly:true,reuse:!!rawCache,
            onUndecodableInput(path) { undecodable.push(path); },
            onRawFacts(nodes, raw) { const preserved = preserveCandidates(nodes, raw); candidateFacts = preserved.facts; candidateEdges = preserved.edges; }});
          const graph = readGraph(result.graphPath);
          if (!graph) throw new Error("graph output was not readable");
          const keys = new Set(graph.edges.map(e => `${e.source}\0${e.relation}\0${e.target}`));
          for (const edge of candidateEdges) if (!keys.has(`${edge.source}\0${edge.relation}\0${edge.target}`)) graph.edges.push(edge);
          graph.meta.edgeCount = graph.edges.length;
          if (rawCache && result.errors.length === 0) writeExtractCache(rawCache, readExtractCache(out));
          return {identity:key,value:{graph, errors:result.errors, nativeFallback:!!result.nativeFallback, candidateFacts, undecodable}};
        },
        async publish(entry) {
          const stage = join(temp,"graph.tmp"), destination = join(temp,"graph-current.json");
          writeFileSync(stage, JSON.stringify(entry), {mode:0o600,flag:"wx"}); renameSync(stage,destination);
        },
      }});
      if (loaded.status !== "current") throw new Error("conservative graph refresh or publication failed");
      const result = loaded.value as {graph:GraphV1;errors:string[];nativeFallback:boolean;candidateFacts:CandidateFact[];undecodable:string[]};
      for (const error of result.errors) gaps.push({revision,path:null,kind:"index_failure",detail:error,scope:null});
      if (result.nativeFallback) gaps.push({revision,path:null,kind:"parser_fallback",detail:"A depth parser was unavailable",scope:null});
      for (const path of result.undecodable) gaps.push({revision,path,kind:"unsupported_encoding",detail:"Source could not be decoded for extraction",scope:null});
      const indexedPaths = new Set(result.graph.nodes.filter(n => n.kind === "file").map(n => n.path));
      for (const path of inputPaths) {
        const tier = tierOf(path);
        if ((tier.lang || tier.generic || tier.container) && !indexedPaths.has(path))
          gaps.push({revision,path,kind:"unindexed_source",detail:"Recognized source was not represented in the snapshot graph",scope:null});
      }
      for (const fact of result.candidateFacts) gaps.push({revision,path:fact.path,kind:fact.relation === "calls" ? "unresolved_call" : "unresolved_reference",scope:null,
        detail:`${fact.relation} ${fact.name} from ${fact.source} is not exhaustively resolved; recorded candidates are possibilities, not a complete target set`,
        source:fact.source,relation:fact.relation,name:fact.name,candidates:fact.candidates,candidate_basis:fact.basis});
      return result.graph;
    } catch (error) {
      gaps.push({ revision, path:null, kind:"index_failure", detail: `Snapshot graph could not be built: ${error instanceof Error ? error.message : String(error)}`, scope:null });
      return null;
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
function closure(graph: GraphV1 | null, revision: "from" | "to", changes: Change[]): Affected[] {
  const paths = new Set(changes.map(c => revision === "from" ? c.old_path : c.new_path).filter((p): p is string => p !== null));
  const affected: Affected[] = [...paths].sort().map(path => ({ revision, path, entity:null, reasons:[{kind:"changed", detail:"Changed file in this snapshot"}] }));
  if (!graph) return affected;
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const reached = new Set(graph.nodes.filter(n => paths.has(n.path)).map(n => n.id));
  const queue = [...reached].sort();
  const incoming = new Map<string, typeof graph.edges>();
  for (const e of graph.edges) { const list = incoming.get(e.target) ?? []; list.push(e); incoming.set(e.target, list); }
  const evidence = new Map<string, string>();
  for (const edges of incoming.values()) edges.sort((a,b) => a.source.localeCompare(b.source) || a.relation.localeCompare(b.relation) || a.confidence.localeCompare(b.confidence));
  for (let i=0; i<queue.length; i++) for (const e of incoming.get(queue[i]) ?? []) if (!reached.has(e.source)) {
    reached.add(e.source); queue.push(e.source);
    evidence.set(e.source, `${e.source} ${e.relation} ${e.target} (${e.confidence})`);
  }
  for (const id of [...reached].sort()) {
    const n = nodes.get(id); if (!n) continue;
    const direct = paths.has(n.path);
    affected.push({ revision, path:n.path, entity:n.id, reasons:[{kind:direct ? "changed" : "dependency", detail: direct ? "Entity in changed file" : evidence.get(id) ?? "Reverse dependency in snapshot graph"}] });
    if (direct) for (const c of changes) if ((revision === "from" ? c.old_path : c.new_path) === n.path) (revision === "from" ? c.old_entities : c.new_entities).push(n.id);
  }
  return affected;
}
export async function analyzeImpact(repo: string, fromRef: string, toRef: string, version: string) {
  const from = endpoint(repo, fromRef);
  const to = endpoint(repo, toRef);
  for (const tree of [from.tree, to.tree]) treeEntries(repo,tree);
  const changes = compare(repo, from, to);
  const gaps: Gap[] = [];
  let affected: Affected[] = [];
  if (changes.length) {
    const oldGraph = await graphFor(repo, from, "from", gaps, version);
    const newGraph = await graphFor(repo, to, "to", gaps, version);
    affected = [...closure(oldGraph, "from", changes), ...closure(newGraph, "to", changes)];
    // Existing navigation extraction and resolution deliberately omit unresolved
    // calls and do not model all dependency kinds. They can inform impact but
    // cannot justify exclusions until completeness is demonstrated.
    for (const revision of ["from", "to"] as const) gaps.push({revision, path:null, kind:"unmodeled_dependencies", detail:"Dynamic calls, resources, registrations and unresolved dependency candidates are not comprehensively modeled", scope:null});
  } else if (git(repo, ["ls-tree", "-r", "--name-only", from.tree]).length > 0) {
    // Identical trees need no change closure, but unmodeled constructs still
    // prevent us from asserting completeness of dependency analysis.
    gaps.push({revision:"from",path:null,kind:"unmodeled_dependencies",detail:"Dependency analysis is not complete for all supported constructs",scope:null});
  }
  affected.sort((a,b) => a.revision.localeCompare(b.revision) || a.path.localeCompare(b.path) || (a.entity ?? "").localeCompare(b.entity ?? ""));
  gaps.sort((a,b) => a.revision.localeCompare(b.revision) || (a.path ?? "").localeCompare(b.path ?? "") || a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail));
  const stamp = extractorStamp() ?? "unavailable";
  let grammar = "unavailable";
  try { grammar = createHash("sha256").update(readFileSync(fileURLToPath(new URL("../../package-lock.json", import.meta.url)))).digest("hex"); } catch { /* cache reuse is disabled if the lock is absent */ }
  return { schema_version:1, analysis_identity:{ analyzer_version:version, grammar_identity:grammar, extractor_identity:stamp, resolver_identity:stamp, policy_identity:"conservative-v1", mode:"conservative" }, comparison:{from,to}, changes, affected, analysis_gaps:gaps, required_fallback_scopes:gaps.length ? [{kind:"full_profile",scope:null,reason:"Dependency analysis has unbounded gaps"}] : [], analysis_status:gaps.length ? "incomplete" : "complete" };
}
