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
  basis: "local-name" | "receiver-owner" | "receiver-hierarchy" | "module-specifier" | "unknown";
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
  // A type name can denote several declarations. Keep all name-compatible
  // declarations, and all raw inheritance links, rather than using the
  // navigation resolver's single preferred match. These are possibilities,
  // not proof that a binding or dynamic dispatch was completely modelled.
  const typeKinds = new Set(["class", "interface", "trait", "struct"]);
  const types = nodes.filter(n => typeKinds.has(n.kind));
  const typeById = new Map(types.map(n => [n.id, n]));
  const neighbours = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    const set = neighbours.get(from) ?? new Set<string>();
    set.add(to); neighbours.set(from, set);
  };
  for (const intent of raw) {
    if ((intent.relation !== "extends" && intent.relation !== "implements") || !intent.name || !typeById.has(intent.source)) continue;
    for (const target of named.get(intent.name) ?? []) {
      if (!typeById.has(target.id)) continue;
      link(intent.source, target.id); link(target.id, intent.source);
    }
  }
  for (const intent of raw) {
    if (intent.relation === "imports" && intent.specifier) {
      const spec=intent.specifier, stem=spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(intent.file),spec)).replace(/\.(?:[cm]?[jt]sx?)$/, "") : spec.replace(/\./g,"/");
      const possible=nodes.filter(n=>n.kind === "file" && (n.path === stem || [".ts",".tsx",".js",".jsx",".py"].some(ext=>n.path === stem+ext || n.path === `${stem}/index${ext}` || n.path === `${stem}/__init__${ext}`)));
      const candidates=[...new Set(possible.map(n=>n.id))].sort();
      facts.push({path:intent.file,source:intent.source,relation:"imports",name:spec,candidates,basis:"module-specifier"});
      for(const target of candidates) {const key=`${intent.source}\0imports\0${target}`;if(!seen.has(key)){seen.add(key);edges.push({source:intent.source,target,relation:"imports",confidence:"inferred"});}}
      continue;
    }
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
      // Keep every declaration compatible with the stated receiver type and
      // raw inheritance graph, including possible overrides and overloads.
      // Cross-file identity remains unresolved; broad matches are candidates.
      const visited = new Set<string>();
      const queue = types.filter(n => n.name === intent.recvType).map(n => n.id);
      while (queue.length) {
        const id = queue.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const neighbour of neighbours.get(id) ?? []) if (!visited.has(neighbour)) queue.push(neighbour);
      }
      const owners = new Set([...visited].map(id => {
        const type = typeById.get(id)!;
        return `${type.path}\0${type.name}`;
      }));
      // Some extractors record an owner without a corresponding type node.
      owners.add(`${intent.file}\0${intent.recvType}`);
      possible = sameName.filter(n => n.kind === "method" && owners.has(`${n.path}\0${n.owner}`));
      basis = visited.size ? "receiver-hierarchy" : "receiver-owner";
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
