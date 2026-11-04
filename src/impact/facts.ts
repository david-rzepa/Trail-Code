/** Preserve plausible raw targets independently of navigation's drop-on-ambiguity resolver.
 * These are candidate relationships, not proof of a complete dependency model. */
import type { RawEdge } from "../graph/extract.js";
import type { EdgeV1, NodeV1 } from "../graph/types.js";
import { posix } from "node:path";

export interface CandidateFact {
  path: string;
  source: string;
  relation: RawEdge["relation"];
  name: string;
  candidates: string[];
  basis: "local-name" | "receiver-owner" | "module-specifier" | "unknown";
}

/** The selected candidates have explicit local or receiver evidence. A missing
 * candidate is NOT evidence that the relationship is external or absent. */
export function preserveCandidates(nodes: readonly NodeV1[], raw: readonly RawEdge[]): { facts: CandidateFact[]; edges: EdgeV1[] } {
  const named = new Map<string, NodeV1[]>();
  for (const node of nodes) {
    if (node.kind === "file") continue;
    const list = named.get(node.name) ?? [];
    list.push(node);
    named.set(node.name, list);
  }
  const facts: CandidateFact[] = [];
  const edges: EdgeV1[] = [];
  const seen = new Set<string>();
  for (const intent of raw) {
    if (!["calls", "references", "extends", "implements"].includes(intent.relation) || !intent.name) continue;
    const sameName = named.get(intent.name) ?? [];
    let basis: CandidateFact["basis"] = "unknown";
    let possible: NodeV1[] = [];
    if (intent.specifier?.startsWith(".")) {
      // Only literal, relative imports supply path evidence. Account for the
      // usual JS/TS extension remapping and directory index convention while
      // retaining ambiguity rather than picking a single matching file.
      basis = "module-specifier";
      const base = posix.normalize(posix.join(posix.dirname(intent.file), intent.specifier));
      const stem = base.replace(/\.(?:[cm]?[jt]sx?)$/, "");
      const variants = new Set([base, ...[".ts",".tsx",".mts",".cts",".js",".jsx",".mjs",".cjs",".py"].flatMap(ext => [stem + ext, `${stem}/index${ext}`])]);
      possible = sameName.filter(n => variants.has(n.path));
    } else if (intent.relation === "calls" && intent.viaMember && intent.recvType) {
      // Keep every same-file owner match, including overloads. Cross-file type
      // identity, inheritance, and dispatch remain explicitly unresolved.
      basis = "receiver-owner";
      possible = sameName.filter(n => n.kind === "method" && n.path === intent.file && n.owner === intent.recvType);
    } else if (!intent.viaMember && !intent.specifier) {
      basis = "local-name";
      possible = sameName.filter(n => n.path === intent.file && (intent.kinds ? intent.kinds.includes(n.kind) : intent.relation === "calls" ? n.kind === "function" : ["class","interface","trait","struct","enum","type","module"].includes(n.kind)));
    }
    const candidates = [...new Set(possible.map(n => n.id))].sort();
    facts.push({path:intent.file,source:intent.source,relation:intent.relation,name:intent.name,candidates,basis});
    for (const target of candidates) {
      const key = `${intent.source}\0${intent.relation}\0${target}`;
      if (!seen.has(key)) { seen.add(key); edges.push({source:intent.source,target,relation:intent.relation,confidence:"inferred"}); }
    }
  }
  facts.sort((a,b) => a.path.localeCompare(b.path) || a.source.localeCompare(b.source) || a.relation.localeCompare(b.relation) || a.name.localeCompare(b.name) || a.basis.localeCompare(b.basis));
  edges.sort((a,b) => a.source.localeCompare(b.source) || a.relation.localeCompare(b.relation) || a.target.localeCompare(b.target));
  return {facts,edges};
}
